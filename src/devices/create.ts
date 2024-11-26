import HomekitDevice from './index.js';
import HomeKitDevicePlug from './homekitPlug.js';
import HomeKitDevicePowerStrip from './homekitPowerstrip.js';
import HomeKitDeviceSwitch from './homekitSwitch.js';
import { Switches } from './kasaDevices.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, Plug, Powerstrip, Switch } from './kasaDevices.js';

function isPlug(device: KasaDevice): device is Plug {
  return 'child_num' in device.sys_info && device.sys_info.child_num === 0;
}

function isPowerStrip(device: KasaDevice): device is Powerstrip {
  return device.sys_info.children !== undefined && device.sys_info.child_num > 0 && Array.isArray(device.sys_info.children);
}

function isSwitch(device: KasaDevice): device is Switch {
  return Switches.includes(device.sys_info.model);
}

export default function create(
  platform: KasaPythonPlatform,
  KasaDevice: KasaDevice,
): HomekitDevice | undefined {
  if (isPowerStrip(KasaDevice)) {
    return new HomeKitDevicePowerStrip(platform, KasaDevice);
  }

  if (isSwitch(KasaDevice)) {
    return new HomeKitDeviceSwitch(platform, KasaDevice);
  }

  if (isPlug(KasaDevice)) {
    return new HomeKitDevicePlug(platform, KasaDevice);
  }

  platform.log.error('Unknown device type:', KasaDevice);
  return undefined;
}