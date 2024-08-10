import type { HAP, PlatformAccessory, Service } from 'homebridge';

import type HomekitDevice from './devices/index.js';

export default function accessoryInformation(
  hap: HAP,
): (accessory: PlatformAccessory, homekitDevice: HomekitDevice) => Service | undefined {
  const { Characteristic, Service: { AccessoryInformation } } = hap;

  return (accessory: PlatformAccessory, homekitDevice: HomekitDevice) => {
    const infoService = accessory.getService(AccessoryInformation) ?? accessory.addService(AccessoryInformation);

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