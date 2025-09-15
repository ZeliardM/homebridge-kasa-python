import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import { EventEmitter } from 'node:events';

import HomeKitDevice from './index.js';
import { deferAndCombine } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { ChildDevice, KasaDevice, PowerStrip, SysInfo } from './kasaDevices.js';
import { EnergyCharacteristics } from '../customCharacteristics.js';

export default class HomeKitDevicePowerStrip extends HomeKitDevice {
  public isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<void>;
  private pollingInterval: NodeJS.Timeout | undefined;
  private updateEmitter: EventEmitter = new EventEmitter();
  private static locks: Map<string, Promise<void>> = new Map();

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: PowerStrip,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
      'OUTLET',
    );
    this.log.debug(`Initializing HomeKitDevicePowerStrip for device: ${kasaDevice.sys_info.alias}`);
    this.kasaDevice.sys_info.children?.forEach((child: ChildDevice, index: number) => {
      this.checkService(child, index);
    });
    this.getSysInfo = deferAndCombine(async () => {
      if (!this.deviceManager) {
        this.log.warn('Device manager is not available');
        return;
      }
      const host = this.kasaDevice.sys_info?.host;
      if (!host) {
        this.log.warn('No host found in sys_info for device');
        return;
      }
      try {
        this.previousKasaDevice = { ...this.kasaDevice };
        const updatedSysInfo = await this.deviceManager.getSysInfo(host) as SysInfo;
        if (!updatedSysInfo) {
          this.log.warn('getSysInfo returned undefined');
          return;
        }
        this.kasaDevice.sys_info = updatedSysInfo;
        this.log.debug(`Updated sys_info for device: ${updatedSysInfo.alias ?? host}`);
      } catch (err: unknown) {
        const errorMsg = 'Error updating sys_info:';
        if (err instanceof Error) {
          this.log.error(`${errorMsg} ${err.message}`);
        } else {
          this.log.error(`${errorMsg} ${String(err)}`);
        }
      }
    }, platform.config.advancedOptions.waitTimeUpdate);
    platform.periodicDeviceDiscoveryEmitter.on('periodicDeviceDiscoveryComplete', () => {
      this.updateEmitter.emit('periodicDeviceDiscoveryComplete');
    });
  }

  public async initialize(): Promise<void> {
    this.log.debug(`Initializing polling for device: ${this.kasaDevice.sys_info.alias}`);
    await this.startPolling();
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    let lock = HomeKitDevicePowerStrip.locks.get(key);
    if (!lock) {
      lock = Promise.resolve();
    }
    const currentLock = lock.then(async () => {
      try {
        return await action();
      } finally {
        if (HomeKitDevicePowerStrip.locks.get(key) === currentLock) {
          HomeKitDevicePowerStrip.locks.delete(key);
        }
      }
    });
    HomeKitDevicePowerStrip.locks.set(key, currentLock.then(() => {}));
    return currentLock;
  }

  private checkService(child: ChildDevice, index: number) {
    const serviceType = this.getServiceType();
    const service: Service =
      this.homebridgeAccessory.getServiceById(serviceType, `child-${index + 1}`) ??
      this.addService(serviceType, child.alias, `child-${index + 1}`);
    const oldService: Service | undefined = this.homebridgeAccessory.getServiceById(serviceType, `outlet-${index + 1}`);
    if (oldService) {
      this.homebridgeAccessory.removeService(oldService);
    }
    this.checkCharacteristics(service, child);

    // Add Energy Monitoring Service if device supports energy monitoring
    if (this.kasaDevice.feature_info.energy && child.energy) {
      this.checkEnergyMonitoringService(child, index);
    }
  }

  private getServiceType() {
    const { Outlet } = this.platform.Service;
    return Outlet;
  }

  private checkCharacteristics(service: Service, child: ChildDevice) {
    const characteristics = this.getCharacteristics();
    characteristics.forEach(({ type, name }) => {
      this.getOrAddCharacteristic(service, type, name, child);
    });
  }

  private getCharacteristics() {
    const characteristics: { type: WithUUID<new () => Characteristic>; name: string | undefined }[] = [];
    characteristics.push(
      {
        type: this.platform.Characteristic.On,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.On),
      },
      {
        type: this.platform.Characteristic.OutletInUse,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.OutletInUse),
      },
    );
    return characteristics;
  }

  private getEnergyMonitoringCharacteristics() {
    const characteristics: { type: WithUUID<new () => Characteristic>; name: string | undefined }[] = [];
    characteristics.push(
      {
        type: this.platform.CustomCharacteristics.Volts,
        name: EnergyCharacteristics.VOLTS.name,
      },
      {
        type: this.platform.CustomCharacteristics.Amperes,
        name: EnergyCharacteristics.AMPERES.name,
      },
      {
        type: this.platform.CustomCharacteristics.Watts,
        name: EnergyCharacteristics.WATTS.name,
      },
      {
        type: this.platform.CustomCharacteristics.KilowattHours,
        name: EnergyCharacteristics.KILOWATT_HOURS.name,
      },
    );
    return characteristics;
  }

  private checkEnergyMonitoringService(child: ChildDevice, index: number) {
    // Add custom characteristics to the existing Outlet service
    const service = this.homebridgeAccessory.getServiceById(this.platform.Service.Outlet, `child-${index + 1}`);
    if (service) {
      this.checkEnergyMonitoringCharacteristics(service, child);
    }
  }

  private checkEnergyMonitoringCharacteristics(service: Service, child: ChildDevice) {
    const characteristics = this.getEnergyMonitoringCharacteristics();
    characteristics.forEach(({ type, name }) => {
      this.getOrAddEnergyCharacteristic(service, type, name, child);
    });
  }

  private getOrAddCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ) {
    const characteristic: Characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, service, characteristicType, characteristicName, child));
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, characteristicName, child));
    }
  }

  private getOrAddEnergyCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ) {
    const characteristic: Characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);
    characteristic.onGet(this.handleEnergyOnGet.bind(this, service, characteristicType, characteristicName, child));
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ): Promise<CharacteristicValue> {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.log.warn(`Device is offline or platform is shutting down, cannot get value for characteristic ${characteristicName}`);
      return false;
    }
    try {
      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (!characteristicValue) {
        characteristicValue = this.getInitialValue(characteristicType, child);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      this.log.debug(`Got value for characteristic ${characteristicName}: ${characteristicValue}`);
      return characteristicValue ?? false;
    } catch (error) {
      this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
      this.kasaDevice.offline = true;
      await this.stopPolling();
      return false;
    }
  }

  private getInitialValue(characteristicType: WithUUID<new () => Characteristic>, child: ChildDevice): CharacteristicValue {
    if (this.kasaDevice.feature_info.energy && this.kasaDevice.feature_info.energy === true && child.energy) {
      if (characteristicType === this.platform.Characteristic.On) {
        return child.state ?? false;
      }
      if (characteristicType === this.platform.Characteristic.OutletInUse) {
        return (child.energy.power ?? 0) > 1;
      }
    } else {
      if (characteristicType === this.platform.Characteristic.On || characteristicType === this.platform.Characteristic.OutletInUse) {
        return child.state ?? false;
      }
    }
    return false;
  }

  private getEnergyInitialValue(characteristicType: WithUUID<new () => Characteristic>, child: ChildDevice): CharacteristicValue {
    if (this.kasaDevice.feature_info.energy && child.energy) {
      if (characteristicType === this.platform.CustomCharacteristics.Volts) {
        return child.energy.voltage ?? 0;
      }
      if (characteristicType === this.platform.CustomCharacteristics.Amperes) {
        return child.energy.current ?? 0;
      }
      if (characteristicType === this.platform.CustomCharacteristics.Watts) {
        return child.energy.power ?? 0;
      }
      if (characteristicType === this.platform.CustomCharacteristics.KilowattHours) {
        return child.energy.total ?? 0;
      }
    }
    return 0;
  }

  private async handleEnergyOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ): Promise<CharacteristicValue> {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.log.warn(`Device is offline or platform is shutting down, cannot get energy value for characteristic ${characteristicName}`);
      return 0;
    }
    try {
      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (characteristicValue === undefined || characteristicValue === null) {
        characteristicValue = this.getEnergyInitialValue(characteristicType, child);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      this.log.debug(`Got energy value for characteristic ${characteristicName}: ${characteristicValue}`);
      return characteristicValue ?? 0;
    } catch (error) {
      this.log.error(`Error getting energy value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
      return 0;
    }
  }

  private async handleOnSet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
    value: CharacteristicValue,
  ): Promise<void> {
    const lockKey = `${this.kasaDevice.sys_info.device_id}:${child.id}`;
    await this.withLock(lockKey, async () => {
      if (this.kasaDevice.offline || this.platform.isShuttingDown) {
        this.log.warn(`Device is offline or platform is shutting down, cannot set value for characteristic ${characteristicName}`);
        return;
      }
      const task = async () => {
        if (this.deviceManager) {
          try {
            this.isUpdating = true;
            this.log.debug(`Setting value for characteristic ${characteristicName} to ${value}`);
            const characteristicKey = this.getCharacteristicKey(characteristicName);
            if (!characteristicKey) {
              throw new Error(`Characteristic key not found for ${characteristicName}`);
            }
            const childNumber = parseInt(child.id.slice(-1), 10);
            await this.deviceManager.controlDevice(this.kasaDevice.sys_info.host, characteristicKey, value, childNumber);
            (child as Record<string, CharacteristicValue>)[characteristicKey] = value;
            const childIndex = this.kasaDevice.sys_info.children?.findIndex(c => c.id === child.id);
            if (childIndex !== undefined && childIndex !== -1) {
              this.kasaDevice.sys_info.children![childIndex] = { ...child };
            }
            this.updateValue(service, service.getCharacteristic(characteristicType), child.alias, value);
            if (this.kasaDevice.feature_info.energy && this.kasaDevice.feature_info.energy === true && child.energy) {
              const outlet_in_use: CharacteristicValue = (Number(child.energy.power ?? 0) > 1) as CharacteristicValue;
              this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.alias, outlet_in_use);
            } else {
              this.updateValue(
                service,
                service.getCharacteristic(this.platform.Characteristic.OutletInUse),
                child.alias,
                child.state ?? false,
              );
            }
            this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
            this.log.debug(`Set value for characteristic ${characteristicName} to ${value} successfully`);
          } catch (error) {
            this.log.error(`Error setting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
            this.kasaDevice.offline = true;
            await this.stopPolling();
          } finally {
            this.isUpdating = false;
            this.updateEmitter.emit('updateComplete');
          }
        } else {
          throw new Error('Device manager is undefined.');
        }
      };
      await task();
    });
  }

  private getCharacteristicKey(characteristicName: string | undefined): string {
    const characteristicMap: { [key: string]: string } = {
      On: 'state',
    };
    return characteristicMap[characteristicName ?? ''];
  }

  protected async updateState() {
    const lockKey = `${this.kasaDevice.sys_info.device_id}`;
    await this.withLock(lockKey, async () => {
      if (this.kasaDevice.offline || this.platform.isShuttingDown) {
        await this.stopPolling();
        return;
      }
      if (this.isUpdating || this.platform.periodicDeviceDiscovering) {
        let periodicDiscoveryComplete = false;
        await Promise.race([
          new Promise<void>((resolve) => this.updateEmitter.once('updateComplete', resolve)),
          new Promise<void>((resolve) => {
            this.updateEmitter.once('periodicDeviceDiscoveryComplete', () => {
              periodicDiscoveryComplete = true;
              resolve();
            });
          }),
        ]);
        if (periodicDiscoveryComplete) {
          if (this.pollingInterval) {
            await new Promise((resolve) => setTimeout(resolve, this.platform.config.discoveryOptions.pollingInterval));
          } else {
            return;
          }
        }
      }
      this.isUpdating = true;
      const task = async () => {
        try {
          await this.getSysInfo();
          this.kasaDevice.sys_info.children?.forEach((child: ChildDevice) => {
            const childNumber = parseInt(child.id.slice(-1), 10);
            const service = this.getService(childNumber);
            if (service && this.previousKasaDevice) {
              this.updateChildState(service, child);
            } else {
              this.log.warn(`Service not found for child device: ${child.alias} or previous Kasa device is undefined`);
            }
          });
        } catch (error) {
          this.log.error('Error updating device state:', error);
          this.kasaDevice.offline = true;
          await this.stopPolling();
        } finally {
          this.isUpdating = false;
          this.updateEmitter.emit('updateComplete');
        }
      };
      await task();
    });
  }

  private getService(childNumber: number) {
    return this.homebridgeAccessory.getServiceById(this.platform.Service.Outlet, `child-${childNumber + 1}`);
  }

  private updateChildState(service: Service, child: ChildDevice) {
    const previousChild = this.previousKasaDevice?.sys_info.children?.find(c => c.id === child.id);
    if (previousChild) {
      if (previousChild.state !== child.state) {
        this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), child.alias, child.state);
        if (this.kasaDevice.feature_info.energy && this.kasaDevice.feature_info.energy === true && child.energy) {
          const outlet_in_use: CharacteristicValue = (Number(child.energy.power ?? 0) > 1) as CharacteristicValue;
          this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.alias, outlet_in_use);
        } else {
          this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.alias, child.state ?? false);
        }
        this.log.debug(`Updated state for child device: ${child.alias} to ${child.state}`);
      }

      // Update energy characteristics if energy monitoring is supported
      if (this.kasaDevice.feature_info.energy && child.energy) {
        this.updateEnergyCharacteristics(child);
      }
    }
  }

  private updateEnergyCharacteristics(child: ChildDevice) {
    const childIndex = this.kasaDevice.sys_info.children?.findIndex(c => c.id === child.id);
    if (childIndex !== undefined && childIndex !== -1) {
      const service = this.homebridgeAccessory.getServiceById(this.platform.Service.Outlet, `child-${childIndex + 1}`);
      if (service && child.energy) {
        // Update voltage
        const voltage = child.energy.voltage ?? 0;
        this.updateValue(service, service.getCharacteristic(this.platform.CustomCharacteristics.Volts), child.alias, voltage);

        // Update current
        const current = child.energy.current ?? 0;
        this.updateValue(service, service.getCharacteristic(this.platform.CustomCharacteristics.Amperes), child.alias, current);

        // Update power
        const power = child.energy.power ?? 0;
        this.updateValue(service, service.getCharacteristic(this.platform.CustomCharacteristics.Watts), child.alias, power);

        // Update total consumption
        const totalConsumption = child.energy.total ?? 0;
        this.updateValue(service, service.getCharacteristic(this.platform.CustomCharacteristics.KilowattHours), child.alias, totalConsumption);

        this.log.debug(`Updated energy characteristics for child device: ${child.alias} - Volts: ${voltage}V, Amperes: ${current}A, Watts: ${power}W, kWh: ${totalConsumption}`);
      }
    }
  }

  public updateAfterPeriodicDiscovery() {
    this.kasaDevice.sys_info.children?.forEach((child: ChildDevice, index: number) => {
      const serviceType = this.getServiceType();
      const service: Service | undefined =
        this.homebridgeAccessory.getServiceById(serviceType, `child-${index + 1}`);
      if (service) {
        this.updateCharacteristics(service, child);
      } else {
        this.log.debug(`Service not found for child device: ${child.alias}`);
      }

      // Update energy monitoring service if supported
      if (this.kasaDevice.feature_info.energy && child.energy) {
        this.updateEnergyCharacteristics(child);
      }
    });
  }

  private updateCharacteristics(service: Service, child: ChildDevice) {
    const characteristics = this.getCharacteristics();
    characteristics.forEach(({ type, name }) => {
      if (type === this.platform.Characteristic.On) {
        const characteristic: Characteristic = service.getCharacteristic(type);
        if (characteristic) {
          const characteristicKey = this.getCharacteristicKey(name);
          if (child[characteristicKey as keyof ChildDevice] !== undefined) {
            const value = child[characteristicKey as keyof ChildDevice] as unknown as CharacteristicValue;
            this.log.debug(`Setting value for characteristic ${name} to ${value}`);
            this.updateValue(service, characteristic, child.alias, value);
            if (this.kasaDevice.feature_info.energy && this.kasaDevice.feature_info.energy === true && child.energy) {
              const outlet_in_use: CharacteristicValue = (Number(child.energy.power ?? 0) > 1) as CharacteristicValue;
              this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), child.alias, outlet_in_use);
            } else {
              this.updateValue(
                service,
                service.getCharacteristic(this.platform.Characteristic.OutletInUse),
                child.alias,
                child.state ?? false,
              );
            }
          }
        }
      }
    });
  }

  public async startPolling(): Promise<void> {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      await this.stopPolling();
      return;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.log.debug('Starting polling for device:', this.name);
    this.pollingInterval = setInterval(async () => {
      if (this.kasaDevice.offline || this.platform.isShuttingDown) {
        if (this.isUpdating) {
          this.isUpdating = false;
          this.updateEmitter.emit('updateComplete');
        }
        await this.stopPolling();
      } else {
        await this.updateState();
      }
    }, this.platform.config.discoveryOptions.pollingInterval);
  }

  public async stopPolling(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
      this.log.debug('Stopped polling');
    }
    if (this.isUpdating) {
      this.log.debug('Waiting for ongoing polling task to complete for device:', this.name);
      await new Promise<void>((resolve) => {
        this.isUpdating = false;
        this.updateEmitter.once('updateComplete', resolve);
      });
    }
  }

  identify(): void {
    this.log.info('identify');
  }
}