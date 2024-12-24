import type { HAP, PlatformAccessory, Service } from 'homebridge';

import type HomeKitDevice from './devices/index.js';

export default function platformAccessoryInformation(
  hap: HAP,
): (platformAccessory: PlatformAccessory, homekitDevice: HomeKitDevice) => Service | undefined {
  const { Characteristic, Service: { AccessoryInformation } } = hap;

  return (platformAccessory: PlatformAccessory, homekitDevice: HomeKitDevice) => {
    const existingInfoService = platformAccessory.getService(AccessoryInformation);
    if (existingInfoService) {
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