import type { API, Logger, MatterAccessory } from 'homebridge';

import { prefixLogger } from '../utils.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings.js';
import type KasaPythonPlatform from '../platform.js';
import type { LightBulb } from './deviceTypes.js';

/**
 * Bulb feature flags, mirroring the booleans computed in HomeKitDeviceLightBulb.
 */
export interface MatterLightBulbFeatures {
  hasBrightness: boolean;
  hasColorTemp: boolean;
  hasHSV: boolean;
}

/**
 * Matter range constants.
 *
 * Matter LevelControl `currentLevel` is 1-254, ColorControl hue/saturation are 0-254.
 * Color temperature is expressed in mireds on both the Matter side and inside this
 * plugin (python-kasa works in Kelvin, but kasaApi.py converts to/from mireds before
 * it ever reaches TypeScript), so color temperature is a clamped pass-through.
 */
const LEVEL_MIN = 1;
const LEVEL_MAX = 254;
const COLOR_MAX = 254;
const MIRED_MIN = 140;
const MIRED_MAX = 500;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Brightness: HomeKit/Kasa percent (0-100) <-> Matter level (1-254).
function pctToLevel(pct: number): number {
  return clamp(Math.round((pct / 100) * (LEVEL_MAX - 1)) + 1, LEVEL_MIN, LEVEL_MAX);
}
function levelToPct(level: number): number {
  // Canonical Matter mapping: level 1 -> 0%, level 254 -> 100%. 0% is handled as
  // "off" by the caller, so the floor here is 0 (not 1).
  return clamp(Math.round(((level - 1) / (LEVEL_MAX - 1)) * 100), 0, 100);
}

// Hue: HomeKit degrees (0-360) <-> Matter hue (0-254).
function degToMatterHue(deg: number): number {
  return clamp(Math.round((deg / 360) * COLOR_MAX), 0, COLOR_MAX);
}
function matterHueToDeg(hue: number): number {
  return clamp(Math.round((hue / COLOR_MAX) * 360), 0, 360);
}

// Saturation: HomeKit percent (0-100) <-> Matter saturation (0-254).
function pctToMatterSat(pct: number): number {
  return clamp(Math.round((pct / 100) * COLOR_MAX), 0, COLOR_MAX);
}
function matterSatToPct(sat: number): number {
  return clamp(Math.round((sat / COLOR_MAX) * 100), 0, 100);
}

function clampMired(mired: number): number {
  return clamp(Math.round(mired), MIRED_MIN, MIRED_MAX);
}

// Enhanced hue is 16-bit (0-65535); normal hue is 8-bit (0-254).
function matterTargetHueToDeg(targetHue: number, isEnhancedHue: boolean): number {
  const span = isEnhancedHue ? 65535 : COLOR_MAX;
  return clamp(Math.round((targetHue / span) * 360), 0, 360);
}

/**
 * Convert a Matter ColorControl XY color to Kasa HSV. `targetX`/`targetY` are 16-bit
 * (0-65535) CIE 1931 chromaticity coordinates. Brightness is carried separately by
 * LevelControl, so luminance Y is fixed at 1.0 and only hue/saturation are derived.
 */
function xyToHueSat(targetX: number, targetY: number): { hue: number; saturation: number } {
  const x = clamp(targetX / 65535, 0, 1);
  const y = clamp(targetY / 65535, 0, 1);
  if (y <= 0) {
    return { hue: 0, saturation: 0 };
  }
  const z = 1 - x - y;
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;

  // CIE XYZ (D65) -> linear sRGB
  let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  let b = X * 0.0557 - Y * 0.2040 + Z * 1.0570;

  // Linear -> gamma-corrected sRGB
  const gamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  r = gamma(r);
  g = gamma(g);
  b = gamma(b);

  // Normalise so the brightest channel is 1 (luminance lives in LevelControl).
  const peak = Math.max(r, g, b);
  if (peak > 0) {
    r /= peak;
    g /= peak;
    b /= peak;
  }
  r = clamp(r, 0, 1);
  g = clamp(g, 0, 1);
  b = clamp(b, 0, 1);

  // sRGB -> HSV (hue 0-360, saturation 0-100)
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }
    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }
  const saturation = max === 0 ? 0 : (delta / max) * 100;
  return { hue: Math.round(hue), saturation: Math.round(saturation) };
}

/**
 * Publishes a Kasa light bulb to Matter alongside its HomeKit (HAP) accessory.
 *
 * Homebridge exposes a Matter Plugin API (`api.matter`) on bridges where Matter is
 * enabled, analogous to `api.hap`. This class registers a single Matter accessory and
 * mirrors the bulb's state into it. It is a no-op on Homebridge 1.x or whenever Matter
 * is not enabled for the bridge — callers guard with {@link MatterLightBulb.isSupported}.
 */
export default class MatterLightBulb {
  private readonly log: Logger;
  private readonly api: API;
  private readonly uuid: string;
  private registered = false;

  constructor(
    private readonly platform: KasaPythonPlatform,
    private readonly kasaDevice: LightBulb,
    private readonly features: MatterLightBulbFeatures,
  ) {
    this.api = platform.api;
    this.log = prefixLogger(platform.log, `[Matter:${kasaDevice.sys_info.alias}]`);
    this.uuid = this.api.matter!.uuid.generate(kasaDevice.sys_info.device_id);
  }

  /**
   * Whether the running Homebridge has Matter enabled for this bridge. Homebridge 1.x
   * does not define `isMatterEnabled`/`matter`, so feature-detect both.
   */
  static isSupported(api: API): boolean {
    return typeof api.isMatterEnabled === 'function' && api.isMatterEnabled() && !!api.matter;
  }

  private get host(): string {
    return this.kasaDevice.sys_info.host;
  }

  private async control(feature: string, value: unknown): Promise<void> {
    const deviceManager = this.platform.deviceManager;
    if (!deviceManager) {
      this.log.warn('Device manager not available; dropping Matter command');
      return;
    }
    try {
      await deviceManager.controlDevice(this.host, feature, value as never);
    } catch (error) {
      this.log.error(`Matter command failed (${feature}):`, error);
    }
  }

  /**
   * Apply a Matter LevelControl target level to the bulb. Matter's level range maps
   * level 1 -> 0% and level 254 -> 100%, and controllers (1Home included) send level 1
   * for a 0% slider. A Kasa bulb cannot be on at 0%, and homebridge's level behavior
   * flips the Matter OnOff state at the minimum but never calls our onOff handler, so
   * 0% must turn the device off here. Any higher level sets brightness, which also
   * powers the bulb on.
   */
  private async applyLevel(level: number | undefined): Promise<void> {
    const pct = levelToPct(level ?? LEVEL_MIN);
    if (pct <= 0) {
      await this.control('state', false);
      return;
    }
    await this.control('brightness', pct);
  }

  private deviceType() {
    const dt = this.api.matter!.deviceTypes;
    if (this.features.hasHSV) {
      return dt.ExtendedColorLight;
    }
    if (this.features.hasColorTemp) {
      return dt.ColorTemperatureLight;
    }
    if (this.features.hasBrightness) {
      return dt.DimmableLight;
    }
    return dt.OnOffLight;
  }

  private buildColorControlState(): Record<string, number> | undefined {
    const { hasColorTemp, hasHSV } = this.features;
    if (!hasColorTemp && !hasHSV) {
      return undefined;
    }
    const sys = this.kasaDevice.sys_info;
    // ExtendedColorLight and ColorTemperatureLight both carry the ColorTemperature
    // feature, whose conformance makes these attributes mandatory. matter.js provides
    // no defaults for them, so they must be set explicitly or registration fails with
    // "Behaviors have errors" / "Matter requires you to set this attribute".
    const state: Record<string, number> = {
      colorTempPhysicalMinMireds: MIRED_MIN,
      colorTempPhysicalMaxMireds: MIRED_MAX,
      coupleColorTempToLevelMinMireds: MIRED_MIN,
      colorTemperatureMireds: clampMired(sys.color_temp ?? MIRED_MAX),
    };
    if (hasHSV && sys.hsv) {
      state.currentHue = degToMatterHue(sys.hsv.hue);
      state.currentSaturation = pctToMatterSat(sys.hsv.saturation);
    }
    // ColorMode: 0 = hue/saturation, 2 = color temperature mireds.
    state.colorMode = hasHSV ? 0 : 2;
    return state;
  }

  private buildAccessory(): MatterAccessory {
    const sys = this.kasaDevice.sys_info;
    const { hasBrightness, hasColorTemp, hasHSV } = this.features;

    const clusters: MatterAccessory['clusters'] = {
      onOff: { onOff: sys.state ?? false },
    };
    if (hasBrightness) {
      clusters!.levelControl = {
        currentLevel: pctToLevel(sys.brightness ?? 1),
        minLevel: LEVEL_MIN,
        maxLevel: LEVEL_MAX,
      };
    }
    const colorState = this.buildColorControlState();
    if (colorState) {
      clusters!.colorControl = colorState;
    }

    const handlers: MatterAccessory['handlers'] = {
      onOff: {
        on: async () => this.control('state', true),
        off: async () => this.control('state', false),
      },
    };
    if (hasBrightness) {
      handlers!.levelControl = {
        moveToLevel: async args => this.applyLevel(args?.level),
        moveToLevelWithOnOff: async args => this.applyLevel(args?.level),
      };
    }
    if (hasColorTemp || hasHSV) {
      handlers!.colorControl = {
        // The bulb applies discrete values, so there is no in-flight transition to
        // stop. A handler must still be registered: homebridge's ColorControl behavior
        // calls this (e.g. after a controller colour change) and throws an unhandled
        // error that crashes the child bridge if no handler exists.
        stopAllColorMovement: async () => {},
        ...(hasColorTemp && {
          moveToColorTemperatureLogic: async args => this.control('color_temp', clampMired(args.colorTemperatureMireds)),
        }),
        ...(hasHSV && {
          moveToHueAndSaturationLogic: async args => this.control('hsv', {
            hue: matterHueToDeg(args.hue),
            saturation: matterSatToPct(args.saturation),
          }),
          moveToHueLogic: async args => this.control('hsv', {
            hue: matterTargetHueToDeg(args.targetHue, args.isEnhancedHue),
            saturation: this.kasaDevice.sys_info.hsv?.saturation ?? 0,
          }),
          moveToSaturationLogic: async args => this.control('hsv', {
            hue: this.kasaDevice.sys_info.hsv?.hue ?? 0,
            saturation: matterSatToPct(args.targetSaturation),
          }),
          // Many controllers (1Home included) represent colour as CIE XY, not hue/sat.
          moveToColorLogic: async args => this.control('hsv', xyToHueSat(args.targetX, args.targetY)),
        }),
      };
    }

    return {
      UUID: this.uuid,
      displayName: sys.alias,
      deviceType: this.deviceType(),
      serialNumber: sys.mac,
      manufacturer: 'TP-Link',
      model: `${sys.model} ${sys.hw_ver}`,
      firmwareRevision: sys.sw_ver,
      context: {},
      clusters,
      handlers,
    };
  }

  async register(): Promise<void> {
    if (this.registered) {
      return;
    }
    try {
      await this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.buildAccessory()]);
      this.registered = true;
      this.log.info(`Registered Matter accessory (${this.kasaDevice.sys_info.model})`);
    } catch (error) {
      this.log.error('Failed to register Matter accessory:', error);
    }
  }

  /**
   * Pushes the bulb's current Kasa state into its Matter accessory. Called after each
   * poll so changes made outside Matter (Kasa app, HomeKit, automations) are reflected.
   * ColorMode is intentionally left untouched here so the controller keeps whichever
   * mode the user last selected; only the attribute values are updated.
   */
  sync(): void {
    if (!this.registered) {
      return;
    }
    const matter = this.api.matter;
    if (!matter) {
      return;
    }
    const sys = this.kasaDevice.sys_info;
    const updates: Array<Promise<void>> = [
      matter.updateAccessoryState(this.uuid, 'onOff', { onOff: sys.state ?? false }),
    ];
    if (this.features.hasBrightness && sys.brightness !== undefined) {
      updates.push(matter.updateAccessoryState(this.uuid, 'levelControl', { currentLevel: pctToLevel(sys.brightness) }));
    }
    if (this.features.hasColorTemp && sys.color_temp !== undefined) {
      updates.push(matter.updateAccessoryState(this.uuid, 'colorControl', { colorTemperatureMireds: clampMired(sys.color_temp) }));
    }
    if (this.features.hasHSV && sys.hsv) {
      updates.push(matter.updateAccessoryState(this.uuid, 'colorControl', {
        currentHue: degToMatterHue(sys.hsv.hue),
        currentSaturation: pctToMatterSat(sys.hsv.saturation),
      }));
    }
    Promise.all(updates).catch(error => this.log.error('Failed to sync Matter state:', error));
  }
}
