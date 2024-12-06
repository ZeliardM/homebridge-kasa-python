import { Categories } from 'homebridge';
import type { Service } from 'homebridge';

import HomekitDevice from './index.js';
import type KasaPythonPlatform from '../platform.js';
import type { LightBulb } from './kasaDevices.js';

export default class HomeKitDeviceLightBulb extends HomekitDevice {
  private hasBrightness: boolean;
  private hasColorTemp: boolean;
  private hasHSV: boolean;

  constructor(
    platform: KasaPythonPlatform,
    protected kasaDevice: LightBulb,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.LIGHTBULB,
      'LIGHTBULB',
    );
    this.log.debug(`Initializing HomeKitDeviceLightBulb for device: ${kasaDevice.sys_info.alias}`);
    this.hasBrightness = !!this.kasaDevice.feature_info.brightness;
    this.hasColorTemp = !!this.kasaDevice.feature_info.color_temp;
    this.hasHSV = !!this.kasaDevice.feature_info.hsv;
    this.addLightBulbService();
  }

  private addLightBulbService() {
    const { Lightbulb } = this.platform.Service;

    const lightbulbService: Service =
      this.homebridgeAccessory.getService(Lightbulb) ?? this.addService(Lightbulb, this.name);

    this.log.debug(`Adding characteristics for lightbulb service: ${this.name}`);
    if (this.hasBrightness) {
      this.addCharacteristic(lightbulbService, this.platform.Characteristic.Brightness);
    } else if (this.hasColorTemp) {
      this.addCharacteristic(lightbulbService, this.platform.Characteristic.ColorTemperature);
    } else if (this.hasHSV) {
      this.addCharacteristic(lightbulbService, this.platform.Characteristic.Hue);
      this.addCharacteristic(lightbulbService, this.platform.Characteristic.Saturation);
    }
    this.addCharacteristic(lightbulbService, this.platform.Characteristic.On);

    return lightbulbService;
  }

  identify(): void {
    this.log.info('identify');
  }
}