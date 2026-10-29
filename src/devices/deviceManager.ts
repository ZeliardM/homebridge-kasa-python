import type { CharacteristicValue, Logger } from 'homebridge';

import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { EventSource } from 'eventsource';
import type { ErrorEvent } from 'eventsource';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';

import KasaPythonPlatform from '../platform.js';
import type { FeatureInfo, HSV, KasaDevice, SysInfo } from './deviceTypes.js';

// HomeKit answers a write within 9 s, then gives up on it. A command carries the time left (keeping
// ~40 ms for the reply), so the Python service fits its retries into it and stops when it runs
// out, and a command HomeKit has given up on is not sent.
const HOMEKIT_WRITE_BUDGET_MS = 8960;
const homeKitWriteDeadline = new AsyncLocalStorage<number>();

const DISCOVERY_STREAM_MAX_MS = 30000;
// The service only starts the run before it answers.
const DISCOVER_REQUEST_TIMEOUT_MS = 10000;

// Every request to the Python service carries the token it was started with (see kasaApi.py).
export const API_TOKEN_HEADER = 'X-Kasa-Api-Token';

export function runHomeKitWrite<T>(write: () => Promise<T>): Promise<T> {
  return homeKitWriteDeadline.run(performance.now() + HOMEKIT_WRITE_BUDGET_MS, write);
}

export const deviceEventEmitter = new EventEmitter();

// The Python service failed a request (it did not answer, or answered with an HTTP error), which says nothing about
// the device the request was for.
export class KasaApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KasaApiError';
  }
}

type ControlValue = CharacteristicValue | HSV;

export default class DeviceManager {
  private log!: Logger;
  private api!: AxiosInstance;
  private apiToken!: string;
  private enableCredentials!: boolean;
  private username!: string;
  private password!: string;
  private disableBroadcast!: boolean;
  private additionalBroadcasts!: string[];
  private manualDeviceHosts!: string[];
  private excludeMacs!: string[];
  private includeMacs!: string[];
  private pollsFailingInService = false;

  constructor(private platform: KasaPythonPlatform) {
    this.refreshConfigSnapshot();
  }

  // The service gets a new port each time it is started again
  private get apiUrl(): string {
    return `http://127.0.0.1:${this.platform.port}`;
  }

  private refreshConfigSnapshot(): void {
    this.log = this.platform.log;
    this.enableCredentials = this.platform.config.enableCredentials;
    this.username = this.platform.config.username;
    this.password = this.platform.config.password;
    this.apiToken = this.platform.apiToken;
    this.api = axios.create({ headers: { [API_TOKEN_HEADER]: this.apiToken } });
    this.disableBroadcast = this.platform.config.discoveryOptions.disableBroadcast;
    this.additionalBroadcasts = this.platform.config.discoveryOptions.additionalBroadcasts;
    this.manualDeviceHosts = this.platform.config.discoveryOptions.manualDevices.map(d => d.host);
    this.excludeMacs = this.platform.config.discoveryOptions.excludeMacAddresses;
    this.includeMacs = this.platform.config.discoveryOptions.includeMacAddresses;
  }

  // Resolves once the service reports that it has handled every device this run found. Rejects when the request or
  // the stream fails, or when the run is not done within DISCOVERY_STREAM_MAX_MS: the devices reported until then are
  // still added and updated, but such a run cannot tell which devices are gone.
  async discoverDevices(): Promise<void> {
    this.log.debug('Starting device discovery...');
    // python-kasa logs in with these to every device that answers discovery, so they are sent only
    // when the user turned Enable Credentials on, not merely because they are still in the config.
    const authConfig = this.enableCredentials && this.username && this.password
      ? { auth: { username: this.username, password: this.password } }
      : {};
    try {
      await this.api.post<Record<string, { sys_info: SysInfo; feature_info: FeatureInfo }>>(
        `${this.apiUrl}/discover`,
        {
          disableBroadcast: this.disableBroadcast,
          additionalBroadcasts: this.additionalBroadcasts,
          manualDevices: this.manualDeviceHosts,
          excludeMacAddresses: this.excludeMacs,
          includeMacAddresses: this.includeMacs,
        },
        { ...authConfig, timeout: DISCOVER_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      throw this.requestFailed('Discovery request failed', error);
    }

    // The service sends discovery_complete once it has handled every device this run found, so
    // a device that takes longer (a HomeKit check that times out) is still reported in this run.
    // A run held up longer than that ends here; its late results come with the next run.
    await new Promise<void>((resolve, reject) => {
      const eventSource = new EventSource(`${this.apiUrl}/stream`, {
        fetch: (input, init) => fetch(input, { ...init, headers: { ...init.headers, [API_TOKEN_HEADER]: this.apiToken } }),
      });
      const finish = (error?: Error) => {
        clearTimeout(timer);
        eventSource.close();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(
        () => finish(new Error(`Discovery did not finish within ${DISCOVERY_STREAM_MAX_MS / 1000} s`)),
        DISCOVERY_STREAM_MAX_MS,
      );
      eventSource.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.log.debug('SSE event data:', data);
          if (data.status === 'discovery_complete') {
            this.log.debug('Device discovery complete.');
            finish();
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
      eventSource.onerror = (error: ErrorEvent) => {
        finish(new Error(`Discovery stream failed: ${error.message ?? error.code ?? 'unknown error'}`));
      };
    });
  }

  // Undefined when the device did not answer or answered with an error. Throws a KasaApiError when the service itself
  // failed the request; that is logged once here, not against each device.
  async getSysInfo(host: string): Promise<SysInfo | undefined> {
    let response;
    try {
      response = await this.api.post(`${this.apiUrl}/getSysInfo`, { host });
    } catch (error) {
      this.handleAxiosError(error, 'getSysInfo', 'debug');
      const failure = this.requestFailed(`Poll of ${host} failed in the Kasa API`, error);
      // A service that exited is logged by the platform
      if (!this.pollsFailingInService && this.platform.isKasaApiAvailable) {
        this.pollsFailingInService = true;
        this.log.warn(`${failure.message}. Polls the Kasa API cannot answer do not count against the devices.`);
      }
      throw failure;
    }
    if (this.pollsFailingInService) {
      this.pollsFailingInService = false;
      this.log.info('The Kasa API answers polls again.');
    }
    const sysInfo: SysInfo | undefined = response.data?.sys_info;
    if (!sysInfo) {
      this.log.debug(`[getSysInfo] No sys_info payload returned for host ${host}`);
      return undefined;
    }
    this.updateDeviceAlias(sysInfo);
    return sysInfo;
  }

  async controlDevice(
    host: string,
    feature: string,
    value: ControlValue,
    childNum?: number,
    options: { lightOn?: boolean } = {},
  ): Promise<void> {
    const action = this.mapFeatureToAction(feature, value);
    await this.performDeviceAction(host, feature, action, value, childNum, options.lightOn);
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
    lightOn?: boolean,
  ): Promise<void> {
    const deadline = homeKitWriteDeadline.getStore();
    const remainingMs = deadline === undefined ? undefined : deadline - performance.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      // HomeKit has already given up on this write; sending it now would switch the device late.
      throw new Error(`HomeKit write expired before it could be sent (${feature}/${action}) to ${host}`);
    }
    const payload = {
      host,
      feature,
      action,
      value,
      ...(childNumber !== undefined && { child_num: childNumber }),
      ...(lightOn !== undefined && { light_on: lightOn }),
      ...(remainingMs !== undefined && { deadline_ms: remainingMs }),
    };
    let response;
    try {
      response = await this.api.post(`${this.apiUrl}/controlDevice`, payload);
    } catch (error) {
      throw this.requestFailed(`Control request failed (${feature}/${action}) on ${host}`, error);
    }
    if (response.data?.status !== 'success') {
      const reason = response.data?.message ?? response.data?.error ?? 'unknown error';
      this.log.error(`Action failed (${feature}/${action}) on ${host}: ${reason}`);
      throw new Error(`Action failed (${feature}/${action}) on ${host}: ${reason}`);
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

  // An error for a failed request to the service, with a one-line reason. Its cause is only the error code: the axios
  // error holds the request, the token and the TP-Link account included, and a logged error prints its cause in full.
  private requestFailed(message: string, error: unknown): KasaApiError {
    return new KasaApiError(`${message}: ${this.describeError(error)}`, {
      cause: axios.isAxiosError(error) ? (error.code ?? 'AxiosError') : error,
    });
  }

  private describeError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const message = error.response.data?.error || error.response.statusText || 'Unknown error';
        return `HTTP ${error.response.status}: ${message}`;
      } else if (error.code === 'ECONNREFUSED') {
        return 'Connection refused (device API offline?)';
      } else if (error.code === 'ETIMEDOUT') {
        return 'Connection timed out (network issue)';
      }
      return `Axios error: ${error.message}`;
    } else if (error instanceof Error) {
      return `Error: ${error.message}`;
    }
    return `Unknown error: ${JSON.stringify(error)}`;
  }

  private handleAxiosError(error: unknown, context: string, level: 'debug' | 'error' = 'error'): void {
    const writeLog = level === 'debug'
      ? this.log.debug.bind(this.log)
      : this.log.error.bind(this.log);
    writeLog(`[${context}] ${this.describeError(error)}`);
    if (!axios.isAxiosError(error) && error instanceof Error && error.stack) {
      this.log.debug(error.stack);
    }
  }
}
