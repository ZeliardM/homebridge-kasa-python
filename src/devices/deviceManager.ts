import type { CharacteristicValue, Logger, PlatformConfig } from 'homebridge';
import axios from 'axios';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import KasaPythonPlatform from '../platform.js';
import { parseConfig } from '../config.js';
import type { ConfigDevice, DeviceConfig, FeatureInfo, KasaDevice, SysInfo } from './kasaDevices.js';

export default class DeviceManager {
  private log: Logger;
  private apiUrl: string;
  private username: string;
  private password: string;
  private additionalBroadcasts: string[];
  private manualDevices: string[];

  constructor(private platform: KasaPythonPlatform) {
    this.log = platform.log;
    this.username = platform.config.username;
    this.password = platform.config.password;
    this.apiUrl = `http://127.0.0.1:${platform.port}`;
    this.additionalBroadcasts = platform.config.discoveryOptions.additionalBroadcasts;
    this.manualDevices = platform.config.discoveryOptions.manualDevices.map(device => device.host);
  }

  private convertManualDevices(manualDevices: (string | ConfigDevice)[]): ConfigDevice[] {
    return manualDevices.map(device => {
      if (typeof device === 'string') {
        return { host: device, alias: 'Will Be Filled By Plug-In Automatically' };
      } else if ('breakoutChildDevices' in device) {
        delete device.breakoutChildDevices;
      } else if ('host' in device && !('alias' in device)) {
        (device as ConfigDevice).alias = 'Will Be Filled By Plug-In Automatically';
      }
      return device;
    });
  }

  private updateDeviceAlias(device: KasaDevice | SysInfo): void {
    const sysInfo = 'sys_info' in device ? device.sys_info as SysInfo : device;
    if (sysInfo.alias) {
      const aliasMappings: { [key: string]: string } = {
        'TP-LINK_Power Strip_': 'Power Strip',
        'TP-LINK_Smart Plug_': 'Smart Plug',
        'TP-LINK_Smart Bulb_': 'Smart Bulb',
      };

      for (const [pattern, replacement] of Object.entries(aliasMappings)) {
        if (sysInfo.alias.includes(pattern)) {
          sysInfo.alias = `${replacement} ${sysInfo.alias.slice(-4)}`;
          break;
        }
      }
    }
  }

  private async readConfigFile(configPath: string): Promise<PlatformConfig> {
    try {
      const configData = await fs.readFile(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      this.log.error(`Error reading config file: ${error}`);
      throw error;
    }
  }

  private async writeConfigFile(configPath: string, fileConfig: PlatformConfig): Promise<void> {
    try {
      await fs.writeFile(configPath, JSON.stringify(fileConfig, null, 2), 'utf8');
    } catch (error) {
      this.log.error(`Error writing config file: ${error}`);
    }
  }

  async discoverDevices(): Promise<Record<string, KasaDevice>> {
    this.log.info('Discovering devices...');
    try {
      const config = this.username && this.password ? { auth: { username: this.username, password: this.password } } : {};
      const response = await axios.post<Record<string, {
        sys_info: SysInfo;
        feature_info: FeatureInfo;
        device_config: DeviceConfig;
      }>>(
        `${this.apiUrl}/discover`,
        {
          additionalBroadcasts: this.additionalBroadcasts,
          manualDevices: this.manualDevices,
        },
        config,
      );

      const devices: Record<string, {
        sys_info: SysInfo;
        feature_info: FeatureInfo;
      }> = response.data;

      if (!devices || Object.keys(devices).length === 0) {
        this.log.error('No devices found.');
        return {};
      }

      const configPath = path.join(this.platform.storagePath, 'config.json');
      const fileConfig = await this.readConfigFile(configPath);

      const platformConfig = fileConfig.platforms.find((platformConfig: PlatformConfig) => platformConfig.platform === 'KasaPython');
      if (!platformConfig) {
        this.log.error('KasaPython configuration not found in config file.');
        return {};
      }

      platformConfig.manualDevices = platformConfig.manualDevices || [];

      platformConfig.manualDevices = platformConfig.manualDevices.filter((device: string | ConfigDevice) => {
        if (typeof device === 'string') {
          return true;
        } else if (!device.host) {
          this.log.warn(`Removing manual device without host: ${JSON.stringify(device)}`);
          return false;
        }
        return true;
      });

      if (this.shouldConvertManualDevices(platformConfig.manualDevices)) {
        platformConfig.manualDevices = this.convertManualDevices(platformConfig.manualDevices);
      }

      const processedDevices: { [key: string]: KasaDevice } = {};

      Object.keys(devices).forEach(ip => {
        const deviceInfo = devices[ip].sys_info;
        const featureInfo = devices[ip].feature_info;

        const device: KasaDevice = {
          sys_info: deviceInfo,
          feature_info: featureInfo,
          last_seen: new Date(),
          offline: false,
        };
        this.processDevice(device, platformConfig);
        processedDevices[ip] = device;
      });

      if (!platformConfig.manualDevices.length) {
        delete platformConfig.manualDevices;
      }

      await this.writeConfigFile(configPath, fileConfig);
      this.platform.config = parseConfig(platformConfig);

      return processedDevices;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const statusCode = error.response.status;
        const errorMessage = error.response.data.error;
        if (statusCode === 500) {
          this.log.error(`Exception during discoverDevices post request: ${errorMessage}`);
        } else {
          this.log.error(`Unexpected error during discoverDevices post request: ${errorMessage}`);
        }
      } else {
        this.log.error('Error during discoverDevices post request:', error);
      }
      return {};
    }
  }

  private processDevice(device: KasaDevice, platformConfig: PlatformConfig): void {
    try {
      this.updateDeviceAlias(device);

      const existingDevice = platformConfig.manualDevices.find((d: ConfigDevice) => d.host === device.sys_info.host);
      if (existingDevice) {
        existingDevice.host = device.sys_info.host;
        existingDevice.alias = device.sys_info.alias;
      }
    } catch (error) {
      this.log.error(`Error processing device: ${(error as Error).message}`);
    }
  }

  private shouldConvertManualDevices(manualDevices: (string | ConfigDevice)[]): boolean {
    return manualDevices.length > 0 &&
      (typeof manualDevices[0] === 'string' ||
        manualDevices.some((device) => typeof device !== 'string'));
  }

  async getSysInfo(host: string): Promise<SysInfo | undefined> {
    try {
      const response = await axios.post(`${this.apiUrl}/getSysInfo`, { host });
      const sysInfo: SysInfo = response.data.sys_info;
      this.updateDeviceAlias(sysInfo);
      return sysInfo;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const statusCode = error.response.status;
        const errorMessage = error.response.data.error;
        if (statusCode === 500) {
          this.log.error(`Exception during getSysInfo post request: ${errorMessage}`);
        } else {
          this.log.error(`Unexpected error during getSysInfo post request: ${errorMessage}`);
        }
      } else {
        this.log.error('Error during getSysInfo post request:', error);
      }
    }
  }

  async controlDevice(host: string, feature: string, value: CharacteristicValue, child_num?: number): Promise<void> {
    let action: string;
    switch (feature) {
      case 'brightness':
      case 'color_temp':
        action = `set_${feature}`;
        break;
      case 'hue':
      case 'saturation':
        action = 'set_hsv';
        break;
      case 'state':
        action = value ? 'turn_on' : 'turn_off';
        break;
      default:
        throw new Error(`Unsupported feature: ${feature}`);
    }

    await this.performDeviceAction(host, feature, action, value, child_num);
  }

  private async performDeviceAction(
    host: string, feature: string, action: string, value: CharacteristicValue, childNumber?: number,
  ): Promise<void> {
    const url = `${this.apiUrl}/controlDevice`;
    const data = {
      host,
      feature,
      action,
      value,
      ...(childNumber !== undefined && { child_num: childNumber }),
    };

    try {
      const response = await axios.post(url, data);
      if (response.data.status !== 'success') {
        this.log.error(`Error performing action: ${response.data.message}`);
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const statusCode = error.response.status;
        const errorMessage = error.response.data.error;
        if (statusCode === 500) {
          this.log.error(`Exception during controlDevice post request: ${errorMessage}`);
        } else {
          this.log.error(`Unexpected error during controlDevice post request: ${errorMessage}`);
        }
      } else {
        this.log.error('Error during controlDevice post request:', error);
      }
    }
  }
}