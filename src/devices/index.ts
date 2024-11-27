import { PlatformAccessoryEvent } from 'homebridge';
import type {
  Categories,
  Characteristic,
  CharacteristicValue,
  HapStatusError,
  Logger,
  Nullable,
  PlatformAccessory,
  Service,
} from 'homebridge';

import AccessoryInformation from '../accessoryInformation.js';
import DeviceManager from './deviceManager.js';
import { prefixLogger } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { DeviceConfig, KasaDevice } from './kasaDevices.js';
import type { KasaPythonAccessoryContext } from '../platform.js';

export default abstract class HomekitDevice {
  readonly log: Logger;
  readonly categoryName: string;
  readonly deviceConfig: DeviceConfig;
  protected deviceManager: DeviceManager | undefined;
  homebridgeAccessory: PlatformAccessory<KasaPythonAccessoryContext>;

  constructor(
    readonly platform: KasaPythonPlatform,
    protected kasaDevice: KasaDevice,
    readonly category: Categories,
  ) {
    this.deviceConfig = kasaDevice.device_config;
    this.deviceManager = platform.deviceManager;
    this.log = prefixLogger(platform.log, `[${this.name}]`);
    this.categoryName = this.platform.getCategoryName(this.category);
    this.homebridgeAccessory = this.initializeAccessory();
    this.homebridgeAccessory.on(PlatformAccessoryEvent.IDENTIFY, () => this.identify());
  }

  private initializeAccessory(): PlatformAccessory<KasaPythonAccessoryContext> {
    const uuid = this.platform.api.hap.uuid.generate(this.id);
    const homebridgeAccessory = this.platform.configuredAccessories.get(uuid);
    let accessory: PlatformAccessory<KasaPythonAccessoryContext>;

    if (!homebridgeAccessory) {
      this.log.debug(`Creating new Accessory [${this.id}] [${uuid}] category: ${this.categoryName}`);
      accessory = new this.platform.api.platformAccessory(this.name, uuid, this.category);
      accessory.context.deviceId = this.id;
      this.platform.registerPlatformAccessory(accessory);
    } else {
      this.log.debug(
        `Existing Accessory found [${homebridgeAccessory.context.deviceId}] ` +
        `[${homebridgeAccessory.UUID}] category: ${this.platform.getCategoryName(homebridgeAccessory.category)}`,
      );
      accessory = homebridgeAccessory;
      this.updateAccessory(accessory);
    }

    const accInfo = AccessoryInformation(this.platform.api.hap)(accessory, this);
    if (!accInfo) {
      this.log.error('Could not retrieve default AccessoryInformation');
    }

    return accessory;
  }

  private updateAccessory(accessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.correctAccessoryProperty(accessory, 'displayName', this.name);
    this.correctAccessoryProperty(accessory, 'category', this.category);
    this.correctAccessoryProperty(accessory.context, 'deviceId', this.id);
    this.platform.configuredAccessories.set(accessory.UUID, accessory);
    this.platform.api.updatePlatformAccessories([accessory]);
  }

  private correctAccessoryProperty<T, K extends keyof T>(obj: T, key: K, expectedValue: T[K]): void {
    if (obj[key] !== expectedValue) {
      this.log.warn(`Correcting Accessory ${String(key)} from: ${String(obj[key])} to: ${String(expectedValue)}`);
      obj[key] = expectedValue;
    }
  }

  get id(): string {
    return this.kasaDevice.sys_info.device_id;
  }

  get name(): string {
    return this.kasaDevice.sys_info.alias;
  }

  get manufacturer(): string {
    return 'TP-Link';
  }

  get model(): string {
    return `${this.kasaDevice.disc_info.model} ${this.kasaDevice.sys_info.hw_ver}`;
  }

  get serialNumber(): string {
    return this.kasaDevice.sys_info.mac;
  }

  get firmwareRevision(): string {
    return `${this.kasaDevice.sys_info.sw_ver.split(' ')[0]}`;
  }

  abstract identify(): void;

  updateValue(
    service: Service,
    characteristic: Characteristic,
    value: Nullable<CharacteristicValue> | Error | HapStatusError,
    childDeviceAlias?: string,
  ): void {
    const logMessage = `Updating ${this.platform.lsc(service, characteristic)}` +
      `${childDeviceAlias ? ` on ${childDeviceAlias}` : ''} to ${value}`;
    this.log.debug(logMessage);
    characteristic.updateValue(value);
  }

  addService(serviceConstructor: typeof this.platform.Service.Outlet, name: string, subType?: string): Service {
    const serviceName = this.platform.getServiceName(serviceConstructor);
    this.log.debug(`Creating new ${serviceName} Service on ${name}${subType ? ` [${subType}]` : ''}`);
    return this.homebridgeAccessory.addService(serviceConstructor, name, subType);
  }

  protected logRejection(reason: unknown): void {
    this.log.error(JSON.stringify(reason));
  }
}