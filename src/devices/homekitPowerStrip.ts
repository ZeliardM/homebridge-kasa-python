import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import HomeKitDevice from './index.js';
import { deferAndCombine } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { ChildDevice, KasaDevice, PowerStrip, SysInfo } from './kasaDevices.js';

export default class HomeKitDevicePowerStrip extends HomeKitDevice {
  public isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<void>;
  private pollingInterval: NodeJS.Timeout | undefined;

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: PowerStrip,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
      'OUTLET',
    );
    this.log.debug(`Initializing HomeKitDevicePowerStrip for device: ${kasaDevice.sys_info.alias}`);
    this.kasaDevice.sys_info.children?.forEach((child: ChildDevice, index: number) => {
      this.checkService(child, index);
    });

    this.getSysInfo = deferAndCombine(async () => {
      if (this.deviceManager) {
        this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
        this.kasaDevice.sys_info = await this.deviceManager.getSysInfo(this.deviceConfig) as SysInfo;
        this.log.debug(`Updated sys_info for device: ${this.kasaDevice.sys_info.alias}`);
      } else {
        this.log.warn('Device manager is not available');
      }
    }, platform.config.advancedOptions.waitTimeUpdate);

    this.startPolling();
  }

  private checkService(child: ChildDevice, index: number) {
    const { Outlet } = this.platform.Service;
    const service: Service =
      this.homebridgeAccessory.getServiceById(Outlet, `outlet-${index + 1}`) ??
      this.addService(Outlet, child.alias, `outlet-${index + 1}`);
    this.checkCharacteristics(service, child);
    return service;
  }

  private checkCharacteristics(service: Service, child: ChildDevice) {
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
      this.getOrAddCharacteristic(service, type, name, child);
    });
  }

  private getOrAddCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ) {
    const characteristic: Characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, service, characteristicType, characteristicName, child));
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, characteristicName, child));
    }
    return service;
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ): Promise<CharacteristicValue> {
    try {
      if (this.kasaDevice.offline) {
        this.log.warn(`Device is offline, cannot get value for characteristic ${characteristicName}`);
        return false;
      }

      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (!characteristicValue) {
        characteristicValue = this.getInitialValue(characteristicType, child);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      this.log.debug(`Got value for characteristic ${characteristicName}: ${characteristicValue}`);
      return characteristicValue ?? false;
    } catch (error) {
      this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
      this.kasaDevice.offline = true;
      this.stopPolling();
    }
    return false;
  }

  private getInitialValue(characteristicType: WithUUID<new () => Characteristic>, child: ChildDevice): CharacteristicValue {
    if (characteristicType === this.platform.Characteristic.On || characteristicType === this.platform.Characteristic.OutletInUse) {
      return child.state ?? false;
    }
    return false;
  }

  private async handleOnSet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
    value: CharacteristicValue,
  ): Promise<void> {
    if (this.kasaDevice.offline) {
      this.log.warn(`Device is offline, cannot set value for characteristic ${characteristicName}`);
      return;
    }

    if (this.deviceManager) {
      try {
        this.isUpdating = true;
        this.log.debug(`Setting value for characteristic ${characteristicName} to ${value}`);

        const characteristicMap: { [key: string]: string } = {
          On: 'state',
        };

        const characteristicKey = characteristicMap[characteristicName ?? ''];
        if (!characteristicKey) {
          throw new Error(`Characteristic key not found for ${characteristicName}`);
        }

        const childNumber = parseInt(child.id.slice(-1), 10);
        await this.deviceManager.controlDevice(this.deviceConfig, characteristicKey, value, childNumber);
        (child[characteristicKey as keyof ChildDevice] as unknown as CharacteristicValue) = value;

        const childIndex = this.kasaDevice.sys_info.children?.findIndex(c => c.id === child.id);
        if (childIndex !== undefined && childIndex !== -1) {
          this.kasaDevice.sys_info.children![childIndex] = { ...child };
        }

        this.updateValue(service, service.getCharacteristic(characteristicType), child.alias, value);
        this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.alias, value);

        this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
        this.log.debug(`Set value for characteristic ${characteristicName} to ${value} successfully`);
      } catch (error) {
        this.log.error(`Error setting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
        this.kasaDevice.offline = true;
        this.stopPolling();
      } finally {
        this.isUpdating = false;
      }
    } else {
      throw new Error('Device manager is undefined.');
    }
  }

  protected async updateState() {
    if (this.kasaDevice.offline) {
      this.stopPolling();
      return;
    }
    if (this.isUpdating || this.platform.periodicDeviceDiscovering) {
      return;
    }
    this.isUpdating = true;
    try {
      await this.getSysInfo();
      this.kasaDevice.sys_info.children?.forEach((child: ChildDevice) => {
        const childNumber = parseInt(child.id.slice(-1), 10);
        const service = this.homebridgeAccessory.getServiceById(this.platform.Service.Outlet, `outlet-${childNumber + 1}`);
        if (service && this.previousKasaDevice) {
          const previousChild = this.previousKasaDevice.sys_info.children?.find(c => c.id === child.id);
          if (previousChild) {
            if (previousChild.state !== child.state) {
              this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), child.alias, child.state);
              this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.alias, child.state);
              this.log.debug(`Updated state for child device: ${child.alias} to ${child.state}`);
            }
          }
        } else {
          this.log.warn(`Service not found for child device: ${child.alias} or previous Kasa device is undefined`);
        }
      });
    } catch (error) {
      this.log.error('Error updating device state:', error);
      this.kasaDevice.offline = true;
      this.stopPolling();
    } finally {
      this.isUpdating = false;
    }
  }

  public startPolling() {
    if (this.kasaDevice.offline) {
      this.stopPolling();
      return;
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.log.debug('Starting polling for device:', this.name);
    this.pollingInterval = setInterval(async () => {
      if (this.kasaDevice.offline) {
        if (this.isUpdating) {
          this.isUpdating = false;
        }
        this.stopPolling();
      } else {
        await this.updateState();
      }
    }, this.platform.config.discoveryOptions.pollingInterval);
  }

  public stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
      this.log.debug('Stopped polling');
    }
  }

  identify(): void {
    this.log.info('identify');
  }
}