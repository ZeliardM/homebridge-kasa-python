import { Categories } from 'homebridge'; // enum
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

import chalk from 'chalk';
import { promises as fs } from 'fs';
import path from 'path';
import { Range, satisfies } from 'semver';
import { fileURLToPath } from 'url';

import { parseConfig } from './config.js';
import type { KasaPythonConfig } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { lookup, lookupCharacteristicNameByUUID, isObjectLike } from './utils.js';
import type { KasaDevice } from './utils.js';
import create from './devices/create.js';
import HomekitDevice from './devices/index.js';
import DeviceManager from './devices/deviceManager.js';
import PythonChecker from './python/pythonChecker.js';

let packageConfig: { name: string; version: string; engines: { node: string | Range } };
try {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageConfigPath = path.join(__dirname, '..', 'package.json');
  const packageConfigData = await fs.readFile(packageConfigPath, 'utf8');
  packageConfig = JSON.parse(packageConfigData);
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('Error reading package.json: %s', error);
}

export type KasaPythonAccessoryContext = {
  deviceId?: string;
};

export default class KasaPythonPlatform implements DynamicPlatformPlugin {
  public readonly Service;

  public readonly Characteristic;

  public config: KasaPythonConfig;

  private readonly configuredAccessories: Map<
    string,
    PlatformAccessory<KasaPythonAccessoryContext>
  > = new Map();

  private readonly homekitDevicesById: Map<string, HomekitDevice> = new Map();

  public readonly storagePath: string;
  public readonly venvPythonExecutable: string;

  private deviceManager: DeviceManager;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.api = api;
    this.storagePath = this.api.user.storagePath();
    this.venvPythonExecutable = path.join(this.storagePath, 'kasa-python', '.venv', 'bin', 'python3');

    this.deviceManager = new DeviceManager(this);

    this.log.info(
      '%s v%s, node %s, homebridge v%s, api v%s Initializing...',
      packageConfig.name,
      packageConfig.version,
      process.version,
      this.api.serverVersion,
      this.api.version,
    );
    if (!satisfies(process.version, packageConfig.engines.node)) {
      this.log.error(
        'Error: not using minimum node version %s',
        packageConfig.engines.node,
      );
    } else {
      this.log.debug('Using minimum node version or better: %s', packageConfig.engines.node);
    }
    if (
      this.api.versionGreaterOrEqual === null ||
        !this.api.versionGreaterOrEqual('1.8.3')
    ) {
      this.log.error(
        `homebridge-kasa-python requires homebridge >= 1.8.3. Currently running: ${this.api.serverVersion}`,
      );
      throw new Error(
        `homebridge-kasa-python requires homebridge >= 1.8.3. Currently running: ${this.api.serverVersion}`,
      );
    } else {
      this.log.debug('Using minimum homebridge version or better: %s', this.api.serverVersion);
    }

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.log.debug('config.json: %j', config);
    this.config = parseConfig(config);
    this.log.debug('config: %j', this.config);

    this.log.info(
      '%s v%s, node %s, homebridge v%s, api v%s Finished Initializing.',
      packageConfig.name,
      packageConfig.version,
      process.version,
      this.api.serverVersion,
      this.api.version,
    );

    this.api.on('didFinishLaunching', async () => {
      this.log.info('Did Finish Launching Event Received');

      try {
        await this.checkPython().catch(error => {
          this.log.error('Error checking python environment: %s', error);
        });
        await this.deviceManager.discoverDevices().catch(error => {
          this.log.error('Error discovering devices: %s', error);
        });
      } catch (error) {
        this.log.error('An error occurred during startup: %s', error);
      }
    });
  }

  /**
   * Function invoked when checking python environment.
   */
  private async checkPython(): Promise<void> {
    this.log.info('Executing Python Checker...');
    await new PythonChecker(this, this.storagePath, this.config.pythonExecutable)
      .allInOne(this.config.forceVenvRecreate).catch((error) => {
        this.log.error('Error checking python environment: %s', error);
      });
    this.log.info('Python Checker finished, environment is ready.');
  }

  /**
   * Return string representation of Service/Characteristic for logging
   *
   * @internal
   */
  public lsc(
    serviceOrCharacteristic: Service | Characteristic | { UUID: string },
    characteristic?: Characteristic | { UUID: string },
  ): string {
    let serviceName: string | undefined;
    let characteristicName: string | undefined;

    if (serviceOrCharacteristic instanceof this.api.hap.Service) {
      serviceName = this.getServiceName(serviceOrCharacteristic);
    } else if (
      serviceOrCharacteristic instanceof this.api.hap.Characteristic ||
      ('UUID' in serviceOrCharacteristic &&
        typeof serviceOrCharacteristic.UUID === 'string')
    ) {
      characteristicName = this.getCharacteristicName(serviceOrCharacteristic);
    }

    if (characteristic instanceof this.api.hap.Characteristic) {
      characteristicName = this.getCharacteristicName(characteristic);
    }

    if (serviceName !== null && characteristicName !== null) {
      return `[${chalk.yellow(serviceName)}.${chalk.green(
        characteristicName,
      )}]`;
    }
    if (serviceName !== undefined) {
      return `[${chalk.yellow(serviceName)}]`;
    }
    return `[${chalk.green(characteristicName)}]`;
  }

  private createHomekitDevice(
    accessory: PlatformAccessory<KasaPythonAccessoryContext> | undefined,
    kasaDevice: KasaDevice,
  ): HomekitDevice | undefined{
    return create(this, this.config, accessory, kasaDevice);
  }

  getCategoryName(category: Categories): string | undefined {
    // @ts-expect-error: this should work
    return this.api.hap.Accessory.Categories[category];
  }

  getServiceName(service: { UUID: string }): string | undefined {
    return lookup(
      this.api.hap.Service,
      (thisKeyValue, value) =>
        isObjectLike(thisKeyValue) &&
        'UUID' in thisKeyValue &&
        thisKeyValue.UUID === value,
      service.UUID,
    );
  }

  getCharacteristicName(
    characteristic: WithUUID<{ name?: string; displayName?: string }>,
  ): string | undefined {
    if ('name' in characteristic && characteristic.name !== undefined) {
      return characteristic.name;
    }
    if (
      'displayName' in characteristic &&
      characteristic.displayName !== undefined
    ) {
      return characteristic.displayName;
    }

    if ('UUID' in characteristic) {
      return lookupCharacteristicNameByUUID(
        this.api.hap.Characteristic,
        characteristic.UUID,
      );
    }
    return undefined;
  }

  /**
   * Registers a Homebridge PlatformAccessory.
   *
   * Calls {@link external:homebridge.API#registerPlatformAccessories}
   */
  registerPlatformAccessory(
    platformAccessory: PlatformAccessory<KasaPythonAccessoryContext>,
  ): void {
    this.log.debug(
      `registerPlatformAccessory(${chalk.blue(
        `[${platformAccessory.displayName}]`,
      )})`,
    );
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      platformAccessory,
    ]);
  }

  /**
   * Function invoked when homebridge tries to restore cached accessory
   */
  configureAccessory(
    accessory: PlatformAccessory<KasaPythonAccessoryContext>,
  ): void {
    this.log.info(
      `Configuring cached accessory: ${chalk.blue(
        `[${accessory.displayName}]`,
      )} UUID: ${accessory.UUID} deviceId: %s `,
      accessory.context?.deviceId,
    );
    this.log.debug('%O', accessory.context);

    this.configuredAccessories.set(accessory.UUID, accessory);
  }

  /**
   * Adds a new device.
   */
  foundDevice(device: KasaDevice): void {
    const deviceId = device.sys_info.deviceId;
    const deviceAlias = device.alias;
    const deviceHost = device.host;
    const deviceType = device.sys_info.mic_type;

    if (deviceId === null || deviceId.length === 0) {
      this.log.error('Missing deviceId: %s', deviceHost);
      return;
    }

    if (this.homekitDevicesById.get(deviceId) !== undefined) {
      this.log.info(
        `Device already added: ${chalk.blue(`[${deviceAlias}]`)} %s [%s]`,
        deviceType,
        deviceId,
      );
      return;
    }

    this.log.info(
      `Adding: ${chalk.blue(`[${deviceAlias}]`)} %s [%s]`,
      deviceType,
      deviceId,
    );

    this.log.info('Generating UUID for device: %s', deviceId);
    const uuid = this.api.hap.uuid.generate(deviceId);
    const accessory = this.configuredAccessories.get(uuid);

    this.homekitDevicesById.set(
      deviceId,
      this.createHomekitDevice(accessory, device) as HomekitDevice,
    );
  }
}