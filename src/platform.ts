import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  WithUUID,
} from 'homebridge';
import { Logger } from 'homebridge/dist/logger.js';

import axios from 'axios';
import getPort from 'get-port';
import path from 'node:path';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { Range, satisfies } from 'semver';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, parse } from 'node:url';

import create from './devices/create.js';
import DeviceManager from './devices/deviceManager.js';
import HomekitDevice from './devices/index.js';
import PythonChecker from './python/pythonChecker.js';
import { parseConfig } from './config.js';
import { runCommand } from './utils.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { isObjectLike, lookup, lookupCharacteristicNameByUUID, prefixLogger } from './utils.js';
import type { KasaPythonConfig } from './config.js';
import type { KasaDevice } from './devices/kasaDevices.js';

export type KasaPythonAccessoryContext = {
  deviceId?: string;
};

let packageConfig: { name: string; version: string; engines: { node: string | Range } };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadPackageConfig(logger: Logging): Promise<void> {
  const packageConfigPath = path.join(__dirname, '..', 'package.json');
  const log: Logger = prefixLogger(logger, '[Package Config]');
  try {
    const packageConfigData = await fs.readFile(packageConfigPath, 'utf8');
    packageConfig = JSON.parse(packageConfigData);
  } catch (error) {
    log.error(`Error reading package.json: ${error}`);
    throw error;
  }
}

async function checkForUpgrade(storagePath: string, logger: Logging): Promise<boolean> {
  const versionDir = path.join(storagePath, 'kasa-python');
  const versionFilePath = path.join(versionDir, 'kasa-python-version.json');
  let storedVersion = '';

  try {
    await fs.access(versionFilePath);
    const versionData = await fs.readFile(versionFilePath, 'utf8');
    storedVersion = JSON.parse(versionData).version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info('Version file does not exist, treating as new install or version change.');
    } else {
      logger.error('Error reading version file:', error);
    }
  }

  if (storedVersion !== packageConfig.version) {
    try {
      await fs.mkdir(versionDir, { recursive: true });
      await fs.writeFile(versionFilePath, JSON.stringify({ version: packageConfig.version }), 'utf8');
      logger.info(`Version file updated to version ${packageConfig.version}`);
    } catch (error) {
      logger.error('Error writing version file:', error);
    }
    return true;
  }

  return false;
}

function startLoggingServer(log: Logging, callback: (port: number) => void) {
  getPort().then(port => {
    const server = createServer((req, res) => {
      const parsedUrl = parse(req.url!, true);
      const decoder = new StringDecoder('utf-8');
      let buffer = '';

      req.on('data', (chunk) => {
        buffer += decoder.write(chunk);
      });

      req.on('end', () => {
        buffer += decoder.end();
        if (parsedUrl.pathname === '/log' && req.method === 'POST') {
          try {
            const logEntry: LogEntry = JSON.parse(buffer);
            if (logEntry.level in log) {
              log[logEntry.level](logEntry.message);
            } else {
              log.error(`Invalid log level: ${logEntry.level}`);
            }
          } catch (error) {
            log.error('Failed to parse log entry:', error);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });

    server.listen(port, () => {
      log.debug(`Logging server started on port ${port}`);
      callback(port);
    });
  });
}

async function waitForServer(url: string, log: Logging, timeout: number = 30000, interval: number = 1000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const response = await axios.get(url);
      if (response.status === 200) {
        log.debug(`Server responded with status ${response.status}`);
        return;
      }
    } catch {
      // Ignore errors and continue checking
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Server did not respond within ${timeout / 1000} seconds`);
}

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export default class KasaPythonPlatform implements DynamicPlatformPlugin {
  public readonly Characteristic: typeof Characteristic;
  public readonly configuredAccessories: Map<string, PlatformAccessory<KasaPythonAccessoryContext>> = new Map();
  public readonly Service: typeof Service;
  public readonly storagePath: string;
  public readonly venvPythonExecutable: string;
  public config: KasaPythonConfig;
  public deviceManager: DeviceManager | undefined;
  public port: number = 0;
  private readonly homekitDevicesById: Map<string, HomekitDevice> = new Map();
  private kasaProcess: ChildProcessWithoutNullStreams | undefined | null = null;
  private platformInitialization: Promise<void>;
  private isUpgrade: boolean = false;

  constructor(public readonly log: Logging, config: PlatformConfig, public readonly api: API) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.storagePath = this.api.user.storagePath();
    this.venvPythonExecutable = path.join(this.storagePath, 'kasa-python', '.venv', 'bin', 'python3');
    this.config = parseConfig(config);
    this.platformInitialization = this.initializePlatform().catch((error) => {
      this.log.error('Platform initialization failed:', error);
    });

    this.api.on('didFinishLaunching', async () => {
      await this.platformInitialization;
      await this.didFinishLaunching();
    });

    this.api.on('shutdown', () => {
      this.stopKasaApi();
    });
  }

  private createHomekitDevice(kasaDevice: KasaDevice): HomekitDevice | undefined {
    return create(this, kasaDevice);
  }

  async initializePlatform(): Promise<void> {
    try {
      await loadPackageConfig(this.log);
      this.logInitializationDetails();
      await this.verifyEnvironment();
      this.isUpgrade = await checkForUpgrade(this.storagePath, this.log);
      if (this.isUpgrade) {
        this.log.info('Plugin version changed, virtual python environment will be recreated.');
      }
    } catch (error) {
      this.log.error('Error during platform initialization:', error);
    }
  }

  private logInitializationDetails(): void {
    this.log.info(
      `${packageConfig.name} v${packageConfig.version}, node ${process.version}, ` +
      `homebridge v${this.api.serverVersion}, api v${this.api.version} Initializing...`,
    );
  }

  private async verifyEnvironment(): Promise<void> {
    try {
      if (!satisfies(process.version, packageConfig.engines.node)) {
        this.log.error(`Error: not using minimum node version ${packageConfig.engines.node}`);
      }
      if (this.api.versionGreaterOrEqual && !this.api.versionGreaterOrEqual('1.8.4')) {
        throw new Error(`homebridge-kasa-python requires homebridge >= 1.8.4. Currently running: ${this.api.serverVersion}`);
      }
    } catch (error) {
      this.log.error('Error verifying environment:', error);
      throw error;
    }
  }

  private async didFinishLaunching(): Promise<void> {
    let discovered_devices: Record<string, KasaDevice> = {};
    try {
      await this.checkPython(this.isUpgrade);
      this.port = await getPort();
      this.deviceManager = new DeviceManager(this);
      await this.startKasaApi();
      await waitForServer(`http://127.0.0.1:${this.port}/health`, this.log);
      if (this.deviceManager) {
        discovered_devices = await this.deviceManager.discoverDevices();
      } else {
        this.log.error('Device manager is undefined.');
      }
      if (Object.keys(discovered_devices).length > 0) {
        Object.keys(discovered_devices).forEach(ip => {
          const device: KasaDevice = discovered_devices[ip];
          this.foundDevice(device);
        });
      } else {
        this.log.error('No devices found.');
      }

      this.unregisterUnusedAccessories();
    } catch (error) {
      this.log.error('An error occurred during startup:', error);
    }
  }

  private async checkPython(isUpgrade: boolean): Promise<void> {
    try {
      await new PythonChecker(this).allInOne(isUpgrade);
    } catch (error) {
      this.log.error('Error checking python environment:', error);
      throw error;
    }
  }

  private async startKasaApi(): Promise<void> {
    const scriptPath = path.join(__dirname, 'python', 'kasaApi.py');
    const loggerLevel = this.getLoggerLevel();

    startLoggingServer(this.log, async (loggingPort) => {
      const loggingServerUrl = `http://localhost:${loggingPort}/log`;

      try {
        const [, , , process] = await runCommand(
          this.log,
          this.venvPythonExecutable,
          [scriptPath, this.port.toString()],
          undefined,
          true,
          true,
          true,
          {
            LOGGER_LEVEL: loggerLevel,
            LOGGING_SERVER_URL: loggingServerUrl,
          },
        );

        this.kasaProcess = process;
      } catch (error) {
        if (error instanceof Error) {
          this.log.error(`Error starting kasaApi.py process: ${error.message}`);
        } else {
          this.log.error('An unknown error occurred during startup');
        }
        throw error;
      }
    });
  }

  private stopKasaApi(): void {
    if (this.kasaProcess) {
      this.kasaProcess.kill();
      this.kasaProcess = null;
    }
  }

  private getLoggerLevel(): string {
    const level = process.env.LOGGER_LEVEL || 'INFO';

    switch (level.toUpperCase()) {
      case 'DEBUG':
        return 'DEBUG';
      case 'INFO':
        return 'INFO';
      case 'WARN':
        return 'WARN';
      case 'ERROR':
        return 'ERROR';
      default:
        return 'INFO';
    }
  }

  private unregisterUnusedAccessories(): void {
    const homekitDeviceIds = new Set(this.homekitDevicesById.keys());

    this.configuredAccessories.forEach((accessory, uuid) => {
      const deviceId = accessory.context.deviceId;
      if (deviceId && !homekitDeviceIds.has(deviceId)) {
        this.log.info(`Unregistering unused accessory: [${accessory.displayName}] UUID: ${uuid}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.configuredAccessories.delete(uuid);
      }
    });
  }

  public lsc(
    serviceOrCharacteristic: Service | Characteristic | { UUID: string },
    characteristic?: Characteristic | { UUID: string },
  ): string {
    const serviceName = serviceOrCharacteristic instanceof this.api.hap.Service
      ? this.getServiceName(serviceOrCharacteristic)
      : undefined;
    const characteristicName = characteristic instanceof this.api.hap.Characteristic
      ? this.getCharacteristicName(characteristic)
      : serviceOrCharacteristic instanceof this.api.hap.Characteristic || 'UUID' in serviceOrCharacteristic
        ? this.getCharacteristicName(serviceOrCharacteristic)
        : undefined;

    return `[${serviceName ? serviceName : ''}` +
      `${serviceName && characteristicName ? '.' : ''}` +
      `${characteristicName ? characteristicName : ''}]`;
  }

  getServiceName(service: { UUID: string }): string | undefined {
    return lookup(this.api.hap.Service, (thisKeyValue, value) =>
      isObjectLike(thisKeyValue) && 'UUID' in thisKeyValue && thisKeyValue.UUID === value, service.UUID);
  }

  getCharacteristicName(characteristic: WithUUID<{ name?: string | null; displayName?: string | null }>): string | undefined {
    return characteristic.name ??
      characteristic.displayName ??
      lookupCharacteristicNameByUUID(this.api.hap.Characteristic, characteristic.UUID);
  }

  registerPlatformAccessory(platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
  }

  configureAccessory(accessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    this.log.info(
      `Configuring cached accessory: [${accessory.displayName}] UUID: ${accessory.UUID} deviceId: ${
        accessory.context.deviceId
      }`,
    );
    this.configuredAccessories.set(accessory.UUID, accessory);
  }

  private foundDevice(device: KasaDevice): void {
    const { sys_info: { alias: deviceAlias, device_id: deviceId, device_type: deviceType, host: deviceHost } } = device;
    if (!deviceId) {
      this.log.error('Missing deviceId:', deviceHost);
      return;
    }
    if (this.homekitDevicesById.has(deviceId)) {
      this.log.info(`Device already added: [${deviceAlias}] ${deviceType} [${deviceId}]`);
      return;
    }
    this.log.info(`Adding: [${deviceAlias}] ${deviceType} [${deviceId}]`);
    this.homekitDevicesById.set(deviceId, this.createHomekitDevice(device) as HomekitDevice);
  }
}