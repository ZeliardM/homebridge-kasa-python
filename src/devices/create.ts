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

export default async function create(
  platform: KasaPythonPlatform,
  kasaDevice: KasaDevice,
): Promise<HomeKitDevice | undefined> {
  let homeKitDevice: HomeKitDevice | undefined;

  if (isLightBulb(kasaDevice)) {
    const lightBulb = kasaDevice as LightBulb;
    platform.log.debug('HomeKit device is a LightBulb:', lightBulb.sys_info.model);
    homeKitDevice = new HomeKitDeviceLightBulb(platform, lightBulb);
  } else if (isPlug(kasaDevice)) {
    const plug = kasaDevice as Plug;
    platform.log.debug('HomeKit device is a Plug:', plug.sys_info.model);
    homeKitDevice = new HomeKitDevicePlug(platform, plug);
  } else if (isPowerStrip(kasaDevice)) {
    const powerStrip = kasaDevice as PowerStrip;
    platform.log.debug('HomeKit device is a PowerStrip:', powerStrip.sys_info.model);
    homeKitDevice = new HomeKitDevicePowerStrip(platform, powerStrip);
  } else if (isSwitch(kasaDevice)) {
    const switchDevice = kasaDevice as Switch;
    platform.log.debug('HomeKit device is a Switch:', switchDevice.sys_info.model);
    if (switchDevice.sys_info.child_num > 0) {
      homeKitDevice = new HomeKitDeviceSwitchWithChildren(platform, switchDevice);
    } else {
      homeKitDevice = new HomeKitDeviceSwitch(platform, switchDevice);
    }
  } else {
    platform.log.error('Unknown device type:', kasaDevice);
    return undefined;
  }
  if (homeKitDevice) {
    try {
      await homeKitDevice.initialize();
    } catch (error) {
      platform.log.error(`Error initializing device [${kasaDevice.sys_info.device_id}]:`, error);
      return undefined;
    }
  }

  return homeKitDevice;
}