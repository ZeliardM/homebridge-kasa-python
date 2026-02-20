import type { CharacteristicValue, Logger, PlatformConfig } from 'homebridge';

import axios from 'axios';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventSource } from 'eventsource';
import { EventEmitter } from 'node:events';

import KasaPythonPlatform from '../platform.js';
import { parseConfig } from '../config.js';
import type { ConfigDevice, FeatureInfo, HSV, KasaDevice, SysInfo } from './deviceTypes.js';

export const deviceEventEmitter = new EventEmitter();

type ControlValue = CharacteristicValue | HSV;

export default class DeviceManager {
  private log: Logger;
  private apiUrl: string;
  private username: string;
  private password: string;
  private additionalBroadcasts: string[];
  private manualDeviceHosts: string[];
  private excludeMacs: string[];
  private includeMacs: string[];

  constructor(private platform: KasaPythonPlatform) {
    this.log = platform.log;
    this.username = platform.config.username;
    this.password = platform.config.password;
    this.apiUrl = `http://127.0.0.1:${platform.port}`;
    this.additionalBroadcasts = platform.config.discoveryOptions.additionalBroadcasts;
    this.manualDeviceHosts = platform.config.discoveryOptions.manualDevices.map(d => d.host);
    this.excludeMacs = platform.config.discoveryOptions.excludeMacAddresses;
    this.includeMacs = platform.config.discoveryOptions.includeMacAddresses;
  }

  async discoverDevices(): Promise<void> {
    this.log.debug('Starting device discovery...');
    try {
      const authConfig = this.username && this.password
        ? { auth: { username: this.username, password: this.password } }
        : {};
      await axios.post<Record<string, { sys_info: SysInfo; feature_info: FeatureInfo }>>(
        `${this.apiUrl}/discover`,
        {
          additionalBroadcasts: this.additionalBroadcasts,
          manualDevices: this.manualDeviceHosts,
          excludeMacAddresses: this.excludeMacs,
          includeMacAddresses: this.includeMacs,
        },
        authConfig,
      );

      const configPath = path.join(this.platform.storagePath, 'config.json');
      const fileConfig = await this.readConfigFile(configPath);
      const platformSection = fileConfig.platforms.find((p: PlatformConfig) => p.platform === 'KasaPython');
      if (!platformSection) {
        this.log.error('KasaPython configuration missing in config file.');
      } else {
        platformSection.manualDevices = platformSection.manualDevices || [];
      }

      const eventSource = new EventSource(`${this.apiUrl}/stream`);
      eventSource.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.log.debug('SSE event data:', data);
          if (data.status === 'discovery_complete') {
            this.log.debug('Device discovery complete.');
            eventSource.close();
            return;
          }
          if (!data.sys_info || !data.sys_info.host) {
            this.log.error('Invalid device payload (missing sys_info.host):', data);
            return;
          }
          const device: KasaDevice = {
            sys_info: data.sys_info,
            feature_info: data.feature_info,
            last_seen: new Date(),
            offline: false,
          };
          this.log.debug(`Discovered device: ${device.sys_info.alias} (${device.sys_info.host})`);
          this.updateDeviceAlias(device.sys_info);
          this.persistDiscoveredDevice(device, platformSection);
          deviceEventEmitter.emit('deviceDiscovered', device);
        } catch (error) {
          this.log.error('Error parsing discovery SSE event:', error);
        }
      };
      eventSource.onerror = (error: Event) => {
        this.log.error('Discovery EventSource error:', error);
        eventSource.close();
      };

      await new Promise(resolve => setTimeout(resolve, 10000));
      eventSource.close();

      if (platformSection) {
        platformSection.manualDevices = platformSection.manualDevices.filter((entry: string | ConfigDevice) => {
          if (typeof entry === 'string') {
            return true;
          }
          if (!entry.host) {
            this.log.warn(`Removing manual device without host: ${JSON.stringify(entry)}`);
            return false;
          }
          return true;
        });
        if (this.needsManualDevicesNormalization(platformSection.manualDevices)) {
          platformSection.manualDevices = this.normalizeManualDevices(platformSection.manualDevices);
        }
        await this.writeConfigFile(configPath, fileConfig);
        this.platform.config = parseConfig(platformSection);
      }
    } catch (error) {
      this.handleAxiosError(error, 'discoverDevices');
    }
  }

  private persistDiscoveredDevice(device: KasaDevice, platformConfig: PlatformConfig): void {
    try {
      if (platformConfig.manualDevices) {
        const existing = platformConfig.manualDevices.find(
          (d: ConfigDevice) => (d as ConfigDevice).host === device.sys_info.host,
        ) as ConfigDevice | undefined;
        if (existing) {
          existing.host = device.sys_info.host;
          existing.alias = device.sys_info.alias;
        }
      }
    } catch (error) {
      this.log.error('Error persisting discovered device:', error);
    }
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

  async controlDevice(host: string, feature: string, value: ControlValue, childNum?: number): Promise<void> {
    const action = this.mapFeatureToAction(feature, value);
    await this.performDeviceAction(host, feature, action, value, childNum);
  }

  private mapFeatureToAction(feature: string, value: ControlValue): string {
    switch (feature) {
      case 'brightness':
      case 'color_temp':
      case 'fan_speed_level':
        return `set_${feature}`;
      case 'hsv':
        return 'set_hsv';
      case 'state':
        return value ? 'turn_on' : 'turn_off';
      default:
        throw new Error(`Unsupported feature: ${feature}`);
    }
  }

  private async performDeviceAction(
    host: string,
    feature: string,
    action: string,
    value: ControlValue,
    childNumber?: number,
  ): Promise<void> {
    const url = `${this.apiUrl}/controlDevice`;
    const payload = {
      host,
      feature,
      action,
      value,
      ...(childNumber !== undefined && { child_num: childNumber }),
    };
    try {
      const response = await axios.post(url, payload);
      if (response.data.status !== 'success') {
        this.log.error(`Action failed (${feature}/${action}) on ${host}: ${response.data.message}`);
      }
    } catch (error) {
      this.handleAxiosError(error, 'controlDevice');
    }
  }

  private updateDeviceAlias(sysInfo: SysInfo): void {
    if (!sysInfo.alias) {
      return;
    }
    const aliasPatterns: Record<string, string> = {
      'TP-LINK_Power Strip_': 'Power Strip',
      'TP-LINK_Smart Plug_': 'Smart Plug',
      'TP-LINK_Smart Bulb_': 'Smart Bulb',
    };
    for (const [pattern, replacement] of Object.entries(aliasPatterns)) {
      if (sysInfo.alias.includes(pattern)) {
        sysInfo.alias = `${replacement} ${sysInfo.alias.slice(-4)}`;
        break;
      }
    }
  }

  private needsManualDevicesNormalization(manualDevices: (string | ConfigDevice)[]): boolean {
    return manualDevices.length > 0 &&
      (typeof manualDevices[0] === 'string' ||
        manualDevices.some(entry => typeof entry !== 'string'));
  }

  private normalizeManualDevices(manualDevices: (string | ConfigDevice)[]): ConfigDevice[] {
    return manualDevices.map(entry => {
      if (typeof entry === 'string') {
        return { host: entry, alias: 'Will Be Filled By Plug-In Automatically' };
      } else if ('host' in entry && !('alias' in entry)) {
        (entry as ConfigDevice).alias = 'Will Be Filled By Plug-In Automatically';
      } else if ('breakoutChildDevices' in entry) {
        delete entry.breakoutChildDevices;
      }
      return entry;
    });
  }

  private async readConfigFile(configPath: string): Promise<PlatformConfig> {
    const data = await fs.readFile(configPath, 'utf8');
    return JSON.parse(data);
  }

  private async writeConfigFile(configPath: string, fileConfig: PlatformConfig): Promise<void> {
    try {
      await fs.writeFile(configPath, JSON.stringify(fileConfig, null, 2), 'utf8');
    } catch (error) {
      this.log.error(`Error writing config file: ${String(error)}`);
    }
  }

  private handleAxiosError(error: unknown, context: string): void {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const statusCode = error.response.status;
        const message = error.response.data?.error || error.response.statusText || 'Unknown error';
        this.log.error(`[${context}] HTTP ${statusCode}: ${message}`);
      } else if (error.code === 'ECONNREFUSED') {
        this.log.error(`[${context}] Connection refused (device API offline?)`);
      } else if (error.code === 'ETIMEDOUT') {
        this.log.error(`[${context}] Connection timed out (network issue)`);
      } else {
        this.log.error(`[${context}] Axios error: ${error.message}`);
      }
    } else if (error instanceof Error) {
      this.log.error(`[${context}] Error: ${error.message}`);
      if (error.stack) {
        this.log.debug(error.stack);
      }
    } else {
      this.log.error(`[${context}] Unknown error: ${JSON.stringify(error)}`);
    }
  }
}