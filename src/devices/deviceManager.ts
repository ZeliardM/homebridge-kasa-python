import type { CharacteristicValue, Logger, PlatformConfig } from 'homebridge';
import axios from 'axios';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import KasaPythonPlatform from '../platform.js';
import { parseConfig } from '../config.js';
import type { ConfigDevice, FeatureInfo, KasaDevice, SysInfo } from './kasaDevices.js';
import { EventEmitter } from 'events';
import { EventSource } from 'eventsource';

export const deviceEventEmitter = new EventEmitter();

export default class DeviceManager {
  private log: Logger;
  private apiUrl: string;
  private username: string;
  private password: string;
  private additionalBroadcasts: string[];
  private manualDevices: string[];
  private excludeMacAddresses: string[];

  constructor(private platform: KasaPythonPlatform) {
    this.log = platform.log;
    this.username = platform.config.username;
    this.password = platform.config.password;
    this.apiUrl = `http://127.0.0.1:${platform.port}`;
    this.additionalBroadcasts = platform.config.discoveryOptions.additionalBroadcasts;
    this.manualDevices = platform.config.discoveryOptions.manualDevices.map(device => device.host);
    this.excludeMacAddresses = platform.config.discoveryOptions.excludeMacAddresses;
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
    let sysInfo: SysInfo;

    if (this.isKasaDevice(device)) {
      sysInfo = device.sys_info as SysInfo;
    } else {
      sysInfo = device as SysInfo;
    }

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

  private isKasaDevice(device: KasaDevice | SysInfo): device is KasaDevice {
    return (device as KasaDevice).sys_info !== undefined;
  }

  private async readConfigFile(configPath: string): Promise<PlatformConfig> {
    try {
      const configData = await fs.readFile(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      this.log.error(`Error reading config file: ${String(error)}`);
      throw error;
    }
  }

  private async writeConfigFile(configPath: string, fileConfig: PlatformConfig): Promise<void> {
    try {
      await fs.writeFile(configPath, JSON.stringify(fileConfig, null, 2), 'utf8');
    } catch (error) {
      this.log.error(`Error writing config file: ${String(error)}`);
    }
  }

  async discoverDevices(): Promise<void> {
    this.log.info('Discovering devices using streaming...');

    try {
      const config = this.username && this.password
        ? { auth: { username: this.username, password: this.password } }
        : {};
      const response = await axios.post<Record<string, { sys_info: SysInfo; feature_info: FeatureInfo }>>(
        `${this.apiUrl}/discover`,
        {
          additionalBroadcasts: this.additionalBroadcasts,
          manualDevices: this.manualDevices,
          excludeMacAddresses: this.excludeMacAddresses,
        },
        config,
      );
      this.log.info('Discovery initiated:', response.data);

      const configPath = path.join(this.platform.storagePath, 'config.json');
      const fileConfig = await this.readConfigFile(configPath);
      const platformConfig = fileConfig.platforms.find((p: PlatformConfig) => p.platform === 'KasaPython');
      if (!platformConfig) {
        this.log.error('KasaPython configuration not found in config file.');
      } else {
        platformConfig.manualDevices = platformConfig.manualDevices || [];
      }

      const eventSource = new EventSource(`${this.apiUrl}/stream`);
      eventSource.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.log.debug('Received SSE event data:', data);
          if (data.status === 'discovery_complete') {
            this.log.info('Device discovery complete.');
            eventSource.close();
          } else {
            if (!data.sys_info || !data.sys_info.host) {
              this.log.error('Invalid device data received:', data);
              return;
            }
            const device: KasaDevice = {
              sys_info: data.sys_info,
              feature_info: data.feature_info,
              last_seen: new Date(),
              offline: false,
            };
            this.log.info(`Received device info for ${device.sys_info.host}`);
            this.processDevice(device, platformConfig);
            deviceEventEmitter.emit('deviceDiscovered', device);
          }
        } catch (err) {
          this.log.error('Error parsing SSE event data:', err);
        }
      };
      eventSource.onerror = (err: Event) => {
        this.log.error('EventSource error:', err);
        eventSource.close();
      };

      await new Promise(resolve => setTimeout(resolve, 10000));
      eventSource.close();

      if (platformConfig) {
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
        await this.writeConfigFile(configPath, fileConfig);
        this.platform.config = parseConfig(platformConfig);
      }
    } catch (error) {
      this.handleAxiosError(error, 'discoverDevices');
    }
  }

  private processDevice(device: KasaDevice, platformConfig: PlatformConfig): void {
    try {
      this.updateDeviceAlias(device);
      if (platformConfig.manualDevices) {
        const existingDevice = platformConfig.manualDevices.find((d: ConfigDevice) => d.host === device.sys_info.host);
        if (existingDevice) {
          existingDevice.host = device.sys_info.host;
          existingDevice.alias = device.sys_info.alias;
        }
      }
    } catch (error) {
      this.log.error(`Error processing device: ${String(error)}`);
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
      if (!sysInfo) {
        this.log.error(`No sys_info returned for host: ${host}`);
        return undefined;
      }
      this.updateDeviceAlias(sysInfo);
      return sysInfo;
    } catch (error) {
      this.handleAxiosError(error, 'getSysInfo');
      throw error;
    }
  }

  async controlDevice(host: string, feature: string, value: CharacteristicValue, child_num?: number): Promise<void> {
    let action: string;
    switch (feature) {
      case 'brightness':
      case 'color_temp':
      case 'fan_speed_level':
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
      this.handleAxiosError(error, 'controlDevice');
    }
  }

  private handleAxiosError(error: unknown, context: string): void {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const statusCode = error.response.status;
        const errorMessage = error.response.data?.error || error.response.statusText || 'Unknown error';
        if (statusCode === 500) {
          this.log.error(`Error during ${context}: ${errorMessage}`);
        } else {
          this.log.error(`Error during ${context}: ${statusCode} - ${errorMessage}`);
        }
      } else if (error.code === 'ECONNREFUSED') {
        this.log.error(`Connection refused during ${context} - device may be offline`);
      } else if (error.code === 'ETIMEDOUT') {
        this.log.error(`Connection timed out during ${context} - network may be down`);
      } else {
        this.log.error(`Axios error during ${context}: ${error.message}`);
      }
    } else if (error instanceof Error) {
      this.log.error(`Error during ${context}: ${error.message}`);
      if (error.stack) {
        this.log.debug(error.stack);
      }
    } else {
      this.log.error(`Unknown error during ${context}: ${JSON.stringify(error)}`);
    }
  }
}