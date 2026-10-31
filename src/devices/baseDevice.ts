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
import DeviceManager, { runHomeKitWrite } from './deviceManager.js';
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

const MAX_CONSECUTIVE_POLL_FAILURES = 2;
const TURN_ON_BY_BRIGHTNESS_WINDOW_MS = 1000;

export default abstract class HomeKitDevice {
  readonly log: Logger;
  protected deviceManager: DeviceManager | undefined;
  public homebridgeAccessory: PlatformAccessory<KasaPythonAccessoryContext>;
  public isUpdating = false;
  // When the device last answered a poll or discovery found it (performance.now())
  public lastAnsweredAt?: number;
  protected previousSnapshot?: KasaDevice;
  protected pollingInterval?: NodeJS.Timeout;
  protected updateEmitter = new EventEmitter();

  private static locks: Map<string, Promise<unknown>> = new Map();
  private pendingChanges: Map<string, { pendingValue: CharacteristicValue; count: number }> = new Map();

  protected getSysInfoDeferred: () => Promise<boolean>;

  protected primaryDescriptors: CharacteristicDescriptor[] = [];
  protected primaryService?: Service;
  private consecutivePollFailures = 0;
  // Set when a poll of this device's address answered as another device (the address was given to
  // a new one); writes are then refused instead of switching that device. Cleared when this device
  // answers there again or discovery finds it.
  private addressHeldByOther = false;
  private removedFromPlatform = false;
  private refreshAllAfterRecovery = false;
  private writeGeneration = 0;
  private turnedOnByBrightnessAt: Map<string, number> = new Map();

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
    // Wait for the previous holder to settle either way. Its error belongs to its own caller;
    // chaining with a plain then() would hand it to every later caller and never free the key.
    const currentPromise = previousPromise.catch(() => undefined).then(async () => {
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
    return this.removedFromPlatform || this.platform.isShuttingDown;
  }

  // Wait for this device's own write to finish; every write ends by emitting updateComplete.
  protected async waitForUpdate(): Promise<void> {
    await new Promise<void>(resolve => this.updateEmitter.once('updateComplete', resolve));
  }

  protected async getSysInfo(): Promise<boolean> {
    return await this.getSysInfoDeferred();
  }

  private async fetchSysInfoInternal(): Promise<boolean> {
    if (!this.deviceManager) {
      this.log.warn('Device manager not available');
      return false;
    }
    const host = this.kasaDevice.sys_info?.host;
    if (!host) {
      this.log.warn('No host in sys_info');
      return false;
    }
    const generation = this.writeGeneration;
    let updatedSysInfo: SysInfo | undefined;
    try {
      updatedSysInfo = await this.deviceManager.getSysInfo(host);
    } catch (error) {
      // The local service failed the request, not the device: this poll neither counts toward No Response nor resets
      // the count. While the service is down, HomeKit reads get No Response (genericOnGet).
      this.log.debug(`Poll not counted: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (this.shouldSkipUpdate()) {
      // Shutdown stopped the service during this read, or the device was removed; neither is the device's failure
      return false;
    }
    if (generation !== this.writeGeneration) {
      // A write started while this read was in flight, so the reading may predate it.
      this.log.debug('Discarding sys_info read that started before a write');
      return false;
    }
    if (this.kasaDevice.sys_info.host !== host) {
      // Discovery found the device at a new address while this read of the old one was in flight.
      this.log.debug(`Discarding sys_info read of ${host}; the device is now at ${this.kasaDevice.sys_info.host}`);
      return false;
    }
    if (!updatedSysInfo) {
      this.recordPollCommunicationFailure(host);
      return false;
    }
    if (updatedSysInfo.device_id !== this.kasaDevice.sys_info.device_id) {
      // The address now belongs to another device (it was given to a new one); this device is not
      // there, and its accessory must not take on the other device's state.
      this.addressHeldByOther = true;
      this.recordPollCommunicationFailure(host, `${host} answered as another device (${updatedSysInfo.device_id})`);
      return false;
    }
    this.addressHeldByOther = false;
    this.kasaDevice.sys_info = updatedSysInfo;
    const previousFailures = this.consecutivePollFailures;
    const wasOffline = this.kasaDevice.offline;
    this.markDeviceReachable(new Date());
    if (wasOffline) {
      this.log.warn(
        `Recovered communication with ${updatedSysInfo.alias ?? host} after ` +
        `${previousFailures} consecutive poll failures.`,
      );
    } else if (previousFailures > 0) {
      this.log.debug(
        `Recovered communication with ${updatedSysInfo.alias ?? host} after ` +
        `${previousFailures} failed poll attempt(s).`,
      );
    }
    this.log.debug(`Updated sys_info: ${updatedSysInfo.alias ?? host}`);
    return true;
  }

  protected async refreshAndUpdateCharacteristics(forceUpdate: boolean): Promise<void> {
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
      if (this.isUpdating) {
        await this.waitForUpdate();
      }
      if (this.shouldSkipUpdate()) {
        await this.stopPolling();
        return;
      }
      this.isUpdating = true;
      try {
        const didUpdateSysInfo = await this.getSysInfo();
        if (!didUpdateSysInfo || this.shouldSkipUpdate()) {
          return;
        }
        // After an offline period HomeKit still shows the values from before it: take the device's
        // values at once instead of debouncing them.
        const forceAll = forceUpdate || this.refreshAllAfterRecovery;
        await this.updateAllServicesAndCharacteristics(forceAll);
        this.refreshAllAfterRecovery = false;
        this.previousSnapshot = JSON.parse(JSON.stringify(this.kasaDevice));
      } catch (error) {
        this.log.error('Error during poll update:', error);
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
      () => void this.refreshInBackground(false),
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

  public removeFromPlatform(): void {
    this.removedFromPlatform = true;
    void this.stopPolling();
    // Release anything still waiting on this device.
    this.updateEmitter.emit('updateComplete');
  }

  public markDeviceReachable(lastSeen: Date): void {
    this.consecutivePollFailures = 0;
    this.lastAnsweredAt = performance.now();
    this.kasaDevice.last_seen = lastSeen;
    this.homebridgeAccessory.context.lastSeen = lastSeen;
    this.setOfflineState(false);
  }

  // Discovery reads device state earlier than it reaches here, so only identity is taken
  // from it; current state comes from the next poll, under the device lock.
  public updateFromDiscovery(device: KasaDevice): void {
    this.addressHeldByOther = false;
    this.kasaDevice.sys_info.host = device.sys_info.host;
    this.kasaDevice.sys_info.alias = device.sys_info.alias;
    this.kasaDevice.feature_info = device.feature_info;
  }

  // Discovery found a device that was offline or at a new address: read it now, not at the next poll.
  public updateAfterPeriodicDiscovery(): void {
    void this.refreshInBackground(true);
  }

  // Nothing awaits these refreshes, and an unhandled rejection makes Homebridge shut down.
  private async refreshInBackground(forceUpdate: boolean): Promise<void> {
    try {
      await this.refreshAndUpdateCharacteristics(forceUpdate);
    } catch (error) {
      this.log.error('Background refresh failed:', error);
    }
  }

  protected markWriteStarted(): void {
    this.writeGeneration += 1;
  }

  // A brightness write above zero already turns the light on. HomeKit scenes send On right
  // after it, so that On needs no command of its own. The key is '' or a child id.
  protected noteTurnedOnByBrightness(key: string): void {
    this.turnedOnByBrightnessAt.set(key, Date.now());
  }

  protected shouldSkipTurnOn(key: string, value: CharacteristicValue): boolean {
    const turnedOnAt = this.turnedOnByBrightnessAt.get(key);
    this.turnedOnByBrightnessAt.delete(key);
    const skip = Boolean(value) && turnedOnAt !== undefined && Date.now() - turnedOnAt < TURN_ON_BY_BRIGHTNESS_WINDOW_MS;
    if (skip) {
      this.log.debug('Skipping turn on; the brightness write just turned the light on');
    }
    return skip;
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
    if (this.kasaDevice.offline || !this.platform.isKasaApiAvailable) {
      throw this.communicationFailure();
    }
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
      this.ensureAddressIsOwn();
      try {
        this.isUpdating = true;
        this.markWriteStarted();
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
              this.logDeviceChange(`Set ${this.platform.lsc(this.primaryService, char)} on ${context.alias} to ${postSetValue}`);
            }
          }
        }
        this.previousSnapshot = JSON.parse(JSON.stringify(this.kasaDevice));
      } catch (error) {
        this.log.error(`OnSet error for ${descriptor.name ?? descriptor.type.UUID}`, error);
        throw this.communicationFailure();
      } finally {
        if (!isGrouped) {
          this.isUpdating = false;
          this.updateEmitter.emit('updateComplete');
        }
      }
    };

    if (this.shouldBypassSetLock(descriptor)) {
      await runHomeKitWrite(runSet);
      return;
    }

    const lockKey = this.makeLockKey();
    await runHomeKitWrite(() => this.withLock(lockKey, runSet));
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
          if (!forceUpdate && effectiveNext !== nextDeviceValue && hkValue !== nextDeviceValue) {
            this.log.debug(
              `Debouncing ${descriptor.name ?? descriptor.type.UUID}: ` +
              `keeping ${hkValue}, observed ${nextDeviceValue}`,
            );
          }
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
      this.logDeviceChange(`Updating ${this.platform.lsc(service, characteristic)} on ${deviceAlias} to ${value}`);
    }
    characteristic.updateValue(value);
  }

  // Reduce Device Logging moves routine change messages to debug.
  protected logDeviceChange(message: string): void {
    if (this.platform.config.advancedOptions.reduceDeviceLogging) {
      this.log.debug(message);
    } else {
      this.log.info(message);
    }
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

  // Polls only change what HomeKit is shown: reads get No Response while the device is offline (HAP has no way to
  // push that before the next read). The cached accessory's offline flag, which decides when it is removed, is left
  // to discovery: a short network drop must not be saved, nor count toward removal.
  protected setOfflineState(offline: boolean): void {
    const wasOffline = this.kasaDevice.offline;
    this.kasaDevice.offline = offline;
    if (!offline && wasOffline) {
      this.refreshAllAfterRecovery = true;
    }
  }

  // A write must not reach the device that now holds this device's address.
  protected ensureAddressIsOwn(): void {
    if (this.addressHeldByOther) {
      this.log.debug(`Not sending the write: another device answers at ${this.kasaDevice.sys_info.host}`);
      throw this.communicationFailure();
    }
  }

  protected communicationFailure(): HapStatusError {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private recordPollCommunicationFailure(host: string, reason = `No sys_info returned for ${host}`): void {
    this.consecutivePollFailures += 1;
    const markedOffline = this.consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES;

    if (markedOffline) {
      this.setOfflineState(true);
    }

    const message = markedOffline
      ? `${reason} after ${this.consecutivePollFailures} consecutive poll failures. ` +
        'Marking device offline but continuing to poll for recovery.'
      : `${reason} (${this.consecutivePollFailures}/${MAX_CONSECUTIVE_POLL_FAILURES} ` +
        'failed polls before marking offline).';

    if (this.consecutivePollFailures <= MAX_CONSECUTIVE_POLL_FAILURES) {
      this.log.warn(`Poll update failed: ${message}`);
    } else {
      this.log.debug(`Poll update still failing: ${message}`);
    }
  }

  public abstract initialize(): Promise<void>;
  public abstract identify(): void;
}
