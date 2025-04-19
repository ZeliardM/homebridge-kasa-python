import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import { EventEmitter } from 'node:events';

import HomeKitDevice from './index.js';
import { deferAndCombine } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, Switch, SysInfo } from './kasaDevices.js';

export default class HomeKitDeviceSwitch extends HomeKitDevice {
  public isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<void>;
  private hasBrightness: boolean;
  private pollingInterval: NodeJS.Timeout | undefined;
  private updateEmitter: EventEmitter = new EventEmitter();
  private static locks: Map<string, Promise<void>> = new Map();

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: Switch,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.SWITCH,
      'SWITCH',
    );
    this.log.debug(`Initializing HomeKitDeviceSwitch for device: ${kasaDevice.sys_info.alias}`);
    this.hasBrightness = !!this.kasaDevice.feature_info.brightness;
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
    let lock = HomeKitDeviceSwitch.locks.get(key);
    if (!lock) {
      lock = Promise.resolve();
    }
    const currentLock = lock.then(async () => {
      try {
        return await action();
      } finally {
        if (HomeKitDeviceSwitch.locks.get(key) === currentLock) {
          HomeKitDeviceSwitch.locks.delete(key);
        }
      }
    });
    HomeKitDeviceSwitch.locks.set(key, currentLock.then(() => {}));
    return currentLock;
  }

  private checkService() {
    const serviceType = this.getServiceType();
    const service: Service =
      this.homebridgeAccessory.getService(serviceType) ?? this.addService(serviceType, this.name);
    this.checkCharacteristics(service);
  }

  private getServiceType() {
    const { Switch, Lightbulb } = this.platform.Service;
    return this.hasBrightness ? Lightbulb : Switch;
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
    );
    if (this.hasBrightness) {
      characteristics.push(
        {
          type: this.platform.Characteristic.Brightness,
          name: this.platform.getCharacteristicName(this.platform.Characteristic.Brightness),
        },
      );
    }
    return characteristics;
  }

  private getOrAddCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ) {
    const characteristic: Characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);
    characteristic.onGet(this.handleOnGet.bind(this, service, characteristicType, characteristicName));
    characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, characteristicName));
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ): Promise<CharacteristicValue> {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.log.warn(`Device is offline or platform is shutting down, cannot get value for characteristic ${characteristicName}`);
      return this.getDefaultValue(characteristicType);
    }
    try {
      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (!characteristicValue) {
        characteristicValue = this.getInitialValue(characteristicType);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      this.log.debug(`Got value for characteristic ${characteristicName}: ${characteristicValue}`);
      return characteristicValue ?? this.getDefaultValue(characteristicType);
    } catch (error) {
      this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${this.name}:`, error);
      this.kasaDevice.offline = true;
      await this.stopPolling();
      return this.getDefaultValue(characteristicType);
    }
  }

  private getDefaultValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    if (characteristicType === this.platform.Characteristic.Brightness) {
      return 0;
    }
    return false;
  }

  private getInitialValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    if (characteristicType === this.platform.Characteristic.On) {
      return this.kasaDevice.sys_info.state ?? false;
    } else if (characteristicType === this.platform.Characteristic.Brightness) {
      return this.kasaDevice.sys_info.brightness ?? 0;
    }
    return this.getDefaultValue(characteristicType);
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
      Brightness: 'brightness',
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
    return this.homebridgeAccessory.getService(this.platform.Service.Switch) ??
      this.homebridgeAccessory.getService(this.platform.Service.Lightbulb);
  }

  private updateDeviceState(service: Service) {
    const { state, brightness } = this.kasaDevice.sys_info;
    const prevState = this.previousKasaDevice!.sys_info;
    if (prevState.state !== state) {
      this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), this.name, state ?? false);
      this.log.debug(`Updated state for device: ${this.name} to state: ${state}`);
    }

    if (this.hasBrightness && prevState.brightness !== brightness) {
      this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.Brightness), this.name, brightness ?? 0);
      this.log.debug(`Updated brightness for device: ${this.name} to brightness: ${brightness}`);
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
  }

  private updateCharacteristics(service: Service) {
    const characteristics = this.getCharacteristics();
    characteristics.forEach(({ type, name }) => {
      const characteristic: Characteristic = service.getCharacteristic(type);
      if (characteristic) {
        const characteristicKey = this.getCharacteristicKey(name);
        if (this.kasaDevice.sys_info[characteristicKey as keyof SysInfo] !== undefined) {
          const value = this.kasaDevice.sys_info[characteristicKey as keyof SysInfo] as unknown as CharacteristicValue;
          this.log.debug(`Setting value for characteristic ${name} to ${value}`);
          this.updateValue(service, characteristic, this.name, value);
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