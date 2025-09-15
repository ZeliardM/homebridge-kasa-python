import type { API, Characteristic, WithUUID } from 'homebridge';

export const EnergyCharacteristics = {
  VOLTS: {
    name: 'Volts',
    uuid: 'E863F10A-079E-48FF-8F27-9C2605A29F52',
  },
  AMPERES: {
    name: 'Amperes',
    uuid: 'E863F126-079E-48FF-8F27-9C2605A29F52',
  },
  WATTS: {
    name: 'Watts',
    uuid: 'E863F10D-079E-48FF-8F27-9C2605A29F52',
  },
  KILOWATT_HOURS: {
    name: 'KilowattHours',
    uuid: 'E863F10C-079E-48FF-8F27-9C2605A29F52',
  },
};

export interface CustomCharacteristics {
  Volts: WithUUID<new () => Characteristic>;
  Amperes: WithUUID<new () => Characteristic>;
  Watts: WithUUID<new () => Characteristic>;
  KilowattHours: WithUUID<new () => Characteristic>;
}

export function createCustomCharacteristics(api: API): CustomCharacteristics {
  const { Characteristic, Formats, Perms } = api.hap;

  // Custom characteristic for Volts
  const Volts = class extends Characteristic {
    static readonly UUID: string = EnergyCharacteristics.VOLTS.uuid;

    constructor() {
      super(EnergyCharacteristics.VOLTS.name, Volts.UUID, {
        format: Formats.FLOAT,
        unit: undefined, // Volts
        minValue: 0,
        maxValue: 65535,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  };

  // Custom characteristic for Amperes
  const Amperes = class extends Characteristic {
    static readonly UUID: string = EnergyCharacteristics.AMPERES.uuid;

    constructor() {
      super(EnergyCharacteristics.AMPERES.name, Amperes.UUID, {
        format: Formats.FLOAT,
        unit: undefined, // Amperes
        minValue: 0,
        maxValue: 65535,
        minStep: 0.01,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  };

  // Custom characteristic for Watts
  const Watts = class extends Characteristic {
    static readonly UUID: string = EnergyCharacteristics.WATTS.uuid;

    constructor() {
      super(EnergyCharacteristics.WATTS.name, Watts.UUID, {
        format: Formats.FLOAT,
        unit: undefined, // Watts
        minValue: 0,
        maxValue: 65535,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  };

  // Custom characteristic for KilowattHours
  const KilowattHours = class extends Characteristic {
    static readonly UUID: string = EnergyCharacteristics.KILOWATT_HOURS.uuid;

    constructor() {
      super(EnergyCharacteristics.KILOWATT_HOURS.name, KilowattHours.UUID, {
        format: Formats.FLOAT,
        unit: undefined, // kWh
        minValue: 0,
        maxValue: 65535,
        minStep: 0.001,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  };

  return {
    Volts: Volts as WithUUID<new () => Characteristic>,
    Amperes: Amperes as WithUUID<new () => Characteristic>,
    Watts: Watts as WithUUID<new () => Characteristic>,
    KilowattHours: KilowattHours as WithUUID<new () => Characteristic>,
  };
}
