import type { CharacteristicValue, Service, WithUUID } from 'homebridge';

import HomeKitDevice from './baseDevice.js';
import type {
  CharacteristicDescriptor,
  ChildDevice,
  DescriptorContext,
  SysInfo,
} from './deviceTypes.js';

export default abstract class HomeKitParentDevice extends HomeKitDevice {
  private childDescriptorMap: Map<string, CharacteristicDescriptor[]> = new Map();

  protected setupChildServices(): void {
    const children = this.kasaDevice.sys_info.children;
    if (!Array.isArray(children)) {
      return;
    }
    for (const child of children) {
      this.ensureChildService(child);
    }
  }

  private ensureChildService(child: ChildDevice): void {
    const serviceType = this.getChildServiceType(child);
    const childIndex = this.extractChildIndex(child);
    const subType = `child-${childIndex + 1}`;
    let service = this.homebridgeAccessory.getServiceById(serviceType, subType);
    if (!service) {
      service = this.addService(serviceType, child.alias, subType);
    }
    const descriptors = this.buildChildDescriptors(child);
    this.childDescriptorMap.set(this.childKey(child), descriptors);
    for (const descriptor of descriptors) {
      const onSet = descriptor.writable
        ? (value: CharacteristicValue) => this.childOnSet(service!, child, descriptor, value)
        : undefined;
      this.registerCharacteristic(service!, descriptor.type, () => this.childOnGet(service!, child, descriptor), onSet);
    }
  }

  private childKey(child: ChildDevice): string {
    return String(child.id ?? child.alias);
  }

  private resolveLiveChild(snapshotChild: ChildDevice): ChildDevice | undefined {
    const id = snapshotChild?.id;
    const children = this.kasaDevice.sys_info.children;
    if (!Array.isArray(children)) {
      return undefined;
    }
    return children.find(c => c.id === id);
  }

  protected updateChildField<K extends keyof ChildDevice>(childId: string, key: K, value: ChildDevice[K]): void {
    const children = this.kasaDevice.sys_info.children;
    if (!Array.isArray(children)) {
      return;
    }
    const idx = children.findIndex(c => c.id === childId);
    if (idx >= 0) {
      (children[idx] as ChildDevice)[key] = value as keyof ChildDevice;
    }
  }

  private buildChildDescriptorContext(child: ChildDevice): DescriptorContext {
    const live = this.resolveLiveChild(child) ?? child;
    return this.buildDescriptorContext(live);
  }

  private async childOnGet(service: Service, child: ChildDevice, descriptor: CharacteristicDescriptor) {
    const context = this.buildChildDescriptorContext(child);
    try {
      let value = service.getCharacteristic(descriptor.type).value;
      if (value === undefined || value === null) {
        value = descriptor.getInitial(context);
        service.getCharacteristic(descriptor.type).updateValue(value);
      }
      return value;
    } catch (error) {
      this.log.error(`Child OnGet error (${child.alias}) ${descriptor.name}`, error);
      this.kasaDevice.offline = true;
      await this.stopPolling();
      return this.defaultValueForCharacteristic(descriptor.type);
    }
  }

  private async childOnSet(
    service: Service,
    child: ChildDevice,
    descriptor: CharacteristicDescriptor,
    value: CharacteristicValue,
  ) {
    const context = this.buildChildDescriptorContext(child);
    if (!descriptor.applySet) {
      return;
    }
    await this.executeChildDescriptorSet(service, child, descriptor, value, context);
  }

  private getChildService(child: ChildDevice): Service | undefined {
    const serviceType = this.getChildServiceType(child);
    const childIndex = this.extractChildIndex(child);
    return this.homebridgeAccessory.getServiceById(serviceType, `child-${childIndex + 1}`);
  }

  private async executeChildDescriptorSet(
    service: Service,
    child: ChildDevice,
    descriptor: CharacteristicDescriptor,
    value: CharacteristicValue,
    context: DescriptorContext,
    isGrouped = false,
  ) {
    const lockKey = this.makeLockKey();
    await this.withLock(lockKey, async () => {
      if (this.shouldSkipUpdate()) {
        return;
      }
      if (!this.deviceManager) {
        throw new Error('Device manager undefined');
      }
      try {
        this.isUpdating = true;
        await descriptor.applySet!(value, context);

        const postSetValue = descriptor.getCurrent(context);

        this.updateValue(service, service.getCharacteristic(descriptor.type), context.alias, postSetValue as CharacteristicValue);
        this.previousSnapshot = JSON.parse(JSON.stringify(this.kasaDevice));
      } catch (error) {
        this.log.error(`Child OnSet error (${child.alias}) ${descriptor.name}`, error);
        this.kasaDevice.offline = true;
        await this.stopPolling();
      } finally {
        if (!isGrouped) {
          this.isUpdating = false;
          this.updateEmitter.emit('updateComplete');
        }
      }
    });
  }

  protected async updateAllServicesAndCharacteristics(forceUpdate: boolean): Promise<void> {
    const children = this.kasaDevice.sys_info.children;
    if (!Array.isArray(children)) {
      return;
    }
    for (const child of children) {
      const service = this.getChildService(child);
      if (!service) {
        continue;
      }
      const key = this.childKey(child);
      const descriptors = this.childDescriptorMap.get(key);
      if (!descriptors) {
        continue;
      }
      for (const descriptor of descriptors) {
        const context = this.buildChildDescriptorContext(child);
        try {
          const previousChild = this.previousSnapshot?.sys_info.children?.find(c => c.id === child.id);
          const previousContext: DescriptorContext = {
            platform: this.platform,
            device: (this.previousSnapshot?.sys_info as SysInfo) ?? {} as SysInfo,
            child: previousChild,
            alias: child.alias,
          };
          (previousContext.device as SysInfo).__snapshot = true;

          const previousValue = previousChild ? descriptor.getCurrent(previousContext) : descriptor.getInitial(context);
          const nextValue = descriptor.getCurrent(context);
          this.updateIfChanged(
            service,
            service.getCharacteristic(descriptor.type),
            context.alias,
            previousValue as CharacteristicValue,
            nextValue as CharacteristicValue,
            descriptor.name,
            forceUpdate,
          );
        } catch (error) {
          this.log.error(`Child update diff error (${child.alias}) ${descriptor.name}`, error);
        }
      }
    }
  }

  protected abstract getChildServiceType(child: ChildDevice): WithUUID<typeof this.platform.Service>;
  protected abstract buildChildDescriptors(child: ChildDevice): CharacteristicDescriptor[];
}