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
  disableBroadcast?: boolean;
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
    disableBroadcast: boolean;
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
    disableBroadcast: false,
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

// A blank row in the Manual Devices list (no host, or an empty one) is skipped with a warning.
function normalizeManualDevices(
  manualDevices: (string | ConfigDevice)[] | undefined | null,
  warn: (message: string) => void,
): ConfigDevice[] {
  if (!manualDevices || manualDevices.length === 0) {
    return [];
  }

  return manualDevices.flatMap((device, index) => {
    const host = typeof device === 'string' ? device : (device as LegacyConfigDevice).host;
    if (!isNonEmptyString(host)) {
      warn(`\`manualDevices[${index}]\` has no host; skipping it.`);
      return [];
    }

    return [{ host }];
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
      return;
    }

    if (!isObjectLike(entry)) {
      errors.push(`\`manualDevices[${index}]\` should be an object.`);
      return;
    }

    // A missing or empty host is a blank row, which normalizeManualDevices skips.
    const host = (entry as Record<string, unknown>).host;
    if (host !== undefined && host !== null && typeof host !== 'string') {
      errors.push(`\`manualDevices[${index}].host\` should be a string.`);
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
  validateType(config, 'disableBroadcast', 'boolean', errors);

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

// Node fires a timer given more than 2^31-1 ms (about 24.8 days) after 1 ms instead, so the intervals that
// drive timers stay below that.
const MAX_TIMER_SECONDS = 2147483;
// Longer than one discovery run, which waits up to 30 s for the service to report every device it found.
const MIN_DISCOVERY_POLLING_INTERVAL_SECONDS = 60;
const MAX_WAIT_TIME_UPDATE_MS = 60000;
const MIN_POWER_THRESHOLD_WATTS = 0.001;

// Wrong types are errors. Numbers out of range are clamped with a warning instead, so a hand-edited value does not
// stop the plugin.
export function parseConfig(
  config: Record<string, unknown>,
  warn: (message: string) => void = () => undefined,
): KasaPythonConfig {
  if (!isObjectLike(config)) {
    throw new ConfigParseError('Error parsing config');
  }

  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ConfigParseError('Error parsing config', errors);
  }

  const parsedConfig = config as KasaPythonConfigInput;
  const normalizedManualDevices = normalizeManualDevices(parsedConfig.manualDevices, warn);

  const clamp = (key: keyof KasaPythonConfigInput, value: number, fallback: number, min: number, max = Infinity): number => {
    if (!Number.isFinite(value)) {
      warn(`\`${key}\` is ${value}; using ${fallback}.`);
      return fallback;
    }
    const clamped = Math.min(Math.max(value, min), max);
    if (clamped !== value) {
      const limit = value < min ? `below the minimum of ${min}` : `above the maximum of ${max}`;
      warn(`\`${key}\` is ${value}, ${limit}; using ${clamped}.`);
    }
    return clamped;
  };
  const number = (key: keyof KasaPythonConfigInput, fallback: number, min: number, max?: number): number =>
    clamp(key, (parsedConfig[key] as number | undefined) ?? fallback, fallback, min, max);

  const pollingInterval = number('pollingInterval', defaultConfig.discoveryOptions.pollingInterval, 1, MAX_TIMER_SECONDS);
  const discoveryPollingInterval = number(
    'discoveryPollingInterval',
    defaultConfig.discoveryOptions.discoveryPollingInterval,
    MIN_DISCOVERY_POLLING_INTERVAL_SECONDS,
    MAX_TIMER_SECONDS,
  );
  const offlineInterval = number('offlineInterval', defaultConfig.discoveryOptions.offlineInterval, 1);
  const waitTimeUpdate = number('waitTimeUpdate', defaultConfig.advancedOptions.waitTimeUpdate, 0, MAX_WAIT_TIME_UPDATE_MS);
  let powerThreshold = number('powerThreshold', defaultConfig.energyOptions.powerThreshold, MIN_POWER_THRESHOLD_WATTS);
  const roundedPowerThreshold = Math.round(powerThreshold * 1000) / 1000;
  if (roundedPowerThreshold !== powerThreshold) {
    warn(`\`powerThreshold\` is ${powerThreshold}, which has more than three decimal places; using ${roundedPowerThreshold}.`);
    powerThreshold = roundedPowerThreshold;
  }

  return {
    name: parsedConfig.name ?? defaultConfig.name,
    enableCredentials: parsedConfig.enableCredentials ?? defaultConfig.enableCredentials,
    username: parsedConfig.username ?? defaultConfig.username,
    password: parsedConfig.password ?? defaultConfig.password,
    energyOptions: {
      enableEnergyMonitoring: parsedConfig.enableEnergyMonitoring ?? defaultConfig.energyOptions.enableEnergyMonitoring,
      powerThreshold,
      logEnergyMonitoring: parsedConfig.logEnergyMonitoring ?? defaultConfig.energyOptions.logEnergyMonitoring,
    },
    homekitOptions: {
      hideHomeKitMatter: parsedConfig.hideHomeKitMatter ?? defaultConfig.homekitOptions.hideHomeKitMatter,
    },
    discoveryOptions: {
      pollingInterval: pollingInterval * 1000,
      discoveryPollingInterval: discoveryPollingInterval * 1000,
      offlineInterval: offlineInterval * 24 * 60 * 60 * 1000,
      disableBroadcast: parsedConfig.disableBroadcast ?? defaultConfig.discoveryOptions.disableBroadcast,
      additionalBroadcasts: parsedConfig.additionalBroadcasts ?? defaultConfig.discoveryOptions.additionalBroadcasts,
      manualDevices: normalizedManualDevices,
      excludeMacAddresses: parsedConfig.excludeMacAddresses ?? defaultConfig.discoveryOptions.excludeMacAddresses,
      includeMacAddresses: parsedConfig.includeMacAddresses ?? defaultConfig.discoveryOptions.includeMacAddresses,
    },
    advancedOptions: {
      waitTimeUpdate,
      pythonPath: parsedConfig.pythonPath ?? defaultConfig.advancedOptions.pythonPath,
      advancedPythonLogging: parsedConfig.advancedPythonLogging ?? defaultConfig.advancedOptions.advancedPythonLogging,
    },
  };
}