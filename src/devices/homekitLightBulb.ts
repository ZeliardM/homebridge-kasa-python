import { Categories } from 'homebridge';
import type { AdaptiveLightingController } from 'homebridge';

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
  private readonly adaptiveLightingColorModeTemperature = 140;
  private hasBrightness: boolean;
  private hasColorTemp: boolean;
  private hasHSV: boolean;
  private adaptiveLightingController?: AdaptiveLightingController;

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
    this.setupAdaptiveLighting();
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
      { debouncePolls: 2 },
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
          this.syncHueSaturationFromColorTemperature(Number(value), context.alias);
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

  protected async updateAllServicesAndCharacteristics(forceUpdate: boolean): Promise<void> {
    const previousColorTemp = this.previousSnapshot?.sys_info.color_temp;
    const previousHue = this.previousSnapshot?.sys_info.hsv?.hue;
    const previousSaturation = this.previousSnapshot?.sys_info.hsv?.saturation;

    await super.updateAllServicesAndCharacteristics(forceUpdate);

    if (!this.adaptiveLightingController?.isAdaptiveLightingActive() || forceUpdate) {
      return;
    }

    const currentColorTemp = this.kasaDevice.sys_info.color_temp;
    const currentHue = this.kasaDevice.sys_info.hsv?.hue;
    const currentSaturation = this.kasaDevice.sys_info.hsv?.saturation;
    const colorChanged = previousColorTemp !== currentColorTemp;
    const hueChanged = previousHue !== currentHue;
    const saturationChanged = previousSaturation !== currentSaturation;

    if (colorChanged || hueChanged || saturationChanged) {
      this.log.debug('Disabling Adaptive Lighting due to external color state change');
      this.adaptiveLightingController.disableAdaptiveLighting();
    }
  }

  private setupAdaptiveLighting(): void {
    if (!this.primaryService || !this.hasBrightness || !this.hasColorTemp || this.adaptiveLightingController) {
      return;
    }

    const controller = new this.platform.api.hap.AdaptiveLightingController(this.primaryService);
    this.homebridgeAccessory.configureController(controller);
    this.adaptiveLightingController = controller;
  }

  private syncHueSaturationFromColorTemperature(colorTemperature: number, alias: string): void {
    if (!this.primaryService || !this.hasHSV) {
      return;
    }

    const { hue, saturation } = this.platform.api.hap.ColorUtils.colorTemperatureToHueAndSaturation(colorTemperature);
    this.kasaDevice.sys_info.hsv = { hue, saturation };

    this.updateValue(
      this.primaryService,
      this.primaryService.getCharacteristic(this.platform.Characteristic.Hue),
      alias,
      hue,
      false,
    );
    this.updateValue(
      this.primaryService,
      this.primaryService.getCharacteristic(this.platform.Characteristic.Saturation),
      alias,
      saturation,
      false,
    );
  }

  private cacheColorTemperatureForColorMode(): void {
    if (!this.primaryService || !this.hasColorTemp) {
      return;
    }

    this.kasaDevice.sys_info.color_temp = this.adaptiveLightingColorModeTemperature;
    this.primaryService.getCharacteristic(this.platform.Characteristic.ColorTemperature).value =
      this.adaptiveLightingColorModeTemperature;
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
      this.cacheColorTemperatureForColorMode();
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
