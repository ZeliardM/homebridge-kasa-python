import type { HAP, PlatformAccessory, Service } from 'homebridge';

import type HomeKitDevice from './devices/index.js';

export default function platformAccessoryInformation(
  hap: HAP,
): (platformAccessory: PlatformAccessory, homekitDevice: HomeKitDevice) => Service | undefined {
  const { Characteristic, Service: { AccessoryInformation } } = hap;

  return (platformAccessory: PlatformAccessory, homekitDevice: HomeKitDevice) => {
    const infoService = platformAccessory.getService(AccessoryInformation) ?? platformAccessory.addService(AccessoryInformation);

    [Characteristic.Name, Characteristic.Manufacturer, Characteristic.Model, Characteristic.SerialNumber, Characteristic.FirmwareRevision]
      .forEach(characteristic => {
        if (!infoService.getCharacteristic(characteristic)) {
          infoService.addCharacteristic(characteristic);
        }
      });

    infoService
      .setCharacteristic(Characteristic.Name, homekitDevice.name)
      .setCharacteristic(Characteristic.Manufacturer, homekitDevice.manufacturer)
      .setCharacteristic(Characteristic.Model, homekitDevice.model)
      .setCharacteristic(Characteristic.SerialNumber, homekitDevice.serialNumber)
      .setCharacteristic(Characteristic.FirmwareRevision, homekitDevice.firmwareRevision);

    return infoService;
  };
}