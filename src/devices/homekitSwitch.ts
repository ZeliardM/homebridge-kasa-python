import { Categories } from 'homebridge';
import type { Service } from 'homebridge';

import HomekitDevice from './index.js';
import type KasaPythonPlatform from '../platform.js';
import type { Switch } from './kasaDevices.js';

export default class HomeKitDeviceSwitch extends HomekitDevice {
  private hasBrightness: boolean;

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
    this.hasBrightness = !!this.kasaDevice.feature_info.brightness;
    this.addSwitchService();
  }

  private addSwitchService() {
    const { Switch, Lightbulb } = this.platform.Service;

    const serviceType = this.hasBrightness ? Lightbulb : Switch;

    const switchService: Service =
      this.homebridgeAccessory.getService(serviceType) ?? this.addService(serviceType, this.name);

    this.log.debug(`Adding characteristics for ${this.hasBrightness ? 'lightbulb' : 'switch'} service: ${this.name}`);
    if (this.hasBrightness) {
      this.addCharacteristic(switchService, this.platform.Characteristic.Brightness);
    }
    this.addCharacteristic(switchService, this.platform.Characteristic.On);

    return switchService;
  }

  identify(): void {
    this.log.info('identify');
  }
}