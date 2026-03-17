import { Categories } from 'homebridge';

import HomeKitDevice from './baseDevice.js';
import {
  buildEnergyDescriptors,
  buildOnDescriptor,
  buildOutletInUseDescriptor,
} from './descriptorHelpers.js';
import type KasaPythonPlatform from '../platform.js';
import type { CharacteristicDescriptor, Plug } from './deviceTypes.js';

export default class HomeKitDevicePlug extends HomeKitDevice {
  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: Plug,
  ) {
    super(platform, kasaDevice, Categories.OUTLET, 'OUTLET');
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
    const syncGroup = 'outletState';
    const supportsEnergy = !!(this.kasaDevice.feature_info.energy || this.kasaDevice.sys_info.energy);
    const includeEnergyCharacteristics = !!(
      this.platform.config.energyOptions.enableEnergyMonitoring &&
      energyChars &&
      supportsEnergy
    );

    const onDescriptor = buildOnDescriptor(
      C,
      async (value, context) => {
        await this.deviceManager!.controlDevice(context.device.host, 'state', value);
      },
      supportsEnergy ? undefined : syncGroup,
    );

    const list: CharacteristicDescriptor[] = [
      onDescriptor,
      buildOutletInUseDescriptor(C, supportsEnergy, syncGroup),
    ];

    if (includeEnergyCharacteristics) {
      list.push(...buildEnergyDescriptors(energyChars));
    }

    return list;
  }

  public identify(): void {
    this.log.info('identify');
  }
}