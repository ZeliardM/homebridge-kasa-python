import type { CharacteristicValue, Logger } from 'homebridge';

import axios from 'axios';
import { EventSource } from 'eventsource';
import { EventEmitter } from 'node:events';

import KasaPythonPlatform from '../platform.js';
import type { FeatureInfo, HSV, KasaDevice, SysInfo } from './deviceTypes.js';

export const deviceEventEmitter = new EventEmitter();

type ControlValue = CharacteristicValue | HSV;

export default class DeviceManager {
  private log!: Logger;
  private apiUrl!: string;
  private username!: string;
  private password!: string;
  private additionalBroadcasts!: string[];
  private manualDeviceHosts!: string[];
  private excludeMacs!: string[];
  private includeMacs!: string[];

  constructor(private platform: KasaPythonPlatform) {
    this.refreshConfigSnapshot();
  }

  private refreshConfigSnapshot(): void {
    this.log = this.platform.log;
    this.username = this.platform.config.username;
    this.password = this.platform.config.password;
    this.apiUrl = `http://127.0.0.1:${this.platform.port}`;
    this.additionalBroadcasts = this.platform.config.discoveryOptions.additionalBroadcasts;
    this.manualDeviceHosts = this.platform.config.discoveryOptions.manualDevices.map(d => d.host);
    this.excludeMacs = this.platform.config.discoveryOptions.excludeMacAddresses;
    this.includeMacs = this.platform.config.discoveryOptions.includeMacAddresses;
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
    } catch (error) {
      this.handleAxiosError(error, 'discoverDevices');
    }
  }

  async getSysInfo(host: string): Promise<SysInfo | undefined> {
    try {
      const response = await axios.post(`${this.apiUrl}/getSysInfo`, { host });
      const sysInfo: SysInfo | undefined = response.data?.sys_info;
      if (!sysInfo) {
        this.log.debug(`[getSysInfo] No sys_info payload returned for host ${host}`);
        return undefined;
      }
      this.updateDeviceAlias(sysInfo);
      return sysInfo;
    } catch (error) {
      this.handleAxiosError(error, 'getSysInfo');
      return undefined;
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