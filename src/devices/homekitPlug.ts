import { Categories } from 'homebridge'; // enum
import type { Service, PlatformAccessory, Characteristic, CharacteristicValue } from 'homebridge';

import HomekitDevice from './index.js';
import { KasaPythonConfig } from '../config.js';
import DeviceManager from './deviceManager.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaPythonAccessoryContext } from '../platform.js';
import { deferAndCombine, getOrAddCharacteristic } from '../utils.js';
import type { KasaDevice } from '../utils.js';
import type { DeviceConfig, Plug } from './kasaDevices.js';

export default class HomeKitDevicePlug extends HomekitDevice {
  constructor(
    platform: KasaPythonPlatform,
    readonly config: KasaPythonConfig,
    homebridgeAccessory:
      | PlatformAccessory<KasaPythonAccessoryContext>
      | undefined,
    readonly kasaDevice: Plug,
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

    this.addOutletService();

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

  private addOutletService() {
    const { Outlet } = this.platform.Service;

    const outletService: Service =
      this.homebridgeAccessory.getService(Outlet) ??
      this.addService(Outlet, this.name);

    this.addOnCharacteristic(outletService);

    this.addOutletInUseCharacteristic(outletService);

    return outletService;
  }

  private addOnCharacteristic(service: Service) {
    const onCharacteristic: Characteristic = getOrAddCharacteristic(
      service,
      this.platform.Characteristic.On,
    );

    onCharacteristic
      .onGet(async () => {
        const device: void | KasaDevice | undefined = await this.getSysInfo().catch(this.logRejection.bind(this));
        if (device) {
          const state: number | undefined = device.sys_info.relay_state;
          this.log.debug(`Current State of On is: ${state === 1 ? true : false} for ${this.name}`);
          return state ?? 0;
        }
        return 0;
      })
      .onSet(async (value: CharacteristicValue) => {
        this.log.info(`Setting On to: ${value} for ${this.name}`);
        if (typeof value === 'boolean' && value === true) {
          this.deviceManager.turnOn(this).catch(this.logRejection.bind(this));
          return;
        } else if (typeof value === 'boolean' && value === false) {
          this.deviceManager.turnOff(this).catch(this.logRejection.bind(this));
          return;
        }
        this.log.warn('setValue: Invalid On:', value);
        throw new Error(`setValue: Invalid On: ${value}`);
      });

    let oldState: number = this.kasaDevice.sys_info.relay_state;

    setInterval(async () => {
      const device: void | KasaDevice | undefined = await this.getSysInfo().catch(this.logRejection.bind(this));
      let newState: number | undefined;
      if (device) {
        newState = device.sys_info.relay_state;
      }

      if (newState !== undefined && newState !== oldState) {
        this.updateValue(service, onCharacteristic, newState);
        oldState = newState;
      }
    }, this.config.discoveryOptions.pollingInterval);

    return service;
  }

  private addOutletInUseCharacteristic(service: Service) {
    const outletInUseCharacteristic: Characteristic = getOrAddCharacteristic(
      service,
      this.platform.Characteristic.OutletInUse,
    );

    outletInUseCharacteristic
      .onGet(async () => {
        const device: void | KasaDevice | undefined = await this.getSysInfo().catch(this.logRejection.bind(this));
        if (device) {
          const state: number | undefined = device.sys_info.relay_state;
          this.log.debug(`Current State of On is: ${state === 1 ? true : false} for ${this.name}`);
          return state ?? 0;
        }
        return 0;
      });

    let oldState: number = this.kasaDevice.sys_info.relay_state;

    setInterval(async () => {
      const device: void | KasaDevice | undefined = await this.getSysInfo().catch(this.logRejection.bind(this));
      let newState: number | undefined;
      if (device) {
        newState = device.sys_info.relay_state;
      }

      if (newState !== undefined && newState !== oldState) {
        this.updateValue(service, outletInUseCharacteristic, newState);
        oldState = newState;
      }
    }, this.config.discoveryOptions.pollingInterval);

    return service;
  }

  identify(): void {
    this.log.info('identify');
  }
}