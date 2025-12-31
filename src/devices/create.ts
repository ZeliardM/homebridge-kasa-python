import HomeKitDevice from './baseDevice.js';
import HomeKitDeviceLightBulb from './homekitLightBulb.js';
import HomeKitDevicePlug from './homekitPlug.js';
import HomeKitDevicePowerStrip from './homekitPowerStrip.js';
import HomeKitDeviceSwitch from './homekitSwitch.js';
import HomeKitDeviceSwitchWithChildren from './homekitSwitchWithChildren.js';
import { LightBulbs, Plugs, PowerStrips, Switches } from './deviceTypes.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice } from './deviceTypes.js';

function isLightBulb(device: KasaDevice) {
  return LightBulbs.includes(device.sys_info.model);
}
function isPlug(device: KasaDevice) {
  return Plugs.includes(device.sys_info.model);
}
function isPowerStrip(device: KasaDevice) {
  return PowerStrips.includes(device.sys_info.model);
}
function isSwitch(device: KasaDevice) {
  return Switches.includes(device.sys_info.model);
}

export default async function createDevice(
  platform: KasaPythonPlatform,
  kasaDevice: KasaDevice,
): Promise<HomeKitDevice | undefined> {
  let instance: HomeKitDevice;

  if (isLightBulb(kasaDevice)) {
    platform.log.debug('Device classified as LightBulb:', kasaDevice.sys_info.model);
    instance = new HomeKitDeviceLightBulb(platform, kasaDevice);
  } else if (isPlug(kasaDevice)) {
    platform.log.debug('Device classified as Plug:', kasaDevice.sys_info.model);
    instance = new HomeKitDevicePlug(platform, kasaDevice);
  } else if (isPowerStrip(kasaDevice)) {
    platform.log.debug('Device classified as PowerStrip:', kasaDevice.sys_info.model);
    instance = new HomeKitDevicePowerStrip(platform, kasaDevice);
  } else if (isSwitch(kasaDevice)) {
    platform.log.debug('Device classified as Switch:', kasaDevice.sys_info.model);
    if (kasaDevice.sys_info.child_num > 0) {
      instance = new HomeKitDeviceSwitchWithChildren(platform, kasaDevice);
    } else {
      instance = new HomeKitDeviceSwitch(platform, kasaDevice);
    }
  } else {
    platform.log.error('Unknown device type; skipping:', kasaDevice.sys_info.model);
    return undefined;
  }

  try {
    await instance.initialize();
  } catch (error) {
    platform.log.error(`Error initializing device [${kasaDevice.sys_info.device_id}]:`, error);
    return undefined;
  }
  return instance;
}