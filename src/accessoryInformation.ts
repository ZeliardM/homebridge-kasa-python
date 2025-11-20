import type { HAP, PlatformAccessory, Service } from 'homebridge';

import type HomeKitDevice from './devices/baseDevice.js';

export default function platformAccessoryInformation(
  hap: HAP,
): (accessory: PlatformAccessory, homekitDevice: HomeKitDevice) => Service | undefined {
  const { Characteristic, Service: { AccessoryInformation } } = hap;

  return (accessory: PlatformAccessory, homekitDevice: HomeKitDevice) => {
    let infoService = accessory.getService(AccessoryInformation);
    if (!infoService) {
      infoService = accessory.addService(AccessoryInformation);
    }

    const nameCharacteristic = infoService.getCharacteristic(Characteristic.Name);
    const manufacturerCharacteristic = infoService.getCharacteristic(Characteristic.Manufacturer);
    const modelCharacteristic = infoService.getCharacteristic(Characteristic.Model);
    const serialCharacteristic = infoService.getCharacteristic(Characteristic.SerialNumber);
    const firmwareCharacteristic = infoService.getCharacteristic(Characteristic.FirmwareRevision);
    if (nameCharacteristic.value !== homekitDevice.name) {
      infoService.setCharacteristic(Characteristic.Name, homekitDevice.name);
    }
    if (manufacturerCharacteristic.value !== homekitDevice.manufacturer) {
      infoService.setCharacteristic(Characteristic.Manufacturer, homekitDevice.manufacturer);
    }
    if (modelCharacteristic.value !== homekitDevice.model) {
      infoService.setCharacteristic(Characteristic.Model, homekitDevice.model);
    }
    if (serialCharacteristic.value !== homekitDevice.serialNumber) {
      infoService.setCharacteristic(Characteristic.SerialNumber, homekitDevice.serialNumber);
    }
    if (firmwareCharacteristic.value !== homekitDevice.firmwareRevision) {
      infoService.setCharacteristic(Characteristic.FirmwareRevision, homekitDevice.firmwareRevision);
    }

    return infoService;
  };
}