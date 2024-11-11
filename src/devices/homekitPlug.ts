import { Categories } from 'homebridge';
import type { Service, Characteristic, CharacteristicValue, WithUUID } from 'homebridge';

import HomekitDevice from './index.js';
import { deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, Plug } from './kasaDevices.js';

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
    this.addOutletService();

    this.getSysInfo = deferAndCombine(async (requestCount: number) => {
      this.log.debug(`executing deferred getSysInfo count: ${requestCount}`);
      if (this.deviceManager) {
        const newKasaDevice = await this.deviceManager.getSysInfo(this) as Plug;
        this.previousKasaDevice = this.kasaDevice;
        this.kasaDevice = newKasaDevice;
        this.kasaDevice.alias = this.previousKasaDevice.alias;
        return this.kasaDevice;
      }
      return undefined;
    }, platform.config.waitTimeUpdate);

    this.startPolling();
  }

  private addOutletService() {
    const { Outlet } = this.platform.Service;

    const outletService: Service =
      this.homebridgeAccessory.getService(Outlet) ?? this.addService(Outlet, this.name);

    this.addCharacteristic(outletService, this.platform.Characteristic.On);
    this.addCharacteristic(outletService, this.platform.Characteristic.OutletInUse);

    return outletService;
  }

  private addCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
  ) {
    const characteristic: Characteristic = getOrAddCharacteristic(service, characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, characteristicType));
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this));
    }

    return service;
  }

  private async handleOnGet(characteristicType: WithUUID<new () => Characteristic>): Promise<CharacteristicValue> {
    try {
      const stateValue = this.kasaDevice.sys_info.relay_state === 1;
      const characteristicName = this.platform.getCharacteristicName(characteristicType);

      this.log.debug(`Current State of ${characteristicName} is: ${stateValue} for ${this.name}`);

      return this.kasaDevice.sys_info.relay_state ?? 0;
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
          await this.deviceManager.toggleDevice(this, value);
          this.kasaDevice.sys_info.relay_state = value ? 1 : 0;
          this.previousKasaDevice = this.kasaDevice;
          const service = this.homebridgeAccessory.getService(this.platform.Service.Outlet);
          if (service) {
            const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
            const outletInUseCharacteristic = service.getCharacteristic(this.platform.Characteristic.OutletInUse);
            this.updateValue(service, onCharacteristic, value);
            this.updateValue(service, outletInUseCharacteristic, value);
          }
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
      return;
    }
    this.isUpdating = true;
    try {
      const device = await this.getSysInfo() as Plug;
      if (device) {
        const service = this.homebridgeAccessory.getService(this.platform.Service.Outlet);
        if (service && this.previousKasaDevice) {
          const previousRelayState = this.previousKasaDevice.sys_info.relay_state;
          if (previousRelayState !== device.sys_info.relay_state) {
            this.kasaDevice.sys_info.relay_state = device.sys_info.relay_state;
            const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
            const outletInUseCharacteristic = service.getCharacteristic(this.platform.Characteristic.OutletInUse);
            this.updateValue(service, onCharacteristic, device.sys_info.relay_state === 1);
            this.updateValue(service, outletInUseCharacteristic, device.sys_info.relay_state === 1);
          }
        }
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