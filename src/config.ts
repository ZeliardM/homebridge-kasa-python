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
  powerThreshold?: number;
  logEnergyMonitoring?: boolean;
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
}

export type KasaPythonConfig = {
  name: string;
  enableCredentials: boolean;
  username: string;
  password: string;
  energyOptions: {
    enableEnergyMonitoring: boolean;
    powerThreshold: number;
    logEnergyMonitoring: boolean;
  };
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
  };
};

export const defaultConfig: KasaPythonConfig = {
  name: 'kasa-python',
  enableCredentials: false,
  username: '',
  password: '',
  energyOptions: {
    enableEnergyMonitoring: false,
    powerThreshold: 2,
    logEnergyMonitoring: false,
  },
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
  },
};

type LegacyConfigDevice = {
  host?: unknown;
  alias?: unknown;
  breakoutChildDevices?: boolean;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeManualDevices(manualDevices: (string | ConfigDevice)[] | undefined | null): ConfigDevice[] {
  if (!manualDevices || manualDevices.length === 0) {
    return [];
  }

  return manualDevices.flatMap(device => {
    if (typeof device === 'string') {
      return isNonEmptyString(device) ? [{ host: device }] : [];
    }

    const migratedDevice = device as LegacyConfigDevice;
    if (!isNonEmptyString(migratedDevice.host)) {
      return [];
    }

    return [{ host: migratedDevice.host }];
  });
}

function validateManualDevices(
  manualDevices: unknown,
  errors: string[],
): void {
  if (manualDevices === undefined) {
    return;
  }

  if (!Array.isArray(manualDevices)) {
    errors.push('`manualDevices` should be an array.');
    return;
  }

  manualDevices.forEach((entry, index) => {
    if (typeof entry === 'string') {
      if (!isNonEmptyString(entry)) {
        errors.push(`\`manualDevices[${index}]\` should not be an empty string.`);
      }
      return;
    }

    if (!isObjectLike(entry)) {
      errors.push(`\`manualDevices[${index}]\` should be an object.`);
      return;
    }

    const device = entry as Record<string, unknown>;
    if (!isNonEmptyString(device.host)) {
      errors.push(`\`manualDevices[${index}].host\` should be a non-empty string.`);
    }
  });
}

function validateConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = [];

  validateType(config, 'name', 'string', errors);
  validateType(config, 'enableCredentials', 'boolean', errors);
  validateType(config, 'username', 'string', errors);
  validateType(config, 'password', 'string', errors);
  validateType(config, 'enableEnergyMonitoring', 'boolean', errors);
  validateType(config, 'powerThreshold', 'number', errors);
  validateType(config, 'logEnergyMonitoring', 'boolean', errors);
  validateType(config, 'hideHomeKitMatter', 'boolean', errors);
  validateType(config, 'pollingInterval', 'number', errors);
  validateType(config, 'discoveryPollingInterval', 'number', errors);
  validateType(config, 'offlineInterval', 'number', errors);

  if (config.additionalBroadcasts !== undefined && !Array.isArray(config.additionalBroadcasts)) {
    errors.push('`additionalBroadcasts` should be an array of strings.');
  }

  validateManualDevices(config.manualDevices, errors);

  if (config.excludeMacAddresses !== undefined && !Array.isArray(config.excludeMacAddresses)) {
    errors.push('`excludeMacAddresses` should be an array of strings.');
  }

  if (config.includeMacAddresses !== undefined && !Array.isArray(config.includeMacAddresses)) {
    errors.push('`includeMacAddresses` should be an array of strings.');
  }

  validateType(config, 'waitTimeUpdate', 'number', errors);
  validateType(config, 'pythonPath', 'string', errors);
  validateType(config, 'advancedPythonLogging', 'boolean', errors);

  validatePowerThreshold(config.powerThreshold, errors);

  return errors;
}

function validatePowerThreshold(value: unknown, errors: string[]): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'number' || Number.isNaN(value)) {
    return;
  }

  if (value < 0.001) {
    errors.push('`powerThreshold` should be at least 0.001.');
  }

  if (Math.abs(Math.round(value * 1000) - (value * 1000)) > Number.EPSILON * 1000) {
    errors.push('`powerThreshold` should use no more than three decimal places.');
  }
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
  if (!isObjectLike(config)) {
    throw new ConfigParseError('Error parsing config');
  }

  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ConfigParseError('Error parsing config', errors);
  }

  const parsedConfig = { ...defaultConfig, ...config } as KasaPythonConfigInput;
  const normalizedManualDevices = normalizeManualDevices(parsedConfig.manualDevices)
    ?? defaultConfig.discoveryOptions.manualDevices;

  return {
    name: parsedConfig.name ?? defaultConfig.name,
    enableCredentials: parsedConfig.enableCredentials ?? defaultConfig.enableCredentials,
    username: parsedConfig.username ?? defaultConfig.username,
    password: parsedConfig.password ?? defaultConfig.password,
    energyOptions: {
      enableEnergyMonitoring: parsedConfig.enableEnergyMonitoring ?? defaultConfig.energyOptions.enableEnergyMonitoring,
      powerThreshold: parsedConfig.powerThreshold ?? defaultConfig.energyOptions.powerThreshold,
      logEnergyMonitoring: parsedConfig.logEnergyMonitoring ?? defaultConfig.energyOptions.logEnergyMonitoring,
    },
    homekitOptions: {
      hideHomeKitMatter: parsedConfig.hideHomeKitMatter ?? defaultConfig.homekitOptions.hideHomeKitMatter,
    },
    discoveryOptions: {
      pollingInterval: (parsedConfig.pollingInterval ?? defaultConfig.discoveryOptions.pollingInterval) * 1000,
      discoveryPollingInterval: (parsedConfig.discoveryPollingInterval ?? defaultConfig.discoveryOptions.discoveryPollingInterval) * 1000,
      offlineInterval: (parsedConfig.offlineInterval ?? defaultConfig.discoveryOptions.offlineInterval) * 24 * 60 * 60 * 1000,
      additionalBroadcasts: parsedConfig.additionalBroadcasts ?? defaultConfig.discoveryOptions.additionalBroadcasts,
      manualDevices: normalizedManualDevices,
      excludeMacAddresses: parsedConfig.excludeMacAddresses ?? defaultConfig.discoveryOptions.excludeMacAddresses,
      includeMacAddresses: parsedConfig.includeMacAddresses ?? defaultConfig.discoveryOptions.includeMacAddresses,
    },
    advancedOptions: {
      waitTimeUpdate: parsedConfig.waitTimeUpdate ?? defaultConfig.advancedOptions.waitTimeUpdate,
      pythonPath: parsedConfig.pythonPath ?? defaultConfig.advancedOptions.pythonPath,
      advancedPythonLogging: parsedConfig.advancedPythonLogging ?? defaultConfig.advancedOptions.advancedPythonLogging,
    },
  };
}