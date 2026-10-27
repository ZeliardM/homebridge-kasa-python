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
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import HomeKitDevice from './devices/baseDevice.js';
import create from './devices/create.js';
import DeviceManager, { API_TOKEN_HEADER, deviceEventEmitter } from './devices/deviceManager.js';
import PythonChecker from './python/pythonChecker.js';
import { parseConfig } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { TaskQueue } from './taskQueue.js';
import {
  deferAndCombine,
  getAvailablePort,
  isObjectLike,
  loadPackageConfig,
  lookup,
  lookupCharacteristicNameByUUID,
  runCommand,
  satisfiesVersion,
  waitForServer,
} from './utils.js';
import { createEnergyCharacteristics } from './devices/energyCharacteristics.js';
import type { KasaPythonConfig } from './config.js';
import type { KasaDevice } from './devices/deviceTypes.js';
import type { PackageConfig } from './utils.js';
import type { EnergyCharacteristics } from './devices/energyCharacteristics.js';

export type KasaPythonAccessoryContext = {
  deviceId?: string;
  lastSeen?: Date;
  offline?: boolean;
};

let packageConfig: PackageConfig;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default class KasaPythonPlatform implements DynamicPlatformPlugin {
  // Passed to the Python service in its environment, never on its command line, and sent with every request to it.
  public readonly apiToken: string = randomBytes(32).toString('hex');
  public readonly Characteristic: typeof Characteristic;
  public readonly configuredAccessories: Map<string, PlatformAccessory<KasaPythonAccessoryContext>> = new Map();
  public readonly offlineAccessories: Map<string, PlatformAccessory<KasaPythonAccessoryContext>> = new Map();
  public readonly Service: typeof Service;
  public readonly storagePath: string;
  public config: KasaPythonConfig;
  public deviceManager: DeviceManager | undefined;
  public energyCharacteristics: EnergyCharacteristics | undefined;
  public isShuttingDown: boolean = false;
  public periodicDeviceDiscovering: boolean = false;
  public port: number = 0;
  public taskQueue: TaskQueue;
  public venvPythonExecutable: string = '';
  private readonly homekitDevicesById: Map<string, HomeKitDevice> = new Map();
  private deviceDiscoveredHandler?: (device: KasaDevice) => Promise<void>;
  private discoveryInterval?: NodeJS.Timeout;
  private hideHomeKitMatter: boolean = true;
  private kasaProcess: ChildProcessWithoutNullStreams | undefined | null = null;
  private platformInitialization: Promise<void>;

  constructor(public readonly log: Logging, config: PlatformConfig, public readonly api: API) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.storagePath = this.api.user.storagePath();
    this.config = parseConfig(config);
    if (!this.config.enableCredentials && (this.config.username || this.config.password)) {
      this.log.warn('A username or password is set, but Enable Credentials is off, so they are not used. ' +
        'Turn on Enable Credentials if your devices need your TP-Link account.');
    }
    if (this.config.discoveryOptions.disableBroadcast && this.config.discoveryOptions.manualDevices.length === 0) {
      this.log.warn('Broadcast discovery is disabled and no Manual Devices are configured, so no devices will be discovered.');
    }
    this.energyCharacteristics = this.config.energyOptions.enableEnergyMonitoring
      ? createEnergyCharacteristics(this.api.hap)
      : undefined;
    this.taskQueue = new TaskQueue(this.log, () => this.isShuttingDown);

    this.setupDeviceEventEmitter('firstDiscovery');

    this.platformInitialization = this.initializePlatform();

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
      if (this.discoveryInterval) {
        clearInterval(this.discoveryInterval);
        this.log.debug('Cleared periodic device discovery interval');
      }
      this.log.debug('Stopping all polling tasks');
      for (const device of this.homekitDevicesById.values()) {
        await device.stopPolling(true);
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

  private setupDeviceEventEmitter(mode: string, discoveredDeviceIds?: Set<string>): void {
    if (this.deviceDiscoveredHandler) {
      deviceEventEmitter.off('deviceDiscovered', this.deviceDiscoveredHandler);
    }
    this.log.debug(`Setting up device event emitter: ${mode}`);
    if (mode === 'periodicDiscovery' && discoveredDeviceIds) {
      this.deviceDiscoveredHandler = async (device: KasaDevice) => {
        this.log.debug(`Device discovered during periodic discovery: ${device.sys_info.device_id}`);
        discoveredDeviceIds.add(device.sys_info.device_id);
        this.log.debug(`Added device ID to discoveredDeviceIds: ${device.sys_info.device_id}`);
        await this.processDevice(device);
      };
    } else {
      this.deviceDiscoveredHandler = async (device: KasaDevice) => {
        this.log.debug(`Device discovered during initial discovery: ${device.sys_info.device_id}`);
        await this.processDevice(device);
      };
    }
    deviceEventEmitter.on('deviceDiscovered', this.deviceDiscoveredHandler);
  }

  async initializePlatform(): Promise<void> {
    packageConfig = await loadPackageConfig(this.log);
    this.logInitializationDetails();
    await this.verifyEnvironment();
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
      if (!satisfiesVersion(this.api.serverVersion, packageConfig.engines.homebridge)) {
        throw new Error(
          `homebridge-kasa-python requires Homebridge ${packageConfig.engines.homebridge}. ` +
          `Currently running: ${this.api.serverVersion}`,
        );
      } else {
        this.log.debug(
          `Homebridge version ${this.api.serverVersion} satisfies the requirement ${packageConfig.engines.homebridge}`,
        );
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
      await this.checkPython();

      this.log.debug('Getting available port');
      this.port = await getAvailablePort();
      this.log.debug(`Port assigned: ${this.port}`);

      this.log.debug('Initializing DeviceManager');
      this.deviceManager = new DeviceManager(this);
      this.log.debug('DeviceManager initialized');

      await this.startKasaApi();

      await waitForServer(`http://127.0.0.1:${this.port}/health`, this.log, { [API_TOKEN_HEADER]: this.apiToken });

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

    const discoveryTask = async () => {
      await this.periodicDeviceDiscovery(discoveredDeviceIds);
    };

    const deferredDiscoveryTask = deferAndCombine(discoveryTask, this.config.advancedOptions.waitTimeUpdate);

    this.discoveryInterval = setInterval(() => {
      try {
        this.taskQueue.addTask(deferredDiscoveryTask);
      } catch (err) {
        this.log.error('Error scheduling periodic device discovery:', err);
      }
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
    let discoverySucceeded = false;
    discoveredDeviceIds.clear();
    this.log.debug('Cleared discoveredDeviceIds set before discovery.');
    try {
      if (this.deviceManager) {
        await this.deviceManager.discoverDevices();
        discoverySucceeded = true;
      }
    } catch (error) {
      this.log.error('Error during periodic device discovery:', error);
    } finally {
      if (discoverySucceeded) {
        this.handleOfflineDevices(discoveredDeviceIds);
      } else {
        this.log.warn('Skipping offline accessory reconciliation because periodic discovery did not complete successfully');
      }
      this.periodicDeviceDiscovering = false;
      this.log.debug('Finished periodic device discovery');
    }
  }

  private async processDevice(device: KasaDevice): Promise<void> {
    this.log.debug(`Processing device: ${device.sys_info.device_id}`);
    try {
      const now = new Date();
      device.last_seen = now;
      device.offline = false;
      const accessory = this.findPlatformAccessory(device.sys_info.device_id);
      if (accessory) {
        await this.updateExistingDevice(accessory, device, now);
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
      this.log.debug(`Accessory [${accessory.displayName}] is offline and outside the offline interval. Removing.`);
      this.removeTrackedDevice(accessory.context.deviceId, accessory.UUID);
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
    accessory: PlatformAccessory<KasaPythonAccessoryContext>,
    device: KasaDevice,
    now: Date,
  ): Promise<void> {
    this.log.debug(`Device [${device.sys_info.device_id}] is already configured, updating status.`);
    this.updateAccessoryStatus(accessory, now, false);
    const existingDevice = this.homekitDevicesById.get(device.sys_info.device_id);
    if (existingDevice) {
      // Discovery only refreshes identity, so it applies even while a poll or write is in flight.
      // Otherwise a slow, failing read of an old address keeps every later report from landing.
      const comingOnline = existingDevice.kasaDevice.offline && !device.offline;
      const moved = existingDevice.kasaDevice.sys_info.host !== device.sys_info.host;
      existingDevice.updateFromDiscovery(device);
      existingDevice.markDeviceReachable(device.last_seen);
      if (comingOnline || moved) {
        this.log.debug(`Device [${device.sys_info.device_id}] is back online or at a new address. Updating and restarting polling.`);
        existingDevice.updateAfterPeriodicDiscovery();
        existingDevice.startPolling();
      } else {
        // Its own polling keeps the state current; discovery only refreshed its identity.
        this.log.debug(`Updated existing HomeKit device [${device.sys_info.device_id}] from discovery.`);
      }
    } else {
      await this.addNewDevice(device);
    }
  }

  private async addNewDevice(device: KasaDevice): Promise<void> {
    this.log.debug(`New device [${device.sys_info.device_id}] found, adding to HomeKit.`);
    await this.foundDevice(device);
  }

  private updateAccessoryStatus(
    accessory: PlatformAccessory<KasaPythonAccessoryContext>,
    lastSeen: Date,
    offline: boolean,
  ): void {
    const offlineStatusChanged = accessory.context.offline !== offline;

    accessory.context.lastSeen = lastSeen;
    accessory.context.offline = offline;

    if (offlineStatusChanged) {
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  private async checkPython(): Promise<void> {
    try {
      this.log.debug('Running PythonChecker');
      await new PythonChecker(this, packageConfig.engines.python).allInOne();
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
        { env: { KASA_API_TOKEN: this.apiToken } },
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
    const serviceName = lookup(this.api.hap.Service, (objectProp, value) =>
      isObjectLike(objectProp) && 'UUID' in objectProp && objectProp.UUID === value, service.UUID);
    return serviceName;
  }

  getCharacteristicName(characteristic: WithUUID<{ name?: string | null; displayName?: string | null }>): string | undefined {
    const name = characteristic.name;
    const displayName = characteristic.displayName;
    const lookupName = lookupCharacteristicNameByUUID(this.api.hap.Characteristic, characteristic.UUID);
    return name ?? displayName ?? lookupName;
  }

  registerPlatformAccessory(accessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.log.debug('Registering platform accessory:', accessory.displayName);

    if (!this.configuredAccessories.has(accessory.UUID)) {
      this.log.debug(`Platform Accessory ${accessory.displayName} is not in configuredAccessories, adding it.`);
      this.configuredAccessories.set(accessory.UUID, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.debug(`Platform Accessory ${accessory.displayName} registered with Homebridge.`);
    } else {
      this.log.debug(`Platform Accessory ${accessory.displayName} is already in configuredAccessories, skipping registration.`);
    }
  }

  configureAccessory(accessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.log.debug(`Configuring Platform Accessory: [${accessory.displayName}] UUID: ${accessory.UUID}`);

    if (!accessory.context.lastSeen && !accessory.context.offline) {
      this.log.debug(`Setting initial lastSeen and offline status for Platform Accessory: [${accessory.displayName}]`);
      accessory.context.lastSeen = new Date();
      accessory.context.offline = false;
    }

    if (accessory.context.lastSeen) {
      const now = new Date();
      const timeSinceLastSeen = now.getTime() - new Date(accessory.context.lastSeen).getTime();
      const offlineInterval = this.config.discoveryOptions.offlineInterval;

      this.log.debug(`Platform Accessory [${accessory.displayName}] last seen ${timeSinceLastSeen}ms ago, ` +
        `offline interval is ${offlineInterval}ms, offline status: ${accessory.context.offline}`);

      if (timeSinceLastSeen > offlineInterval && accessory.context.offline === true) {
        this.log.debug(
          `Platform Accessory [${accessory.displayName}] is offline and outside the offline interval, ` +
          'moving to offlineAccessories',
        );
        this.configuredAccessories.delete(accessory.UUID);
        this.offlineAccessories.set(accessory.UUID, accessory);
        return;
      } else if (timeSinceLastSeen < offlineInterval && accessory.context.offline === true) {
        this.log.debug(`Platform Accessory [${accessory.displayName}] is offline and within offline interval.`);
      } else if (accessory.context.offline === false) {
        this.log.debug(`Platform Accessory [${accessory.displayName}] is online, updating lastSeen time.`);
        this.updateAccessoryStatus(accessory, now, false);
      }
    }

    this.refuseWritesUntilFound(accessory);

    if (!this.configuredAccessories.has(accessory.UUID)) {
      this.log.debug(
        `Platform Accessory [${accessory.displayName}] with UUID [${accessory.UUID}] ` +
        'is not in configuredAccessories, adding it.',
      );
      this.configuredAccessories.set(accessory.UUID, accessory);
    } else {
      this.log.debug(
        `Platform Accessory [${accessory.displayName}] with UUID ` +
        `[${accessory.UUID}] is already in configuredAccessories.`,
      );
    }
  }

  // A cached accessory has no handlers until discovery finds its device and the device class sets
  // its own. Until then HomeKit would accept a write and drop it, so it answers No Response instead.
  private refuseWritesUntilFound(accessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    const { Characteristic: C, HapStatusError, HAPStatus } = this.api.hap;
    const writable = [C.On, C.Brightness, C.ColorTemperature, C.Hue, C.Saturation, C.Active, C.RotationSpeed];
    for (const service of accessory.services) {
      for (const type of writable) {
        if (service.testCharacteristic(type)) {
          service.getCharacteristic(type).onSet(() => {
            this.log.warn(`[${accessory.displayName}] has not been found since Homebridge started, so the write was not sent.`);
            throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          });
        }
      }
    }
  }

  private async foundDevice(device: KasaDevice): Promise<void> {
    const { sys_info: { alias: deviceAlias, device_id: deviceId, device_type: deviceType, host: deviceHost } } = device;

    if (!deviceId) {
      this.log.error('Missing deviceId:', deviceHost);
      return;
    }

    const existingDevice = this.homekitDevicesById.get(deviceId);
    if (existingDevice) {
      if (!this.configuredAccessories.has(existingDevice.homebridgeAccessory.UUID)) {
        this.log.warn(
          `HomeKit device [${deviceAlias}] ${deviceType} [${deviceId}] is missing its accessory. Recreating it.`,
        );
        this.removeTrackedDevice(deviceId, existingDevice.homebridgeAccessory.UUID);
      } else {
        this.log.debug(`HomeKit device already added: [${deviceAlias}] ${deviceType} [${deviceId}]`);
        return;
      }
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

  private removeTrackedDevice(deviceId: string | undefined, accessoryUuid: string): void {
    if (!deviceId) {
      return;
    }

    const trackedDevice = this.homekitDevicesById.get(deviceId);
    if (!trackedDevice) {
      return;
    }

    if (trackedDevice.homebridgeAccessory.UUID !== accessoryUuid) {
      this.log.debug(
        `Skipping tracked device cleanup for [${deviceId}] because UUIDs do not match ` +
        `(${trackedDevice.homebridgeAccessory.UUID} !== ${accessoryUuid}).`,
      );
      return;
    }

    this.homekitDevicesById.delete(deviceId);
    trackedDevice.removeFromPlatform();
    this.log.debug(`Removed tracked HomeKit device for [${deviceId}].`);
  }
}
