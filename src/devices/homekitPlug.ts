import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import { EventEmitter } from 'node:events';

import HomeKitDevice from './index.js';
import { deferAndCombine } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, Plug, SysInfo } from './kasaDevices.js';
import { EnergyCharacteristics } from '../customCharacteristics.js';

export default class HomeKitDevicePlug extends HomeKitDevice {
  public isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<void>;
  private pollingInterval: NodeJS.Timeout | undefined;
  private updateEmitter: EventEmitter = new EventEmitter();
  private static locks: Map<string, Promise<void>> = new Map();

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: Plug,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.OUTLET,
      'OUTLET',
    );
    this.log.debug(`Initializing HomeKitDevicePlug for device: ${kasaDevice.sys_info.alias}`);
    this.checkService();
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
    let lock = HomeKitDevicePlug.locks.get(key);
    if (!lock) {
      lock = Promise.resolve();
    }
    const currentLock = lock.then(async () => {
      try {
        return await action();
      } finally {
        if (HomeKitDevicePlug.locks.get(key) === currentLock) {
          HomeKitDevicePlug.locks.delete(key);
        }
      }
    });
    HomeKitDevicePlug.locks.set(key, currentLock.then(() => {}));
    return currentLock;
  }

  private checkService() {
    const serviceType = this.getServiceType();
    const service: Service =
      this.homebridgeAccessory.getService(serviceType) ?? this.addService(serviceType, this.name);
    this.checkCharacteristics(service);

    // Add Energy Monitoring Service if device supports energy monitoring
    if (this.kasaDevice.feature_info.energy && this.kasaDevice.sys_info.energy) {
      this.checkEnergyMonitoringService();
    }
  }

  private getServiceType() {
    const { Outlet } = this.platform.Service;
    return Outlet;
  }

  private checkCharacteristics(service: Service) {
    const characteristics = this.getCharacteristics();
    characteristics.forEach(({ type, name }) => {
      this.getOrAddCharacteristic(service, type, name);
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
        name: EnergyCharacteristics.VOLTS,
      },
      {
        type: this.platform.CustomCharacteristics.Amperes,
        name: EnergyCharacteristics.AMPERES,
      },
      {
        type: this.platform.CustomCharacteristics.Watts,
        name: EnergyCharacteristics.WATTS,
      },
      {
        type: this.platform.CustomCharacteristics.KilowattHours,
        name: EnergyCharacteristics.KILOWATT_HOURS,
      },
    );
    return characteristics;
  }

  private checkEnergyMonitoringService() {
    // Add custom characteristics to the existing Outlet service
    const service = this.getService();
    if (service) {
      this.checkEnergyMonitoringCharacteristics(service);
    }
  }

  private checkEnergyMonitoringCharacteristics(service: Service) {
    const characteristics = this.getEnergyMonitoringCharacteristics();
    characteristics.forEach(({ type, name }) => {
      this.getOrAddEnergyCharacteristic(service, type, name);
    });
  }

  private getOrAddCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ) {
    const characteristic: Characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, service, characteristicType, characteristicName));
    if (characteristicType === this.platform.Characteristic.On) {
      characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, characteristicName));
    }
  }

  private getOrAddEnergyCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ) {
    const characteristic: Characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);
    characteristic.onGet(this.handleEnergyOnGet.bind(this, service, characteristicType, characteristicName));
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ): Promise<CharacteristicValue> {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.log.warn(`Device is offline or platform is shutting down, cannot get value for characteristic ${characteristicName}`);
      return false;
    }
    try {
      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (!characteristicValue) {
        characteristicValue = this.getInitialValue(characteristicType);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      this.log.debug(`Got value for characteristic ${characteristicName}: ${characteristicValue}`);
      return characteristicValue ?? false;
    } catch (error) {
      this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${this.name}:`, error);
      this.kasaDevice.offline = true;
      await this.stopPolling();
      return false;
    }
  }

  private getInitialValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    if (this.kasaDevice.feature_info.energy && this.kasaDevice.feature_info.energy === true && this.kasaDevice.sys_info.energy) {
      if (characteristicType === this.platform.Characteristic.On) {
        return this.kasaDevice.sys_info.state ?? false;
      }
      if (characteristicType === this.platform.Characteristic.OutletInUse) {
        return (this.kasaDevice.sys_info.energy.power ?? 0) > 1;
      }
    } else {
      if (characteristicType === this.platform.Characteristic.On || characteristicType === this.platform.Characteristic.OutletInUse) {
        return this.kasaDevice.sys_info.state ?? false;
      }
    }
    return false;
  }

  private getEnergyInitialValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    if (this.kasaDevice.feature_info.energy && this.kasaDevice.sys_info.energy) {
      if (characteristicType === this.platform.CustomCharacteristics.Volts) {
        return this.kasaDevice.sys_info.energy.voltage ?? 0;
      }
      if (characteristicType === this.platform.CustomCharacteristics.Amperes) {
        return this.kasaDevice.sys_info.energy.current ?? 0;
      }
      if (characteristicType === this.platform.CustomCharacteristics.Watts) {
        return this.kasaDevice.sys_info.energy.power ?? 0;
      }
      if (characteristicType === this.platform.CustomCharacteristics.KilowattHours) {
        return this.kasaDevice.sys_info.energy.total ?? 0;
      }
    }
    return 0;
  }

  private async handleEnergyOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ): Promise<CharacteristicValue> {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.log.warn(`Device is offline or platform is shutting down, cannot get energy value for characteristic ${characteristicName}`);
      return 0;
    }
    try {
      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (characteristicValue === undefined || characteristicValue === null) {
        characteristicValue = this.getEnergyInitialValue(characteristicType);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      this.log.debug(`Got energy value for characteristic ${characteristicName}: ${characteristicValue}`);
      return characteristicValue ?? 0;
    } catch (error) {
      this.log.error(`Error getting energy value for characteristic ${characteristicName} for device: ${this.name}:`, error);
      return 0;
    }
  }

  private async handleOnSet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    value: CharacteristicValue,
  ): Promise<void> {
    const lockKey = `${this.kasaDevice.sys_info.device_id}`;
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
            await this.deviceManager.controlDevice(this.kasaDevice.sys_info.host, characteristicKey, value);
            (this.kasaDevice.sys_info as Record<string, CharacteristicValue>)[characteristicKey] = value;
            this.updateValue(service, service.getCharacteristic(characteristicType), this.name, value);
            if (this.kasaDevice.feature_info.energy && this.kasaDevice.feature_info.energy === true && this.kasaDevice.sys_info.energy) {
              const outlet_in_use: CharacteristicValue = (Number(this.kasaDevice.sys_info.energy.power ?? 0) > 1) as CharacteristicValue;
              this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), this.name, outlet_in_use);
            } else {
              this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), this.name, value);
            }
            this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
            this.log.debug(`Set value for characteristic ${characteristicName} to ${value} successfully`);
          } catch (error) {
            this.log.error(`Error setting current value for characteristic ${characteristicName} for device: ${this.name}:`, error);
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
          const service = this.getService();
          if (service && this.previousKasaDevice) {
            this.updateDeviceState(service);
          } else {
            this.log.warn(`Service not found for device: ${this.name} or previous Kasa device is undefined`);
          }
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

  private getService() {
    return this.homebridgeAccessory.getService(this.platform.Service.Outlet);;
  }

  private updateDeviceState(service: Service) {
    const previousKasaDevice = this.previousKasaDevice;
    if (previousKasaDevice) {
      if (previousKasaDevice.sys_info.state !== this.kasaDevice.sys_info.state) {
        this.updateValue(
          service, service.getCharacteristic(this.platform.Characteristic.On), this.name, this.kasaDevice.sys_info.state ?? false,
        );
        if (this.kasaDevice.feature_info.energy && this.kasaDevice.feature_info.energy === true && this.kasaDevice.sys_info.energy) {
          const outlet_in_use: CharacteristicValue = (Number(this.kasaDevice.sys_info.energy.power ?? 0) > 1) as CharacteristicValue;
          this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), this.name, outlet_in_use);
        } else {
          this.updateValue(
            service,
            service.getCharacteristic(this.platform.Characteristic.OutletInUse),
            this.name,
            this.kasaDevice.sys_info.state ?? false,
          );
        }
        this.log.debug(`Updated state for child device: ${this.name} to ${this.kasaDevice.sys_info.state}`);
      }

      // Update energy characteristics if energy monitoring is supported
      if (this.kasaDevice.feature_info.energy && this.kasaDevice.sys_info.energy) {
        this.updateEnergyCharacteristics();
      }
    }
  }

  private updateEnergyCharacteristics() {
    const service = this.getService();
    if (service && this.kasaDevice.sys_info.energy) {
      // Update voltage
      const voltage = this.kasaDevice.sys_info.energy.voltage ?? 0;
      this.updateValue(service, service.getCharacteristic(this.platform.CustomCharacteristics.Volts), this.name, voltage);

      // Update current
      const current = this.kasaDevice.sys_info.energy.current ?? 0;
      this.updateValue(service, service.getCharacteristic(this.platform.CustomCharacteristics.Amperes), this.name, current);

      // Update power
      const power = this.kasaDevice.sys_info.energy.power ?? 0;
      this.updateValue(service, service.getCharacteristic(this.platform.CustomCharacteristics.Watts), this.name, power);

      // Update total consumption
      const totalConsumption = this.kasaDevice.sys_info.energy.total ?? 0;
      this.updateValue(service, service.getCharacteristic(this.platform.CustomCharacteristics.KilowattHours), this.name, totalConsumption);

      this.log.debug(`Updated energy characteristics for device: ${this.name} - Volts: ${voltage}V, Amperes: ${current}A, Watts: ${power}W, kWh: ${totalConsumption}`);
    }
  }

  public updateAfterPeriodicDiscovery() {
    const serviceType = this.getServiceType();
    const service: Service | undefined = this.homebridgeAccessory.getService(serviceType);
    if (service) {
      this.updateCharacteristics(service);
    } else {
      this.log.debug(`Service not found for device: ${this.name}`);
    }

    // Update energy monitoring characteristics if supported
    if (this.kasaDevice.feature_info.energy && this.kasaDevice.sys_info.energy) {
      this.updateEnergyCharacteristics();
    }
  }

  private updateCharacteristics(service: Service) {
    const characteristics = this.getCharacteristics();
    characteristics.forEach(({ type, name }) => {
      if (type === this.platform.Characteristic.On) {
        const characteristic: Characteristic = service.getCharacteristic(type);
        if (characteristic) {
          const characteristicKey = this.getCharacteristicKey(name);
          if (this.kasaDevice.sys_info[characteristicKey as keyof SysInfo] !== undefined) {
            const value = this.kasaDevice.sys_info[characteristicKey as keyof SysInfo] as unknown as CharacteristicValue;
            this.log.debug(`Setting value for characteristic ${name} to ${value}`);
            this.updateValue(service, characteristic, this.name, value);
            if (this.kasaDevice.feature_info.energy && this.kasaDevice.feature_info.energy === true && this.kasaDevice.sys_info.energy) {
              const outlet_in_use: CharacteristicValue = (Number(this.kasaDevice.sys_info.energy.power ?? 0) > 1) as CharacteristicValue;
              this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.OutletInUse), this.name, outlet_in_use);
            } else {
              this.updateValue(
                service,
                service.getCharacteristic(this.platform.Characteristic.OutletInUse),
                this.name,
                this.kasaDevice.sys_info.state ?? false,
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