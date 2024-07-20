import Ajv, { ErrorObject as AjvErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import * as fs from 'fs';
import defaults from 'lodash.defaults';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { isObjectLike } from './utils.js';

export class ConfigParseError extends Error {
  /**
   * Set by `Error.captureStackTrace`
   */
  readonly stack = '';

  constructor(
    message: string,
    readonly errors?:
      | AjvErrorObject<string, Record<string, unknown>, unknown>[]
      | null
      | undefined,
    readonly unknownError?:unknown,
  ) {
    super(message);

    const errorsAsString =
      errors !== null && errors !== undefined
        ? errors
          .map((e) => {
            let msg = `\`${e.instancePath.replace(/^\//, '')}\` ${e.message}`;
            if ('allowedValues' in e.params) {
              msg += `. Allowed values: ${JSON.stringify(
                e.params.allowedValues,
              )}`;
            }
            return msg;
          })
          .join('\n')
        : '';

    this.name = 'ConfigParseError';
    if (errorsAsString === '') {
      this.message = message;
    } else {
      this.message = `${message}:\n${errorsAsString}`;
    }

    if (unknownError instanceof Error) {
      this.message += `\nAdditional Error: ${unknownError.message}`;
    } else if (unknownError) {
      this.message += `\nAdditional Error: [Error details not available: ${unknownError}]`;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}
export interface DeviceConfigInput {
  host: string;
  port?: number | undefined;
}
export interface KasaPythonConfigInput {
  // ==================
  // Environment Settings
  // ------------------
  /**
   * Username. If discovering devices is not working, try setting this to your Kasa Cloud Username.
   * This is required for the following devices:
   * EP25
     - Hardware: 2.6 (US) / Firmware: 1.0.1
     - Hardware: 2.6 (US) / Firmware: 1.0.2
     HS100
     - Hardware: 4.1 (UK) / Firmware: 1.1.0
     KP125M
     - Hardware: 1.0 (US) / Firmware: 1.1.3
     HS220
     - Hardware: 3.26 (US) / Firmware: 1.0.1
     KS205
     - Hardware: 1.0 (US) / Firmware: 1.0.2
     - Hardware: 1.0 (US) / Firmware: 1.1.0
     KS225
     - Hardware: 1.0 (US) / Firmware: 1.0.2
     - Hardware: 1.0 (US) / Firmware: 1.1.0
     KS240
     - Hardware: 1.0 (US) / Firmware: 1.0.4
     - Hardware: 1.0 (US) / Firmware: 1.0.5
     KH100
     - Hardware: 1.0 (UK) / Firmware: 1.5.6
     KE100
     - Hardware: 1.0 (EU) / Firmware: 2.4.0
     - Hardware: 1.0 (EU) / Firmware: 2.8.0
     - Hardware: 1.0 (UK) / Firmware: 2.8.0
   * @defaultValue ''
   */
  username?: string;
  /**
   * Password. If discovering devices is not working, try setting this to your Kasa Cloud Password.
   * This is required for the following devices:
   * EP25
     - Hardware: 2.6 (US) / Firmware: 1.0.1
     - Hardware: 2.6 (US) / Firmware: 1.0.2
     HS100
     - Hardware: 4.1 (UK) / Firmware: 1.1.0
     KP125M
     - Hardware: 1.0 (US) / Firmware: 1.1.3
     HS220
     - Hardware: 3.26 (US) / Firmware: 1.0.1
     KS205
     - Hardware: 1.0 (US) / Firmware: 1.0.2
     - Hardware: 1.0 (US) / Firmware: 1.1.0
     KS225
     - Hardware: 1.0 (US) / Firmware: 1.0.2
     - Hardware: 1.0 (US) / Firmware: 1.1.0
     KS240
     - Hardware: 1.0 (US) / Firmware: 1.0.4
     - Hardware: 1.0 (US) / Firmware: 1.0.5
     KH100
     - Hardware: 1.0 (UK) / Firmware: 1.5.6
     KE100
     - Hardware: 1.0 (EU) / Firmware: 2.4.0
     - Hardware: 1.0 (EU) / Firmware: 2.8.0
     - Hardware: 1.0 (UK) / Firmware: 2.8.0
   * @defaultValue ''
   */
  password?: string;
  // ==================
  // HomeKit Settings
  // ------------------
  /**
   * Create Multi-Outlet Devices as a Power Strip.
   * Enable to create a single power strip accessory with multiple outlets, used for models HS107, KP200, HS300, KP303, KP400, and EP40.
   * @defaultValue false
   */
  powerStrip?: boolean;
  // ==================
  // Discovery Settings
  // ------------------
  /**
   * Port to bind UDP socket for discovery.
   * If port is not specified or is 0, the operating system will attempt to bind to a random port.
   * @defaultValue 0
   */
  discoveryPort?: number;
  /**
   * Broadcast Address. If discovery is not working, tweak to match your subnet, eg: 192.168.1.255
   * @defaultValue '255.255.255.255'
   */
  broadcastAddress?: string;
  /**
   * How often to check device status in the background (seconds)
   * @defaultValue 10
   */
  pollingInterval?: number;
  /**
   * Allow-list of MAC Addresses to include. If specified will ignore other devices.
   * MAC Addresses are normalized, special characters are removed and made uppercase for comparison.
   * Supports glob-style patterns
   */
  includeMacAddress?: Array<string>;
  /**
   * Deny-list of MAC Addresses to exclude.
   * MAC Addresses are normalized, special characters are removed and made uppercase for comparison.
   * Supports glob-style patterns
   */
  excludeMacAddresses?: Array<string>;
  // ==================
  // Manual Discovery Settings
  // ------------------
  /**
   * Manual list of devices Before resorting to manually specifying devices.
   * Try setting the broadcast address and check your router/switch/firewall configuration.
   * You must assign static IP addresses to your devices to use this configuration.
   */
  devices?: Array<DeviceConfigInput>;

  // ==================
  // Advanced Settings
  // ------------------
  /**
   * Force Venv Recreation
   * Set this to force to recreate the virtual python environment with the next restart of the plugin.
   * @defaultValue false
   */
  forceVenvRecreate?: boolean;
  /**
   * Python Executable
   * Here you can specify a path that points to a python executable. The plugin uses the systems default python as default. Setting a
   * specific python executable here may be required if your systems default python version is too current for the plugin.
   */
  pythonExecutable?: string;
  /**
   * Communication Timeout (seconds)
   * @defaultValue 15
   */
  timeout?: number;
  /**
   * The time to wait to combine similar commands for a device before sending a command to a device (milliseconds)
   * @defaultValue 100
   */
  waitTimeUpdate?: number;
}

type KasaPythonConfigDefault = {
  username: string;
  password: string;
  powerStrip: boolean;
  discoveryPort: number;
  broadcastAddress: string;
  pollingInterval: number;
  includeMacAddress?: Array<string>;
  excludeMacAddresses?: Array<string>;
  devices?: Array<{ host: string; port?: number | undefined }>;

  forceVenvRecreate: boolean;
  pythonExecutable?: string;
  timeout: number;
  waitTimeUpdate: number;
};

export type KasaPythonConfig = {
  username: string;
  password: string;
  forceVenvRecreate: boolean;
  pythonExecutable?: string;
  waitTimeUpdate: number;
  powerStrip: boolean;

  defaultSendOptions: {
    timeout: number;
  };

  discoveryOptions: {
    port: number | undefined;
    broadcastAddress: string;
    pollingInterval: number;
    deviceOptions: {
      defaultSendOptions: {
        timeout: number;
      };
    };
    includeMacAddress?: Array<string>;
    excludeMacAddresses?: Array<string>;
    devices?: Array<{ host: string; port?: number | undefined }>;
  };
};

export const defaultConfig: KasaPythonConfigDefault = {
  username: '',
  password: '',
  powerStrip: false,
  discoveryPort: 0,
  broadcastAddress: '255.255.255.255',
  pollingInterval: 10,
  includeMacAddress: undefined,
  excludeMacAddresses: undefined,
  devices: undefined,

  forceVenvRecreate: false,
  pythonExecutable: undefined,
  timeout: 15,
  waitTimeUpdate: 100,
};

function isArrayOfStrings(value: unknown): value is Array<string> {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isDeviceConfigInput(value: unknown): value is DeviceConfigInput {
  return (
    isObjectLike(value) &&
    'host' in value &&
    typeof value.host === 'string' &&
    (!('port' in value) || typeof value.port === 'number')
  );
}

function isArrayOfDeviceConfigInput(
  value: unknown,
): value is Array<DeviceConfigInput> {
  return (
    Array.isArray(value) && value.every((item) => isDeviceConfigInput(item))
  );
}

function isKasaPythonConfigInput(
  c: unknown,
): c is KasaPythonConfigInput {
  return (
    isObjectLike(c) &&
    (!('username' in c) || typeof c.username === 'string') &&
    (!('password' in c) || typeof c.password === 'string') &&
    (!('powerStrip' in c) || typeof c.powerStrip === 'boolean') &&
    (!('discoveryPort' in c) || typeof c.discoveryPort === 'number') &&
    (!('broadcastAddress' in c) || typeof c.broadcastAddress === 'string') &&
    (!('pollingInterval' in c) || typeof c.pollingInterval === 'number') &&
    (!('includeMacAddress' in c) ||
      isArrayOfStrings(c.includeMacAddress) ||
      c.includeMacAddress === undefined) &&
    (!('excludeMacAddresses' in c) ||
      isArrayOfStrings(c.excludeMacAddresses) ||
      c.excludeMacAddresses === undefined) &&
    (!('devices' in c) ||
      isArrayOfDeviceConfigInput(c.devices) ||
      c.devices === undefined) &&
    (!('forceVenvRecreate' in c) || typeof c.forceVenvRecreate === 'boolean') &&
    (!('pythonExecutable' in c) ||
      typeof c.pythonExecutable === 'string' ||
      c.pythonExecutable === undefined) &&
    (!('timeout' in c) || typeof c.timeout === 'number') &&
    (!('waitTimeUpdate' in c) || typeof c.waitTimeUpdate === 'number')
  );
}

export function parseConfig(
  config: Record<string, unknown>,
): KasaPythonConfig {
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

  let schema;
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const schemaPath = path.join(__dirname, '../config.schema.json');
    const schemaData = fs.readFileSync(schemaPath, 'utf8');
    schema = JSON.parse(schemaData);
  } catch (error) {
    throw new ConfigParseError('Error reading schema', undefined, error);
  }

  const validate = ajv.compile(schema);
  const valid = validate(config);
  if (!valid) {
    throw new ConfigParseError('Error parsing config', validate.errors);
  }

  if (!isKasaPythonConfigInput(config)) {
    throw new ConfigParseError('Error parsing config');
  }

  const c = defaults(config, defaultConfig);

  const defaultSendOptions = {
    timeout: c.timeout * 1000,
  };

  return {
    username: c.username,
    password: c.password,
    powerStrip: c.powerStrip,
    forceVenvRecreate: c.forceVenvRecreate,
    pythonExecutable: c.pythonExecutable,
    waitTimeUpdate: c.waitTimeUpdate,

    defaultSendOptions,

    discoveryOptions: {
      port: c.discoveryPort,
      broadcastAddress: c.broadcastAddress,
      pollingInterval: c.pollingInterval * 1000,
      deviceOptions: {
        defaultSendOptions,
      },
      includeMacAddress: c.includeMacAddress,
      excludeMacAddresses: c.excludeMacAddresses,
      devices: c.devices,
    },
  };
}