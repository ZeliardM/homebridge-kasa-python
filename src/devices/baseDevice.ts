import { PlatformAccessoryEvent } from 'homebridge';
import type {
  Categories,
  Characteristic,
  CharacteristicValue,
  HapStatusError,
  Logger,
  Nullable,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';

import { EventEmitter } from 'node:events';

import accessoryInformation from './accessoryInformation.js';
import DeviceManager from './deviceManager.js';
import { deferAndCombine, prefixLogger } from '../utils.js';
import type KasaPythonPlatform from '../platform.js';
import type {
  CharacteristicDescriptor,
  ChildDevice,
  DescriptorContext,
  KasaDevice,
  SysInfo,
} from './deviceTypes.js';
import type { KasaPythonAccessoryContext } from '../platform.js';

export default abstract class HomeKitDevice {
  readonly log: Logger;
  protected deviceManager: DeviceManager | undefined;
  public homebridgeAccessory: PlatformAccessory<KasaPythonAccessoryContext>;
  public isUpdating = false;
  protected previousSnapshot?: KasaDevice;
  protected pollingInterval?: NodeJS.Timeout;
  protected updateEmitter = new EventEmitter();

  private static locks: Map<string, Promise<unknown>> = new Map();
  private pendingChanges: Map<string, { pendingValue: CharacteristicValue; count: number }> = new Map();

  protected getSysInfoDeferred: () => Promise<void>;

  private primaryDescriptors: CharacteristicDescriptor[] = [];
  private primaryService?: Service;

  constructor(
    readonly platform: KasaPythonPlatform,
    public kasaDevice: KasaDevice,
    readonly category: Categories,
    readonly categoryName: string,
  ) {
    this.deviceManager = platform.deviceManager;
    this.log = prefixLogger(platform.log, `[${this.name}]`);
    this.homebridgeAccessory = this.initializeAccessory();
    this.homebridgeAccessory.on(PlatformAccessoryEvent.IDENTIFY, () => this.identify());
    platform.periodicDeviceDiscoveryEmitter.on('periodicDeviceDiscoveryComplete', () => {
      this.updateEmitter.emit('periodicDeviceDiscoveryComplete');
    });

    this.getSysInfoDeferred = deferAndCombine(
      this.fetchSysInfoInternal.bind(this),
      platform.config.advancedOptions.waitTimeUpdate,
    );

    try {
      this.previousSnapshot = JSON.parse(JSON.stringify(this.kasaDevice));
    } catch {
      this.previousSnapshot = { ...this.kasaDevice };
    }
  }

  private initializeAccessory(): PlatformAccessory<KasaPythonAccessoryContext> {
    const uuid = this.platform.api.hap.uuid.generate(this.id);
    const existingAccessory = this.platform.configuredAccessories.get(uuid);
    let accessory: PlatformAccessory<KasaPythonAccessoryContext>;
    if (!existingAccessory) {
      this.log.debug(`Creating new Platform Accessory [${this.id}] [${uuid}] category: ${this.categoryName}`);
      accessory = new this.platform.api.platformAccessory(this.name, uuid, this.category);
      accessory.context.deviceId = this.id;
      accessory.context.lastSeen = this.kasaDevice.last_seen;
      accessory.context.offline = this.kasaDevice.offline;
      this.platform.registerPlatformAccessory(accessory);
    } else {
      accessory = existingAccessory;
      this.updateAccessory(accessory);
    }
    const info = accessoryInformation(this.platform.api.hap)(accessory, this);
    if (!info) {
      this.log.error('Could not retrieve default AccessoryInformation');
    }
    return accessory;
  }

  private updateAccessory(accessory: PlatformAccessory<KasaPythonAccessoryContext>): void {
    const currentDisplayName = accessory.displayName;
    const deviceName = this.name;
    let displayNameChanged = false;

    if (!currentDisplayName && deviceName) {
      accessory.displayName = deviceName;
      displayNameChanged = true;
    }

    accessory.context.deviceId = this.id;
    accessory.context.lastSeen = this.kasaDevice.last_seen;
    accessory.context.offline = this.kasaDevice.offline;
    this.platform.configuredAccessories.set(accessory.UUID, accessory);

    if (displayNameChanged) {
      this.platform.api.updatePlatformAccessories([accessory]);
    }
  }

  get id(): string {
    return this.kasaDevice.sys_info.device_id;
  }

  get name(): string {
    return this.kasaDevice.sys_info.alias;
  }

  get manufacturer(): string {
    return 'TP-Link';
  }

  get model(): string {
    return `${this.kasaDevice.sys_info.model} ${this.kasaDevice.sys_info.hw_ver}`;
  }

  get serialNumber(): string {
    return this.kasaDevice.sys_info.mac;
  }

  get firmwareRevision(): string {
    return this.kasaDevice.sys_info.sw_ver;
  }

  protected extractChildIndex(child: { id?: string | number }): number {
    const idString = String(child?.id ?? '');
    const match = idString.match(/(\d{1,2})$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  protected makeLockKey(childId?: string | number): string {
    return childId !== undefined && childId !== null
      ? `${this.kasaDevice.sys_info.device_id}:${childId}`
      : `${this.kasaDevice.sys_info.device_id}`;
  }

  protected async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previousPromise = HomeKitDevice.locks.get(key) ?? Promise.resolve();
    const currentPromise = previousPromise.then(async () => {
      try {
        return await action();
      } finally {
        if (HomeKitDevice.locks.get(key) === currentPromise) {
          HomeKitDevice.locks.delete(key);
        }
      }
    });
    HomeKitDevice.locks.set(key, currentPromise);
    return currentPromise as Promise<T>;
  }

  protected shouldSkipUpdate(): boolean {
    return this.kasaDevice.offline || this.platform.isShuttingDown;
  }

  protected async waitForUpdateOrDiscovery(): Promise<void> {
    let discoveryFinished = false;
    await Promise.race([
      new Promise<void>(resolve => this.updateEmitter.once('updateComplete', resolve)),
      new Promise<void>(resolve => {
        this.updateEmitter.once('periodicDeviceDiscoveryComplete', () => {
          discoveryFinished = true;
          resolve();
        });
      }),
    ]);
    if (discoveryFinished && this.pollingInterval) {
      await new Promise(r => setTimeout(r, this.platform.config.discoveryOptions.pollingInterval));
    }
  }

  protected async getSysInfo(): Promise<void> {
    await this.getSysInfoDeferred();
  }

  private async fetchSysInfoInternal(): Promise<void> {
    if (!this.deviceManager) {
      this.log.warn('Device manager not available');
      return;
    }
    const host = this.kasaDevice.sys_info?.host;
    if (!host) {
      this.log.warn('No host in sys_info');
      return;
    }
    const updatedSysInfo = await this.deviceManager.getSysInfo(host);
    if (!updatedSysInfo) {
      throw new Error(`No sys_info returned for ${host}. Marking offline and stopping polling.`);
    }
    this.kasaDevice.sys_info = updatedSysInfo;
    this.log.debug(`Updated sys_info: ${updatedSysInfo.alias ?? host}`);
  }

  protected async refreshAndUpdateCharacteristics(forceUpdate: boolean, skipFetch = false): Promise<void> {
    const deviceKey = this.kasaDevice.sys_info.device_id;
    if (!forceUpdate && HomeKitDevice.locks.has(deviceKey)) {
      this.log.debug('Skipping poll; active update lock');
      return;
    }
    await this.withLock(deviceKey, async () => {
      if (this.shouldSkipUpdate()) {
        await this.stopPolling();
        return;
      }
      if (this.isUpdating || this.platform.periodicDeviceDiscovering) {
        await this.waitForUpdateOrDiscovery();
      }
      this.isUpdating = true;
      try {
        if (!skipFetch) {
          await this.getSysInfo();
        }
        await this.updateAllServicesAndCharacteristics(forceUpdate);
        this.previousSnapshot = JSON.parse(JSON.stringify(this.kasaDevice));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('No sys_info returned for ')) {
          this.log.warn(`Poll update failed: ${error.message}`);
        } else {
          this.log.error('Error during poll update:', error);
        }
        this.kasaDevice.offline = true;
        await this.stopPolling();
      } finally {
        this.isUpdating = false;
        this.updateEmitter.emit('updateComplete');
      }
    });
  }

  public async startPolling(): Promise<void> {
    if (this.shouldSkipUpdate()) {
      await this.stopPolling();
      return;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.pollingInterval = setInterval(
      () => void this.refreshAndUpdateCharacteristics(false),
      this.platform.config.discoveryOptions.pollingInterval,
    );
  }

  public async stopPolling(waitForCurrentUpdate = false): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
    if (waitForCurrentUpdate && this.isUpdating) {
      await new Promise<void>(resolve => {
        this.updateEmitter.once('updateComplete', resolve);
      });
    }
  }

  public updateAfterPeriodicDiscovery(force = false): void {
    void this.refreshAndUpdateCharacteristics(force, true);
  }

  protected setupPrimaryService(): void {
    const serviceType = this.getPrimaryServiceType();
    if (!serviceType) {
      return;
    }
    this.primaryService = this.homebridgeAccessory.getService(serviceType)
      ?? this.addService(serviceType, this.name);
    this.primaryDescriptors = this.buildPrimaryDescriptors();
    for (const descriptor of this.primaryDescriptors) {
      this.registerCharacteristic(
        this.primaryService,
        descriptor.type,
        () => this.genericOnGet(descriptor),
        descriptor.writable ? (value: CharacteristicValue) => this.genericOnSet(descriptor, value) : undefined,
      );
      this.seedCharacteristicValue(this.primaryService, descriptor, this.buildDescriptorContext(), 'Seed error');
    }
  }

  protected getPrimaryServiceType(): WithUUID<typeof this.platform.Service> | null {
    return null;
  }

  protected buildPrimaryDescriptors(): CharacteristicDescriptor[] {
    return [];
  }

  protected registerCharacteristic(
    service: Service,
    type: WithUUID<new () => Characteristic>,
    onGet: () => Promise<CharacteristicValue>,
    onSet?: (value: CharacteristicValue) => Promise<void>,
  ): void {
    const characteristic = service.getCharacteristic(type) ?? service.addCharacteristic(type);
    characteristic.onGet(onGet);
    if (onSet) {
      characteristic.onSet(onSet);
    }
  }

  protected buildDescriptorContext(child?: ChildDevice): DescriptorContext {
    return {
      platform: this.platform,
      device: this.kasaDevice.sys_info,
      child,
      alias: child ? child.alias : this.name,
    };
  }

  protected seedCharacteristicValue(
    service: Service,
    descriptor: CharacteristicDescriptor,
    context: DescriptorContext,
    errorPrefix: string,
  ): void {
    try {
      const characteristic = service.getCharacteristic(descriptor.type);
      characteristic.updateValue(descriptor.getInitial(context));
    } catch (error) {
      this.log.error(`${errorPrefix} for ${descriptor.name ?? descriptor.type.UUID}`, error);
    }
  }

  protected updateDeviceField<K extends keyof SysInfo>(key: K, value: SysInfo[K]): void {
    (this.kasaDevice.sys_info as SysInfo)[key] = value;
  }

  private async genericOnGet(descriptor: CharacteristicDescriptor): Promise<CharacteristicValue> {
    const context = this.buildDescriptorContext();
    try {
      const characteristic = this.primaryService!.getCharacteristic(descriptor.type);
      let value = characteristic.value;
      if (value === undefined || value === null) {
        value = descriptor.getInitial(context);
        characteristic.updateValue(value);
      }
      return value;
    } catch (error) {
      this.log.error(`OnGet error for ${descriptor.name ?? descriptor.type.UUID}`, error);
      this.kasaDevice.offline = true;
      await this.stopPolling();
      return this.defaultValueForCharacteristic(descriptor.type);
    }
  }

  private async genericOnSet(descriptor: CharacteristicDescriptor, value: CharacteristicValue): Promise<void> {
    if (!descriptor.applySet) {
      return;
    }
    await this.executeDescriptorSet(descriptor, value);
  }

  private async executeDescriptorSet(
    descriptor: CharacteristicDescriptor,
    value: CharacteristicValue,
    isGrouped = false,
  ): Promise<void> {
    const runSet = async () => {
      if (this.shouldSkipUpdate()) {
        return;
      }
      if (!this.deviceManager) {
        throw new Error('Device manager undefined');
      }
      try {
        this.isUpdating = true;
        const context = this.buildDescriptorContext();
        await descriptor.applySet!(value, context);

        const descriptorsToUpdate = descriptor.syncGroup
          ? this.primaryDescriptors.filter(desc => desc.syncGroup === descriptor.syncGroup)
          : [descriptor];

        if (this.primaryService) {
          for (const desc of descriptorsToUpdate) {
            const postSetValue = desc.getCurrent(context);
            const char = this.primaryService.getCharacteristic(desc.type);
            if (desc.syncHomeKitValueAfterSet) {
              this.updateValue(
                this.primaryService,
                char,
                context.alias,
                postSetValue as CharacteristicValue,
              );
            } else {
              this.log.info(`Set ${this.platform.lsc(this.primaryService, char)} on ${context.alias} to ${postSetValue}`);
            }
          }
        }
        this.previousSnapshot = JSON.parse(JSON.stringify(this.kasaDevice));
      } catch (error) {
        this.log.error(`OnSet error for ${descriptor.name ?? descriptor.type.UUID}`, error);
        this.kasaDevice.offline = true;
        await this.stopPolling();
      } finally {
        if (!isGrouped) {
          this.isUpdating = false;
          this.updateEmitter.emit('updateComplete');
        }
      }
    };

    if (this.shouldBypassSetLock(descriptor)) {
      await runSet();
      return;
    }

    const lockKey = this.makeLockKey();
    await this.withLock(lockKey, runSet);
  }

  private shouldBypassSetLock(descriptor: CharacteristicDescriptor): boolean {
    if (!descriptor.syncGroup) {
      return false;
    }

    const writableDescriptorsInGroup = this.primaryDescriptors.filter(desc =>
      desc.syncGroup === descriptor.syncGroup && desc.writable,
    );

    return writableDescriptorsInGroup.length > 1;
  }

  protected async updateAllServicesAndCharacteristics(forceUpdate: boolean): Promise<void> {
    if (!this.primaryService) {
      return;
    }
    for (const descriptor of this.primaryDescriptors) {
      const context = this.buildDescriptorContext();
      try {
        const previousSysInfo = this.previousSnapshot?.sys_info;
        const previousContext: DescriptorContext = {
          platform: this.platform,
          device: (previousSysInfo as SysInfo) || {} as SysInfo,
          alias: this.name,
        };

        if (descriptor.debouncePolls && descriptor.debouncePolls > 1) {
          const characteristic = this.primaryService.getCharacteristic(descriptor.type);
          const hkValue: CharacteristicValue = characteristic.value !== null && characteristic.value !== undefined
            ? characteristic.value as CharacteristicValue
            : descriptor.getInitial(context) as CharacteristicValue;
          const nextDeviceValue = descriptor.getCurrent(context) as CharacteristicValue;
          const debounceKey = `primary:${descriptor.type.UUID}`;
          const effectiveNext = this.resolveWithDebounce(debounceKey, hkValue, nextDeviceValue, descriptor.debouncePolls, forceUpdate);
          this.updateIfChanged(
            this.primaryService,
            characteristic,
            context.alias,
            hkValue,
            effectiveNext,
            descriptor.name,
            forceUpdate,
          );
        } else {
          const previousValue = previousSysInfo ? descriptor.getCurrent(previousContext) : descriptor.getInitial(context);
          const nextValue = descriptor.getCurrent(context);
          this.updateIfChanged(
            this.primaryService,
            this.primaryService.getCharacteristic(descriptor.type),
            context.alias,
            previousValue as CharacteristicValue,
            nextValue as CharacteristicValue,
            descriptor.name,
            forceUpdate,
          );
        }
      } catch (error) {
        this.log.error(`Update diff error for ${descriptor.name ?? descriptor.type.UUID}`, error);
      }
    }
  }

  protected defaultValueForCharacteristic(type: WithUUID<new () => Characteristic>): CharacteristicValue {
    const C = this.platform.Characteristic;
    const zeroish = new Set([
      C.Brightness.UUID, C.ColorTemperature.UUID, C.Hue.UUID,
      C.Saturation.UUID, C.RotationSpeed.UUID,
    ]);
    if (zeroish.has(type.UUID)) {
      return 0;
    }
    if (type.UUID === C.Active.UUID) {
      return C.Active.INACTIVE;
    }
    return false;
  }

  protected resolveWithDebounce(
    key: string,
    currentHomeKitValue: CharacteristicValue,
    nextDeviceValue: CharacteristicValue,
    debouncePolls: number,
    force = false,
  ): CharacteristicValue {
    if (force) {
      this.pendingChanges.delete(key);
      return nextDeviceValue;
    }
    if (currentHomeKitValue === nextDeviceValue) {
      this.pendingChanges.delete(key);
      return nextDeviceValue;
    }
    const pending = this.pendingChanges.get(key);
    if (pending && pending.pendingValue === nextDeviceValue) {
      pending.count++;
      if (pending.count >= debouncePolls) {
        this.pendingChanges.delete(key);
        return nextDeviceValue;
      }
      return currentHomeKitValue;
    }
    this.pendingChanges.set(key, { pendingValue: nextDeviceValue, count: 1 });
    return currentHomeKitValue;
  }

  protected updateIfChanged<T extends CharacteristicValue>(
    service: Service,
    characteristic: Characteristic,
    alias: string,
    previousValue: T,
    nextValue: T,
    label?: string,
    force = false,
  ): void {
    const currentValue = characteristic.value as Nullable<CharacteristicValue>;
    const needsInit = currentValue === undefined || currentValue === null;
    const homeKitValueChanged = needsInit || currentValue !== nextValue;
    const snapshotChanged = previousValue !== nextValue;
    const shouldUpdate = force || needsInit || snapshotChanged;
    const isEnergyCharacteristic = this.isEnergyMonitoringCharacteristic(characteristic);

    if (shouldUpdate) {
      if (label && homeKitValueChanged) {
        if (!isEnergyCharacteristic || (isEnergyCharacteristic && this.platform.config.energyOptions.logEnergyMonitoring)) {
          this.log.debug(`Updating ${label}: ${previousValue} → ${nextValue}`);
        }
      }
      this.updateValue(
        service,
        characteristic,
        alias,
        nextValue as unknown as Nullable<CharacteristicValue>,
        homeKitValueChanged,
      );
    }
  }

  protected addService(serviceCtor: WithUUID<typeof this.platform.Service>, name: string, subType?: string): Service {
    const friendly = this.platform.getServiceName(serviceCtor);
    this.log.debug(`Creating ${friendly} Service on ${name}${subType ? ` [${subType}]` : ''}`);
    return this.homebridgeAccessory.addService(serviceCtor, name, subType ?? '');
  }

  protected updateValue(
    service: Service,
    characteristic: Characteristic,
    deviceAlias: string,
    value: Nullable<CharacteristicValue> | Error | HapStatusError,
    logUpdate = true,
  ): void {
    const isEnergyCharacteristic = this.isEnergyMonitoringCharacteristic(characteristic);
    if (logUpdate && (!isEnergyCharacteristic || (isEnergyCharacteristic && this.platform.config.energyOptions.logEnergyMonitoring))) {
      this.log.info(`Updating ${this.platform.lsc(service, characteristic)} on ${deviceAlias} to ${value}`);
    }
    characteristic.updateValue(value);
  }

  private isEnergyMonitoringCharacteristic(characteristic: Characteristic): boolean {
    if (!this.platform.energyCharacteristics) {
      return false;
    }
    const uuid = characteristic.UUID;
    return (
      uuid === this.platform.energyCharacteristics.Volts.UUID ||
      uuid === this.platform.energyCharacteristics.Amperes.UUID ||
      uuid === this.platform.energyCharacteristics.Watts.UUID ||
      uuid === this.platform.energyCharacteristics.KiloWattHours.UUID
    );
  }

  public abstract initialize(): Promise<void>;
  public abstract identify(): void;
}