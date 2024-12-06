import { Categories } from 'homebridge';
import type { Service } from 'homebridge';

import HomekitDevice from './index.js';
import type KasaPythonPlatform from '../platform.js';
import type { ChildDevice, PowerStrip } from './kasaDevices.js';

export default class HomeKitDevicePowerStrip extends HomekitDevice {
  constructor(
    platform: KasaPythonPlatform,
    protected kasaDevice: PowerStrip,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
      'OUTLET',
    );
    this.log.debug(`Initializing HomeKitDevicePowerStrip for device: ${kasaDevice.sys_info.alias}`);
    this.kasaDevice.sys_info.children?.forEach((child: ChildDevice, index: number) => {
      this.log.debug(`Adding outlet service for child device: ${child.alias}`);
      this.addOutletService(child, index);
    });
  }

  private addOutletService(child: ChildDevice, index: number) {
    const { Outlet } = this.platform.Service;
    const outletService: Service =
      this.homebridgeAccessory.getServiceById(Outlet, `outlet-${index + 1}`) ??
      this.addService(Outlet, child.alias, `outlet-${index + 1}`);

    this.log.debug(`Adding characteristics for outlet service: ${child.alias}`);
    this.addCharacteristic(outletService, this.platform.Characteristic.On, child);
    this.addCharacteristic(outletService, this.platform.Characteristic.OutletInUse, child);

    return outletService;
  }

  identify(): void {
    this.log.info('identify');
  }
}