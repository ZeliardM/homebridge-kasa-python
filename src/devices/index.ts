import { PlatformAccessoryEvent } from 'homebridge'; // enum
import type {
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
import chalk from 'chalk';

import AccessoryInformation from '../accessoryInformation.js';
import type { KasaPythonConfig } from '../config.js';
import DeviceManager from './deviceManager.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaPythonAccessoryContext } from '../platform.js';
import { prefixLogger } from '../utils.js';
import type { KasaDevice } from '../utils.js';

import type { DeviceConfig } from './kasaDevices.js';

export default abstract class HomekitDevice {
  readonly log: Logger;

  protected deviceManager: DeviceManager;

  homebridgeAccessory: PlatformAccessory<KasaPythonAccessoryContext>;

  readonly deviceConfig: DeviceConfig;

  private lsc: (
    serviceOrCharacteristic: Service | Characteristic | { UUID: string },
    characteristic?: Characteristic | { UUID: string }
  ) => string;

  /**
   * Creates an instance of HomeKitDevice.
   */
  constructor(
    readonly platform: KasaPythonPlatform,
    readonly config: KasaPythonConfig,
    homebridgeAccessory:
      | PlatformAccessory<KasaPythonAccessoryContext>
      | undefined,
    readonly kasaDevice: KasaDevice,
    readonly category: Categories,
    deviceConfig: DeviceConfig,
    deviceManager?: DeviceManager,
  ) {
    this.deviceConfig = deviceConfig;
    this.deviceManager = deviceManager ? deviceManager : new DeviceManager(platform);
    this.log = prefixLogger(
      platform.log,
      () => `${chalk.blue(`[${this.name}]`)}`,
    );

    this.lsc = this.platform.lsc.bind(this.platform);

    const categoryName = platform.getCategoryName(category) ?? '';

    if (homebridgeAccessory === null || homebridgeAccessory === undefined) {
      const uuid = platform.api.hap.uuid.generate(this.id);

      this.log.debug(
        `Creating new Accessory [${this.id}] [${uuid}] category: ${categoryName}`,
      );

      this.homebridgeAccessory = new platform.api.platformAccessory(
        this.name,
        uuid,
        category,
      );

      this.homebridgeAccessory.context.deviceId = this.id;
      this.platform.registerPlatformAccessory(this.homebridgeAccessory);
    } else {
      this.homebridgeAccessory = homebridgeAccessory;

      this.log.debug(
        `Existing Accessory found [${homebridgeAccessory.context.deviceId}] [${homebridgeAccessory.UUID}] category: ${categoryName}`,
      );
      this.homebridgeAccessory.displayName = this.name;
      if (this.homebridgeAccessory.category !== category) {
        this.log.warn(
          `Correcting Accessory Category from: ${platform.getCategoryName(
            this.homebridgeAccessory.category,
          )} to: ${categoryName}`,
        );
        this.homebridgeAccessory.category = category;
      }
      this.homebridgeAccessory.context.deviceId = this.id;
      this.platform.api.updatePlatformAccessories([this.homebridgeAccessory]);
    }

    const accInfo = AccessoryInformation(platform.api.hap)(
      this.homebridgeAccessory,
      this,
    );
    if (accInfo === null) {
      this.log.error('Could not retrieve default AccessoryInformation');
    }

    // Remove Old Services
    this.homebridgeAccessory.services.forEach((service: Service) => {
      if (service instanceof platform.Service.AccessoryInformation) {
        return;
      }
      if (service instanceof platform.Service.Outlet) {
        return;
      }
      this.log.warn(
        `Removing stale Service: ${this.lsc(service)} uuid:[%s] subtype:[%s]`,
        service.UUID,
        service.subtype || '',
      );
      this.homebridgeAccessory.removeService(service);
    });

    this.homebridgeAccessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.identify();
    });
  }

  get id(): string {
    return this.kasaDevice.sys_info.deviceId;
  }

  get name(): string {
    return this.kasaDevice.alias;
  }

  get manufacturer(): string {
    return 'TP-Link';
  }

  get model(): string {
    return this.kasaDevice.sys_info.model;
  }

  get serialNumber(): string {
    return `${this.kasaDevice.sys_info.mac} ${this.kasaDevice.sys_info.deviceId}`;
  }

  get firmwareRevision(): string {
    return this.kasaDevice.sys_info.sw_ver;
  }

  get hardwareRevision(): string {
    return this.kasaDevice.sys_info.hw_ver;
  }

  abstract identify(): void;

  updateValue(
    service: Service,
    characteristic: Characteristic,
    value: Nullable<CharacteristicValue> | Error | HapStatusError,
  ) {
    this.log.debug(`Updating ${this.lsc(service, characteristic)} ${value}`);
    characteristic.updateValue(value);
  }

  updateChildValue(
    service: Service,
    characteristic: Characteristic,
    value: Nullable<CharacteristicValue> | Error | HapStatusError,
    childDeviceAlias: string,
  ) {
    const homekitState: boolean = value === 1 ? true : false;

    this.log.debug(`Updating ${this.lsc(service, characteristic)} on ${childDeviceAlias} to ${homekitState}`);
    characteristic.updateValue(homekitState);
  }

  addService(
    serviceConstructor:
      | typeof this.platform.Service.Outlet
      | typeof this.platform.Service.Lightbulb,
    name: string,
    subType?: string,
  ) {
    const serviceName = this.platform.getServiceName(serviceConstructor);
    this.log.debug(`Creating new ${serviceName} Service on ${name}${subType ? ` [${subType}]` : ''}`);
    return this.homebridgeAccessory.addService(serviceConstructor, name, subType);
  }

  protected logRejection(reason: unknown): void {
    this.log.error(JSON.stringify(reason));
  }

  protected removeServiceIfExists(service: WithUUID<typeof Service>) {
    const foundService = this.homebridgeAccessory.getService(service);
    if (foundService !== null && foundService !== undefined) {
      this.log.warn(
        `Removing stale Service: ${this.lsc(service, foundService)} uuid:[%s]`,
        foundService.UUID,
      );

      this.homebridgeAccessory.removeService(foundService);
    }
  }

  protected removeCharacteristicIfExists(
    service: Service,
    characteristic: WithUUID<new () => Characteristic>,
  ) {
    if (
      service.testCharacteristic(
        characteristic as unknown as WithUUID<typeof Characteristic>,
      )
    ) {
      const characteristicToRemove = service.getCharacteristic(characteristic);
      this.log.warn(
        `Removing stale Characteristic: ${this.lsc(
          service,
          characteristicToRemove,
        )} uuid:[%s]`,
        characteristicToRemove.UUID,
      );

      service.removeCharacteristic(characteristicToRemove);
    }
  }
}
