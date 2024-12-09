import type { CharacteristicValue, Logger, PlatformConfig } from 'homebridge';
import axios, { AxiosError } from 'axios';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import KasaPythonPlatform from '../platform.js';
import { parseConfig } from '../config.js';
import type { ConfigDevice, DeviceConfig, DiscoveryInfo, FeatureInfo, KasaDevice, SysInfo } from './kasaDevices.js';

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
      const response = await axios.post<{
        devices: Record<string, {
          sys_info: SysInfo;
          disc_info: DiscoveryInfo;
          feature_info: FeatureInfo;
          device_config: DeviceConfig;
        }>;
      }>(
        `${this.apiUrl}/discover`,
        {
          additionalBroadcasts: this.additionalBroadcasts,
          manualDevices: this.manualDevices,
        },
        config,
      );

      const devices: Record<string, {
        sys_info: SysInfo;
        disc_info: DiscoveryInfo;
        feature_info: FeatureInfo;
        device_config: DeviceConfig;
      }> = response.data.devices;

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

      if (platformConfig.manualDevices.length > 0 &&
        (typeof platformConfig.manualDevices[0] === 'string' ||
          platformConfig.manualDevices.some((device: ConfigDevice) => typeof device !== 'string'))) {
        platformConfig.manualDevices = this.convertManualDevices(platformConfig.manualDevices);
      }

      const processedDevices: { [key: string]: KasaDevice } = {};

      Object.keys(devices).forEach(ip => {
        const deviceInfo = devices[ip].sys_info;
        const discoveryInfo = devices[ip].disc_info;
        const featureInfo = devices[ip].feature_info;
        const deviceConfig = devices[ip].device_config;

        const device: KasaDevice = {
          sys_info: deviceInfo,
          disc_info: discoveryInfo,
          feature_info: featureInfo,
          device_config: deviceConfig,
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
      if (axios.isAxiosError(error)) {
        const errorMessage = (error as AxiosError<{ error: string }>).response?.data?.error || 'An unexpected error occurred';
        this.log.error(`An error occurred during device discovery: ${errorMessage}`);
      } else {
        this.log.error(`An unexpected error occurred: ${(error as Error).message}`);
      }
      return {};
    }
  }

  private processDevice(device: KasaDevice, platformConfig: PlatformConfig): void {
    this.updateDeviceAlias(device);

    const existingDevice = platformConfig.manualDevices.find((d: ConfigDevice) => d.host === device.sys_info.host);
    if (existingDevice) {
      existingDevice.host = device.sys_info.host;
      existingDevice.alias = device.sys_info.alias;
    }
  }

  async getSysInfo(deviceConfig: DeviceConfig): Promise<SysInfo | undefined> {
    try {
      const response = await axios.post(`${this.apiUrl}/getSysInfo`, { device_config: deviceConfig });
      const sysInfo: SysInfo = response.data.sys_info;
      this.updateDeviceAlias(sysInfo);
      return sysInfo;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMessage = (error as AxiosError<{ error: string }>).response?.data?.error || 'An unexpected error occurred';
        this.log.error(`An error occurred during device discovery: ${errorMessage}`);
      } else {
        this.log.error(`An unexpected error occurred: ${(error as Error).message}`);
      }
    }
  }

  async controlDevice(deviceConfig: DeviceConfig, feature: string, value: CharacteristicValue, child_num?: number): Promise<void> {
    try {
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

      await this.performDeviceAction(deviceConfig, feature, action, value, child_num);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMessage = (error as AxiosError<{ error: string }>).response?.data?.error || 'An unexpected error occurred';
        this.log.error(`An error occurred during device discovery: ${errorMessage}`);
      } else {
        this.log.error(`An unexpected error occurred: ${(error as Error).message}`);
      }
    }
  }

  private async performDeviceAction(
    deviceConfig: DeviceConfig, feature: string, action: string, value: CharacteristicValue, childNumber?: number,
  ): Promise<void> {
    const url = `${this.apiUrl}/controlDevice`;
    const data = {
      device_config: deviceConfig,
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
      if (axios.isAxiosError(error)) {
        const errorMessage = (error as AxiosError<{ error: string }>).response?.data?.error || 'An unexpected error occurred';
        this.log.error(`An error occurred during device discovery: ${errorMessage}`);
      } else {
        this.log.error(`An unexpected error occurred: ${(error as Error).message}`);
      }
    }
  }
}