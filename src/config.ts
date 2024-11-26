import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isObjectLike } from './utils.js';
import type { ConfigDevice } from './devices/kasaDevices.js';

let schemaCache: KasaPythonConfig;

export class ConfigParseError extends Error {
  constructor(
    message: string,
    public errors?: ErrorObject<string, Record<string, unknown>, unknown>[] | null,
    public unknownError?: unknown,
  ) {
    super(message);
    this.name = 'ConfigParseError';
    this.message = this.formatMessage(message, errors, unknownError);
    Error.captureStackTrace(this, this.constructor);
  }

  private formatMessage(
    message: string,
    errors?: ErrorObject<string, Record<string, unknown>, unknown>[] | null,
    unknownError?: unknown,
  ): string {
    let formattedMessage = message;
    if (errors && errors.length > 0) {
      const errorsAsString = errors.map((e) => {
        const allowedValues = 'allowedValues' in e.params ? `. Allowed values: ${JSON.stringify(e.params.allowedValues)}` : '';
        return `\`${e.instancePath.replace(/^\//, '')}\` ${e.message}${allowedValues}`;
      }).join('\n');
      formattedMessage += `:\n${errorsAsString}`;
    }
    if (unknownError instanceof Error) {
      formattedMessage += `\nAdditional Error: ${unknownError.message}`;
    } else if (unknownError) {
      formattedMessage += `\nAdditional Error: [Error details not available: ${unknownError}]`;
    }
    return formattedMessage;
  }
}

export interface KasaPythonConfigInput {
  name?: string;
  enableCredentials?: boolean;
  username?: string;
  password?: string;
  pollingInterval?: number;
  additionalBroadcasts?: string[];
  manualDevices?: (string | ConfigDevice)[];
  waitTimeUpdate?: number;
}

export type KasaPythonConfig = {
  name: string;
  enableCredentials: boolean;
  username: string;
  password: string;
  discoveryOptions: {
    pollingInterval: number;
    additionalBroadcasts: string[];
    manualDevices: ConfigDevice[];
  };
  waitTimeUpdate: number;
};

export const defaultConfig: KasaPythonConfig = {
  name: 'kasa-python',
  enableCredentials: false,
  username: '',
  password: '',
  discoveryOptions: {
    pollingInterval: 5,
    additionalBroadcasts: [],
    manualDevices: [],
  },
  waitTimeUpdate: 100,
};

function loadSchema() {
  if (!schemaCache) {
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const schemaPath = path.join(__dirname, '../config.schema.json');
      const schemaData = fs.readFileSync(schemaPath, 'utf8');
      schemaCache = JSON.parse(schemaData);
    } catch (error) {
      throw new ConfigParseError('Error reading schema', undefined, error);
    }
  }
  return schemaCache;
}

function convertManualDevices(manualDevices: (string | ConfigDevice)[] | undefined | null): ConfigDevice[] {
  if (!manualDevices || manualDevices.length === 0) {
    return [];
  }

  const convertedDevices = manualDevices.map(device => {
    if (typeof device === 'string') {
      return { host: device, alias: 'Will Be Filled By Plug-In Automatically' };
    } else {
      if ('breakoutChildDevices' in device) {
        delete device.breakoutChildDevices;
      }
      return device;
    }
  });
  return convertedDevices;
}

export function parseConfig(config: Record<string, unknown>): KasaPythonConfig {
  const ajv = new Ajv({ allErrors: true, strict: 'log' });
  addFormats(ajv);
  ajv.addVocabulary([
    'placeholder',
    'titleMap',
    'pluginAlias',
    'pluginType',
    'singular',
    'headerDisplay',
    'footerDisplay',
    'schema',
    'layout',
  ]);

  const schema = loadSchema();

  const validate = ajv.compile(schema);
  const valid = validate(config);
  if (!valid) {
    throw new ConfigParseError('Error parsing config', validate.errors);
  }

  if (!isObjectLike(config)) {
    throw new ConfigParseError('Error parsing config');
  }

  const c = { ...defaultConfig, ...config } as KasaPythonConfigInput;

  return {
    name: c.name ?? defaultConfig.name,
    enableCredentials: c.enableCredentials ?? defaultConfig.enableCredentials,
    username: c.username ?? defaultConfig.username,
    password: c.password ?? defaultConfig.password,
    waitTimeUpdate: c.waitTimeUpdate ?? defaultConfig.waitTimeUpdate,
    discoveryOptions: {
      pollingInterval: (c.pollingInterval ?? defaultConfig.discoveryOptions.pollingInterval) * 1000,
      additionalBroadcasts: c.additionalBroadcasts ?? defaultConfig.discoveryOptions.additionalBroadcasts,
      manualDevices: c.manualDevices ? convertManualDevices(c.manualDevices) : defaultConfig.discoveryOptions.manualDevices,
    },
  };
}