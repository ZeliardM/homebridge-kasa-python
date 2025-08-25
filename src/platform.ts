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

import path from 'node:path';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import create from './devices/create.js';
import DeviceManager, { deviceEventEmitter } from './devices/deviceManager.js';
import HomeKitDevice from './devices/index.js';
import PythonChecker from './python/pythonChecker.js';
import { parseConfig } from './config.js';
import { TaskQueue } from './taskQueue.js';
import { deferAndCombine, runCommand } from './utils.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  checkForUpgrade,
  getAvailablePort,
  isObjectLike,
  loadPackageConfig,
  lookup,
  lookupCharacteristicNameByUUID,
  satisfiesVersion,
  waitForServer,
} from './utils.js';
import type { KasaPythonConfig } from './config.js';
import type { KasaDevice } from './devices/kasaDevices.js';

export type KasaPythonAccessoryContext = {
  deviceId?: string;
  lastSeen?: Date;
  offline?: boolean;
};

let packageConfig: { name: string; version: string; engines: { node: string } };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default class KasaPythonPlatform implements DynamicPlatformPlugin {
  public readonly Characteristic: typeof Characteristic;
  public readonly configuredAccessories: Map<string, PlatformAccessory<KasaPythonAccessoryContext>> = new Map();
  public readonly offlineAccessories: Map<string, PlatformAccessory<KasaPythonAccessoryContext>> = new Map();
  public readonly Service: typeof Service;
  public readonly storagePath: string;
  public venvPythonExecutable: string = '';
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
    this.config = parseConfig(config);
    this.periodicDeviceDiscoveryEmitter = new EventEmitter();
    this.taskQueue = new TaskQueue(this.log);

    this.setupDeviceEventEmitter('firstDiscovery');

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
      this.log.debug('Stopping all polling tasks');
      for (const device of this.homekitDevicesById.values()) {
        await device.stopPolling();
      }
      this.log.debug('Waiting for tasks to complete');
      try {
        await this.taskQueue.waitForEmptyQueue();
      } catch (error) {
        this.log.error('Error while waiting for task queue to empty during shutdown:', error);
      }
      this.stopKasaApi();
    });
  }

  private setupDeviceEventEmitter(name: string, discoveredDeviceIds?: Set<string>): void {
    deviceEventEmitter.removeAllListeners('deviceDiscovered');
    this.log.debug(`Setting up device event emitter: ${name}`);
    if (name === 'periodicDiscovery' && discoveredDeviceIds) {
      deviceEventEmitter.on('deviceDiscovered', async (device: KasaDevice) => {
        this.log.debug(`Device discovered during periodic discovery: ${device.sys_info.device_id}`);
        discoveredDeviceIds.add(device.sys_info.device_id);
        this.log.debug(`Added device ID to discoveredDeviceIds: ${device.sys_info.device_id}`);
        await this.processDevice(device);
      });
    } else {
      deviceEventEmitter.on('deviceDiscovered', async (device: KasaDevice) => {
        this.log.debug(`Device discovered during initial discovery: ${device.sys_info.device_id}`);
        await this.processDevice(device);
      });
    }
  }

  async initializePlatform(): Promise<void> {
    try {
      packageConfig = await loadPackageConfig(this.log);
      this.logInitializationDetails();
      await this.verifyEnvironment();
      this.isUpgrade = await checkForUpgrade(packageConfig, this.storagePath, this.log);
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

      const discoveredDeviceIds = new Set<string>();
      this.setupPeriodicDiscovery(discoveredDeviceIds);
    } catch (error) {
      this.log.error('An error occurred during startup:', error);
    }
  }

  private setupPeriodicDiscovery(discoveredDeviceIds: Set<string>): void {
    this.log.debug('Setting up periodic device discovery');
    this.setupDeviceEventEmitter('periodicDiscovery', discoveredDeviceIds);
    setInterval(async () => {
      await this.periodicDeviceDiscovery(discoveredDeviceIds);
    }, this.config.discoveryOptions.discoveryPollingInterval);
    this.log.debug('Periodic device discovery setup completed');
  }

  private async discoverDevices() {
    try {
      if (this.deviceManager) {
        await this.deviceManager.discoverDevices();
      }
    } catch (error) {
      this.log.error('Error during discoverDevices:', error);
    }
  }

  private async periodicDeviceDiscovery(discoveredDeviceIds: Set<string>): Promise<void> {
    this.log.debug('Starting periodic device discovery');
    if (this.periodicDeviceDiscovering) {
      this.log.debug('Periodic device discovery already in progress');
      return;
    }
    if (this.isShuttingDown) {
      this.log.debug('Platform is shutting down, skipping periodic device discovery');
      return;
    }
    this.periodicDeviceDiscovering = true;
    discoveredDeviceIds.clear();
    this.log.debug('Cleared discoveredDeviceIds set before discovery.');
    const task = async () => {
      try {
        if (this.deviceManager) {
          await this.deviceManager.discoverDevices();
        }
      } catch (error) {
        this.log.error('Error during periodic device discovery:', error);
      } finally {
        this.handleOfflineDevices(discoveredDeviceIds);
        this.periodicDeviceDiscovering = false;
        this.periodicDeviceDiscoveryEmitter.emit('periodicDeviceDiscoveryComplete');
        this.log.debug('Finished periodic device discovery');
      }
    };
    const deferAndCombinedTask = deferAndCombine(task, this.config.advancedOptions.waitTimeUpdate);
    this.taskQueue.addTask(deferAndCombinedTask);
    await deferAndCombinedTask();
  }

  private async processDevice(device: KasaDevice): Promise<void> {
    this.log.debug(`Processing device: ${device.sys_info.device_id}`);
    try {
      const now = new Date();
      device.last_seen = now;
      device.offline = false;
      const platformAccessory = this.findPlatformAccessory(device.sys_info.device_id);
      if (platformAccessory) {
        await this.updateExistingDevice(platformAccessory, device, now);
      } else {
        await this.addNewDevice(device);
      }
    } catch (error) {
      this.log.error(`Error processing device [${device.sys_info.device_id}]:`, error);
    }
  }

  private handleOfflineDevices(discoveredDeviceIds: Set<string>): void {
    const now = new Date();
    this.configuredAccessories.forEach((accessory, uuid) => {
      const deviceId = accessory.context.deviceId;
      if (!deviceId) {
        this.log.warn(`Accessory [${accessory.displayName}] is missing a deviceId.`);
        return;
      }
      if (discoveredDeviceIds.has(deviceId)) {
        this.log.debug(`Accessory [${accessory.displayName}] was discovered and is online.`);
        this.updateAccessoryStatus(accessory, now, false);
      } else {
        this.handleOfflineAccessory(accessory, uuid, now);
      }
    });
  }

  private handleOfflineAccessory(
    accessory: PlatformAccessory<KasaPythonAccessoryContext>,
    uuid: string,
    now: Date,
  ): void {
    const timeSinceLastSeen = now.getTime() - new Date(accessory.context.lastSeen || 0).getTime();
    const offlineInterval = this.config.discoveryOptions.offlineInterval;
    if (timeSinceLastSeen > offlineInterval) {
      this.log.info(`Accessory [${accessory.displayName}] is offline and outside the offline interval. Removing.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.configuredAccessories.delete(uuid);
    } else if (!accessory.context.offline) {
      this.log.debug(`Accessory [${accessory.displayName}] is offline but within the offline interval.`);
      this.updateAccessoryStatus(accessory, accessory.context.lastSeen || now, true);
    }
  }

  private findPlatformAccessory(deviceId: string): PlatformAccessory<KasaPythonAccessoryContext> | undefined {
    for (const accessory of this.configuredAccessories.values()) {
      if (accessory.context.deviceId === deviceId) {
        return accessory;
      }
    }
    return undefined;
  }

  private async updateExistingDevice(
    platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>,
    device: KasaDevice,
    now: Date,
  ): Promise<void> {
    this.log.debug(`Device [${device.sys_info.device_id}] is already configured, updating status.`);
    this.updateAccessoryStatus(platformAccessory, now, false);
    const existingDevice = this.homekitDevicesById.get(device.sys_info.device_id);
    if (existingDevice) {
      if (!existingDevice.isUpdating) {
        if (existingDevice.kasaDevice.offline && !device.offline) {
          this.log.debug(`Device [${device.sys_info.device_id}] was offline and is now online. Updating and starting polling.`);
          existingDevice.kasaDevice = device;
          existingDevice.updateAfterPeriodicDiscovery();
          existingDevice.startPolling();
        } else {
          this.log.debug(`Updating existing HomeKit device [${device.sys_info.device_id}].`);
          existingDevice.kasaDevice = device;
          existingDevice.updateAfterPeriodicDiscovery();
        }
      } else {
        this.log.debug(`HomeKit device [${device.sys_info.device_id}] is currently updating. Skipping update.`);
      }
    } else {
      await this.addNewDevice(device);
    }
  }

  private async addNewDevice(device: KasaDevice): Promise<void> {
    this.log.debug(`New device [${device.sys_info.device_id}] found, adding to HomeKit.`);
    await this.foundDevice(device);
    const listenerCountBefore = this.periodicDeviceDiscoveryEmitter.listenerCount('periodicDeviceDiscoveryComplete');
    this.log.debug(`Emitter listener count before foundDevice: ${listenerCountBefore}`);
    this.periodicDeviceDiscoveryEmitter.setMaxListeners(this.periodicDeviceDiscoveryEmitter.getMaxListeners() + 10);
    const listenerCountAfter = this.periodicDeviceDiscoveryEmitter.listenerCount('periodicDeviceDiscoveryComplete');
    this.log.debug(`Emitter listener count after foundDevice: ${listenerCountAfter}`);
  }

  private updateAccessoryStatus(
    accessory: PlatformAccessory<KasaPythonAccessoryContext>,
    lastSeen: Date,
    offline: boolean,
  ): void {
    accessory.context.lastSeen = lastSeen;
    accessory.context.offline = offline;
    this.api.updatePlatformAccessories([accessory]);
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
      const [, , , kasaProcessInstance] = await runCommand(
        this.log,
        this.venvPythonExecutable,
        [scriptPath, this.port.toString(), this.hideHomeKitMatter.toString()],
        undefined,
        this.config.advancedOptions.advancedPythonLogging ? false : true,
        this.config.advancedOptions.advancedPythonLogging ? false : true,
        true,
      );

      this.kasaProcess = kasaProcessInstance;
      this.log.debug('Kasa API process started successfully');
    } catch (error) {
      this.log.error(`Error starting kasaApi.py process: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
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
        this.log.info(
          `Platform Accessory [${platformAccessory.displayName}] is offline and outside the offline interval, ` +
          'moving to offlineAccessories',
        );
        this.configuredAccessories.delete(platformAccessory.UUID);
        this.offlineAccessories.set(platformAccessory.UUID, platformAccessory);
        return;
      } else if (timeSinceLastSeen < offlineInterval && platformAccessory.context.offline === true) {
        this.log.debug(`Platform Accessory [${platformAccessory.displayName}] is offline and within offline interval.`);
      } else if (platformAccessory.context.offline === false) {
        this.log.debug(`Platform Accessory [${platformAccessory.displayName}] is online, updating lastSeen time.`);
        this.updateAccessoryStatus(platformAccessory, now, false);
      }
    }

    if (!this.configuredAccessories.has(platformAccessory.UUID)) {
      this.log.debug(
        `Platform Accessory [${platformAccessory.displayName}] with UUID [${platformAccessory.UUID}] ` +
        'is not in configuredAccessories, adding it.',
      );
      this.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    } else {
      this.log.debug(
        `Platform Accessory [${platformAccessory.displayName}] with UUID ` +
        `[${platformAccessory.UUID}] is already in configuredAccessories.`,
      );
    }
  }

  private async foundDevice(device: KasaDevice): Promise<void> {
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
    const homekitDevice = await this.createHomeKitDevice(device) as HomeKitDevice | undefined;
    if (homekitDevice) {
      this.homekitDevicesById.set(deviceId, homekitDevice);
      this.log.debug(`HomeKit device [${deviceAlias}] ${deviceType} [${deviceId}] successfully added`);
    } else {
      this.log.error(`Failed to add HomeKit device for: [${deviceAlias}] ${deviceType} [${deviceId}]`);
    }
  }

  private async createHomeKitDevice(kasaDevice: KasaDevice): Promise<HomeKitDevice | undefined> {
    this.log.debug('Creating HomeKit device for:', kasaDevice.sys_info);
    return await create(this, kasaDevice);
  }
}