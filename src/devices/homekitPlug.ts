import { Categories } from 'homebridge';

import HomeKitDevice from './baseDevice.js';
import {
  buildOnDescriptor,
  buildOutletInUseDescriptor,
  buildEnergyDescriptors,
} from './descriptorHelpers.js';
import type KasaPythonPlatform from '../platform.js';
import type { Plug, CharacteristicDescriptor } from './deviceTypes.js';

export default class HomeKitDevicePlug extends HomeKitDevice {
  private hasEnergy: boolean;

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: Plug,
  ) {
    super(platform, kasaDevice, Categories.OUTLET, 'OUTLET');
    this.hasEnergy = !!kasaDevice.sys_info.energy;
    this.setupPrimaryService();
  }

  public async initialize(): Promise<void> {
    await this.startPolling();
  }

  protected getPrimaryServiceType() {
    return this.platform.Service.Outlet;
  }

  protected buildPrimaryDescriptors(): CharacteristicDescriptor[] {
    const C = this.platform.Characteristic;
    const energyChars = this.platform.energyCharacteristics;

    const onDescriptor = buildOnDescriptor(
      C,
      async (value, context) => {
        await this.deviceManager!.controlDevice(context.device.host, 'state', value);
      },
    );

    const list: CharacteristicDescriptor[] = [
      onDescriptor,
      buildOutletInUseDescriptor(C, this.hasEnergy),
    ];

    if (this.platform.config.enableEnergyMonitoring && energyChars && this.kasaDevice.sys_info.energy) {
      list.push(...buildEnergyDescriptors(energyChars));
    }

    return list;
  }

  protected async updateAllServicesAndCharacteristics(forceUpdate: boolean): Promise<void> {
    await super.updateAllServicesAndCharacteristics(forceUpdate);
  }

  public identify(): void {
    this.log.info('identify');
  }
}