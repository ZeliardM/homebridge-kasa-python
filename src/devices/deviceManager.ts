import type { Logger, PlatformConfig } from 'homebridge';
import axios from 'axios';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import HomekitDevice from './index.js';
import KasaPythonPlatform from '../platform.js';
import { parseConfig } from '../config.js';
import type { ConfigDevice, DeviceConfig, DiscoveryInfo, KasaDevice, SysInfo } from './kasaDevices.js';

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
      } else {
        if ('breakoutChildDevices' in device) {
          delete device.breakoutChildDevices;
        }
        return device;
      }
    });
  }

  private updateDeviceAlias(device: KasaDevice | SysInfo): void {
    if ('sys_info' in device) {
      this.updateAliasForSysInfo(device.sys_info);
    } else {
      this.updateAliasForSysInfo(device);
    }
  }

  private updateAliasForSysInfo(sysInfo: SysInfo): void {
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
      this.log.error('Error reading config file:', error);
      throw error;
    }
  }

  private async writeConfigFile(configPath: string, fileConfig: PlatformConfig): Promise<void> {
    try {
      await fs.writeFile(configPath, JSON.stringify(fileConfig, null, 2), 'utf8');
    } catch (error) {
      this.log.error('Error writing config file:', error);
    }
  }

  async discoverDevices(): Promise<Record<string, KasaDevice>> {
    this.log.info('Discovering devices...');
    try {
      const config = {
        ...(this.username && this.password && {
          auth: {
            username: this.username,
            password: this.password,
          },
        }),
      };
      this.log.debug(
        `Sending discovery request with additionalBroadcasts: ${JSON.stringify(this.additionalBroadcasts)}, ` +
        `and manualDevices: ${JSON.stringify(this.manualDevices)}`,
      );
      const response = await axios.post(`${this.apiUrl}/discover`, {
        additionalBroadcasts: this.additionalBroadcasts,
        manualDevices: this.manualDevices,
      }, config);
      this.log.debug('Discovery request sent successfully');
      const devices: Record<string, { sys_info: SysInfo; disc_info: DiscoveryInfo; device_config: DeviceConfig }> = response.data;
      this.log.info(`Devices discovered: ${Object.keys(devices).length}`);

      const configPath = path.join(this.platform.storagePath, 'config.json');
      this.log.debug(`Reading config file from path: ${configPath}`);
      const fileConfig = await this.readConfigFile(configPath);
      this.log.debug('Config file read successfully');

      const platformConfig = fileConfig.platforms.find((platformConfig: PlatformConfig) => platformConfig.platform === 'KasaPython');
      if (!platformConfig) {
        this.log.error('KasaPython configuration not found in config file.');
        return {};
      }
      this.log.debug('KasaPython configuration found in config file');

      if (!platformConfig.manualDevices) {
        this.log.debug('Initializing manualDevices as an empty array');
        platformConfig.manualDevices = [];
      }

      if (platformConfig.manualDevices.length > 0) {
        this.log.debug('Filtering manualDevices to remove entries without a host');
        platformConfig.manualDevices = platformConfig.manualDevices.filter((device: string | ConfigDevice) => {
          if (typeof device === 'string') {
            return true;
          } else if (!device.host) {
            this.log.warn(`Removing manual device without host: ${JSON.stringify(device)}`);
            return false;
          }
          return true;
        });
      }

      if (
        platformConfig.manualDevices.length > 0 &&
        (typeof platformConfig.manualDevices[0] === 'string' ||
          platformConfig.manualDevices.some((device: ConfigDevice) => typeof device !== 'string' && 'breakoutChildDevices' in device))
      ) {
        this.log.debug('Converting manualDevices');
        platformConfig.manualDevices = this.convertManualDevices(platformConfig.manualDevices);
      }

      const processedDevices: { [key: string]: KasaDevice } = {};
      this.log.debug('Processing discovered devices');

      Object.keys(devices).forEach(ip => {
        const deviceInfo = devices[ip].sys_info;
        const discoveryInfo = devices[ip].disc_info;
        const deviceConfig = devices[ip].device_config;

        const device: KasaDevice = {
          sys_info: deviceInfo,
          disc_info: discoveryInfo,
          device_config: deviceConfig,
        };
        this.processDevice(device, platformConfig);
        processedDevices[ip] = device;
        this.log.debug(`Processed device with IP: ${ip}`);
      });

      if (!platformConfig.manualDevices || platformConfig.manualDevices.length === 0) {
        this.log.debug('Removing manualDevices from config as it is empty or undefined');
        delete platformConfig.manualDevices;
      }

      this.log.debug('Writing updated config file');
      await this.writeConfigFile(configPath, fileConfig);
      this.log.debug('Config file written successfully');

      this.platform.config = parseConfig(platformConfig);
      this.log.debug('Platform config updated');

      return processedDevices;
    } catch (error) {
      this.log.error(
        `An error occurred during device discovery: ${axios.isAxiosError(error) ? error.message : 'An unknown error occurred'}`,
      );
      if (axios.isAxiosError(error) && error.response) {
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
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

  async getSysInfo(device: HomekitDevice): Promise<SysInfo | undefined> {
    try {
      const response = await axios.post(`${this.apiUrl}/getSysInfo`, { device_config: device.deviceConfig });
      const sysInfo: SysInfo = response.data.sys_info;
      this.updateDeviceAlias(sysInfo);
      return sysInfo;
    } catch (error) {
      this.log.error(
        `An error occurred during getSysInfo: ${axios.isAxiosError(error) ? error.message : 'An unknown error occurred'}`,
      );
      if (axios.isAxiosError(error) && error.response) {
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  async toggleDevice(device: HomekitDevice, state: boolean, child_num?: number): Promise<void> {
    const action = state ? 'turn_on' : 'turn_off';
    const childText = child_num !== undefined ? ` child ${child_num}` : '';
    try {
      await this.performDeviceAction(device, action, child_num);
    } catch (error) {
      this.log.error(
        `An error occurred turning ${state ? 'on' : 'off'} device ${device.name}${childText}: ${
          axios.isAxiosError(error) ? error.message : 'An unknown error occurred'
        }`,
      );
      if (axios.isAxiosError(error) && error.response) {
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  private async performDeviceAction(device: HomekitDevice, action: string, childNumber?: number): Promise<void> {
    const url = `${this.apiUrl}/controlDevice`;
    const data = {
      device_config: device.deviceConfig,
      action,
      ...(childNumber !== undefined && { child_num: childNumber }),
    };
    try {
      const response = await axios.post(url, data);
      if (response.data.status !== 'success') {
        this.log.error(`Error performing action: ${response.data.message}`);
      }
    } catch (error) {
      this.log.error(`Error performing action: ${axios.isAxiosError(error) ? error.message : 'An unknown error occurred'}`);
      if (axios.isAxiosError(error) && error.response) {
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }
}