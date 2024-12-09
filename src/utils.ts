import { LogLevel } from 'homebridge';
import type {
  Characteristic,
  Logger,
  Logging,
} from 'homebridge';

import { ChildProcessWithoutNullStreams, spawn, SpawnOptionsWithoutStdio } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

export function deferAndCombine<T, U>(
  fn: (requestCount: number) => Promise<T>,
  timeout: number,
  runNowFn?: (arg: U) => void,
): (arg?: U) => Promise<T> {
  let requests: { resolve: (value: T) => void; reject: (reason?: unknown) => void }[] = [];
  let timer: NodeJS.Timeout | null = null;

  const processRequests = () => {
    const currentRequests = requests;
    requests = [];
    fn(currentRequests.length)
      .then(value => currentRequests.forEach(req => req.resolve(value)))
      .catch(error => currentRequests.forEach(req => req.reject(error)))
      .finally(() => timer = null);
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
): Promise<[string, string, number | null, (ChildProcessWithoutNullStreams | null)?]> {
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
  const p: ChildProcessWithoutNullStreams = spawn(command, filteredArgs, {
    ...options,
    env: process.env,
  });
  logger.debug(`Command PID: ${p.pid}`);

  p.stdout.setEncoding('utf8').on('data', data => {
    stdout += data;
    if (!hideStdout) {
      logger.info(data.trim());
    }
  });

  p.stderr.setEncoding('utf8').on('data', data => {
    stderr += data;
    if (!hideStderr) {
      logger[data.startsWith('WARNING') ? 'warn' : 'error'](data.trim());
    }
  });

  if (returnProcess) {
    logger.debug('Command started.');

    const stderrReady = new Promise<void>((resolve) => {
      p.stderr.once('data', () => {
        resolve();
      });
    });

    await stderrReady;

    return [stdout, stderr, null, p];
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    p.on('close', resolve).on('error', reject);
  });

  p.stdout.destroy();
  p.stderr.destroy();
  p.kill();

  if (outputFile) {
    await writeFile(outputFile, stdout);
  }

  logger.debug('Command finished.');
  return [stdout, stderr, exitCode];
}