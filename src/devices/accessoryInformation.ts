import type { CharacteristicValue, HAP, PlatformAccessory, Service } from 'homebridge';

import type HomeKitDevice from './baseDevice.js';

export default function accessoryInformation(
  hap: HAP,
): (accessory: PlatformAccessory, homekitDevice: HomeKitDevice) => Service | undefined {
  const { Characteristic, Service: { AccessoryInformation } } = hap;

  return (accessory: PlatformAccessory, homekitDevice: HomeKitDevice) => {
    const infoService = accessory.getService(AccessoryInformation) ?? accessory.addService(AccessoryInformation);

    const nameCharacteristic = infoService.getCharacteristic(Characteristic.Name);
    const manufacturerCharacteristic = infoService.getCharacteristic(Characteristic.Manufacturer);
    const modelCharacteristic = infoService.getCharacteristic(Characteristic.Model);
    const serialCharacteristic = infoService.getCharacteristic(Characteristic.SerialNumber);
    const firmwareCharacteristic = infoService.getCharacteristic(Characteristic.FirmwareRevision);
    const currentName = nameCharacteristic.value as string ?? '';
    const deviceName = homekitDevice.name ?? '';

    if (!currentName) {
      infoService.setCharacteristic(Characteristic.Name, deviceName as CharacteristicValue);
    }
    if ((manufacturerCharacteristic.value as string ?? '') !== (homekitDevice.manufacturer ?? '')) {
      infoService.setCharacteristic(Characteristic.Manufacturer, homekitDevice.manufacturer as CharacteristicValue);
    }
    if ((modelCharacteristic.value as string ?? '') !== (homekitDevice.model ?? '')) {
      infoService.setCharacteristic(Characteristic.Model, homekitDevice.model as CharacteristicValue);
    }
    if ((serialCharacteristic.value as string ?? '') !== (homekitDevice.serialNumber ?? '')) {
      infoService.setCharacteristic(Characteristic.SerialNumber, homekitDevice.serialNumber as CharacteristicValue);
    }
    if ((firmwareCharacteristic.value as string ?? '') !== (homekitDevice.firmwareRevision ?? '')) {
      infoService.setCharacteristic(Characteristic.FirmwareRevision, homekitDevice.firmwareRevision as CharacteristicValue);
    }

    return infoService;
  };
}