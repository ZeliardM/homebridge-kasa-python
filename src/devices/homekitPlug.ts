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
  /* eslint @typescript-eslint/no-explicit-any: 0 */
  private historyService: any;

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: Plug,
  ) {
    super(platform, kasaDevice, Categories.OUTLET, 'OUTLET');
    this.setupPrimaryService();
    this.setupEveHistoryService();
  }

  private setupEveHistoryService () : void {
    const { Characteristic, Service, api, eve } = this.platform;
    const accessory = this.homebridgeAccessory;
    const outlet = accessory.getService(Service.Outlet);

    if (!this.platform.config.energyOptions.enableEveHistoryView) {
      // cached accessory to be restored if disabled.
      [
        eve.Services.Consumption,
      ].forEach((x) => {
        const s = accessory.getService(x);
        if (s) {
          accessory.removeService(s);
        }
      });
      [
        eve.Characteristics.LastActivation,
        Characteristic.LockPhysicalControls,
        eve.Characteristics.TotalConsumption,
        eve.Characteristics.ResetTotal,
      ].forEach((x) => {
        if (outlet?.testCharacteristic(x)) {
          const c = outlet?.getCharacteristic(x);
          outlet.removeCharacteristic(c);
        }
      });
      delete(accessory.context.lastActivation);
      delete(accessory.context.totalConsumption);

      return;
    }

    // open event stream
    this.historyService = new this.platform.HistoryService(
      'custom', accessory, { storage: 'fs' },
    );

    //LastActivation characteristic
    const lastActivation = eve.Characteristics.LastActivation;
    outlet?.addOptionalCharacteristic(lastActivation);
    outlet?.getCharacteristic(lastActivation).onGet(() => {
      const initialTime = this.historyService?.getInitialTime();
      const lastTime = accessory.context.lastActivation && initialTime
        ? Math.max(0, accessory.context.lastActivation - initialTime)
        : 0;
      return lastTime;
    });

    // logging on/off status
    const On = outlet?.getCharacteristic(Characteristic.On);
    On?.on('change', async (event) => {
      if (event.newValue !== event.oldValue) {
        const accessory = this.homebridgeAccessory;
        accessory.context.lastActivation = Math.round(new Date().valueOf() / 1000);
        this.historyService?.addEntry({
          time: accessory.context.lastActivation,
          status: event.newValue ? 1 : 0,
        });
      }
    });
    this.historyService?.addEntry({
      time: Math.round(new Date().valueOf() / 1000),
      status: On?.value ? 1 : 0,
    });

    // LockPhysicalControls characteristic
    const lockControl = Characteristic.LockPhysicalControls;
    outlet?.addOptionalCharacteristic(lockControl);
    outlet?.getCharacteristic(lockControl).onGet(() =>
      Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED,
    );

    if (this.platform.config.energyOptions.enableEnergyMonitoring &&
	this.platform.energyCharacteristics &&
	(this.kasaDevice.feature_info.energy || this.kasaDevice.sys_info.energy)) {
      // dummy consumption service to be removed if previously configured
      [
        eve.Services.Consumption,
      ].forEach((x) => {
        const s = accessory.getService(x);
        if (s) {
          accessory.removeService(s);
        }
      });

      // totalConsumption characteristic
      accessory.context.totalConsumption ??= 0;
      const totalConsumption = eve.Characteristics.TotalConsumption;
      outlet?.addOptionalCharacteristic(totalConsumption);
      outlet?.getCharacteristic(totalConsumption).onGet(() => {
        const accessory = this.homebridgeAccessory;
        const totalConsumption = accessory.context.totalConsumption ?? 0;
        return totalConsumption / 1000;
      });

      // resetTotal characteristic
      const resetTotal = eve.Characteristics.ResetTotal;
      outlet?.addOptionalCharacteristic(resetTotal);
      outlet?.getCharacteristic(resetTotal)
        .onSet((_reset) => {
          const accessory = this.homebridgeAccessory;
          accessory.context.totalConsumption = 0;
        })
        // .onGet(() => {
        //   return this.historyService.getInitialTime() - Math.round(Date.parse('01 Jan 2001 00:00:00 GMT')/1000);
        // })
      ;

      // logging power
      this.updateEmitter.on('updateComplete', () => {
        const accessory = this.homebridgeAccessory;
        const power = this.kasaDevice?.sys_info?.energy?.power;
        const interval = this.platform.config.discoveryOptions.pollingInterval / 1000;
        const watts = power ? power / 3600 * interval: 0;
        accessory.context.totalConsumption! += watts;
        this.historyService?.addEntry({
          time: Math.round(new Date().valueOf() / 1000),
          power: watts,
        });
      });
    } else {
      // totalConsumption characteristic to be removed if previously configured
      [
        eve.Characteristics.TotalConsumption,
        eve.Characteristics.ResetTotal,
      ].forEach((x) => {
        if (outlet?.testCharacteristic(x)) {
          const c = outlet?.getCharacteristic(x);
          outlet.removeCharacteristic(c);
        }
      });
      delete(accessory.context.totalConsumption);

      // dummy consumption service to enable switching history
      const dummy =
        accessory.getService(eve.Services.Consumption) ??
        accessory.addService(eve.Services.Consumption, `${this.name} Consumption`);
      dummy?.setHiddenService(true);
      dummy?.addOptionalCharacteristic(eve.Characteristics.TotalConsumption);
      dummy?.getCharacteristic(eve.Characteristics.TotalConsumption).setProps({
        perms: [
          api.hap.Perms.PAIRED_READ,
          api.hap.Perms.NOTIFY,
          api.hap.Perms.HIDDEN,
        ],
      });
    }
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