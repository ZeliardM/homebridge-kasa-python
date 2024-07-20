import * as fs from 'fs';
import * as util from 'util';
import type { Logger } from 'homebridge';

import KasaPythonPlatform from '../platform.js';
import { KasaDevice, runCommand } from '../utils.js';
import HomekitDevice from './index.js';

const readFileAsync = util.promisify(fs.readFile);

export default class DeviceManager {
  private log: Logger;
  private platform: KasaPythonPlatform;

  constructor(platform: KasaPythonPlatform) {
    this.log = platform.log;
    this.platform = platform;
  }

  private async executePythonScript(
    scriptName: string,
    deviceId?: string,
    deviceConfigJson?: string,
    childNumber?: string,
    outputToFile?: boolean): Promise<[string, string, number | null]> {
    const scriptPath = `${this.platform.storagePath}/node_modules/homebridge-kasa-python/dist/python/${scriptName}.py`;
    const args = [scriptPath];
    if (deviceConfigJson) {
      args.push(deviceConfigJson);
    }
    if (childNumber) {
      args.push(childNumber);
    }
    if (outputToFile) {
      const outputFileName = deviceId ? `${deviceId}_${scriptName}_output.json` : `${scriptName}_output.json`;
      args.push(`> ${this.platform.storagePath}/kasa-python/${outputFileName}`);
    }
    return await runCommand(this.log, this.platform.venvPythonExecutable, args);
  }

  async discoverDevices(): Promise<void> {
    this.log.info('Discovering devices...');
    try {
      const [stdout, stderr, exitCode] = await this.executePythonScript('discover', undefined, undefined, undefined, true);

      const outputPath = `${this.platform.storagePath}/kasa-python/discover_output.json`;

      if (exitCode !== 0) {
        this.log.error(`Error executing discovery script: ${stderr}. Output: ${stdout}`);
        return;
      }

      if (fs.existsSync(outputPath)) {
        try {
          const data = await readFileAsync(outputPath, 'utf8');
          const devices = JSON.parse(data);

          let index: number = 0;

          Object.keys(devices).forEach(ip => {
            const device: KasaDevice = devices[ip].device_info;
            device.device_config = devices[ip].device_config;
            this.platform.foundDevice(device);
            index += 1;
          });

          this.log.info('Discovered %d devices.', index);
        } catch (error) {
          this.log.error(`An error occurred during device discovery: ${error}`);
        }
      } else {
        this.log.error(`Discovery script did not output to ${outputPath}`);
      }
    } catch (error) {
      this.log.error(`An error occurred during device discovery: ${error}`);
    }
  }

  async getSysInfo(device: HomekitDevice): Promise<KasaDevice | undefined> {
    this.log.info('Getting system info for device: %s', device.name);
    try {
      const deviceConfigJson = `'${JSON.stringify(device.deviceConfig)}'`;
      const [stdout, stderr, exitCode] = await this.executePythonScript('getSysInfo', device.id, deviceConfigJson, undefined, true);

      const outputPath = `${this.platform.storagePath}/kasa-python/${device.id}_getSysInfo_output.json`;

      if (exitCode !== 0) {
        this.log.error(`Error executing getSysInfo script: ${stderr}. Output: ${stdout}`);
        return;
      }

      if (fs.existsSync(outputPath)) {
        try {
          const data = await readFileAsync(outputPath, 'utf8');
          const device_info = JSON.parse(data);

          const new_device: KasaDevice = device_info.device_info;

          return new_device;
        } catch (error) {
          this.log.error(`An error occurred during device getSysInfo: ${error}`);
        }
      } else {
        this.log.error(`GetSysInfo script did not output to ${outputPath}`);
      }
    } catch (error) {
      this.log.error(`An error occurred during device getSysInfo: ${error}`);
    }
  }

  async turnOn(device: HomekitDevice): Promise<void> {
    this.log.info('Turning on device: %s', device.name);
    try {
      const deviceConfigJson = JSON.stringify(device.deviceConfig);
      const [stdout, stderr, exitCode] = await this.executePythonScript('turnOn', undefined, deviceConfigJson);

      if (exitCode !== 0) {
        this.log.error(`Error executing turnOn script: ${stderr}`);
        return;
      }

      const state = JSON.parse(stdout);
      this.log.debug('Device %s turnOn is %s', device.name, state);
    } catch (error) {
      this.log.error('An error occurred turning on device %s: %s', device.name, error);
    }
  }

  async turnOff(device: HomekitDevice): Promise<void> {
    this.log.info('Turning off device: %s', device.name);
    try {
      const deviceConfigJson = JSON.stringify(device.deviceConfig);
      const [stdout, stderr, exitCode] = await this.executePythonScript('turnOff', undefined, deviceConfigJson);

      if (exitCode !== 0) {
        this.log.error(`Error executing turnOff script: ${stderr}`);
        return;
      }

      const state = JSON.parse(stdout);
      this.log.debug('Device %s turnOff is %s', device.name, state);
    } catch (error) {
      this.log.error('An error occurred turning off device %s: %s', device.name, error);
    }
  }

  async turnOnChild(device: HomekitDevice, child_num: number): Promise<void> {
    this.log.info('Turning on device %s: child %s', device.name, child_num);
    try {
      const childNumberJson = JSON.stringify(child_num);
      const deviceConfigJson = JSON.stringify(device.deviceConfig);
      const [stdout, stderr, exitCode] = await this.executePythonScript('turnOnChild', undefined, deviceConfigJson, childNumberJson);

      if (exitCode !== 0) {
        this.log.error(`Error executing turnOnChild script: ${stderr}`);
        return;
      }

      const state = JSON.parse(stdout);
      this.log.debug('Device %s Child %s turnOn is %s', device.name, child_num, state);
    } catch (error) {
      this.log.error('An error occurred turning on device %s child %s: %s', device.name, child_num, error);
    }
  }

  async turnOffChild(device: HomekitDevice, child_num: number): Promise<void> {
    this.log.info('Turning off device %s: child %s', device.name, child_num);
    try {
      const childNumberJson = JSON.stringify(child_num);
      const deviceConfigJson = JSON.stringify(device.deviceConfig);
      const [stdout, stderr, exitCode] = await this.executePythonScript('turnOffChild', undefined, deviceConfigJson, childNumberJson);

      if (exitCode !== 0) {
        this.log.error(`Error executing turnOffChild script: ${stderr}`);
        return;
      }

      const state = JSON.parse(stdout);
      this.log.debug('Device %s Child %s turnOff is %s', device.name, child_num, state);
    } catch (error) {
      this.log.error('An error occurred turning off device %s child %s: %s', device.name, child_num, error);
    }
  }
}