import { Categories } from 'homebridge';
import type { Service, Characteristic, CharacteristicValue, WithUUID } from 'homebridge';

import HomekitDevice from './index.js';
import { deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, Switch } from './kasaDevices.js';

export default class HomeKitDeviceSwitch extends HomekitDevice {
  private getSysInfo: () => Promise<KasaDevice | undefined>;
  private previousKasaDevice: Switch | undefined;
  private isUpdating: boolean = false;

  constructor(
    platform: KasaPythonPlatform,
    protected kasaDevice: Switch,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.SWITCH,
    );
    this.addSwitchService();

    this.getSysInfo = deferAndCombine(async (requestCount: number) => {
      this.log.debug(`executing deferred getSysInfo count: ${requestCount}`);
      if (this.deviceManager) {
        const newKasaDevice = await this.deviceManager.getSysInfo(this) as Switch;
        this.previousKasaDevice = this.kasaDevice;
        this.kasaDevice = newKasaDevice;
        this.kasaDevice.alias = this.previousKasaDevice.alias;
        return this.kasaDevice;
      }
      return undefined;
    }, platform.config.waitTimeUpdate);

    this.startPolling();
  }

  private addSwitchService() {
    const { Switch } = this.platform.Service;

    const switchService: Service =
      this.homebridgeAccessory.getService(Switch) ?? this.addService(Switch, this.name);

    this.addCharacteristic(switchService, this.platform.Characteristic.On);

    return switchService;
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
          const service = this.homebridgeAccessory.getService(this.platform.Service.Switch);
          if (service) {
            const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
            this.updateValue(service, onCharacteristic, value);
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
      const device = await this.getSysInfo() as Switch;
      if (device) {
        const service = this.homebridgeAccessory.getService(this.platform.Service.Switch);
        if (service && this.previousKasaDevice) {
          const previousRelayState = this.previousKasaDevice.sys_info.relay_state;
          if (previousRelayState !== device.sys_info.relay_state) {
            this.kasaDevice.sys_info.relay_state = device.sys_info.relay_state;
            const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
            this.updateValue(service, onCharacteristic, device.sys_info.relay_state === 1);
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