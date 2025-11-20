import { isObjectLike } from './utils.js';
import type { ConfigDevice } from './devices/deviceTypes.js';

export class ConfigParseError extends Error {
  constructor(
    message: string,
    public errors?: string[] | null,
    public unknownError?: unknown,
  ) {
    super(message);
    this.name = 'ConfigParseError';
    this.message = this.formatMessage(message, errors, unknownError);
    Error.captureStackTrace(this, this.constructor);
  }

  private formatMessage(
    message: string,
    errors?: string[] | null,
    unknownError?: unknown,
  ): string {
    let formattedMessage = message;
    if (errors && errors.length > 0) {
      const errorsAsString = errors.join('\n');
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
  enableEnergyMonitoring?: boolean;
  hideHomeKitMatter?: boolean;
  pollingInterval?: number;
  discoveryPollingInterval?: number;
  offlineInterval?: number;
  additionalBroadcasts?: string[];
  manualDevices?: (string | ConfigDevice)[];
  excludeMacAddresses?: string[];
  includeMacAddresses?: string[];
  waitTimeUpdate?: number;
  pythonPath?: string;
  advancedPythonLogging?: boolean;
  logEnergyMonitoring?: boolean;
}

export type KasaPythonConfig = {
  name: string;
  enableCredentials: boolean;
  username: string;
  password: string;
  enableEnergyMonitoring: boolean;
  homekitOptions: {
    hideHomeKitMatter: boolean;
  };
  discoveryOptions: {
    pollingInterval: number;
    discoveryPollingInterval: number;
    offlineInterval: number;
    additionalBroadcasts: string[];
    manualDevices: ConfigDevice[];
    excludeMacAddresses: string[];
    includeMacAddresses: string[];
  };
  advancedOptions: {
    waitTimeUpdate: number;
    pythonPath?: string;
    advancedPythonLogging: boolean;
    logEnergyMonitoring: boolean;
  };
};

export const defaultConfig: KasaPythonConfig = {
  name: 'kasa-python',
  enableCredentials: false,
  username: '',
  password: '',
  enableEnergyMonitoring: false,
  homekitOptions: {
    hideHomeKitMatter: true,
  },
  discoveryOptions: {
    pollingInterval: 5,
    discoveryPollingInterval: 300,
    offlineInterval: 7,
    additionalBroadcasts: [],
    manualDevices: [],
    excludeMacAddresses: [],
    includeMacAddresses: [],
  },
  advancedOptions: {
    waitTimeUpdate: 100,
    pythonPath: '',
    advancedPythonLogging: false,
    logEnergyMonitoring: false,
  },
};

function convertManualDevices(manualDevices: (string | ConfigDevice)[] | undefined | null): ConfigDevice[] {
  if (!manualDevices || manualDevices.length === 0) {
    return [];
  }

  return manualDevices.map(device => {
    if (typeof device === 'string') {
      return { host: device, alias: 'Will Be Filled By Plug-In Automatically' };
    } else if ('breakoutChildDevices' in device) {
      delete device.breakoutChildDevices;
    } else if ('host' in device && !('alias' in device)) {
      (device as ConfigDevice).alias = 'Will Be Filled By Plug-In Automatically';
    }
    return device;
  });
}

function validateConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = [];

  validateType(config, 'name', 'string', errors);
  validateType(config, 'enableCredentials', 'boolean', errors);
  validateType(config, 'username', 'string', errors);
  validateType(config, 'password', 'string', errors);
  validateType(config, 'enableEnergyMonitoring', 'boolean', errors);
  validateType(config, 'hideHomeKitMatter', 'boolean', errors);
  validateType(config, 'pollingInterval', 'number', errors);
  validateType(config, 'discoveryPollingInterval', 'number', errors);
  validateType(config, 'offlineInterval', 'number', errors);

  if (config.additionalBroadcasts !== undefined && !Array.isArray(config.additionalBroadcasts)) {
    errors.push('`additionalBroadcasts` should be an array of strings.');
  }

  if (config.manualDevices !== undefined && !Array.isArray(config.manualDevices)) {
    errors.push('`manualDevices` should be an array.');
  }

  if (config.excludeMacAddresses !== undefined && !Array.isArray(config.excludeMacAddresses)) {
    errors.push('`excludeMacAddresses` should be an array of strings.');
  }

  if (config.includeMacAddresses !== undefined && !Array.isArray(config.includeMacAddresses)) {
    errors.push('`includeMacAddresses` should be an array of strings.');
  }

  validateType(config, 'waitTimeUpdate', 'number', errors);
  validateType(config, 'pythonPath', 'string', errors);
  validateType(config, 'advancedPythonLogging', 'boolean', errors);
  validateType(config, 'logEnergyMonitoring', 'boolean', errors);

  return errors;
}

function validateType(
  config: Record<string, unknown>,
  key: string,
  expectedType: string,
  errors: string[],
) {
  if (config[key] !== undefined && typeof config[key] !== expectedType) {
    errors.push(`\`${key}\` should be a ${expectedType}.`);
  }
}

export function parseConfig(config: Record<string, unknown>): KasaPythonConfig {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ConfigParseError('Error parsing config', errors);
  }

  if (!isObjectLike(config)) {
    throw new ConfigParseError('Error parsing config');
  }

  const parsedConfig = { ...defaultConfig, ...config } as KasaPythonConfigInput;

  return {
    name: parsedConfig.name ?? defaultConfig.name,
    enableCredentials: parsedConfig.enableCredentials ?? defaultConfig.enableCredentials,
    username: parsedConfig.username ?? defaultConfig.username,
    password: parsedConfig.password ?? defaultConfig.password,
    enableEnergyMonitoring: parsedConfig.enableEnergyMonitoring ?? defaultConfig.enableEnergyMonitoring,
    homekitOptions: {
      hideHomeKitMatter: parsedConfig.hideHomeKitMatter ?? defaultConfig.homekitOptions.hideHomeKitMatter,
    },
    discoveryOptions: {
      pollingInterval: (parsedConfig.pollingInterval ?? defaultConfig.discoveryOptions.pollingInterval) * 1000,
      discoveryPollingInterval: (parsedConfig.discoveryPollingInterval ?? defaultConfig.discoveryOptions.discoveryPollingInterval) * 1000,
      offlineInterval: (parsedConfig.offlineInterval ?? defaultConfig.discoveryOptions.offlineInterval) * 24 * 60 * 60 * 1000,
      additionalBroadcasts: parsedConfig.additionalBroadcasts ?? defaultConfig.discoveryOptions.additionalBroadcasts,
      manualDevices:
        parsedConfig.manualDevices
          ? convertManualDevices(parsedConfig.manualDevices)
          : defaultConfig.discoveryOptions.manualDevices,
      excludeMacAddresses: parsedConfig.excludeMacAddresses ?? defaultConfig.discoveryOptions.excludeMacAddresses,
      includeMacAddresses: parsedConfig.includeMacAddresses ?? defaultConfig.discoveryOptions.includeMacAddresses,
    },
    advancedOptions: {
      waitTimeUpdate: parsedConfig.waitTimeUpdate ?? defaultConfig.advancedOptions.waitTimeUpdate,
      pythonPath: parsedConfig.pythonPath ?? defaultConfig.advancedOptions.pythonPath,
      advancedPythonLogging: parsedConfig.advancedPythonLogging ?? defaultConfig.advancedOptions.advancedPythonLogging,
      logEnergyMonitoring: parsedConfig.logEnergyMonitoring ?? defaultConfig.advancedOptions.logEnergyMonitoring,
    },
  };
}