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
    void _child;
    return this.platform.Service.Outlet;
  }

  protected buildChildDescriptors(_child: ChildDevice): CharacteristicDescriptor[] {
    void _child;
    const C = this.platform.Characteristic;
    const energyChars = this.platform.energyCharacteristics;

    const list: CharacteristicDescriptor[] = [
      buildOnDescriptor(
        C,
        async (value, context) => {
          const idx = this.extractChildIndex(context.child ?? {});
          await this.deviceManager!.controlDevice(context.device.host, 'state', value, idx);
        },
      ),
      buildOutletInUseDescriptor(C, this.hasEnergy),
    ];

    if (this.platform.config.enableEnergyMonitoring && energyChars && _child.energy) {
      list.push(...buildEnergyDescriptors(energyChars));
    }

    return list;
  }

  public identify(): void {
    this.log.info('identify');
  }
}