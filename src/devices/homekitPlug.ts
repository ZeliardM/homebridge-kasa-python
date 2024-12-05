import { Categories } from 'homebridge';
import type { Service } from 'homebridge';

import HomekitDevice from './index.js';
import type KasaPythonPlatform from '../platform.js';
import type { Plug } from './kasaDevices.js';

export default class HomeKitDevicePlug extends HomekitDevice {
  constructor(
    platform: KasaPythonPlatform,
    protected kasaDevice: Plug,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
      'OUTLET',
    );
    this.log.debug(`Initializing HomeKitDevicePlug for device: ${kasaDevice.sys_info.alias}`);
    this.addOutletService();
  }

  private addOutletService() {
    const { Outlet } = this.platform.Service;

    const outletService: Service =
      this.homebridgeAccessory.getService(Outlet) ?? this.addService(Outlet, this.name);

    this.log.debug(`Adding characteristics for outlet service: ${this.name}`);
    this.addCharacteristic(outletService, this.platform.Characteristic.On);
    this.addCharacteristic(outletService, this.platform.Characteristic.OutletInUse);

    return outletService;
  }

  identify(): void {
    this.log.info('identify');
  }
}