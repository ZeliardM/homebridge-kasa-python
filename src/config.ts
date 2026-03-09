import type { PlatformConfig } from 'homebridge';

import fs from 'node:fs/promises';
import path from 'node:path';

import { PLATFORM_NAME } from './settings.js';
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

const MISSING_ALIAS_PLACEHOLDER = 'Will Be Filled By Plug-In Automatically';

type LegacyConfigDevice = ConfigDevice & { breakoutChildDevices?: boolean };
type HomebridgeConfigFile = { platforms?: PlatformConfig[] } & Record<string, unknown>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function migrateManualDevices(
  manualDevices: (string | ConfigDevice)[] | undefined | null,
): { manualDevices: ConfigDevice[]; changed: boolean } {
  if (!manualDevices || manualDevices.length === 0) {
    return { manualDevices: [], changed: false };
  }

  let changed = false;
  const migratedDevices = manualDevices.map(device => {
    if (typeof device === 'string') {
      changed = true;
      return { host: device, alias: MISSING_ALIAS_PLACEHOLDER };
    }

    const migratedDevice = device as LegacyConfigDevice;
    const alias = isNonEmptyString(migratedDevice.alias) ? migratedDevice.alias : MISSING_ALIAS_PLACEHOLDER;
    if (alias !== migratedDevice.alias || 'breakoutChildDevices' in migratedDevice) {
      changed = true;
    }

    return {
      host: migratedDevice.host,
      alias,
    };
  });

  return { manualDevices: migratedDevices, changed };
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
      } else {
        errors.push(`\`manualDevices[${index}]\` should be an object with \`host\` and \`alias\`.`);
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

    if (!isNonEmptyString(device.alias)) {
      errors.push(`\`manualDevices[${index}].alias\` should be a non-empty string.`);
    }

    if ('breakoutChildDevices' in device) {
      errors.push(`\`manualDevices[${index}]\` uses unsupported legacy field \`breakoutChildDevices\`.`);
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
  const strictManualDevices = (parsedConfig.manualDevices as ConfigDevice[] | undefined)
    ?? defaultConfig.discoveryOptions.manualDevices;

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
      manualDevices: strictManualDevices,
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

function getConfigPath(storagePath: string): string {
  return path.join(storagePath, 'config.json');
}

async function readHomebridgeConfig(storagePath: string): Promise<HomebridgeConfigFile> {
  const data = await fs.readFile(getConfigPath(storagePath), 'utf8');
  return JSON.parse(data) as HomebridgeConfigFile;
}

async function writeHomebridgeConfig(storagePath: string, fileConfig: HomebridgeConfigFile): Promise<void> {
  await fs.writeFile(getConfigPath(storagePath), JSON.stringify(fileConfig, null, 2), 'utf8');
}

function getPlatformSection(fileConfig: HomebridgeConfigFile, platformName: string): PlatformConfig | undefined {
  return fileConfig.platforms?.find(platformConfig => platformConfig.platform === platformName);
}

export async function loadPlatformConfigFromStorage(storagePath: string): Promise<KasaPythonConfig> {
  const fileConfig = await readHomebridgeConfig(storagePath);
  const platformSection = getPlatformSection(fileConfig, PLATFORM_NAME);
  if (!platformSection) {
    throw new ConfigParseError('KasaPython configuration missing in config file.');
  }

  const { manualDevices, changed } = migrateManualDevices(platformSection.manualDevices as (string | ConfigDevice)[] | undefined);
  if (platformSection.manualDevices !== undefined) {
    platformSection.manualDevices = manualDevices;
  }

  const parsedConfig = parseConfig(platformSection);
  if (changed) {
    await writeHomebridgeConfig(storagePath, fileConfig);
  }

  return parsedConfig;
}

export async function persistDiscoveredAliases(
  storagePath: string,
  aliasesByHost: Map<string, string>,
): Promise<KasaPythonConfig | undefined> {
  if (aliasesByHost.size === 0) {
    return undefined;
  }

  const fileConfig = await readHomebridgeConfig(storagePath);
  const platformSection = getPlatformSection(fileConfig, PLATFORM_NAME);
  if (!platformSection) {
    throw new ConfigParseError('KasaPython configuration missing in config file.');
  }

  const manualDevices = platformSection.manualDevices;
  if (!Array.isArray(manualDevices) || manualDevices.length === 0) {
    return undefined;
  }

  let changed = false;
  for (const entry of manualDevices) {
    if (!isObjectLike(entry)) {
      continue;
    }

    const device = entry as Record<string, unknown>;
    const host = typeof device.host === 'string' ? device.host : undefined;
    const nextAlias = host ? aliasesByHost.get(host) : undefined;
    if (!nextAlias || device.alias === nextAlias) {
      continue;
    }

    device.alias = nextAlias;
    changed = true;
  }

  if (!changed) {
    return undefined;
  }

  await writeHomebridgeConfig(storagePath, fileConfig);
  return parseConfig(platformSection);
}