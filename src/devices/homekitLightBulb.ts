import { Categories } from 'homebridge';

import HomeKitDevice from './baseDevice.js';
import {
  buildBrightnessDescriptor,
  buildColorTemperatureDescriptor,
  buildHSVDescriptors,
  buildOnDescriptor,
} from './descriptorHelpers.js';
import type KasaPythonPlatform from '../platform.js';
import type { CharacteristicDescriptor, DescriptorContext, LightBulb } from './deviceTypes.js';

export default class HomeKitDeviceLightBulb extends HomeKitDevice {
  private hasBrightness: boolean;
  private hasColorTemp: boolean;
  private hasHSV: boolean;

  private pendingHSV: { hue?: number; saturation?: number } = {};
  private hsvFlushTimer: NodeJS.Timeout | null = null;

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: LightBulb,
  ) {
    super(platform, kasaDevice, Categories.LIGHTBULB, 'LIGHTBULB');
    this.hasBrightness = !!kasaDevice.feature_info.brightness;
    this.hasColorTemp = !!kasaDevice.feature_info.color_temp;
    this.hasHSV = !!kasaDevice.feature_info.hsv;
    this.setupPrimaryService();
  }

  public async initialize(): Promise<void> {
    await this.startPolling();
  }

  protected getPrimaryServiceType() {
    return this.platform.Service.Lightbulb;
  }

  protected buildPrimaryDescriptors(): CharacteristicDescriptor[] {
    const C = this.platform.Characteristic;

    const onDescriptor = buildOnDescriptor(
      C,
      async (value, context) => {
        await this.deviceManager!.controlDevice(context.device.host, 'state', value);
      },
    );

    const list: CharacteristicDescriptor[] = [onDescriptor];

    if (this.hasBrightness) {
      list.push(buildBrightnessDescriptor(
        C,
        async (value, context) => {
          await this.deviceManager!.controlDevice(context.device.host, 'brightness', value);
        },
      ));
    }

    if (this.hasColorTemp) {
      list.push(buildColorTemperatureDescriptor(
        C,
        async (value, context) => {
          await this.deviceManager!.controlDevice(context.device.host, 'color_temp', value);
        },
      ));
    }

    if (this.hasHSV) {
      list.push(...buildHSVDescriptors(
        C,
        async (partial: { hue?: number; saturation?: number }, context: DescriptorContext) => {
          Object.assign(this.pendingHSV, partial);
          if (this.hsvFlushTimer) {
            clearTimeout(this.hsvFlushTimer);
          }
          const host = context.device.host;
          const baseHue = this.kasaDevice.sys_info.hsv?.hue ?? 0;
          const baseSat = this.kasaDevice.sys_info.hsv?.saturation ?? 0;

          this.hsvFlushTimer = setTimeout(async () => {
            const hue = this.pendingHSV.hue ?? baseHue;
            const saturation = this.pendingHSV.saturation ?? baseSat;
            try {
              await this.deviceManager!.controlDevice(host, 'hsv', { hue, saturation });
              context.device.hsv = { hue, saturation };
              this.kasaDevice.sys_info.hsv = { hue, saturation };
            } catch (error) {
              this.log.error('HSV flush error', error);
            } finally {
              this.pendingHSV = {};
            }
          }, 40);
        },
      ));
    }

    return list;
  }

  protected async updateAllServicesAndCharacteristics(forceUpdate: boolean): Promise<void> {
    await super.updateAllServicesAndCharacteristics(forceUpdate);
  }

  public identify(): void {
    this.log.info('identify');
  }
}