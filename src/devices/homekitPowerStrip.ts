import { Categories } from 'homebridge';

import HomeKitParentDevice from './baseParent.js';
import {
  buildEnergyDescriptors,
  buildOnDescriptor,
  buildOutletInUseDescriptor,
} from './descriptorHelpers.js';
import type KasaPythonPlatform from '../platform.js';
import type { CharacteristicDescriptor, ChildDevice, PowerStrip } from './deviceTypes.js';

export default class HomeKitDevicePowerStrip extends HomeKitParentDevice {
  private hasEnergy: boolean;

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: PowerStrip,
  ) {
    super(platform, kasaDevice, Categories.OUTLET, 'OUTLET');
    this.hasEnergy = !!kasaDevice.feature_info.energy;
    this.setupChildServices();
  }

  public async initialize(): Promise<void> {
    await this.startPolling();
  }

  protected getChildServiceType(_child: ChildDevice) {
    return this.platform.Service.Outlet;
  }

  protected buildChildDescriptors(_child: ChildDevice): CharacteristicDescriptor[] {
    const C = this.platform.Characteristic;
    const energyChars = this.platform.energyCharacteristics;
    const syncGroup = 'outletState';
    const supportsEnergy = !!(_child.energy || this.hasEnergy);
    const includeEnergyCharacteristics = !!(
      this.platform.config.energyOptions.enableEnergyMonitoring &&
      energyChars &&
      supportsEnergy
    );

    const list: CharacteristicDescriptor[] = [
      buildOnDescriptor(
        C,
        async (value, context) => {
          const idx = this.extractChildIndex(context.child ?? {});
          await this.deviceManager!.controlDevice(context.device.host, 'state', value, idx);
        },
        supportsEnergy ? undefined : syncGroup,
      ),
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