import type { Logger } from 'homebridge';
import axios from 'axios';
import HomekitDevice from './index.js';
import KasaPythonPlatform from '../platform.js';
import type { KasaDevice } from './kasaDevices.js';

export default class DeviceManager {
  private log: Logger;
  private apiUrl: string;

  constructor(private platform: KasaPythonPlatform) {
    this.log = platform.log;
    this.apiUrl = `http://127.0.0.1:${platform.port}`;
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
    }
  }

  async discoverDevices(): Promise<void> {
    this.log.debug('Discovering devices...');
    try {
      const response = await axios.get(`${this.apiUrl}/discover`);
      const devices = response.data;
      Object.keys(devices).forEach(ip => {
        const device: KasaDevice = devices[ip].device_info;
        if (device.alias.includes('TP-LINK_Power Strip_')) {
          device.alias = `Power Strip ${device.alias.slice(-4)}`;
        }
        device.device_config = devices[ip].device_config;
        this.platform.foundDevice(device);
      });
      this.log.debug(`Discovered ${Object.keys(devices).length} devices.`);
    } catch (error) {
      this.log.error(
        `An error occurred during device discovery: ${axios.isAxiosError(error) ? error.message : 'An unknown error occurred'}`,
      );
    }
  }

  async getSysInfo(device: HomekitDevice): Promise<KasaDevice | undefined> {
    this.log.debug(`Getting system info for device: ${device.name}`);
    try {
      this.log.debug(`Requesting system info with config: ${JSON.stringify(device.deviceConfig)}`);
      const response = await axios.post(`${this.apiUrl}/getSysInfo`, { device_config: device.deviceConfig });
      const kasaDevice: KasaDevice = response.data.device_info;
      if (kasaDevice.alias.includes('TP-LINK_Power Strip_')) {
        kasaDevice.alias = `Power Strip ${kasaDevice.alias.slice(-4)}`;
      }
      return kasaDevice;
    } catch (error) {
      this.log.error(
        `An error occurred during device getSysInfo: ${axios.isAxiosError(error) ? error.message : 'An unknown error occurred'}`,
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
      this.log.debug(`Turned ${state ? 'on' : 'off'} device: ${device.name}${childText}`);
    } catch (error) {
      this.log.error(
        `An error occurred turning ${state ? 'on' : 'off'} device ${device.name}${childText}: ${
          axios.isAxiosError(error) ? error.message : 'An unknown error occurred'
        }`,
      );
    }
  }
}