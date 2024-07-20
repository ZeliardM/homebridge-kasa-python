import { Categories } from 'homebridge'; // enum
import type { Service, PlatformAccessory, Characteristic, CharacteristicValue } from 'homebridge';

import HomekitDevice from './index.js';
import { KasaPythonConfig } from '../config.js';
import DeviceManager from './deviceManager.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaPythonAccessoryContext } from '../platform.js';
import { deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type { KasaDevice } from '../utils.js';
import type { DeviceConfig, Powerstrip, ChildPlug } from './kasaDevices.js';

export default class HomeKitDevicePowerStrip extends HomekitDevice {
  constructor(
    platform: KasaPythonPlatform,
    readonly config: KasaPythonConfig,
    homebridgeAccessory:
      | PlatformAccessory<KasaPythonAccessoryContext>
      | undefined,
    readonly kasaDevice: Powerstrip,
    readonly deviceConfig: DeviceConfig,
    deviceManager?: DeviceManager,
  ) {
    super(
      platform,
      config,
      homebridgeAccessory,
      kasaDevice,
      Categories.OUTLET,
      deviceConfig,
      deviceManager,
    );

    this.kasaDevice.sys_info.children.forEach((child: ChildPlug, index: number) => {
      this.addAndConfigureOutletService(child, index);
    });

    this.getSysInfo = deferAndCombine(async (requestCount: number) => {
      this.log.debug(`executing deferred getSysInfo count: ${requestCount}`);
      return Promise.resolve(await this.deviceManager.getSysInfo(this));
    }, platform.config.waitTimeUpdate);
  }

  /**
   * Aggregates getSysInfo requests
   *
   * @private
   */
  private getSysInfo: () => Promise<KasaDevice | undefined>;

  private addAndConfigureOutletService(child: ChildPlug, index: number) {
    const { Outlet } = this.platform.Service;

    const outletService: Service =
      this.homebridgeAccessory.getServiceById(Outlet, `outlet-${index + 1}`) ??
      this.addService(Outlet, child.alias, `outlet-${index + 1}`);

    this.addOnCharacteristic(outletService, child);

    this.addOutletInUseCharacteristic(outletService, child);

    return outletService;
  }

  private addOnCharacteristic(outletService: Service, childDevice: ChildPlug) {
    const onCharacteristic: Characteristic = getOrAddCharacteristic(
      outletService,
      this.platform.Characteristic.On,
    );

    onCharacteristic
      .onGet(async () => {
        const device: void | KasaDevice | undefined = await this.getSysInfo().catch(this.logRejection.bind(this));
        if (device) {
          const childState: number | undefined = device.sys_info.children?.find((child: ChildPlug) => child.id === childDevice.id)?.state;
          this.log.debug(`Current State of On is: ${childState === 1 ? true : false} for ${childDevice.alias}`);
          return childState ?? 0;
        }
        return 0;
      })
      .onSet(async (value: CharacteristicValue) => {
        this.log.info(`Setting On to: ${value} for ${childDevice.alias}`);
        const childNumber: number = (parseInt(childDevice.id.replace(this.id, ''), 10));
        if (typeof value === 'boolean' && value === true) {
          this.deviceManager.turnOnChild(this, childNumber).catch(this.logRejection.bind(this));
          return;
        } else if (typeof value === 'boolean' && value === false) {
          this.deviceManager.turnOffChild(this, childNumber).catch(this.logRejection.bind(this));
          return;
        }
        this.log.warn('setValue: Invalid On:', value);
        throw new Error(`setValue: Invalid On: ${value}`);
      });

    let oldChildState: number = childDevice.state;

    setInterval(async () => {
      const device: void | KasaDevice | undefined = await this.getSysInfo().catch(this.logRejection.bind(this));
      let newChildState: number | undefined;
      if (device) {
        newChildState = device.sys_info.children?.find((child: ChildPlug) => child.id === childDevice.id)?.state;
      }

      if (newChildState !== undefined && newChildState !== oldChildState) {
        this.updateChildValue(outletService, onCharacteristic, newChildState, childDevice.alias);
        oldChildState = newChildState;
      }
    }, this.config.discoveryOptions.pollingInterval);

    return outletService;
  }

  private addOutletInUseCharacteristic(outletService: Service, childDevice: ChildPlug) {
    const outletInUseCharacteristic: Characteristic = getOrAddCharacteristic(
      outletService,
      this.platform.Characteristic.OutletInUse,
    );

    outletInUseCharacteristic.onGet(async () => {
      const device: void | KasaDevice | undefined = await this.getSysInfo().catch(this.logRejection.bind(this));
      if (device) {
        const childState: number | undefined = device.sys_info.children?.find((child: ChildPlug) => child.id === childDevice.id)?.state;
        this.log.debug(`Current State of Outlet In Use is: ${childState === 1 ? true : false} for ${childDevice.alias}`);
        return childState ?? 0;
      }
      return 0;
    });

    let oldChildState: number = childDevice.state;

    setInterval(async () => {
      const device: void | KasaDevice | undefined = await this.getSysInfo().catch(this.logRejection.bind(this));
      let newChildState: number | undefined;
      if (device) {
        newChildState = device.sys_info.children?.find((child: ChildPlug) => child.id === childDevice.id)?.state;
      }

      if (newChildState !== undefined && newChildState !== oldChildState) {
        this.updateChildValue(outletService, outletInUseCharacteristic, newChildState, childDevice.alias);
        oldChildState = newChildState;
      }
    }, this.config.discoveryOptions.pollingInterval);


    return outletService;
  }

  identify(): void {
    this.log.info('identify');
  }
}
