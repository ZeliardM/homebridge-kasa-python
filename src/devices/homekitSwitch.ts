import { Categories } from 'homebridge';

import HomeKitDevice from './baseDevice.js';
import {
  buildBrightnessDescriptor,
  buildOnDescriptor,
} from './descriptorHelpers.js';
import type KasaPythonPlatform from '../platform.js';
import type { CharacteristicDescriptor, Switch } from './deviceTypes.js';

export default class HomeKitDeviceSwitch extends HomeKitDevice {
  private hasBrightness: boolean;

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: Switch,
  ) {
    super(platform, kasaDevice, Categories.SWITCH, 'SWITCH');
    this.hasBrightness = !!kasaDevice.feature_info.brightness;
    this.setupPrimaryService();
  }

  public async initialize(): Promise<void> {
    await this.startPolling();
  }

  protected getPrimaryServiceType() {
    const { Switch, Lightbulb } = this.platform.Service;
    return this.hasBrightness ? Lightbulb : Switch;
  }

  protected buildPrimaryDescriptors(): CharacteristicDescriptor[] {
    const C = this.platform.Characteristic;

    const list: CharacteristicDescriptor[] = [
      buildOnDescriptor(
        C,
        async (value, context) => {
          await this.deviceManager!.controlDevice(context.device.host, 'state', value);
        },
      ),
    ];

    if (this.hasBrightness) {
      list.push(buildBrightnessDescriptor(
        C,
        async (value, context) => {
          await this.deviceManager!.controlDevice(context.device.host, 'brightness', value);
        },
      ));
    }

    return list;
  }

  public identify(): void {
    this.log.info('identify');
  }
}