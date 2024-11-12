import type { Logger } from 'homebridge';
import axios from 'axios';
import HomekitDevice from './index.js';
import KasaPythonPlatform from '../platform.js';
import type { KasaDevice } from './kasaDevices.js';

export default class DeviceManager {
  private log: Logger;
  private apiUrl: string;
  private username: string;
  private password: string;
  private additionalBroadcasts: string[];
  private manualDevices: { host: string }[];

  constructor(private platform: KasaPythonPlatform) {
    this.log = platform.log;
    this.username = platform.config.username;
    this.password = platform.config.password;
    this.apiUrl = `http://127.0.0.1:${platform.port}`;
    this.additionalBroadcasts = platform.config.discoveryOptions.additionalBroadcasts;
    this.manualDevices = platform.config.discoveryOptions.manualDevices;
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
        this.platform.foundDevice(device);
      });
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
    this.log.debug(`Getting system info for device: ${device.name}`);
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
}