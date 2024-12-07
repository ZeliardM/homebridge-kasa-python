import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import HomekitDevice from './index.js';
import { deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { ChildDevice, KasaDevice, PowerStrip, SysInfo } from './kasaDevices.js';

export default class HomeKitDevicePowerStrip extends HomekitDevice {
  private isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<void>;

  constructor(
    platform: KasaPythonPlatform,
    protected kasaDevice: PowerStrip,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
      'OUTLET',
    );
    this.log.debug(`Initializing HomeKitDevicePowerStrip for device: ${kasaDevice.sys_info.alias}`);
    this.kasaDevice.sys_info.children?.forEach((child: ChildDevice, index: number) => {
      this.log.debug(`Adding outlet service for child device: ${child.alias}`);
      this.addOutletService(child, index);
    });

    this.getSysInfo = deferAndCombine(async (requestCount: number) => {
      this.log.debug(`Executing deferred getSysInfo count: ${requestCount}`);
      if (this.deviceManager) {
        this.log.debug('Fetching new SysInfo from device manager');
        this.previousKasaDevice = this.kasaDevice;
        this.kasaDevice.sys_info = await this.deviceManager.getSysInfo(this.deviceConfig) as SysInfo;
        this.log.debug('Updated SysInfo from device manager');
      } else {
        this.log.warn('Device manager is not available');
      }
    }, platform.config.waitTimeUpdate);

    this.startPolling();
  }

  private addOutletService(child: ChildDevice, index: number) {
    const { Outlet } = this.platform.Service;
    const outletService: Service =
      this.homebridgeAccessory.getServiceById(Outlet, `outlet-${index + 1}`) ??
      this.addService(Outlet, child.alias, `outlet-${index + 1}`);

    this.log.debug(`Adding characteristics for outlet service: ${child.alias}`);
    this.addCharacteristic(outletService, this.platform.Characteristic.On, child);
    this.addCharacteristic(outletService, this.platform.Characteristic.OutletInUse, child);

    return outletService;
  }

  identify(): void {
    this.log.info('identify');
  }

  private addCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    child: ChildDevice,
  ) {
    const alias = child.alias;
    this.log.debug(`Adding characteristic ${this.platform.getCharacteristicName(characteristicType)} for device: ${alias}`);
    const characteristic: Characteristic = getOrAddCharacteristic(service, characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, characteristicType, child));
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, child));
    }
    return service;
  }

  private async handleOnGet(characteristicType: WithUUID<new () => Characteristic>, child: ChildDevice): Promise<CharacteristicValue> {
    const characteristicName = this.platform.getCharacteristicName(characteristicType);
    if (!characteristicName) {
      throw new Error('Characteristic name is undefined');
    }
    this.log.debug(`Getting current value for characteristic ${characteristicName} for device: ${child.alias}`);
    try {
      const characteristicValue = this.getCharacteristicValue(characteristicType, child);
      this.log.debug(`Current Value of ${characteristicName} is: ${characteristicValue} for ${child.alias}`);
      return characteristicValue ?? false;
    } catch (error) {
      this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
    }
    return false;
  }

  private getCharacteristicValue(
    characteristicType: WithUUID<new () => Characteristic>,
    child: ChildDevice,
  ): CharacteristicValue | undefined {
    const characteristicMap: { [key: string]: keyof ChildDevice } = {
      On: 'state',
      OutletInUse: 'state',
    };

    const characteristicKey = characteristicMap[characteristicType.name];
    const childDevice = this.kasaDevice.sys_info.children?.find(c => c.id === child.id);
    const value = childDevice ? childDevice[characteristicKey as keyof ChildDevice] : undefined;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return value;
    }

    return undefined;
  }

  private async handleOnSet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    child: ChildDevice,
    value: CharacteristicValue,
  ): Promise<void> {
    const characteristicName = this.platform.getCharacteristicName(characteristicType);
    if (!characteristicName) {
      throw new Error('Characteristic name is undefined');
    }
    this.log.info(`Setting ${characteristicName} to: ${value} for ${child.alias}`);
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

        const childNumber = parseInt(child.id.slice(-1), 10);
        await this.deviceManager.controlDevice(this.deviceConfig, characteristicKey, value, childNumber);
        const kasaChild = this.kasaDevice.sys_info.children?.find(c => c.id === child.id);
        if (kasaChild) {
          (kasaChild[characteristicKey as keyof ChildDevice] as unknown as CharacteristicValue) = value;
        }

        this.previousKasaDevice = this.kasaDevice;
        this.updateValue(service, service.getCharacteristic(characteristicType), value);
        this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), value);
        this.log.debug(`Successfully set ${characteristicName} to ${value} for ${child.alias}`);
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
      this.log.debug('Device found, updating state');
      this.kasaDevice.sys_info.children?.forEach(async (child: ChildDevice) => {
        const childNumber = parseInt(child.id.slice(-1), 10);
        this.log.debug(`Processing child device: ${child.alias} with child number: ${childNumber}`);
        const service = this.homebridgeAccessory.getServiceById(this.platform.Service.Outlet, `outlet-${childNumber + 1}`);
        if (service && this.previousKasaDevice) {
          this.log.debug(`Service found for child device: ${child.alias}`);
          const previousChild = this.previousKasaDevice.sys_info.children?.find(c => c.id === child.id);
          if (previousChild && previousChild.state !== child.state) {
            this.log.debug('Updating child devicestate');
            this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), child.state);
            this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.state);
            this.log.debug(`Updated state for child device: ${child.alias} to ${child.state}`);
          } else {
            this.log.debug(`State unchanged for child device: ${child.alias}`);
          }
        } else {
          this.log.warn(`Service not found for child device: ${child.alias} or previous Kasa device is undefined`);
        }
      });
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
