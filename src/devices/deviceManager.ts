import type { Logger, PlatformConfig } from 'homebridge';
import axios from 'axios';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import HomekitDevice from './index.js';
import KasaPythonPlatform from '../platform.js';
import { parseConfig } from '../config.js';
import type { ConfigDevice, KasaDevice } from './kasaDevices.js';

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
        return { host: device, alias: device };
      }
      return device;
    });
  }

  private updateDeviceAlias(device: KasaDevice): void {
    if (device.alias) {
      const aliasMappings: { [key: string]: string } = {
        'TP-LINK_Power Strip_': 'Power Strip',
        'TP-LINK_Smart Plug_': 'Smart Plug',
        'TP-LINK_Smart Bulb_': 'Smart Bulb',
      };

      for (const [pattern, replacement] of Object.entries(aliasMappings)) {
        if (device.alias.includes(pattern)) {
          device.alias = `${replacement} ${device.alias.slice(-4)}`;
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

  async discoverDevices(): Promise<void> {
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
      const devices = response.data;
      this.log.info(`Devices discovered: ${Object.keys(devices).length}`);

      const configPath = path.join(this.platform.storagePath, 'config.json');
      const fileConfig = await this.readConfigFile(configPath);

      const platformConfig = fileConfig.platforms.find((platformConfig: PlatformConfig) => platformConfig.platform === 'KasaPython');
      if (!platformConfig) {
        this.log.error('KasaPython configuration not found in config file.');
        return;
      }

      if (!platformConfig.manualDevices) {
        platformConfig.manualDevices = [];
      }

      if (platformConfig.manualDevices.length > 0 && typeof platformConfig.manualDevices[0] === 'string') {
        platformConfig.manualDevices = this.convertManualDevices(platformConfig.manualDevices);
      }

      const processedDevices: { [key: string]: KasaDevice } = {};

      Object.keys(devices).forEach(ip => {
        const device: KasaDevice = devices[ip].device_info;
        device.device_config = devices[ip].device_config;
        this.processDevice(device, platformConfig);
        processedDevices[ip] = device;
      });

      await this.writeConfigFile(configPath, fileConfig);

      this.platform.config = parseConfig(platformConfig);

      Object.keys(processedDevices).forEach(ip => {
        const device: KasaDevice = processedDevices[ip];
        this.platform.foundDevice(device);
      });

      this.platform.unregisterUnusedAccessories();
    } catch (error) {
      this.log.error(
        `An error occurred during device discovery: ${axios.isAxiosError(error) ? error.message : 'An unknown error occurred'}`,
      );
      if (axios.isAxiosError(error) && error.response) {
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  private processDevice(device: KasaDevice, platformConfig: PlatformConfig): void {
    this.updateDeviceAlias(device);

    const existingDevice = platformConfig.manualDevices.find((d: ConfigDevice) => d.host === device.host);
    if (existingDevice) {
      existingDevice.host = device.host;
      existingDevice.alias = device.alias;

      if (device.sys_info.child_num !== undefined && existingDevice.breakoutChildDevices === undefined) {
        existingDevice.breakoutChildDevices = false;
      }
    } else if (device.sys_info.child_num !== undefined) {
      platformConfig.manualDevices.push({
        host: device.host,
        alias: device.alias,
        breakoutChildDevices: false,
      });
    }
  }

  async getSysInfo(device: HomekitDevice): Promise<KasaDevice | undefined> {
    try {
      const response = await axios.post(`${this.apiUrl}/getSysInfo`, { device_config: device.deviceConfig });
      const kasaDevice: KasaDevice = response.data.device_info;
      this.updateDeviceAlias(kasaDevice);
      return kasaDevice;
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