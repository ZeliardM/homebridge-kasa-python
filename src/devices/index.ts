import { PlatformAccessoryEvent } from 'homebridge';
import {
  Categories,
  Characteristic,
  CharacteristicValue,
  HapStatusError,
  Logger,
  Nullable,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';

import AccessoryInformation from '../accessoryInformation.js';
import DeviceManager from './deviceManager.js';
import { prefixLogger } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice } from './kasaDevices.js';
import type { KasaPythonAccessoryContext } from '../platform.js';

export default abstract class HomeKitDevice {
  readonly log: Logger;
  protected deviceManager: DeviceManager | undefined;
  homebridgeAccessory: PlatformAccessory<KasaPythonAccessoryContext>;
  public isUpdating: boolean = false;

  constructor(
    readonly platform: KasaPythonPlatform,
    public kasaDevice: KasaDevice,
    readonly category: Categories,
    readonly categoryName: string,
  ) {
    this.deviceManager = platform.deviceManager;
    this.log = prefixLogger(platform.log, `[${this.name}]`);
    this.homebridgeAccessory = this.initializeAccessory();
    this.homebridgeAccessory.on(PlatformAccessoryEvent.IDENTIFY, () => this.identify());
  }

  private initializeAccessory(): PlatformAccessory<KasaPythonAccessoryContext> {
    const uuid = this.platform.api.hap.uuid.generate(this.id);
    const homebridgeAccessory = this.platform.configuredAccessories.get(uuid);
    let platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>;

    if (!homebridgeAccessory) {
      this.log.debug(`Creating new Platform Accessory [${this.id}] [${uuid}] category: ${this.categoryName}`);
      platformAccessory = new this.platform.api.platformAccessory(this.name, uuid, this.category);
      platformAccessory.context.deviceId = this.id;
      platformAccessory.context.lastSeen = this.kasaDevice.last_seen;
      platformAccessory.context.offline = this.kasaDevice.offline;
      this.platform.registerPlatformAccessory(platformAccessory);
    } else {
      this.log.debug(`Existing Platform Accessory found [${homebridgeAccessory.context.deviceId}] ` +
        `[${homebridgeAccessory.UUID}] category: ${this.categoryName}`);
      platformAccessory = homebridgeAccessory;
      this.updateAccessory(platformAccessory);
    }

    const accInfo = AccessoryInformation(this.platform.api.hap)(platformAccessory, this);
    if (!accInfo) {
      this.log.error('Could not retrieve default AccessoryInformation');
    }

    return platformAccessory;
  }

  private updateAccessory(platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.correctAccessoryProperties(platformAccessory, {
      displayName: this.name,
      category: this.category,
      context: {
        deviceId: this.id,
        lastSeen: this.kasaDevice.last_seen,
        offline: this.kasaDevice.offline,
      },
    });
    this.platform.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    this.platform.api.updatePlatformAccessories([platformAccessory]);
  }

  private correctAccessoryProperties<T>(obj: T, properties: Partial<T>): void {
    for (const [key, expectedValue] of Object.entries(properties)) {
      if (obj[key as keyof T] !== expectedValue) {
        this.log.debug(`Correcting Platform Accessory ${key} from: ${String(obj[key as keyof T])} to: ${String(expectedValue)}`);
        obj[key as keyof T] = expectedValue as T[keyof T];
      }
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
    return `${this.kasaDevice.sys_info.model} ${this.kasaDevice.sys_info.hw_ver}`;
  }

  get serialNumber(): string {
    return this.kasaDevice.sys_info.mac;
  }

  get firmwareRevision(): string {
    return this.kasaDevice.sys_info.sw_ver;
  }

  abstract identify(): void;

  abstract startPolling(): void;

  addService(serviceConstructor: WithUUID<typeof this.platform.Service>, name: string, subType?: string): Service {
    const serviceName = this.platform.getServiceName(serviceConstructor);
    this.log.debug(`Creating new ${serviceName} Service on ${name}${subType ? ` [${subType}]` : ''}`);
    return this.homebridgeAccessory.addService(serviceConstructor, name, subType ? subType : '');
  }

  updateValue(
    service: Service,
    characteristic: Characteristic,
    deviceAlias: string,
    value: Nullable<CharacteristicValue> | Error | HapStatusError,
  ): void {
    this.log.info(`Updating ${this.platform.lsc(service, characteristic)} on ${deviceAlias} to ${value}`);
    characteristic.updateValue(value);
  }

  logRejection(reason: unknown): void {
    this.log.error(`Rejection: ${JSON.stringify(reason)}`);
  }
}