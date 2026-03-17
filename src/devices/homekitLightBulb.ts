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
  private hsvFlushInProgress: boolean = false;
  private hsvWaiters: Array<{ resolve: () => void; reject: (error?: unknown) => void }> = [];

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
    const hsvSyncGroup = 'hsv';

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

          const promise = new Promise<void>((resolve, reject) => {
            this.hsvWaiters.push({ resolve, reject });
          });

          this.scheduleHSVFlush(context.device.host);

          await promise;
        },
        hsvSyncGroup,
      ));
    }

    return list;
  }

  private scheduleHSVFlush(host: string): void {
    if (this.hsvFlushInProgress) {
      return;
    }

    if (this.hsvFlushTimer) {
      clearTimeout(this.hsvFlushTimer);
    }

    this.hsvFlushTimer = setTimeout(() => {
      void this.flushPendingHSV(host);
    }, 40);
  }

  private async flushPendingHSV(host: string): Promise<void> {
    if (this.hsvFlushInProgress) {
      return;
    }

    const hasPendingHSV = this.pendingHSV.hue !== undefined || this.pendingHSV.saturation !== undefined;
    if (!hasPendingHSV) {
      return;
    }

    this.hsvFlushInProgress = true;
    this.hsvFlushTimer = null;

    const pendingHSV = { ...this.pendingHSV };
    const waiters = this.hsvWaiters;
    this.pendingHSV = {};
    this.hsvWaiters = [];

    const currentHSV = this.kasaDevice.sys_info.hsv ?? { hue: 0, saturation: 0 };
    const hue = pendingHSV.hue ?? currentHSV.hue ?? 0;
    const saturation = pendingHSV.saturation ?? currentHSV.saturation ?? 0;

    try {
      await this.deviceManager!.controlDevice(host, 'hsv', { hue, saturation });
      this.kasaDevice.sys_info.hsv = { hue, saturation };
      waiters.forEach(waiter => waiter.resolve());
    } catch (error) {
      waiters.forEach(waiter => waiter.reject(error));
      throw error;
    } finally {
      this.hsvFlushInProgress = false;

      if (this.pendingHSV.hue !== undefined || this.pendingHSV.saturation !== undefined) {
        this.scheduleHSVFlush(host);
      }
    }
  }

  public identify(): void {
    this.log.info('identify');
  }
}