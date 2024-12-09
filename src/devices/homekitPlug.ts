import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import HomekitDevice from './index.js';
import { deferAndCombine } from '../utils.js';
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
    this.checkService();

    this.getSysInfo = deferAndCombine(async () => {
      if (this.deviceManager) {
        this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
        this.kasaDevice.sys_info = await this.deviceManager.getSysInfo(this.deviceConfig) as SysInfo;
      } else {
        this.log.warn('Device manager is not available');
      }
    }, platform.config.waitTimeUpdate);

    this.startPolling();
  }

  private checkService() {
    const { Outlet } = this.platform.Service;
    const service: Service =
      this.homebridgeAccessory.getService(Outlet) ?? this.addService(Outlet, this.name);
    this.checkCharacteristics(service);
    return service;
  }

  private checkCharacteristics(service: Service) {
    const characteristics = [
      {
        type: this.platform.Characteristic.On,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.On),
      },
      {
        type: this.platform.Characteristic.OutletInUse,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.OutletInUse),
      },
    ].filter(Boolean) as { type: WithUUID<new () => Characteristic>; name: string | undefined }[];

    characteristics.forEach(({ type, name }) => {
      this.getOrAddCharacteristic(service, type, name);
    });
  }

  private getOrAddCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ) {
    const characteristic: Characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, service, characteristicType, characteristicName));
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, characteristicName));
    }
    return service;
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ): Promise<CharacteristicValue> {
    try {
      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (!characteristicValue) {
        characteristicValue = this.getInitialValue(characteristicType);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      return characteristicValue ?? false;
    } catch (error) {
      this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${this.name}:`, error);
    }
    return false;
  }

  private getInitialValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    if (characteristicType === this.platform.Characteristic.On || characteristicType === this.platform.Characteristic.OutletInUse) {
      return this.kasaDevice.sys_info.state ?? false;
    }
    return false;
  }

  private async handleOnSet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    value: CharacteristicValue,
  ): Promise<void> {
    if (this.deviceManager) {
      try {
        this.isUpdating = true;

        const characteristicMap: { [key: string]: string } = {
          On: 'state',
        };

        const characteristicKey = characteristicMap[characteristicName ?? ''];
        if (!characteristicKey) {
          throw new Error(`Characteristic key not found for ${characteristicName}`);
        }

        await this.deviceManager.controlDevice(this.deviceConfig, characteristicKey, value);
        (this.kasaDevice.sys_info as unknown as Record<string, CharacteristicValue>)[characteristicKey] = value;

        this.updateValue(service, service.getCharacteristic(characteristicType), this.name, value);
        this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), this.name, value);

        this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
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
      await this.getSysInfo();
      const service = this.homebridgeAccessory.getService(this.platform.Service.Outlet);
      if (service && this.previousKasaDevice) {
        const { state } = this.kasaDevice.sys_info;
        const prevState = this.previousKasaDevice.sys_info;

        if (prevState.state !== state) {
          this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), this.name, state ?? false);
          this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), this.name, state ?? false);
        }
      } else {
        this.log.warn(`Service not found for device: ${this.name} or previous Kasa device is undefined`);
      }
    } catch (error) {
      this.log.error('Error updating device state:', error);
    } finally {
      this.isUpdating = false;
    }
  }

  private startPolling() {
    setInterval(this.updateState.bind(this), this.platform.config.discoveryOptions.pollingInterval);
  }

  identify(): void {
    this.log.info('identify');
  }
}