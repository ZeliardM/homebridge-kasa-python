import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isObjectLike } from './utils.js';

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

export interface DeviceConfigInput {
  host: string;
  port?: number;
}

export interface KasaPythonConfigInput {
  name?: string;
  username?: string;
  password?: string;
  powerStrip?: boolean;
  pollingInterval?: number;
  forceVenvRecreate?: boolean;
  pythonExecutable?: string;
  waitTimeUpdate?: number;
}

export type KasaPythonConfig = {
  name: string;
  username: string;
  password: string;
  powerStrip: boolean;
  discoveryOptions: {
    pollingInterval: number;
  };
  forceVenvRecreate: boolean;
  pythonExecutable?: string;
  waitTimeUpdate: number;
};

export const defaultConfig: KasaPythonConfig = {
  name: 'kasa-python',
  username: '',
  password: '',
  powerStrip: false,
  discoveryOptions: {
    pollingInterval: 5,
  },
  forceVenvRecreate: false,
  pythonExecutable: undefined,
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

  const c = { ...defaultConfig, ...config };

  return {
    name: c.name ?? defaultConfig.name,
    username: c.username ?? defaultConfig.username,
    password: c.password ?? defaultConfig.password,
    powerStrip: c.powerStrip ?? defaultConfig.powerStrip,
    forceVenvRecreate: c.forceVenvRecreate ?? defaultConfig.forceVenvRecreate,
    pythonExecutable: c.pythonExecutable ?? defaultConfig.pythonExecutable,
    waitTimeUpdate: c.waitTimeUpdate ?? defaultConfig.waitTimeUpdate,
    discoveryOptions: {
      pollingInterval: (c.discoveryOptions.pollingInterval ?? defaultConfig.discoveryOptions.pollingInterval) * 1000,
    },
  };
}