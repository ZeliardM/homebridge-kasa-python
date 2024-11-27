import { Categories } from 'homebridge';
import type { Service, Characteristic, CharacteristicValue, WithUUID } from 'homebridge';

import HomekitDevice from './index.js';
import { deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { ChildDevice, KasaDevice, Powerstrip, SysInfo } from './kasaDevices.js';

export default class HomeKitDevicePowerStrip extends HomekitDevice {
  private getSysInfo: () => Promise<KasaDevice | undefined>;
  private previousKasaDevice: Powerstrip | undefined;
  private isUpdating: boolean = false;

  constructor(
    platform: KasaPythonPlatform,
    protected kasaDevice: Powerstrip,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
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
        const newSysInfo = await this.deviceManager.getSysInfo(this) as SysInfo;
        this.previousKasaDevice = this.kasaDevice;
        this.kasaDevice.sys_info = newSysInfo;
        this.log.debug('Updated SysInfo from device manager');
        return this.kasaDevice;
      }
      this.log.warn('Device manager is not available');
      return undefined;
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

  private addCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    child: ChildDevice,
  ) {
    this.log.debug(`Adding characteristic ${this.platform.getCharacteristicName(characteristicType)} for child device: ${child.alias}`);
    const characteristic: Characteristic = getOrAddCharacteristic(service, characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, child, characteristicType));
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this, child));
    }
    return service;
  }

  private async handleOnGet(child: ChildDevice, characteristicType: WithUUID<new () => Characteristic>): Promise<CharacteristicValue> {
    this.log.debug(`Handling OnGet for characteristic ${this.platform.getCharacteristicName(characteristicType)}` +
      ` for child device: ${child.alias}`);
    try {
      const childInfo = this.kasaDevice.sys_info.children?.find((c: ChildDevice) => c.id === child.id);
      if (!childInfo) {
        this.log.warn(`Child with id ${child.id} not found`);
        return false;
      }

      const stateValue = childInfo.state;
      const characteristicName = this.platform.getCharacteristicName(characteristicType);

      this.log.debug(`Current State of ${characteristicName} is: ${stateValue} for ${child.alias}`);

      return childInfo.state;
    } catch (error) {
      this.log.error('Error getting device state:', error);
    }
    return 0;
  }

  private async handleOnSet(child: ChildDevice, value: CharacteristicValue): Promise<void> {
    this.log.info(`Setting On to: ${value} for ${child.alias}`);
    if (typeof value === 'boolean') {
      if (this.deviceManager) {
        const childNumber = parseInt(child.id.slice(-1), 10);
        try {
          this.isUpdating = true;
          this.log.debug(`Toggling device state to ${value} for child number: ${childNumber}`);
          await this.deviceManager.toggleDevice(this, value, childNumber);
          const kasaChild = this.kasaDevice.sys_info.children?.find((c: ChildDevice) => c.id === child.id);
          if (kasaChild) {
            kasaChild.state = value;
          }
          this.previousKasaDevice = this.kasaDevice;
          const service = this.homebridgeAccessory.getServiceById(this.platform.Service.Outlet, `outlet-${childNumber + 1}`);
          if (service) {
            const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
            const outletInUseCharacteristic = service.getCharacteristic(this.platform.Characteristic.OutletInUse);
            this.updateValue(service, onCharacteristic, value);
            this.updateValue(service, outletInUseCharacteristic, value);
          }
          this.log.debug(`Successfully set On to ${value} for ${child.alias}`);
          return;
        } catch (error) {
          this.logRejection(error);
        } finally {
          this.isUpdating = false;
        }
      } else {
        throw new Error('Device manager is undefined.');
      }
    } else {
      this.log.warn('setValue: Invalid On:', value);
      throw new Error(`setValue: Invalid On: ${value}`);
    }
  }

  private async updateState() {
    if (this.isUpdating) {
      this.log.debug('Update already in progress, skipping updateState');
      return;
    }
    this.isUpdating = true;
    try {
      this.log.debug('Updating device state');
      const device = await this.getSysInfo() as Powerstrip;
      if (device) {
        this.log.debug('Device found, updating child devices');
        device.sys_info.children?.forEach(async (child: ChildDevice) => {
          const childNumber = parseInt(child.id.slice(-1), 10);
          this.log.debug(`Processing child device: ${child.alias} with child number: ${childNumber}`);
          const service = this.homebridgeAccessory.getServiceById(this.platform.Service.Outlet, `outlet-${childNumber + 1}`);
          if (service && this.previousKasaDevice) {
            this.log.debug(`Service found for child device: ${child.alias}`);
            const previousKasaChild = this.previousKasaDevice.sys_info.children?.find(c => c.id === child.id);
            const kasaChild = this.kasaDevice.sys_info.children?.find(c => c.id === child.id);
            if (previousKasaChild && kasaChild) {
              this.log.debug(`Previous state: ${previousKasaChild.state}, Current state: ${child.state} for child device: ${child.alias}`);
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
        this.log.warn('Device not found, skipping child device updates');
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

  identify(): void {
    this.log.info('identify');
  }
}