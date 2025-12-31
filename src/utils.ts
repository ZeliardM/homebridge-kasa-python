import { LogLevel } from 'homebridge';
import type {
  Characteristic,
  Logger,
  Logging,
} from 'homebridge';

import axios from 'axios';
import { ChildProcessWithoutNullStreams, spawn, SpawnOptionsWithoutStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';

export async function checkForUpgrade(
  packageConfig: { name: string; version: string; engines: { node: string } },
  storagePath: string,
  logger: Logging,
): Promise<boolean> {
  const versionDir = path.join(storagePath, 'kasa-python');
  const versionFilePath = path.join(versionDir, 'kasa-python-version.json');
  let storedVersion = '';

  logger.debug('Checking for upgrade at path:', versionFilePath);

  try {
    await fs.access(versionFilePath);
    const versionData = await fs.readFile(versionFilePath, 'utf8');
    storedVersion = JSON.parse(versionData).version;
    logger.debug('Stored version:', storedVersion);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info('Version file does not exist, treating as new install or version change.');
    } else {
      logger.error('Error reading version file:', error);
    }
  }

  if (storedVersion !== packageConfig.version) {
    try {
      logger.debug('Updating version file to new version:', packageConfig.version);
      await fs.mkdir(versionDir, { recursive: true });
      await fs.writeFile(versionFilePath, JSON.stringify({ version: packageConfig.version }), 'utf8');
      logger.info(`Version file updated to version ${packageConfig.version}`);
    } catch (error) {
      logger.error('Error writing version file:', error);
    }
    return true;
  }

  logger.debug('No upgrade needed, version is up to date.');
  return false;
}

export function deferAndCombine<T, U>(
  fn: ((requestCount: number) => Promise<T>) | (() => Promise<T>),
  timeout: number,
  runNowFn?: (arg: U) => void,
): (arg?: U) => Promise<T> {
  let requests: { resolve: (value: T) => void; reject: (reason?: unknown) => void }[] = [];
  let timer: NodeJS.Timeout | null = null;

  const processRequests = () => {
    const currentRequests = requests;
    requests = [];
    let result: Promise<T>;
    if (fn.length === 0) {
      result = (fn as () => Promise<T>)();
    } else {
      result = (fn as (requestCount: number) => Promise<T>)(currentRequests.length);
    }
    result
      .then(value => currentRequests.forEach(req => req.resolve(value)))
      .catch(error => currentRequests.forEach(req => req.reject(error)))
      .finally(() => {
        timer = null;
      });
  };

  return (arg?: U) => {
    if (runNowFn && arg !== undefined) {
      runNowFn(arg);
    }

    return new Promise<T>((resolve, reject) => {
      requests.push({ resolve, reject });

      if (!timer) {
        timer = setTimeout(processRequests, timeout);
      }
    });
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isObjectLike(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null || typeof candidate === 'function';
}

export async function loadPackageConfig(logger: Logging): Promise<{ name: string; version: string; engines: { node: string } }> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageConfigPath = path.join(__dirname, '..', 'package.json');
  const log: Logger = prefixLogger(logger, '[Package Config]');
  log.debug('Loading package configuration from:', packageConfigPath);

  try {
    const packageConfigData = await fs.readFile(packageConfigPath, 'utf8');
    return JSON.parse(packageConfigData);
  } catch (error) {
    log.error(`Error reading package.json: ${error}`);
    throw error;
  }
}

export function lookup<T>(
  object: unknown,
  compareFn: undefined | ((objectProp: unknown, search: T) => boolean),
  value: T,
): string | undefined {
  const compare = compareFn ?? ((objectProp: unknown, search: T): boolean => objectProp === search);

  if (isObjectLike(object)) {
    return Object.keys(object).find(key => compare(object[key], value));
  }
  return undefined;
}

export function lookupCharacteristicNameByUUID(
  characteristic: typeof Characteristic,
  uuid: string,
): string | undefined {
  return Object.keys(characteristic).find(key => ((characteristic as unknown as {[key: string]: {UUID: string}})[key].UUID === uuid));
}

export function prefixLogger(logger: Logger, prefix: string | (() => string)): Logging {
  const methods: Array<'info' | 'warn' | 'error' | 'debug' | 'log'> = ['info', 'warn', 'error', 'debug', 'log'];
  const clonedLogger: Logging = methods.reduce((acc: Logging, method) => {
    acc[method] = (...args: unknown[]) => {
      const prefixString = typeof prefix === 'function' ? prefix() : prefix;
      if (method === 'log') {
        const [level, message, ...parameters] = args;
        logger[method](level as LogLevel, `${prefixString} ${message}`, ...parameters);
      } else {
        const [message, ...parameters] = args;
        logger[method](`${prefixString} ${message}`, ...parameters);
      }
    };
    return acc;
  }, {} as Logging);

  (clonedLogger as { prefix: string | (() => string) }).prefix = typeof logger.prefix === 'string' ? `${prefix} ${logger.prefix}` : prefix;

  return clonedLogger;
}

export async function runCommand(
  logger: Logger,
  command: string,
  args: readonly string[] = [],
  options?: SpawnOptionsWithoutStdio,
  hideStdout: boolean = false,
  hideStderr: boolean = false,
  returnProcess: boolean = false,
  suppressErrors: string[] = [],
): Promise<[string, string, number | null, (ChildProcessWithoutNullStreams | null)?]> {
  const MAX_BUFFER_SIZE = 1024 * 1024;
  let stdout: string = '';
  let stderr: string = '';
  let outputFile: string | null = null;

  const filteredArgs = args.filter(arg => {
    if (arg.startsWith('>')) {
      outputFile = arg.substring(1).trim();
      return false;
    }
    return true;
  });

  logger.debug(`Running command: ${command} ${filteredArgs.join(' ')}`);

  const env = {
    ...process.env,
    ...(options?.env || {}),
  };

  const p: ChildProcessWithoutNullStreams = spawn(command, filteredArgs, {
    ...options,
    env,
  });

  logger.debug(`Command PID: ${p.pid}`);

  p.stdout.setEncoding('utf8').on('data', data => {
    stdout += data;
    if (stdout.length > MAX_BUFFER_SIZE) {
      stdout = stdout.slice(-MAX_BUFFER_SIZE);
    }
    if (!hideStdout) {
      logger.debug(`STDOUT: ${data.trim()}`);
    }
  });

  p.stderr.setEncoding('utf8').on('data', data => {
    stderr += data;
    if (stderr.length > MAX_BUFFER_SIZE) {
      stderr = stderr.slice(-MAX_BUFFER_SIZE);
    }
    if (!hideStderr) {
      logger.error(`STDERR: ${data.trim()}`);
    }
  });

  if (returnProcess) {
    logger.debug('Command started and returning process.');

    const stderrReady = new Promise<void>((resolve) => {
      p.stderr.once('data', () => {
        logger.debug('Process data received.');
        resolve();
      });
    });

    await stderrReady;

    return [stdout, stderr, null, p];
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    p.on('close', (code) => {
      logger.debug(`Command closed with exit code: ${code}`);
      resolve(code);
    }).on('error', (error: NodeJS.ErrnoException) => {
      const errorMessage = error.message.toLowerCase();
      const shouldSuppress =
    suppressErrors.some(err =>
      (error.code && error.code.toString().toLowerCase() === err.toLowerCase()) ||
      errorMessage.includes(err.toLowerCase()),
    );
      if (!shouldSuppress) {
        logger.error('Command encountered an error:', error);
      }
      reject(error);
    });
  });

  p.stdout.destroy();
  p.stderr.destroy();
  p.kill();

  if (outputFile) {
    logger.debug(`Writing command output to file: ${outputFile}`);
    await writeFile(outputFile, stdout);
  }

  logger.debug('Command finished.');
  return [stdout, stderr, exitCode];
}

export function satisfiesVersion(currentVersion: string, requiredVersion: string): boolean {
  const versions = requiredVersion.split('||').map(v => v.trim());

  return versions.some(version => {
    const [requiredMajor, requiredMinor, requiredPatch] = version.replace('^', '').split('.').map(Number);
    const [currentMajor, currentMinor, currentPatch] = currentVersion.replace('v', '').split('.').map(Number);

    if (currentMajor > requiredMajor) {
      return true;
    }
    if (currentMajor < requiredMajor) {
      return false;
    }
    if (currentMinor > requiredMinor) {
      return true;
    }
    if (currentMinor < requiredMinor) {
      return false;
    }
    return currentPatch >= requiredPatch;
  });
}

export async function waitForServer(url: string, log: Logging, timeout: number = 30000, interval: number = 1000): Promise<void> {
  const startTime = Date.now();
  log.debug(`Waiting for server at ${url} with timeout ${timeout}ms and interval ${interval}ms`);

  while (Date.now() - startTime < timeout) {
    try {
      const response = await axios.get(url);
      if (response.status === 200) {
        log.debug('Server responded successfully');
        return;
      }
    } catch {
      log.debug('Server not responding yet, retrying...');
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  log.error(`Server did not respond within ${timeout / 1000} seconds`);
  throw new Error(`Server did not respond within ${timeout / 1000} seconds`);
}

export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}