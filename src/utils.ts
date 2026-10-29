import { LogLevel } from 'homebridge';
import type {
  Characteristic,
  Logger,
  Logging,
} from 'homebridge';

import axios from 'axios';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { ChildProcessWithoutNullStreams, spawn, SpawnOptionsWithoutStdio } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function deferAndCombine<T, U>(
  fn: ((requestCount: number) => Promise<T>) | (() => Promise<T>),
  timeout: number,
  runNowFn?: (arg: U) => void,
): (arg?: U) => Promise<T> {
  let requests: { resolve: (value: T) => void; reject: (reason?: unknown) => void }[] = [];
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const schedule = () => {
    if (!timer && !running) {
      timer = setTimeout(processRequests, timeout);
    }
  };

  const processRequests = () => {
    timer = null;
    running = true;
    const currentRequests = requests;
    requests = [];
    let result: Promise<T>;
    try {
      if (fn.length === 0) {
        result = (fn as () => Promise<T>)();
      } else {
        result = (fn as (requestCount: number) => Promise<T>)(currentRequests.length);
      }
    } catch (error) {
      result = Promise.reject(error);
    }
    // One run at a time: requests that arrive while fn is running wait for it to settle, then get their own run.
    result
      .then(value => currentRequests.forEach(req => req.resolve(value)))
      .catch(error => currentRequests.forEach(req => req.reject(error)))
      .finally(() => {
        running = false;
        if (requests.length > 0) {
          schedule();
        }
      });
  };

  return (arg?: U) => {
    if (runNowFn && arg !== undefined) {
      runNowFn(arg);
    }

    return new Promise<T>((resolve, reject) => {
      requests.push({ resolve, reject });
      schedule();
    });
  };
}

// Whether the promise settles within ms, either way. The timer is cleared as soon as it does.
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isObjectLike(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null || typeof candidate === 'function';
}

export interface PackageConfig {
  name: string;
  version: string;
  engines: { homebridge: string; node: string; python: string };
}

export async function loadPackageConfig(logger: Logging): Promise<PackageConfig> {
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

    // A process that cannot be started emits 'error' instead of throwing, and one that fails at once exits without
    // a word on stderr. Either rejects here; an 'error' without a listener would be an uncaught exception, which
    // stops Homebridge.
    await new Promise<void>((resolve, reject) => {
      const onData = () => {
        cleanup();
        logger.debug('Process data received.');
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        const output = stderr.trim().split('\n').slice(-5).join(' | ');
        reject(new Error(`${command} exited (${code ?? signal}) before it started${output ? `: ${output}` : ''}`));
      };
      const cleanup = () => {
        p.stderr.off('data', onData);
        p.off('error', onError);
        p.off('close', onClose);
      };
      p.stderr.once('data', onData);
      p.once('error', onError);
      p.once('close', onClose);
    });
    p.on('error', (error: Error) => logger.error(`Command error: ${error.message}`));

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
    await fs.writeFile(outputFile, stdout);
  }

  logger.debug('Command finished.');
  return [stdout, stderr, exitCode];
}

export function satisfiesVersion(currentVersion: string, requiredVersion: string): boolean {
  const parseVersionParts = (version: string): [number, number, number] => {
    const [major = '0', minor = '0', patch = '0'] = version.replace('^', '').replace('v', '').split('.');
    return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
  };

  const versions = requiredVersion.split('||').map(v => v.trim());
  const [currentMajor, currentMinor, currentPatch] = parseVersionParts(currentVersion);

  // Each alternative is a caret range (a bare version is read as one): at least that version, within the same major
  // version, or the same minor version for 0.x. So "^22.12 || ^24" accepts 22.12 and later 22.x and 24.x, but not
  // 23 or 25.
  return versions.some(version => {
    const [requiredMajor, requiredMinor, requiredPatch] = parseVersionParts(version);

    if (currentMajor !== requiredMajor) {
      return false;
    }
    if (requiredMajor === 0 && currentMinor !== requiredMinor) {
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

export interface WaitForServerOptions {
  headers?: Record<string, string>;
  timeout?: number;
  interval?: number;
  signal?: AbortSignal;
}

export async function waitForServer(
  url: string,
  log: Logging,
  { headers = {}, timeout = 30000, interval = 1000, signal }: WaitForServerOptions = {},
): Promise<void> {
  const startTime = Date.now();
  log.debug(`Waiting for server at ${url} with timeout ${timeout}ms and interval ${interval}ms`);

  while (Date.now() - startTime < timeout) {
    // Given up on by the caller (the server exited): stop asking
    signal?.throwIfAborted();
    try {
      const response = await axios.get(url, { headers, timeout: 5000 });
      if (response.status === 200) {
        log.debug('Server responded successfully');
        return;
      }
    } catch {
      log.debug('Server not responding yet, retrying...');
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Server did not respond within ${timeout / 1000} seconds`);
}

// A free port on 127.0.0.1, the only address the Python service listens on.
export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}