import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';

import HomekitDevice from './index.js';
import { deferAndCombine } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type { KasaDevice, LightBulb, SysInfo } from './kasaDevices.js';

const enableLogging = false;

export default class HomeKitDeviceLightBulb extends HomekitDevice {
  public isUpdating: boolean = false;
  private getSysInfo: () => Promise<void>;
  private hasBrightness: boolean;
  private hasColorTemp: boolean;
  private hasHSV: boolean;
  private previousKasaDevice: KasaDevice | undefined;
  private pollingInterval: NodeJS.Timeout | undefined;

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: LightBulb,
  ) {
    super(
      platform,
      kasaDevice,
      Categories.LIGHTBULB,
      'LIGHTBULB',
    );
    this.log.debug(`Initializing HomeKitDeviceLightBulb for device: ${kasaDevice.sys_info.alias}`);
    this.hasBrightness = !!this.kasaDevice.feature_info.brightness;
    this.hasColorTemp = !!this.kasaDevice.feature_info.color_temp;
    this.hasHSV = !!this.kasaDevice.feature_info.hsv;
    this.checkService();

    this.getSysInfo = deferAndCombine(async () => {
      if (this.deviceManager) {
        this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
        this.kasaDevice.sys_info = await this.deviceManager.getSysInfo(this.deviceConfig) as SysInfo;
      } else {
        this.log.warn('Device manager is not available');
      }
    }, platform.config.waitTimeUpdate);

    this.startPolling();
  }

  private checkService() {
    const { Lightbulb } = this.platform.Service;
    const service: Service =
      this.homebridgeAccessory.getService(Lightbulb) ?? this.addService(Lightbulb, this.name);
    this.checkCharacteristics(service);
    return service;
  }

  private checkCharacteristics(service: Service) {
    const characteristics = [
      {
        type: this.platform.Characteristic.On,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.On),
      },
      this.hasBrightness && {
        type: this.platform.Characteristic.Brightness,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.Brightness),
      },
      this.hasColorTemp && {
        type: this.platform.Characteristic.ColorTemperature,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.ColorTemperature),
      },
      this.hasHSV && {
        type: this.platform.Characteristic.Hue,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.Hue),
      },
      this.hasHSV && {
        type: this.platform.Characteristic.Saturation,
        name: this.platform.getCharacteristicName(this.platform.Characteristic.Saturation),
      },
    ].filter(Boolean) as { type: WithUUID<new () => Characteristic>; name: string | undefined }[];

    characteristics.forEach(({ type, name }) => {
      this.getOrAddCharacteristic(service, type, name);
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
    characteristic.onSet(this.handleOnSet.bind(this, service, characteristicType, characteristicName));
    return characteristic;
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ): Promise<CharacteristicValue> {
    try {
      if (this.kasaDevice.offline) {
        this.log.warn(`Device is offline, cannot get value for characteristic ${characteristicName}`);
        return false;
      }

      let characteristicValue = service.getCharacteristic(characteristicType).value;
      if (!characteristicValue) {
        characteristicValue = this.getInitialValue(characteristicType);
        service.getCharacteristic(characteristicType).updateValue(characteristicValue);
      }
      return characteristicValue ?? this.getDefaultValue(characteristicType);
    } catch (error) {
      if (enableLogging) {
        this.log.error(`Error getting current value for characteristic ${characteristicName} for device: ${this.name}:`, error);
      }
      this.kasaDevice.offline = true;
      this.stopPolling();
    }
    return this.getDefaultValue(characteristicType);
  }

  private getInitialValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    if (characteristicType === this.platform.Characteristic.On) {
      return this.kasaDevice.sys_info.state ?? false;
    } else if (characteristicType === this.platform.Characteristic.Brightness) {
      return this.kasaDevice.sys_info.brightness ?? 0;
    } else if (characteristicType === this.platform.Characteristic.ColorTemperature) {
      return this.kasaDevice.sys_info.color_temp ?? 0;
    } else if (characteristicType === this.platform.Characteristic.Hue) {
      return this.kasaDevice.sys_info.hsv?.hue ?? 0;
    } else if (characteristicType === this.platform.Characteristic.Saturation) {
      return this.kasaDevice.sys_info.hsv?.saturation ?? 0;
    }
    return this.getDefaultValue(characteristicType);
  }

  private getDefaultValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    const zeroValueCharacteristics: WithUUID<new () => Characteristic>[] = [
      this.platform.Characteristic.Brightness,
      this.platform.Characteristic.ColorTemperature,
      this.platform.Characteristic.Hue,
      this.platform.Characteristic.Saturation,
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
    value: CharacteristicValue,
  ): Promise<void> {
    if (this.kasaDevice.offline) {
      this.log.warn(`Device is offline, cannot set value for characteristic ${characteristicName}`);
      return;
    }

    if (this.deviceManager) {
      try {
        this.isUpdating = true;

        const characteristicMap: { [key: string]: string } = {
          Brightness: 'brightness',
          On: 'state',
          ColorTemperature: 'color_temp',
          Hue: 'hue',
          Saturation: 'saturation',
        };

        const characteristicKey = characteristicMap[characteristicName ?? ''];
        if (!characteristicKey) {
          throw new Error(`Characteristic key not found for ${characteristicName}`);
        }

        await this.deviceManager.controlDevice(this.deviceConfig, characteristicKey, value);
        (this.kasaDevice.sys_info as unknown as Record<string, CharacteristicValue>)[characteristicKey] = value;

        this.updateValue(service, service.getCharacteristic(characteristicType), this.name, value);

        this.previousKasaDevice = JSON.parse(JSON.stringify(this.kasaDevice));
      } catch (error) {
        if (enableLogging) {
          this.log.error(`Error setting current value for characteristic ${characteristicName} for device: ${this.name}:`, error);
        }
        this.kasaDevice.offline = true;
        this.stopPolling();
      } finally {
        this.isUpdating = false;
      }
    } else {
      throw new Error('Device manager is undefined.');
    }
  }

  protected async updateState() {
    if (this.kasaDevice.offline) {
      this.stopPolling();
      return;
    }
    if (this.isUpdating || this.platform.periodicDeviceDiscovering) {
      return;
    }
    this.isUpdating = true;
    try {
      await this.getSysInfo();
      const service = this.homebridgeAccessory.getService(this.platform.Service.Lightbulb);
      if (service && this.previousKasaDevice) {
        const { state, brightness, color_temp, hsv } = this.kasaDevice.sys_info;
        const prevState = this.previousKasaDevice.sys_info;

        if (prevState.state !== state) {
          this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.On), this.name, state ?? false);
        }

        if (this.hasBrightness && prevState.brightness !== brightness) {
          this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.Brightness), this.name, brightness ?? 0);
        }

        if (this.hasColorTemp && prevState.color_temp !== color_temp) {
          this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.ColorTemperature), this.name, color_temp ?? 0);
        }

        if (this.hasHSV) {
          if (prevState.hsv?.hue !== hsv?.hue) {
            this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.Hue), this.name, hsv?.hue ?? 0);
          }
          if (prevState.hsv?.saturation !== hsv?.saturation) {
            this.updateValue(service, service.getCharacteristic(this.platform.Characteristic.Saturation), this.name, hsv?.saturation ?? 0);
          }
        }
      } else {
        this.log.warn(`Service not found for device: ${this.name} or previous Kasa device is undefined`);
      }
    } catch (error) {
      if (enableLogging) {
        this.log.error('Error updating device state:', error);
      }
      this.kasaDevice.offline = true;
      this.stopPolling();
    } finally {
      this.isUpdating = false;
    }
  }

  public startPolling() {
    if (this.kasaDevice.offline) {
      this.stopPolling();
      return;
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.pollingInterval = setInterval(async () => {
      if (this.kasaDevice.offline) {
        if (this.isUpdating) {
          this.isUpdating = false;
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
    }
  }

  identify(): void {
    this.log.info('identify');
  }
}