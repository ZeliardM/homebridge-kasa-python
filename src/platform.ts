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

import axios from 'axios';
import net from 'node:net';
import path from 'node:path';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import create from './devices/create.js';
import DeviceManager from './devices/deviceManager.js';
import HomeKitDevice from './devices/index.js';
import PythonChecker from './python/pythonChecker.js';
import { parseConfig } from './config.js';
import { TaskQueue } from './taskQueue.js';
import { deferAndCombine, runCommand } from './utils.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { isObjectLike, lookup, lookupCharacteristicNameByUUID, prefixLogger } from './utils.js';
import type { KasaPythonConfig } from './config.js';
import type { KasaDevice } from './devices/kasaDevices.js';

export type KasaPythonAccessoryContext = {
  deviceId?: string;
  lastSeen?: Date;
  offline?: boolean;
};

let packageConfig: { name: string; version: string; engines: { node: string } };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadPackageConfig(logger: Logging): Promise<void> {
  const packageConfigPath = path.join(__dirname, '..', 'package.json');
  const log: Logger = prefixLogger(logger, '[Package Config]');
  log.debug('Loading package configuration from:', packageConfigPath);

  try {
    const packageConfigData = await fs.readFile(packageConfigPath, 'utf8');
    packageConfig = JSON.parse(packageConfigData);
  } catch (error) {
    log.error(`Error reading package.json: ${error}`);
    throw error;
  }
}

function satisfiesVersion(currentVersion: string, requiredVersion: string): boolean {
  const versions = requiredVersion.split('||').map(v => v.trim());

  return versions.some(version => {
    const [requiredMajor, requiredMinor, requiredPatch] = version.replace('^', '').split('.').map(Number);
    const [currentMajor, currentMinor, currentPatch] = currentVersion.replace('v', '').split('.').map(Number);

    if (currentMajor > requiredMajor) {
      return true;
    }
    if (currentMajor < requiredMajor) {
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

async function checkForUpgrade(storagePath: string, logger: Logging): Promise<boolean> {
  const versionDir = path.join(storagePath, 'kasa-python');
  const versionFilePath = path.join(versionDir, 'kasa-python-version.json');
  let storedVersion = '';

  logger.debug('Checking for upgrade at path:', versionFilePath);

  try {
    await fs.access(versionFilePath);
    const versionData = await fs.readFile(versionFilePath, 'utf8');
    storedVersion = JSON.parse(versionData).version;
    logger.debug('Stored version:', storedVersion);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info('Version file does not exist, treating as new install or version change.');
    } else {
      logger.error('Error reading version file:', error);
    }
  }

  if (storedVersion !== packageConfig.version) {
    try {
      logger.debug('Updating version file to new version:', packageConfig.version);
      await fs.mkdir(versionDir, { recursive: true });
      await fs.writeFile(versionFilePath, JSON.stringify({ version: packageConfig.version }), 'utf8');
      logger.info(`Version file updated to version ${packageConfig.version}`);
    } catch (error) {
      logger.error('Error writing version file:', error);
    }
    return true;
  }

  logger.debug('No upgrade needed, version is up to date.');
  return false;
}

async function waitForServer(url: string, log: Logging, timeout: number = 30000, interval: number = 1000): Promise<void> {
  const startTime = Date.now();
  log.debug(`Waiting for server at ${url} with timeout ${timeout}ms and interval ${interval}ms`);

  while (Date.now() - startTime < timeout) {
    try {
      const response = await axios.get(url);
      if (response.status === 200) {
        log.debug('Server responded successfully');
        return;
      }
    } catch {
      log.debug('Server not responding yet, retrying...');
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  log.error(`Server did not respond within ${timeout / 1000} seconds`);
  throw new Error(`Server did not respond within ${timeout / 1000} seconds`);
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export default class KasaPythonPlatform implements DynamicPlatformPlugin {
  public readonly Characteristic: typeof Characteristic;
  public readonly configuredAccessories: Map<string, PlatformAccessory<KasaPythonAccessoryContext>> = new Map();
  public readonly offlineAccessories: Map<string, PlatformAccessory<KasaPythonAccessoryContext>> = new Map();
  public readonly Service: typeof Service;
  public readonly storagePath: string;
  public readonly venvPythonExecutable: string;
  public config: KasaPythonConfig;
  public deviceManager: DeviceManager | undefined;
  public isShuttingDown: boolean = false;
  public periodicDeviceDiscovering: boolean = false;
  public periodicDeviceDiscoveryEmitter: EventEmitter;
  public port: number = 0;
  public taskQueue: TaskQueue;
  private readonly homekitDevicesById: Map<string, HomeKitDevice> = new Map();
  private hideHomeKitMatter: boolean = true;
  private isUpgrade: boolean = false;
  private kasaProcess: ChildProcessWithoutNullStreams | undefined | null = null;
  private platformInitialization: Promise<void>;

  constructor(public readonly log: Logging, config: PlatformConfig, public readonly api: API) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.storagePath = this.api.user.storagePath();
    this.venvPythonExecutable = path.join(this.storagePath, 'kasa-python', '.venv', 'bin', 'python3');
    this.config = parseConfig(config);
    this.periodicDeviceDiscoveryEmitter = new EventEmitter();
    this.taskQueue = new TaskQueue(this.log);

    this.platformInitialization = this.initializePlatform().catch((error) => {
      this.log.error('Platform initialization failed:', error);
    });

    this.api.on('didFinishLaunching', async () => {
      this.log.debug('KasaPython Platform finished launching');
      await this.platformInitialization;
      await this.didFinishLaunching();
      if (this.offlineAccessories.size > 0) {
        this.log.debug('Unregistering offline accessories');
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, Array.from(this.offlineAccessories.values()));
        this.offlineAccessories.clear();
      }
    });

    this.api.on('shutdown', async () => {
      this.log.debug('KasaPython shutting down');
      if (!this.isShuttingDown) {
        this.isShuttingDown = true;
      }
      this.log.debug('Waiting for tasks to complete');
      await this.taskQueue.waitForEmptyQueue();
      this.stopKasaApi();
    });
  }

  private createHomeKitDevice(kasaDevice: KasaDevice): HomeKitDevice | undefined {
    this.log.debug('Creating HomeKit device for:', kasaDevice.sys_info);
    return create(this, kasaDevice);
  }

  async initializePlatform(): Promise<void> {
    try {
      await loadPackageConfig(this.log);
      this.logInitializationDetails();
      await this.verifyEnvironment();
      this.isUpgrade = await checkForUpgrade(this.storagePath, this.log);
      if (this.isUpgrade) {
        this.log.info('Plugin version changed, virtual python environment will be recreated.');
      }
    } catch (error) {
      this.log.error('Error during platform initialization:', error);
    }
  }

  private logInitializationDetails(): void {
    this.log.info(
      `${packageConfig.name} v${packageConfig.version}, node ${process.version}, ` +
      `homebridge v${this.api.serverVersion}, api v${this.api.version} Initializing...`,
    );
  }

  private async verifyEnvironment(): Promise<void> {
    this.log.debug('Verifying environment');

    try {
      this.log.debug('Checking Node.js version');
      if (!satisfiesVersion(process.version, packageConfig.engines.node)) {
        this.log.error(`Error: not using minimum node version ${packageConfig.engines.node}`);
      } else {
        this.log.debug(`Node.js version ${process.version} satisfies the requirement ${packageConfig.engines.node}`);
      }

      this.log.debug('Checking Homebridge version');
      if (this.api.versionGreaterOrEqual && !this.api.versionGreaterOrEqual('1.8.4')) {
        throw new Error(`homebridge-kasa-python requires homebridge >= 1.8.4. Currently running: ${this.api.serverVersion}`);
      } else {
        this.log.debug(`Homebridge version ${this.api.serverVersion} satisfies the requirement >= 1.8.4`);
      }
    } catch (error) {
      this.log.error('Error verifying environment:', error);
      throw error;
    }
  }

  private async didFinishLaunching(): Promise<void> {
    this.log.debug('Finished launching');

    try {
      this.log.debug('Checking Python environment');
      await this.checkPython(this.isUpgrade);

      this.log.debug('Getting available port');
      this.port = await getAvailablePort();
      this.log.debug(`Port assigned: ${this.port}`);

      this.log.debug('Initializing DeviceManager');
      this.deviceManager = new DeviceManager(this);
      this.log.debug('DeviceManager initialized');

      await this.startKasaApi();

      await waitForServer(`http://127.0.0.1:${this.port}/health`, this.log);

      await this.discoverDevices();
      this.log.debug('Device discovery completed');

      this.log.debug('Setting up periodic device discovery');
      setInterval(async () => {
        await this.periodicDeviceDiscovery();
      }, this.config.discoveryOptions.discoveryPollingInterval);
      this.log.debug('Periodic device discovery setup completed');
    } catch (error) {
      this.log.error('An error occurred during startup:', error);
    }
  }

  private async periodicDeviceDiscovery(): Promise<void> {
    this.log.debug('Starting periodic device discovery');
    if (this.periodicDeviceDiscovering) {
      this.log.debug('Periodic device discovery already in progress');
      return;
    }

    this.periodicDeviceDiscovering = true;
    const task = async () => {
      try {
        const discoveredDevices = await this.deviceManager?.discoverDevices() || {};
        const now = new Date();
        const offlineInterval = this.config.discoveryOptions.offlineInterval;

        this.log.info(`Discovered ${Object.keys(discoveredDevices).length} devices`);

        this.configuredAccessories.forEach((platformAccessory, uuid) => {
          const deviceId = platformAccessory.context.deviceId;
          if (deviceId) {
            const device = this.findDiscoveredDevice(discoveredDevices, platformAccessory);
            if (device) {
              this.updateAccessoryDeviceStatus(platformAccessory, device, now);
              this.updateOrCreateHomeKitDevice(deviceId, device);
            } else {
              this.updateAccessoryStatus(platformAccessory);
              this.handleOfflineAccessory(platformAccessory, uuid, now, offlineInterval);
            }
          }
        });

        Object.values(discoveredDevices).forEach(device => {
          device.last_seen = now;
          device.offline = false;
          const deviceId = device.sys_info.device_id;
          const isConfigured = Array.from(this.configuredAccessories.values()).some(
            platformAccessory => platformAccessory.context.deviceId === deviceId,
          );
          if (!isConfigured) {
            this.log.debug(`New device [${deviceId}] found, adding to HomeKit`);
            let listenerCount = this.periodicDeviceDiscoveryEmitter.listenerCount('periodicDeviceDiscoveryComplete');
            this.log.debug('periodicDeviceDiscoveryEmitter periodicDeviceDiscoveryComplete listener count:', listenerCount);
            this.log.debug('periodicDeviceDiscoveryEmitter max listener count:', this.periodicDeviceDiscoveryEmitter.getMaxListeners());
            this.foundDevice(device);
            this.periodicDeviceDiscoveryEmitter.setMaxListeners(this.periodicDeviceDiscoveryEmitter.getMaxListeners() + 1);
            listenerCount = this.periodicDeviceDiscoveryEmitter.listenerCount('periodicDeviceDiscoveryComplete');
            this.log.debug('periodicDeviceDiscoveryEmitter periodicDeviceDiscoveryComplete listener count:', listenerCount);
            this.log.debug('periodicDeviceDiscoveryEmitter max listener count:', this.periodicDeviceDiscoveryEmitter.getMaxListeners());
          }
        });
      } catch (error) {
        this.log.error('Error during periodic device discovery:', error);
      } finally {
        this.periodicDeviceDiscovering = false;
        this.periodicDeviceDiscoveryEmitter.emit('periodicDeviceDiscoveryComplete');
        this.log.debug('Finished periodic device discovery');
      }
    };
    const deferAndCombinedTask = deferAndCombine(task, this.config.advancedOptions.waitTimeUpdate);

    this.taskQueue.addTask(deferAndCombinedTask);
    await deferAndCombinedTask();
  }

  private findDiscoveredDevice(
    discoveredDevices: Record<string, KasaDevice>,
    platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>,
  ): KasaDevice | undefined {
    this.log.debug(`Finding discovered device with Platform Accessory ${platformAccessory.displayName}`);

    try {
      const device = Object.values(discoveredDevices).find(device => device.sys_info.device_id === platformAccessory.context.deviceId);

      if (device) {
        this.log.debug(`Discovered device ${device.sys_info.alias}`);
      } else {
        this.log.debug(`No discovered device found with Platform Accessory ${platformAccessory.displayName}`);
      }

      return device;
    } catch (error) {
      this.log.error(`Error finding discovered device with Platform Accessory ${platformAccessory.displayName}: ${error}`);
      return undefined;
    }
  }

  private updateAccessoryDeviceStatus(
    platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>,
    device: KasaDevice,
    now: Date,
  ): void {
    this.log.debug(`Updating Platform Accessory and HomeKit device statuses for ${platformAccessory.displayName}`);

    try {
      this.log.debug(`Setting HomeKit device ${device.sys_info.alias} last seen time to now and marking as online`);
      device.last_seen = now;
      device.offline = false;

      this.log.debug(`Setting Platform Accessory ${platformAccessory.displayName} last seen time to now and marking as online`);
      platformAccessory.context.lastSeen = now;
      platformAccessory.context.offline = false;

      this.log.debug(`Updating Platform Accessory ${platformAccessory.displayName}`);
      this.api.updatePlatformAccessories([platformAccessory]);

      this.log.debug(`Platform Accessory and HomeKit device statuses for ${platformAccessory.displayName} updated successfully`);
    } catch (error) {
      this.log.error(`Error updating Platform Accessory and HomeKit device statuses for ${platformAccessory.displayName}: ${error}`);
    }
  }

  private updateOrCreateHomeKitDevice(deviceId: string, device: KasaDevice): void {
    this.log.debug(`Updating or creating HomeKit device ${device.sys_info.alias}`);

    try {
      if (this.homekitDevicesById.has(deviceId)) {
        this.log.debug(`HomeKit device ${device.sys_info.alias} already exists.`);
        const existingDevice = this.homekitDevicesById.get(deviceId);
        if (existingDevice) {
          if (!existingDevice.isUpdating) {
            if (existingDevice.kasaDevice.offline === true && device.offline === false) {
              this.log.debug(`HomeKit device ${device.sys_info.alias} was offline and is now online. ` +
                'Updating device and starting polling.');
              existingDevice.kasaDevice = device;
              existingDevice.startPolling();
            } else {
              this.log.debug(`Updating existing HomeKit device ${device.sys_info.alias}`);
              existingDevice.kasaDevice = device;
            }
          } else {
            this.log.debug(`HomeKit device ${device.sys_info.alias} is currently updating. Skipping update.`);
          }
        } else {
          this.log.error(`Failed to retrieve existing HomeKit device ${device.sys_info.alias} from homekitDevicesById.`);
        }
      } else {
        this.log.debug(`HomeKit device ${device.sys_info.alias} does not exist.`);
        this.foundDevice(device);
      }
    } catch (error) {
      this.log.error(`Error updating or creating HomeKit device ${device.sys_info.alias}: ${error}`);
    }
  }

  private updateAccessoryStatus(platformAccessory: PlatformAccessory): void {
    try {
      this.log.debug(`Setting Platform Accessory ${platformAccessory.displayName} offline status to true`);
      platformAccessory.context.offline = true;

      this.api.updatePlatformAccessories([platformAccessory]);

      this.log.debug(`Platform Accessory ${platformAccessory.displayName} status updated successfully`);
    } catch (error) {
      this.log.error(`Error updating Platform Accessory ${platformAccessory.displayName} status: ${error}`);
    }
  }

  private handleOfflineAccessory(platformAccessory: PlatformAccessory, uuid: string, now: Date, offlineInterval: number): void {
    this.log.debug(`Handling offline Platform Accessory ${platformAccessory.displayName}`);

    try {
      const homekitDevice = this.homekitDevicesById.get(platformAccessory.context.deviceId);
      if (homekitDevice) {
        const timeSinceLastSeen = now.getTime() - new Date(homekitDevice.kasaDevice.last_seen).getTime();
        this.log.debug(
          `Time since last seen for Platform Accessory ${platformAccessory.displayName}: ${timeSinceLastSeen}ms, ` +
          `offline interval: ${offlineInterval}ms`,
        );

        if (timeSinceLastSeen < offlineInterval) {
          this.log.debug(`Platform Accessory ${platformAccessory.displayName} is offline and within offline interval.`);
          homekitDevice.kasaDevice.offline = true;
        } else if (timeSinceLastSeen > offlineInterval) {
          this.log.info(`Platform Accessory ${platformAccessory.displayName} is offline and outside the offline interval, removing.`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
          this.configuredAccessories.delete(uuid);
          this.log.debug(`Platform Accessory [${platformAccessory.displayName}] removed successfully.`);
        }
      } else if (platformAccessory.context.offline === true) {
        const timeSinceLastSeen = now.getTime() - new Date(platformAccessory.context.lastSeen).getTime();
        this.log.debug(
          `Time since last seen for Platform Accessory ${platformAccessory.displayName}: ${timeSinceLastSeen}ms, ` +
          `offline interval: ${offlineInterval}ms`,
        );

        if (timeSinceLastSeen < offlineInterval) {
          this.log.debug(`Platform Accessory [${platformAccessory.displayName}] is offline and within offline interval.`);
          this.updateAccessoryStatus(platformAccessory);
        } else if (timeSinceLastSeen > offlineInterval) {
          this.log.info(`Platform Accessory ${platformAccessory.displayName} is offline and outside the offline interval, removing.`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
          this.configuredAccessories.delete(uuid);
          this.log.debug(`Platform Accessory [${platformAccessory.displayName}] removed successfully.`);
        }
      }
    } catch (error) {
      this.log.error(`Error handling offline Platform Accessory ${platformAccessory.displayName}: ${error}`);
    }
  }

  private async checkPython(isUpgrade: boolean): Promise<void> {
    try {
      this.log.debug(`Running PythonChecker with isUpgrade: ${isUpgrade}`);
      await new PythonChecker(this).allInOne(isUpgrade);
    } catch (error) {
      this.log.error('Error checking python environment:', error);
      throw error;
    }
  }

  private async startKasaApi(): Promise<void> {
    const scriptPath = path.join(__dirname, 'python', 'startKasaApi.py');
    this.hideHomeKitMatter = this.config.homekitOptions.hideHomeKitMatter;
    this.log.debug('Starting Kasa API with script:', scriptPath);

    try {
      const [, , , process] = await runCommand(
        this.log,
        this.venvPythonExecutable,
        [scriptPath, this.port.toString(), this.hideHomeKitMatter.toString()],
        undefined,
        this.config.advancedOptions.advancedPythonLogging ? false: true,
        this.config.advancedOptions.advancedPythonLogging ? false: true,
        true,
      );

      this.kasaProcess = process;
      this.log.debug('Kasa API process started successfully');
    } catch (error) {
      this.log.error(`Error starting kasaApi.py process: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private async discoverDevices() {
    try {
      const discoveredDevices = await this.deviceManager?.discoverDevices() || {};
      const deviceCount = Object.keys(discoveredDevices).length;
      this.log.debug(`Number of devices discovered: ${deviceCount}`);

      if (deviceCount > 0) {
        Object.values(discoveredDevices).forEach(device => {
          this.log.debug(`Processing discovered device: ${device.sys_info.device_id}`);
          let listenerCount = this.periodicDeviceDiscoveryEmitter.listenerCount('periodicDeviceDiscoveryComplete');
          this.log.debug('periodicDeviceDiscoveryEmitter periodicDeviceDiscoveryComplete listener count:', listenerCount);
          this.log.debug('periodicDeviceDiscoveryEmitter max listener count:', this.periodicDeviceDiscoveryEmitter.getMaxListeners());
          this.foundDevice(device);
          this.periodicDeviceDiscoveryEmitter.setMaxListeners(this.periodicDeviceDiscoveryEmitter.getMaxListeners() + 1);
          listenerCount = this.periodicDeviceDiscoveryEmitter.listenerCount('periodicDeviceDiscoveryComplete');
          this.log.debug('periodicDeviceDiscoveryEmitter periodicDeviceDiscoveryComplete listener count:', listenerCount);
          this.log.debug('periodicDeviceDiscoveryEmitter max listener count:', this.periodicDeviceDiscoveryEmitter.getMaxListeners());
        });
      } else {
        this.log.debug('No devices discovered');
      }
    } catch (error) {
      this.log.error('Error discovering devices:', error);
    }
  }

  private stopKasaApi(): void {
    this.log.debug('Stopping Kasa API');

    if (this.kasaProcess) {
      this.log.debug('Kasa API process found, attempting to kill the process');
      this.kasaProcess.kill();
      this.kasaProcess = null;
      this.log.debug('Kasa API process successfully killed');
    } else {
      this.log.debug('No Kasa API process found to stop');
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

    const result = `[${serviceName ? serviceName : ''}` +
                   `${serviceName && characteristicName ? '.' : ''}` +
                   `${characteristicName ? characteristicName : ''}]`;
    return result;
  }

  getServiceName(service: { UUID: string }): string | undefined {
    const serviceName = lookup(this.api.hap.Service, (thisKeyValue, value) =>
      isObjectLike(thisKeyValue) && 'UUID' in thisKeyValue && thisKeyValue.UUID === value, service.UUID);
    return serviceName;
  }

  getCharacteristicName(characteristic: WithUUID<{ name?: string | null; displayName?: string | null }>): string | undefined {
    const name = characteristic.name;
    const displayName = characteristic.displayName;
    const lookupName = lookupCharacteristicNameByUUID(this.api.hap.Characteristic, characteristic.UUID);
    return name ?? displayName ?? lookupName;
  }

  registerPlatformAccessory(platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.log.debug('Registering platform platformAccessory:', platformAccessory.displayName);

    if (!this.configuredAccessories.has(platformAccessory.UUID)) {
      this.log.debug(`Platform Accessory ${platformAccessory.displayName} is not in configuredAccessories, adding it.`);
      this.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    } else {
      this.log.debug(`Platform Accessory ${platformAccessory.displayName} is already in configuredAccessories.`);
    }

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
    this.log.debug(`Platform Accessory ${platformAccessory.displayName} registered with Homebridge.`);
  }

  configureAccessory(platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.log.debug(`Configuring Platform Accessory: [${platformAccessory.displayName}] UUID: ${platformAccessory.UUID}`);

    if (!platformAccessory.context.lastSeen && !platformAccessory.context.offline) {
      this.log.debug(`Setting initial lastSeen and offline status for Platform Accessory: [${platformAccessory.displayName}]`);
      platformAccessory.context.lastSeen = new Date();
      platformAccessory.context.offline = false;
    }

    if (platformAccessory.context.lastSeen) {
      const now = new Date();
      const timeSinceLastSeen = now.getTime() - new Date(platformAccessory.context.lastSeen).getTime();
      const offlineInterval = this.config.discoveryOptions.offlineInterval;

      this.log.debug(`Platform Accessory [${platformAccessory.displayName}] last seen ${timeSinceLastSeen}ms ago, ` +
        `offline interval is ${offlineInterval}ms, offline status: ${platformAccessory.context.offline}`);

      if (timeSinceLastSeen > offlineInterval && platformAccessory.context.offline === true) {
        this.log.info(`Platform Accessory [${platformAccessory.displayName}] is offline and outside the offline interval, ` +
          'moving to offlineAccessories');
        this.configuredAccessories.delete(platformAccessory.UUID);
        this.offlineAccessories.set(platformAccessory.UUID, platformAccessory);
        return;
      } else if (timeSinceLastSeen < offlineInterval && platformAccessory.context.offline === true) {
        this.log.debug(`Platform Accessory [${platformAccessory.displayName}] is offline and within offline interval.`);
      } else if (platformAccessory.context.offline === false) {
        this.log.debug(`Platform Accessory [${platformAccessory.displayName}] is online, updating lastSeen time.`);
        platformAccessory.context.lastSeen = now;
        this.api.updatePlatformAccessories([platformAccessory]);
      }
    }

    if (!this.configuredAccessories.has(platformAccessory.UUID)) {
      this.log.debug(
        `Platform Accessory [${platformAccessory.displayName}] with UUID ` +
        `[${platformAccessory.UUID}] is not in configuredAccessories, adding it.`,
      );
      this.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    } else {
      this.log.debug(
        `Platform Accessory [${platformAccessory.displayName}] with UUID [${platformAccessory.UUID}] is already in configuredAccessories.`,
      );
    }
  }

  private foundDevice(device: KasaDevice): void {
    const { sys_info: { alias: deviceAlias, device_id: deviceId, device_type: deviceType, host: deviceHost } } = device;

    if (!deviceId) {
      this.log.error('Missing deviceId:', deviceHost);
      return;
    }

    if (this.homekitDevicesById.has(deviceId)) {
      this.log.info(`HomeKit device already added: [${deviceAlias}] ${deviceType} [${deviceId}]`);
      return;
    }

    this.log.info(`Adding HomeKit device: [${deviceAlias}] ${deviceType} [${deviceId}] at host [${deviceHost}]`);
    const homekitDevice = this.createHomeKitDevice(device) as HomeKitDevice;
    if (homekitDevice) {
      this.homekitDevicesById.set(deviceId, homekitDevice);
      this.log.debug(`HomeKit device [${deviceAlias}] ${deviceType} [${deviceId}] successfully added`);
    } else {
      this.log.error(`Failed to add HomeKit device for: [${deviceAlias}] ${deviceType} [${deviceId}]`);
    }
  }
}