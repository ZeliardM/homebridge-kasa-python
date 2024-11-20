import type { Logger, PlatformConfig } from 'homebridge';
import axios from 'axios';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import HomekitDevice from './index.js';
import KasaPythonPlatform from '../platform.js';
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
    this.manualDevices = this.convertManualDevices(platform.config.discoveryOptions.manualDevices).map(device => device.host);
  }

  private convertManualDevices(manualDevices: (string | ConfigDevice)[]): ConfigDevice[] {
    return manualDevices.map(device => {
      if (typeof device === 'string') {
        return { host: device, alias: device, breakoutChildDevices: false };
      }
      return device;
    });
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
      let fileConfig;
      try {
        const configData = await fs.readFile(configPath, 'utf8');
        fileConfig = JSON.parse(configData);
      } catch (error) {
        this.log.error('Error reading config file:', error);
        return;
      }

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
        this.platform.log.debug('Converted manualDevices to new format.');
      }

      Object.keys(devices).forEach(ip => {
        const device: KasaDevice = devices[ip].device_info;
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
        device.device_config = devices[ip].device_config;

        const existingDevice = platformConfig.manualDevices.find((d: ConfigDevice) => d.host === device.host);
        if (existingDevice) {
          existingDevice.host = device.host;
          existingDevice.alias = device.alias;
          this.platform.log.debug(`Device ${device.alias} already exists in config, updated host and alias.`);
        } else if (device.sys_info.child_num !== undefined) {
          platformConfig.manualDevices.push({
            host: device.host,
            alias: device.alias,
            breakoutChildDevices: false,
          });
          this.platform.log.debug(`Device ${device.alias} added to config file.`);
        }

        this.platform.foundDevice(device);
      });

      try {
        await fs.writeFile(configPath, JSON.stringify(fileConfig, null, 2), 'utf8');
        this.log.debug('Config file updated with discovered devices.');
      } catch (error) {
        this.log.error('Error writing config file:', error);
      }
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

  async getSysInfo(device: HomekitDevice): Promise<KasaDevice | undefined> {
    try {
      const response = await axios.post(`${this.apiUrl}/getSysInfo`, { device_config: device.deviceConfig });
      const kasaDevice: KasaDevice = response.data.device_info;
      if (kasaDevice.alias) {
        const aliasMappings: { [key: string]: string } = {
          'TP-LINK_Power Strip_': 'Power Strip',
          'TP-LINK_Smart Plug_': 'Smart Plug',
          'TP-LINK_Smart Bulb_': 'Smart Bulb',
        };

        for (const [pattern, replacement] of Object.entries(aliasMappings)) {
          if (kasaDevice.alias.includes(pattern)) {
            kasaDevice.alias = `${replacement} ${kasaDevice.alias.slice(-4)}`;
            break;
          }
        }
      }
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