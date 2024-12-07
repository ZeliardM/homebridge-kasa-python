import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import HomekitDevice from './index.js';
import { deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, Plug, SysInfo } from './kasaDevices.js';

export default class HomeKitDevicePlug extends HomekitDevice {
  private isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<void>;

  constructor(
    platform: KasaPythonPlatform,
    protected kasaDevice: Plug,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
      'OUTLET',
    );
    this.log.debug(`Initializing HomeKitDevicePlug for device: ${kasaDevice.sys_info.alias}`);
    this.addOutletService();

    this.getSysInfo = deferAndCombine(async (requestCount: number) => {
      this.log.debug(`Executing deferred getSysInfo count: ${requestCount}`);
      if (this.deviceManager) {
        this.log.debug('Fetching new SysInfo from device manager');
        this.previousKasaDevice = this.kasaDevice;
        this.kasaDevice.sys_info = await this.deviceManager.getSysInfo(this.deviceConfig) as SysInfo;;
        this.log.debug('Updated SysInfo from device manager');
      } else {
        this.log.warn('Device manager is not available');
      }
    }, platform.config.waitTimeUpdate);

    this.startPolling();
  }

  private addOutletService() {
    const { Outlet } = this.platform.Service;

    const outletService: Service =
        this.homebridgeAccessory.getService(Outlet) ?? this.addService(Outlet, this.name);

    this.log.debug(`Adding characteristics for outlet service: ${this.name}`);
    this.addCharacteristic(outletService, this.platform.Characteristic.On);
    this.addCharacteristic(outletService, this.platform.Characteristic.OutletInUse);

    return outletService;
  }

  identify(): void {
    this.log.info('identify');
  }

  private addCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
  ) {
    this.log.debug(`Adding characteristic ${this.platform.getCharacteristicName(characteristicType)} for device: ${this.name}`);
    const characteristic: Characteristic = getOrAddCharacteristic(service, characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, characteristicType));
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType));
    }
    return service;
  }

  private async handleOnGet(characteristicType: WithUUID<new () => Characteristic>): Promise<CharacteristicValue> {
    const characteristicName = this.platform.getCharacteristicName(characteristicType);
    if (!characteristicName) {
      throw new Error('Characteristic name is undefined');
    }
    this.log.debug(`Getting current value for characteristic ${characteristicName} for device: ${this.name}`);
    try {
      const characteristicValue = this.getCharacteristicValue(characteristicType);
      this.log.debug(`Current Value of ${characteristicName} is: ${characteristicValue} for ${this.name}`);
      return characteristicValue ?? false;
    } catch (error) {
      this.log.error(
        `Error getting current value for characteristic ${characteristicName} for device: ${this.name}:`,
        error,
      );
    }
    return false;
  }

  private getCharacteristicValue(
    characteristicType: WithUUID<new () => Characteristic>,
  ): CharacteristicValue | undefined {
    const characteristicMap: { [key: string]: keyof SysInfo } = {
      On: 'state',
      OutletInUse: 'state',
    };

    const characteristicKey = characteristicMap[characteristicType.name];
    if (!characteristicKey) {
      this.log.warn(`Characteristic ${characteristicType.name} is not supported`);
      return undefined;
    }

    const value = this.kasaDevice.sys_info[characteristicKey as keyof SysInfo];

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return value;
    }

    return undefined;
  }

  private async handleOnSet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    value: CharacteristicValue,
  ): Promise<void> {
    const characteristicName = this.platform.getCharacteristicName(characteristicType);
    if (!characteristicName) {
      throw new Error('Characteristic name is undefined');
    }
    this.log.info(`Setting ${characteristicName} to: ${value} for ${this.name}`);
    if (this.deviceManager) {
      try {
        this.isUpdating = true;

        const characteristicMap: { [key: string]: string } = {
          On: 'state',
        };

        const characteristicKey = characteristicMap[characteristicName];
        if (!characteristicKey) {
          throw new Error(`Characteristic key not found for ${characteristicName}`);
        }

        await this.deviceManager.controlDevice(this.deviceConfig, characteristicKey, value);
        (this.kasaDevice.sys_info as unknown as Record<string, CharacteristicValue>)[characteristicKey] = value;

        this.previousKasaDevice = this.kasaDevice;
        this.updateValue(service, service.getCharacteristic(characteristicType), value);
        this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), value);
        this.log.debug(`Successfully set ${characteristicName} to ${value} for ${this.name}`);
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
      await this.getSysInfo();
      const service = this.homebridgeAccessory.getService(this.platform.Service.Outlet);
      if (service && this.previousKasaDevice) {
        if (this.previousKasaDevice.sys_info.state !== this.kasaDevice.sys_info.state) {
          this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), this.kasaDevice.sys_info.state ?? false);
          this.updateValue(
            service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), this.kasaDevice.sys_info.state ?? false,
          );
          this.log.debug(`Updated state for device: ${this.name} to ${this.kasaDevice.sys_info.state}`);
        } else {
          this.log.debug(`State unchanged for device: ${this.name}`);
        }
      } else {
        this.log.warn(`Service not found for device: ${this.name} or previous Kasa device is undefined`);
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