import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import { EventEmitter } from 'node:events';

import HomeKitDevice from './index.js';
import { deferAndCombine } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { ChildDevice, KasaDevice, Switch, SysInfo } from './kasaDevices.js';

export default class HomeKitDeviceSwitchWithChildren extends HomeKitDevice {
  public isUpdating: boolean = false;
  private previousKasaDevice: KasaDevice | undefined;
  private getSysInfo: () => Promise<void>;
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
    this.kasaDevice.sys_info.children?.forEach((child: ChildDevice, index: number) => {
      this.checkService(child, index);
    });

    this.getSysInfo = deferAndCombine(async () => {
      if (this.deviceManager) {
        this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
        this.kasaDevice.sys_info = await this.deviceManager.getSysInfo(this.kasaDevice.sys_info.host) as SysInfo;
        this.log.debug(`Updated sys_info for device: ${this.kasaDevice.sys_info.alias}`);
      } else {
        this.log.warn('Device manager is not available');
      }
    }, platform.config.advancedOptions.waitTimeUpdate);

    this.startPolling();

    platform.periodicDeviceDiscoveryEmitter.on('periodicDeviceDiscoveryComplete', () => {
      this.updateEmitter.emit('periodicDeviceDiscoveryComplete');
    });
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    let lock = HomeKitDeviceSwitchWithChildren.locks.get(key);
    if (!lock) {
      lock = Promise.resolve();
    }
    const currentLock = lock.then(async () => {
      try {
        return await action();
      } finally {
        if (HomeKitDeviceSwitchWithChildren.locks.get(key) === currentLock) {
          HomeKitDeviceSwitchWithChildren.locks.delete(key);
        }
      }
    });
    HomeKitDeviceSwitchWithChildren.locks.set(key, currentLock.then(() => {}));
    return currentLock;
  }

  private checkService(child: ChildDevice, index: number) {
    const { Lightbulb, Fanv2 } = this.platform.Service;
    const serviceType = child.fan_speed_level ? Fanv2 : Lightbulb;
    const service: Service =
      this.homebridgeAccessory.getServiceById(serviceType, `child-${index + 1}`) ??
      this.addService(serviceType, child.alias, `child-${index + 1}`);
    this.checkCharacteristics(service, child);
    return service;
  }

  private checkCharacteristics(service: Service, child: ChildDevice) {
    const characteristics = [
      child.fan_speed_level && {
        type: this.platform.Characteristic.RotationSpeed,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.RotationSpeed),
      },
      child.fan_speed_level && {
        type: this.platform.Characteristic.Active,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.Active),
      },
      child.brightness && {
        type: this.platform.Characteristic.On,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.Brightness),
      },
      child.brightness && {
        type: this.platform.Characteristic.Brightness,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.Brightness),
      },
    ].filter(Boolean) as { type: WithUUID<new () => Characteristic>; name: string | undefined }[];

    characteristics.forEach(({ type, name }) => {
      this.getOrAddCharacteristic(service, type, name, child);
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
    characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, characteristicName, child));
    return characteristic;
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
    child: ChildDevice,
  ): Promise<CharacteristicValue> {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.log.warn(`Device is offline or platform is shutting down, cannot get value for characteristic ${characteristicName}`);
      return this.getDefaultValue(characteristicType);
    }

    try {
      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (!characteristicValue) {
        characteristicValue = this.getInitialValue(characteristicType, child);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      this.log.debug(`Got value for characteristic ${characteristicName}: ${characteristicValue}`);
      return characteristicValue ?? this.getDefaultValue(characteristicType);
    } catch (error) {
      this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
      this.kasaDevice.offline = true;
      this.stopPolling();
      return false;
    }
  }

  private getInitialValue(characteristicType: WithUUID<new () => Characteristic>, child: ChildDevice): CharacteristicValue {
    if (characteristicType === this.platform.Characteristic.Active) {
      return child.state ? 1 : 0;
    } else if (characteristicType === this.platform.Characteristic.Brightness) {
      return child.brightness ?? 0;
    } else if (characteristicType === this.platform.Characteristic.RotationSpeed) {
      return child.fan_speed_level ?? 0;
    } else if (characteristicType === this.platform.Characteristic.On) {
      return child.state ?? false;
    }
    return false;
  }

  private getDefaultValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    const zeroValueCharacteristics: WithUUID<new () => Characteristic>[] = [
      this.platform.Characteristic.Active,
      this.platform.Characteristic.Brightness,
      this.platform.Characteristic.RotationSpeed,
    ];

    if (zeroValueCharacteristics.includes(characteristicType)) {
      return 0;
    }
    return false;
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

      if (this.isUpdating || this.platform.periodicDeviceDiscovering) {
        await Promise.race([
          new Promise<void>((resolve) => this.updateEmitter.once('updateComplete', resolve)),
          new Promise<void>((resolve) => this.updateEmitter.once('periodicDeviceDiscoveryComplete', resolve)),
        ]);
      }

      const task = async () => {
        if (this.deviceManager) {
          try {
            this.isUpdating = true;
            this.log.debug(`Setting value for characteristic ${characteristicName} to ${value}`);

            const characteristicMap: { [key: string]: string } = {
              Active: 'state',
              Brightness: 'brightness',
              RotationSpeed: 'fan_speed_level',
              On: 'state',
            };

            const characteristicKey = characteristicMap[characteristicName ?? ''];
            if (!characteristicKey) {
              throw new Error(`Characteristic key not found for ${characteristicName}`);
            }

            const childNumber = parseInt(child.id.slice(-1), 10);
            let controlValue;
            if (characteristicName === 'Active') {
              controlValue = value === 1 ? true : false;
            } else if (characteristicName === 'RotationSpeed') {
              controlValue = this.mapValuetoRotationSpeed(value as number);
            } else {
              controlValue = value;
            }
            await this.deviceManager.controlDevice(this.kasaDevice.sys_info.host, characteristicKey, controlValue, childNumber);
            (child[characteristicKey as keyof ChildDevice] as unknown as CharacteristicValue) = controlValue;

            const childIndex = this.kasaDevice.sys_info.children?.findIndex(c => c.id === child.id);
            if (childIndex !== undefined && childIndex !== -1) {
                this.kasaDevice.sys_info.children![childIndex] = { ...child };
            }

            this.updateValue(service, service.getCharacteristic(characteristicType), child.alias, value);

            this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
            this.log.debug(`Set value for characteristic ${characteristicName} to ${value} successfully`);
          } catch (error) {
            this.log.error(`Error setting current value for characteristic ${characteristicName} for device: ${child.alias}:`, error);
            this.kasaDevice.offline = true;
            this.stopPolling();
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

  private mapValuetoRotationSpeed(value: number): number {
    if (value === 0) {
      return 0;
    } else if (value >= 1 && value <= 25) {
      return 1;
    } else if (value >= 26 && value <= 50) {
      return 2;
    } else if (value >= 51 && value <= 75) {
      return 3;
    } else if (value >= 76 && value <= 100) {
      return 4;
    }
    return 0;
  }

  protected async updateState() {
    const lockKey = `${this.kasaDevice.sys_info.device_id}`;
    await this.withLock(lockKey, async () => {
      if (this.kasaDevice.offline || this.platform.isShuttingDown) {
        this.stopPolling();
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
          await new Promise((resolve) => setTimeout(resolve, this.platform.config.discoveryOptions.pollingInterval));
        }
      }
      this.isUpdating = true;
      const task = async () => {
        try {
          await this.getSysInfo();
          this.kasaDevice.sys_info.children?.forEach((child: ChildDevice) => {
            const childNumber = parseInt(child.id.slice(-1), 10);
            let service;
            if (child.brightness) {
              service = this.homebridgeAccessory.getServiceById(this.platform.Service.Lightbulb, `child-${childNumber + 1}`);
            } else if (child.fan_speed_level) {
              service = this.homebridgeAccessory.getServiceById(this.platform.Service.Fanv2, `child-${childNumber + 1}`);
            }
            if (service && service.UUID === this.platform.Service.Lightbulb.UUID && this.previousKasaDevice) {
              const previousChild = this.previousKasaDevice.sys_info.children?.find(c => c.id === child.id);
              if (previousChild) {
                if (previousChild.state !== child.state) {
                  this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), child.alias, child.state);
                  this.log.debug(`Updated state for child device: ${child.alias} to ${child.state}`);
                }
                if (child.brightness && previousChild.brightness !== child.brightness) {
                  this.updateValue(
                    service,
                    service.getCharacteristic(this.platform.Characteristic.Brightness),
                    child.alias,
                    child.brightness,
                  );
                  this.log.debug(`Updated brightness for child device: ${child.alias} to ${child.brightness}`);
                }
              }
            } else if (service && service.UUID === this.platform.Service.Fanv2.UUID && this.previousKasaDevice) {
              const previousChild = this.previousKasaDevice.sys_info.children?.find(c => c.id === child.id);
              if (previousChild) {
                if (previousChild.state !== child.state) {
                  this.updateValue(
                    service, service.getCharacteristic(this.platform.Characteristic.Active), child.alias, child.state ? 1 : 0,
                  );
                  this.log.debug(`Updated state for child device: ${child.alias} to ${child.state}`);
                }
                if (child.fan_speed_level && previousChild.fan_speed_level !== child.fan_speed_level) {
                  this.updateValue(
                    service,
                    service.getCharacteristic(this.platform.Characteristic.RotationSpeed),
                    child.alias,
                    child.fan_speed_level,
                  );
                  this.log.debug(`Updated fan speed for child device: ${child.alias} to ${child.fan_speed_level}`);
                }
              }
            } else {
              this.log.warn(`Service not found for child device: ${child.alias} or previous Kasa device is undefined`);
            }
          });
        } catch (error) {
          this.log.error('Error updating device state:', error);
          this.kasaDevice.offline = true;
          this.stopPolling();
        } finally {
          this.isUpdating = false;
          this.updateEmitter.emit('updateComplete');
        }
      };
      await task();
    });
  }

  public startPolling() {
    if (this.kasaDevice.offline || this.platform.isShuttingDown) {
      this.stopPolling();
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
        this.stopPolling();
      } else {
        await this.updateState();
      }
    }, this.platform.config.discoveryOptions.pollingInterval);
  }

  public stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
      this.log.debug('Stopped polling');
    }
  }

  identify(): void {
    this.log.info('identify');
  }
}