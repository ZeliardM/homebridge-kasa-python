import type { HAP, PlatformAccessory, Service } from 'homebridge';

import type HomeKitDevice from './devices/index.js';

export default function platformAccessoryInformation(
  hap: HAP,
): (platformAccessory: PlatformAccessory, homekitDevice: HomeKitDevice) => Service | undefined {
  const { Characteristic, Service: { AccessoryInformation } } = hap;

  return (platformAccessory: PlatformAccessory, homekitDevice: HomeKitDevice) => {
    const existingInfoService = platformAccessory.getService(AccessoryInformation);
    if (existingInfoService) {
      if (existingInfoService.getCharacteristic(Characteristic.Name).value !== homekitDevice.name) {
        existingInfoService.setCharacteristic(Characteristic.Name, homekitDevice.name);
      } else if (existingInfoService.getCharacteristic(Characteristic.Manufacturer).value !== homekitDevice.manufacturer) {
        existingInfoService.setCharacteristic(Characteristic.Manufacturer, homekitDevice.manufacturer);
      } else if (existingInfoService.getCharacteristic(Characteristic.Model).value !== homekitDevice.model) {
        existingInfoService.setCharacteristic(Characteristic.Model, homekitDevice.model);
      } else if (existingInfoService.getCharacteristic(Characteristic.SerialNumber).value !== homekitDevice.serialNumber) {
        existingInfoService.setCharacteristic(Characteristic.SerialNumber, homekitDevice.serialNumber);
      } else if (existingInfoService.getCharacteristic(Characteristic.FirmwareRevision).value !== homekitDevice.firmwareRevision) {
        existingInfoService.setCharacteristic(Characteristic.FirmwareRevision, homekitDevice.firmwareRevision);
      }
      return existingInfoService;
    } else {
      const infoService = platformAccessory.addService(AccessoryInformation);
      infoService
        .setCharacteristic(Characteristic.Name, homekitDevice.name)
        .setCharacteristic(Characteristic.Manufacturer, homekitDevice.manufacturer)
        .setCharacteristic(Characteristic.Model, homekitDevice.model)
        .setCharacteristic(Characteristic.SerialNumber, homekitDevice.serialNumber)
        .setCharacteristic(Characteristic.FirmwareRevision, homekitDevice.firmwareRevision);
      return infoService;
    }
  };
}