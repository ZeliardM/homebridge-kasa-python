import HomekitDevice from './index.js';
import HomeKitDeviceLightBulb from './homekitLightBulb.js';
import HomeKitDevicePlug from './homekitPlug.js';
import HomeKitDevicePowerStrip from './homekitPowerstrip.js';
import HomeKitDeviceSwitch from './homekitSwitch.js';
import { Bulbs, Lightstrips, Plugs, Powerstrips, Switches } from './kasaDevices.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, LightBulb, Plug, Powerstrip, Switch } from './kasaDevices.js';

function isLightBulb(device: KasaDevice): device is LightBulb {
  return Bulbs.includes(device.disc_info.model) || Lightstrips.includes(device.disc_info.model);
}

function isPlug(device: KasaDevice): device is Plug {
  return Plugs.includes(device.disc_info.model);
}

function isPowerStrip(device: KasaDevice): device is Powerstrip {
  return Powerstrips.includes(device.disc_info.model);
}

function isSwitch(device: KasaDevice): device is Switch {
  return Switches.includes(device.disc_info.model);
}

export default function create(
  platform: KasaPythonPlatform,
  KasaDevice: KasaDevice,
): HomekitDevice | undefined {
  if (isLightBulb(KasaDevice)) {
    return new HomeKitDeviceLightBulb(platform, KasaDevice);
  }

  if (isPlug(KasaDevice)) {
    return new HomeKitDevicePlug(platform, KasaDevice);
  }

  if (isPowerStrip(KasaDevice)) {
    return new HomeKitDevicePowerStrip(platform, KasaDevice);
  }

  if (isSwitch(KasaDevice)) {
    return new HomeKitDeviceSwitch(platform, KasaDevice);
  }

  platform.log.error('Unknown device type:', KasaDevice);
  return undefined;
}