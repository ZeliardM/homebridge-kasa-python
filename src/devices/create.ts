import type { PlatformAccessory } from 'homebridge';

import { KasaPythonConfig } from '../config.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaPythonAccessoryContext } from '../platform.js';
import type { KasaDevice } from '../utils.js';

import HomekitDevice from './index.js';
import HomeKitDevicePlug from './homekitPlug.js';
import HomeKitDevicePowerStrip from './homekitPowerstrip.js';
import type { Plug, Powerstrip } from './kasaDevices.js';

function isPlug(device: KasaDevice): device is Plug {
  return 'children' in device && Array.isArray(device.children) && device.children.length === 0;
}

function isPowerStrip(device: KasaDevice): device is Powerstrip {
  return device.sys_info.child_num !== undefined && device.sys_info.child_num > 1 && Array.isArray(device.sys_info.children);
}

/**
 * Factory method to create a HomeKitDevicePlug or HomeKitDevicePowerstrip.
 */
export default function create(
  platform: KasaPythonPlatform,
  config: KasaPythonConfig,
  homebridgeAccessory: PlatformAccessory<KasaPythonAccessoryContext> | undefined,
  KasaDevice: KasaDevice,
): HomekitDevice | undefined {
  if (isPowerStrip(KasaDevice)) {
    return new HomeKitDevicePowerStrip(
      platform,
      config,
      homebridgeAccessory,
      KasaDevice,
      KasaDevice.device_config,
    );
  } else if (isPlug(KasaDevice)) {
    return new HomeKitDevicePlug(
      platform,
      config,
      homebridgeAccessory,
      KasaDevice,
      KasaDevice.device_config,
    );
  }
}