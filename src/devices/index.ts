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
import { prefixLogger, deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { ChildDevice, DeviceConfig, HSV, KasaDevice, SysInfo } from './kasaDevices.js';
import type { KasaPythonAccessoryContext } from '../platform.js';

export default abstract class HomekitDevice {
  readonly log: Logger;
  readonly deviceConfig: DeviceConfig;
  protected deviceManager: DeviceManager | undefined;
  homebridgeAccessory: PlatformAccessory<KasaPythonAccessoryContext>;
  private isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<KasaDevice | undefined>;

  constructor(
    readonly platform: KasaPythonPlatform,
    protected kasaDevice: KasaDevice,
    readonly category: Categories,
    readonly categoryName: string,
  ) {
    this.deviceConfig = kasaDevice.device_config;
    this.deviceManager = platform.deviceManager;
    this.log = prefixLogger(platform.log, `[${this.name}]`);
    this.homebridgeAccessory = this.initializeAccessory();
    this.homebridgeAccessory.on(PlatformAccessoryEvent.IDENTIFY, () => this.identify());

    this.getSysInfo = deferAndCombine(async (requestCount: number) => {
      this.log.debug(`Executing deferred getSysInfo count: ${requestCount}`);
      if (this.deviceManager) {
        this.log.debug('Fetching new SysInfo from device manager');
        const newSysInfo = await this.deviceManager.getSysInfo(this) as SysInfo;
        this.previousKasaDevice = this.kasaDevice;
        this.kasaDevice.sys_info = newSysInfo;
        this.log.debug('Updated SysInfo from device manager');
        return this.kasaDevice;
      }
      this.log.warn('Device manager is not available');
      return this.kasaDevice;
    }, platform.config.waitTimeUpdate);

    this.startPolling();
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
        `[${homebridgeAccessory.UUID}] category: ${this.categoryName}`,
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

  protected addCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    child?: ChildDevice,
  ) {
    const alias = child ? child.alias : this.name;
    this.log.debug(`Adding characteristic ${this.platform.getCharacteristicName(characteristicType)} for device: ${alias}`);
    const characteristic: Characteristic = getOrAddCharacteristic(service, characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, characteristicType, child));
    characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, child));
    return service;
  }

  private async handleOnGet(characteristicType: WithUUID<new () => Characteristic>, child?: ChildDevice): Promise<CharacteristicValue> {
    const alias = child ? child.alias : this.name;
    const characteristicName = this.platform.getCharacteristicName(characteristicType);
    if (!characteristicName) {
      throw new Error('Characteristic name is undefined');
    }
    this.log.debug(`Getting current value for characteristic ${characteristicName} for device: ${alias}`);
    try {
      const characteristicValue = this.getCharacteristicValue(characteristicType, child);
      this.log.debug(`Current Value of ${characteristicName} is: ${characteristicValue} for ${alias}`);
      return characteristicValue ?? this.getDefaultValue(characteristicType);
    } catch (error) {
      this.log.error(
        `Error getting current value for characteristic ${characteristicName} for device: ${alias}:`,
        error,
      );
    }
    return this.getDefaultValue(characteristicType);
  }

  private getCharacteristicValue(
    characteristicType: WithUUID<new () => Characteristic>,
    child: ChildDevice | undefined,
  ): CharacteristicValue | undefined {
    const characteristicMap: { [key: string]: keyof SysInfo | keyof ChildDevice } = {
      Brightness: 'brightness',
      ColorTemperature: 'color_temperature',
      Hue: 'hue',
      On: 'state',
      OutletInUse: 'state',
      Saturation: 'saturation',
    };

    const characteristicKey = characteristicMap[characteristicType.name];
    let value: string | number | boolean | ChildDevice[] | HSV[] | undefined;

    if (child) {
      const childDevice = this.kasaDevice.sys_info.children?.find(c => c.id === child.id);
      if (childDevice) {
        value = childDevice[characteristicKey as keyof ChildDevice];
      }
    } else {
      value = this.kasaDevice.sys_info[characteristicKey as keyof SysInfo];
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return value;
    }

    return undefined;
  }

  private getDefaultValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    if (
      characteristicType === this.platform.Characteristic.Brightness ||
      characteristicType === this.platform.Characteristic.ColorTemperature ||
      characteristicType === this.platform.Characteristic.Hue ||
      characteristicType === this.platform.Characteristic.Saturation
    ) {
      return 0;
    }
    return false;
  }

  private async handleOnSet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    child: ChildDevice | undefined,
    value: CharacteristicValue,
  ): Promise<void> {
    const alias = child ? child.alias : this.name;
    const characteristicName = this.platform.getCharacteristicName(characteristicType);
    if (!characteristicName) {
      throw new Error('Characteristic name is undefined');
    }
    this.log.info(`Setting ${characteristicName} to: ${value} for ${alias}`);
    if (this.deviceManager) {
      try {
        this.isUpdating = true;

        const characteristicMap: { [key: string]: string } = {
          Brightness: 'brightness',
          ColorTemperature: 'color_temp',
          Hue: 'hue',
          On: 'state',
          OutletInUse: 'state',
          Saturation: 'saturation',
        };

        const characteristicKey = characteristicMap[characteristicName];
        if (!characteristicKey) {
          throw new Error(`Characteristic key not found for ${characteristicName}`);
        }

        if (child) {
          const childNumber = parseInt(child.id.slice(-1), 10);
          await this.deviceManager.controlDevice(this, characteristicKey, value, childNumber);
          const kasaChild = this.kasaDevice.sys_info.children?.find(c => c.id === child.id);
          if (kasaChild) {
            (kasaChild[characteristicKey as keyof ChildDevice] as unknown as CharacteristicValue) = value;
          }
        } else {
          await this.deviceManager.controlDevice(this, characteristicKey, value);
          (this.kasaDevice.sys_info as unknown as Record<string, CharacteristicValue>)[characteristicKey] = value;
        }
        this.previousKasaDevice = this.kasaDevice;
        this.updateValue(service, service.getCharacteristic(characteristicType), value);
        this.log.debug(`Successfully set ${characteristicName} to ${value} for ${alias}`);
        return;
      } catch (error) {
        this.logRejection(error);
      } finally {
        this.isUpdating = false;
      }
    } else {
      throw new Error('Device manager is undefined.');
    }
  }

  protected async updateState() {
    if (this.isUpdating) {
      this.log.debug('Update already in progress, skipping updateState');
      return;
    }
    this.isUpdating = true;
    try {
      this.log.debug('Updating device state');
      const device = await this.getSysInfo();
      if (device) {
        this.log.debug('Device found, updating state');
        if (device.sys_info.children) {
          device.sys_info.children.forEach(async (child: ChildDevice) => {
            const childNumber = parseInt(child.id.slice(-1), 10);
            this.log.debug(`Processing child device: ${child.alias} with child number: ${childNumber}`);
            const service = this.homebridgeAccessory.getServiceById(this.platform.Service.Outlet, `outlet-${childNumber + 1}`);
            if (service && this.previousKasaDevice) {
              this.log.debug(`Service found for child device: ${child.alias}`);
              const previousKasaChild = this.previousKasaDevice.sys_info.children?.find(c => c.id === child.id);
              const kasaChild = this.kasaDevice.sys_info.children?.find(c => c.id === child.id);
              if (previousKasaChild && kasaChild) {
                this.log.debug(`Previous state: ${previousKasaChild.state}, Current state: ${child.state} ` +
                  `for child device: ${child.alias}`);
                if (previousKasaChild.state !== child.state) {
                  kasaChild.state = child.state;
                  const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
                  const outletInUseCharacteristic = service.getCharacteristic(this.platform.Characteristic.OutletInUse);
                  this.updateValue(service, onCharacteristic, child.state, child.alias);
                  this.updateValue(service, outletInUseCharacteristic, child.state, child.alias);
                  this.log.debug(`Updated state for child device: ${child.alias} to ${child.state}`);
                } else {
                  this.log.debug(`State unchanged for child device: ${child.alias}`);
                }
              } else {
                this.log.warn(`Child device: ${child.alias} not found in previous or current Kasa device`);
              }
            } else {
              this.log.warn(`Service not found for child device: ${child.alias} or previous Kasa device is undefined`);
            }
          });
        } else {
          const service = this.homebridgeAccessory.getService(this.platform.Service.Outlet);
          if (service && this.previousKasaDevice) {
            const previousRelayState = this.previousKasaDevice.sys_info.state;
            if (previousRelayState !== device.sys_info.state) {
              this.kasaDevice.sys_info.state = device.sys_info.state;
              const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
              const outletInUseCharacteristic = service.getCharacteristic(this.platform.Characteristic.OutletInUse);
              this.updateValue(service, onCharacteristic, device.sys_info.state ?? false);
              this.updateValue(service, outletInUseCharacteristic, device.sys_info.state ?? false);
              this.log.debug(`Updated state for device: ${this.name} to ${device.sys_info.state}`);
            } else {
              this.log.debug(`State unchanged for device: ${this.name}`);
            }
          } else {
            this.log.warn(`Service not found for device: ${this.name} or previous Kasa device is undefined`);
          }
        }
      } else {
        this.log.warn('Device not found, skipping state update');
      }
      this.log.debug('Device state updated successfully');
    } catch (error) {
      this.log.error('Error updating device state:', error);
    } finally {
      this.isUpdating = false;
    }
  }

  private startPolling() {
    this.log.debug('Starting polling for device state updates');
    setInterval(this.updateState.bind(this), this.platform.config.discoveryOptions.pollingInterval);
  }
}