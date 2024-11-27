import { Categories } from 'homebridge';
import type { Service, Characteristic, CharacteristicValue, WithUUID } from 'homebridge';

import HomekitDevice from './index.js';
import { deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, Plug, SysInfo } from './kasaDevices.js';

export default class HomeKitDevicePlug extends HomekitDevice {
  private getSysInfo: () => Promise<KasaDevice | undefined>;
  private previousKasaDevice: Plug | undefined;
  private isUpdating: boolean = false;

  constructor(
    platform: KasaPythonPlatform,
    protected kasaDevice: Plug,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
    );
    this.log.debug(`Initializing HomeKitDevicePlug for device: ${kasaDevice.sys_info.alias}`);
    this.addOutletService();

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

  private addOutletService() {
    const { Outlet } = this.platform.Service;

    const outletService: Service =
      this.homebridgeAccessory.getService(Outlet) ?? this.addService(Outlet, this.name);

    this.log.debug(`Adding characteristics for outlet service: ${this.name}`);
    this.addCharacteristic(outletService, this.platform.Characteristic.On);
    this.addCharacteristic(outletService, this.platform.Characteristic.OutletInUse);

    return outletService;
  }

  private addCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
  ) {
    this.log.debug(`Adding characteristic ${this.platform.getCharacteristicName(characteristicType)} for device: ${this.name}`);
    const characteristic: Characteristic = getOrAddCharacteristic(service, characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, characteristicType));
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this));
    }

    return service;
  }

  private async handleOnGet(characteristicType: WithUUID<new () => Characteristic>): Promise<CharacteristicValue> {
    this.log.debug(`Handling OnGet for characteristic ${this.platform.getCharacteristicName(characteristicType)} for device: ${this.name}`);
    try {
      const stateValue = this.kasaDevice.sys_info.state;
      const characteristicName = this.platform.getCharacteristicName(characteristicType);

      this.log.debug(`Current State of ${characteristicName} is: ${stateValue} for ${this.name}`);

      return this.kasaDevice.sys_info.state ?? false;
    } catch (error) {
      this.log.error('Error getting device state:', error);
    }
    return 0;
  }

  private async handleOnSet(value: CharacteristicValue): Promise<void> {
    this.log.info(`Setting On to: ${value} for ${this.name}`);
    if (typeof value === 'boolean') {
      if (this.deviceManager) {
        try {
          this.isUpdating = true;
          this.log.debug(`Toggling device state to ${value} for device: ${this.name}`);
          await this.deviceManager.toggleDevice(this, value);
          this.kasaDevice.sys_info.state = value;
          this.previousKasaDevice = this.kasaDevice;
          const service = this.homebridgeAccessory.getService(this.platform.Service.Outlet);
          if (service) {
            const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
            const outletInUseCharacteristic = service.getCharacteristic(this.platform.Characteristic.OutletInUse);
            this.updateValue(service, onCharacteristic, value);
            this.updateValue(service, outletInUseCharacteristic, value);
          }
          this.log.debug(`Successfully set On to ${value} for ${this.name}`);
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
      const device = await this.getSysInfo() as Plug;
      if (device) {
        this.log.debug('Device found, updating state');
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
      } else {
        this.log.warn('Device not found, skipping state update');
      }
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