import { Categories } from 'homebridge';
import type { Service, Characteristic, CharacteristicValue, WithUUID } from 'homebridge';

import HomekitDevice from './index.js';
import { deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, Switch, SysInfo } from './kasaDevices.js';

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
      'SWITCH',
    );
    this.log.debug(`Initializing HomeKitDeviceSwitch for device: ${kasaDevice.sys_info.alias}`);
    this.addSwitchService();

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

  private addSwitchService() {
    const { Switch } = this.platform.Service;

    const switchService: Service =
      this.homebridgeAccessory.getService(Switch) ?? this.addService(Switch, this.name);

    this.log.debug(`Adding characteristics for switch service: ${this.name}`);
    this.addCharacteristic(switchService, this.platform.Characteristic.On);

    return switchService;
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
          const service = this.homebridgeAccessory.getService(this.platform.Service.Switch);
          if (service) {
            const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
            this.updateValue(service, onCharacteristic, value);
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
      const device = await this.getSysInfo() as Switch;
      if (device) {
        this.log.debug('Device found, updating state');
        const service = this.homebridgeAccessory.getService(this.platform.Service.Switch);
        if (service && this.previousKasaDevice) {
          const previousRelayState = this.previousKasaDevice.sys_info.state;
          if (previousRelayState !== device.sys_info.state) {
            this.kasaDevice.sys_info.state = device.sys_info.state;
            const onCharacteristic = service.getCharacteristic(this.platform.Characteristic.On);
            this.updateValue(service, onCharacteristic, device.sys_info.state ?? false);
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