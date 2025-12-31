import { Categories } from 'homebridge';

import HomeKitParentDevice from './baseParent.js';
import {
  buildBrightnessDescriptor,
  buildFanActiveDescriptor,
  buildFanRotationDescriptor,
  buildOnDescriptor,
} from './descriptorHelpers.js';
import type KasaPythonPlatform from '../platform.js';
import type { CharacteristicDescriptor, ChildDevice, Switch } from './deviceTypes.js';

export default class HomeKitDeviceSwitchWithChildren extends HomeKitParentDevice {
  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: Switch,
  ) {
    super(platform, kasaDevice, Categories.SWITCH, 'SWITCH');
    this.setupChildServices();
  }

  public async initialize(): Promise<void> {
    await this.startPolling();
  }

  protected getChildServiceType(child: ChildDevice) {
    const { Lightbulb, Fanv2 } = this.platform.Service;
    return child.fan_speed_level !== undefined ? Fanv2 : Lightbulb;
  }

  protected buildChildDescriptors(child: ChildDevice): CharacteristicDescriptor[] {
    const C = this.platform.Characteristic;
    const descriptors: CharacteristicDescriptor[] = [];

    if (child.fan_speed_level !== undefined) {
      descriptors.push(
        buildFanActiveDescriptor(
          C,
          async (active, context) => {
            const idx = this.extractChildIndex(context.child ?? {});
            await this.deviceManager!.controlDevice(context.device.host, 'state', active, idx);
          },
        ),
        buildFanRotationDescriptor(
          C,
          async (percent, context) => {
            const idx = this.extractChildIndex(context.child ?? {});
            await this.deviceManager!.controlDevice(context.device.host, 'fan_speed_level', percent, idx);
          },
        ),
      );
    }

    if (child.brightness !== undefined) {
      descriptors.push(
        buildOnDescriptor(
          C,
          async (value, context) => {
            const idx = this.extractChildIndex(context.child ?? {});
            await this.deviceManager!.controlDevice(context.device.host, 'state', value, idx);
          },
        ),
        buildBrightnessDescriptor(
          C,
          async (value, context) => {
            const idx = this.extractChildIndex(context.child ?? {});
            await this.deviceManager!.controlDevice(context.device.host, 'brightness', value, idx);
          },
        ),
      );
    }

    return descriptors;
  }

  public identify(): void {
    this.log.info('identify');
  }
}