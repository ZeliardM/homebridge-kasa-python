import HomeKitDevice from './index.js';
import HomeKitDeviceLightBulb from './homekitLightBulb.js';
import HomeKitDevicePlug from './homekitPlug.js';
import HomeKitDevicePowerStrip from './homekitPowerStrip.js';
import HomeKitDeviceSwitch from './homekitSwitch.js';
import HomeKitDeviceSwitchWithChildren from './homekitSwitchWithChildren.js';
import { LightBulbs, Plugs, PowerStrips, Switches } from './kasaDevices.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, LightBulb, Plug, PowerStrip, Switch } from './kasaDevices.js';

function isLightBulb(device: KasaDevice): device is LightBulb {
  return LightBulbs.includes(device.sys_info.model);
}

function isPlug(device: KasaDevice): device is Plug {
  return Plugs.includes(device.sys_info.model);
}

function isPowerStrip(device: KasaDevice): device is PowerStrip {
  return PowerStrips.includes(device.sys_info.model);
}

function isSwitch(device: KasaDevice): device is Switch {
  return Switches.includes(device.sys_info.model);
}

export default function create(
  platform: KasaPythonPlatform,
  kasaDevice: KasaDevice,
): HomeKitDevice | undefined {

  if (isLightBulb(kasaDevice)) {
    const lightBulb = kasaDevice as LightBulb;
    platform.log.debug('HomeKit device is a LightBulb:', lightBulb.sys_info.model);
    return new HomeKitDeviceLightBulb(platform, lightBulb);
  }

  if (isPlug(kasaDevice)) {
    const plug = kasaDevice as Plug;
    platform.log.debug('HomeKit device is a Plug:', plug.sys_info.model);
    return new HomeKitDevicePlug(platform, plug);
  }

  if (isPowerStrip(kasaDevice)) {
    const powerStrip = kasaDevice as PowerStrip;
    platform.log.debug('HomeKit device is a PowerStrip:', powerStrip.sys_info.model);
    return new HomeKitDevicePowerStrip(platform, powerStrip);
  }

  if (isSwitch(kasaDevice)) {
    const switchDevice = kasaDevice as Switch;
    platform.log.debug('HomeKit device is a Switch:', switchDevice.sys_info.model);
    if (switchDevice.sys_info.child_num > 0) {
      return new HomeKitDeviceSwitchWithChildren(platform, switchDevice);
    } else {
      return new HomeKitDeviceSwitch(platform, switchDevice);
    }
  }

  platform.log.error('Unknown device type:', kasaDevice);
  return undefined;
}