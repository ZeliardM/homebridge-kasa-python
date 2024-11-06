import { Categories } from 'homebridge';
import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  WithUUID,
} from 'homebridge';
import { Logger } from 'homebridge/dist/logger.js';

import getPort from 'get-port';
import path from 'node:path';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { Range, satisfies } from 'semver';
import { fileURLToPath } from 'node:url';

import create from './devices/create.js';
import DeviceManager from './devices/deviceManager.js';
import HomekitDevice from './devices/index.js';
import PythonChecker from './python/pythonChecker.js';
import { EnumParser } from './categoriesParse.js';
import { parseConfig } from './config.js';
import { runCommand } from './utils.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { isObjectLike, lookup, lookupCharacteristicNameByUUID, prefixLogger } from './utils.js';
import type { KasaPythonConfig } from './config.js';
import type { KasaDevice } from './devices/kasaDevices.js';

export type KasaPythonAccessoryContext = {
  deviceId?: string;
};

let packageConfig: { name: string; version: string; engines: { node: string | Range } };

async function loadPackageConfig(logger: Logging): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageConfigPath = path.join(__dirname, '..', 'package.json');
  const log: Logger = prefixLogger(logger, '[Package Config]');
  try {
    const packageConfigData = await fs.readFile(packageConfigPath, 'utf8');
    packageConfig = JSON.parse(packageConfigData);
  } catch (error) {
    log.error(`Error reading package.json: ${error}`);
    throw error;
  }
}

async function checkForUpgrade(storagePath: string, logger: Logging): Promise<boolean> {
  const versionFilePath = path.join(storagePath, 'kasa-python-version.json');
  let storedVersion = '';

  try {
    if (await fs.stat(versionFilePath)) {
      const versionData = await fs.readFile(versionFilePath, 'utf8');
      storedVersion = JSON.parse(versionData).version;
    }
  } catch (error) {
    logger.error('Error reading version file:', error);
  }

  if (storedVersion !== packageConfig.version) {
    try {
      await fs.writeFile(versionFilePath, JSON.stringify({ version: packageConfig.version }), 'utf8');
    } catch (error) {
      logger.error('Error writing version file:', error);
    }
    return true;
  }

  return false;
}

export default class KasaPythonPlatform implements DynamicPlatformPlugin {
  public readonly Characteristic: typeof Characteristic;
  public readonly configuredAccessories: Map<string, PlatformAccessory<KasaPythonAccessoryContext>> = new Map();
  public readonly Service: typeof Service;
  public readonly storagePath: string;
  public readonly venvPythonExecutable: string;
  public config: KasaPythonConfig;
  public deviceManager: DeviceManager | undefined;
  public port: number = 0;
  private readonly categories: Record<number, string>;
  private readonly homekitDevicesById: Map<string, HomekitDevice> = new Map();
  private kasaProcess: ChildProcessWithoutNullStreams | undefined | null = null;
  private platformInitialization: Promise<void>;
  private isUpgrade: boolean = false;

  constructor(public readonly log: Logging, config: PlatformConfig, public readonly api: API) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.storagePath = this.api.user.storagePath();
    this.venvPythonExecutable = path.join(this.storagePath, 'kasa-python', '.venv', 'bin', 'python3');
    this.config = parseConfig(config);
    this.categories = this.initializeCategories();
    this.platformInitialization = this.initializePlatform().catch((error) => {
      this.log.error('Platform initialization failed:', error);
    });

    this.api.on('didFinishLaunching', async () => {
      await this.platformInitialization;
      await this.didFinishLaunching();
    });

    this.api.on('shutdown', () => {
      this.stopKasaApi();
    });
  }

  private createHomekitDevice(kasaDevice: KasaDevice): HomekitDevice | undefined {
    return create(this, kasaDevice);
  }

  private initializeCategories(): Record<number, string> {
    return new EnumParser(this).parse() as Record<number, string>;
  }

  async initializePlatform(): Promise<void> {
    await loadPackageConfig(this.log);
    this.logInitializationDetails();
    await this.verifyEnvironment();
    this.isUpgrade = await checkForUpgrade(this.storagePath, this.log);
    if (this.isUpgrade) {
      this.log.info('Plugin upgraded, virtual environment will be recreated.');
    }
  }

  private logInitializationDetails(): void {
    this.log.info(
      `${packageConfig.name} v${packageConfig.version}, node ${process.version}, ` +
      `homebridge v${this.api.serverVersion}, api v${this.api.version} Initializing...`,
    );
  }

  private async verifyEnvironment(): Promise<void> {
    if (!satisfies(process.version, packageConfig.engines.node)) {
      this.log.error(`Error: not using minimum node version ${packageConfig.engines.node}`);
    }
    if (this.api.versionGreaterOrEqual && !this.api.versionGreaterOrEqual('1.8.4')) {
      throw new Error(`homebridge-kasa-python requires homebridge >= 1.8.4. Currently running: ${this.api.serverVersion}`);
    }
  }

  private async didFinishLaunching(): Promise<void> {
    this.log.debug('Did Finish Launching Event Received');
    try {
      await this.checkPython(this.isUpgrade);
      this.port = await getPort();
      this.deviceManager = new DeviceManager(this);
      await this.startKasaApi();
      await this.deviceManager.discoverDevices();
    } catch (error) {
      this.log.error('An error occurred during startup:', error);
    }
  }

  private async checkPython(isUpgrade: boolean): Promise<void> {
    try {
      await new PythonChecker(this).allInOne(isUpgrade);
    } catch (error) {
      this.log.error('Error checking python environment:', error);
    }
  }

  private async startKasaApi(): Promise<void> {
    const scriptPath = `${this.storagePath}/node_modules/homebridge-kasa-python/dist/python/kasaApi.py`;
    try {
      const [, stderr, , process] = await runCommand(
        this.log,
        this.venvPythonExecutable,
        [scriptPath, this.port.toString()],
        undefined,
        false,
        false,
        true,
      );
      this.kasaProcess = process;
      if (stderr) {
        this.log.debug(`kasaApi.py process started: ${stderr}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        this.log.error(`Error starting kasaApi.py process: ${error.message}`);
      } else {
        this.log.error('An unknown error occurred during startup');
      }
    }
  }

  private stopKasaApi(): void {
    if (this.kasaProcess) {
      this.kasaProcess.kill();
      this.kasaProcess = null;
      this.log.debug('kasaApi.py process terminated');
    }
  }

  public lsc(
    serviceOrCharacteristic: Service | Characteristic | { UUID: string },
    characteristic?: Characteristic | { UUID: string },
  ): string {
    const serviceName = serviceOrCharacteristic instanceof this.api.hap.Service
      ? this.getServiceName(serviceOrCharacteristic)
      : undefined;
    const characteristicName = characteristic instanceof this.api.hap.Characteristic
      ? this.getCharacteristicName(characteristic)
      : serviceOrCharacteristic instanceof this.api.hap.Characteristic || 'UUID' in serviceOrCharacteristic
        ? this.getCharacteristicName(serviceOrCharacteristic)
        : undefined;

    return `[${serviceName ? serviceName : ''}` +
      `${serviceName && characteristicName ? '.' : ''}` +
      `${characteristicName ? characteristicName : ''}]`;
  }

  getServiceName(service: { UUID: string }): string | undefined {
    return lookup(this.api.hap.Service, (thisKeyValue, value) =>
      isObjectLike(thisKeyValue) && 'UUID' in thisKeyValue && thisKeyValue.UUID === value, service.UUID);
  }

  getCharacteristicName(characteristic: WithUUID<{ name?: string | null; displayName?: string | null }>): string | undefined {
    return characteristic.name ??
      characteristic.displayName ??
      lookupCharacteristicNameByUUID(this.api.hap.Characteristic, characteristic.UUID);
  }

  getCategoryName(category: Categories): string {
    return this.categories ? this.categories[category] : 'Unknown';
  }

  registerPlatformAccessory(platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.log.debug(`registerPlatformAccessory([${platformAccessory.displayName}])`);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
  }

  configureAccessory(accessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.log.info(
      `Configuring cached accessory: [${accessory.displayName}] UUID: ${accessory.UUID} deviceId: ${
        accessory.context.deviceId
      }`,
    );
    this.configuredAccessories.set(accessory.UUID, accessory);
  }

  foundDevice(device: KasaDevice): void {
    const { sys_info: { deviceId }, alias: deviceAlias, host: deviceHost, sys_info: { mic_type: deviceType } } = device;
    if (!deviceId) {
      this.log.error('Missing deviceId:', deviceHost);
      return;
    }
    if (this.homekitDevicesById.has(deviceId)) {
      this.log.info(`Device already added: [${deviceAlias}] ${deviceType} [${deviceId}]`);
      return;
    }
    this.log.info(`Adding: [${deviceAlias}] ${deviceType} [${deviceId}]`);
    this.homekitDevicesById.set(deviceId, this.createHomekitDevice(device) as HomekitDevice);
  }
}