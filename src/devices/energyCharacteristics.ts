import type { Characteristic, HAP, WithUUID } from 'homebridge';

const EnergyCharacteristicValues = {
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
  KILOWATTHOURS: {
    name: 'KiloWattHours',
    uuid: 'E863F10C-079E-48FF-8F27-9C2605A29F52',
  },
};

export function createEnergyCharacteristics(hap: HAP): EnergyCharacteristics {
  const { Characteristic, Formats, Perms } = hap;

  const Volts = class extends Characteristic {
    static readonly UUID: string = EnergyCharacteristicValues.VOLTS.uuid;
    static readonly name: string = EnergyCharacteristicValues.VOLTS.name;

    constructor() {
      super(Volts.name, Volts.UUID, {
        format: Formats.FLOAT,
        unit: undefined,
        minValue: 0,
        maxValue: 65535,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  };

  const Amperes = class extends Characteristic {
    static readonly UUID: string = EnergyCharacteristicValues.AMPERES.uuid;
    static readonly name: string = EnergyCharacteristicValues.AMPERES.name;

    constructor() {
      super(Amperes.name, Amperes.UUID, {
        format: Formats.FLOAT,
        unit: undefined,
        minValue: 0,
        maxValue: 65535,
        minStep: 0.01,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  };

  const Watts = class extends Characteristic {
    static readonly UUID: string = EnergyCharacteristicValues.WATTS.uuid;
    static readonly name: string = EnergyCharacteristicValues.WATTS.name;

    constructor() {
      super(Watts.name, Watts.UUID, {
        format: Formats.FLOAT,
        unit: undefined,
        minValue: 0,
        maxValue: 65535,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  };

  const KiloWattHours = class extends Characteristic {
    static readonly UUID: string = EnergyCharacteristicValues.KILOWATTHOURS.uuid;
    static readonly name: string = EnergyCharacteristicValues.KILOWATTHOURS.name;

    constructor() {
      super(KiloWattHours.name, KiloWattHours.UUID, {
        format: Formats.FLOAT,
        unit: undefined,
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
    KiloWattHours: KiloWattHours as WithUUID<new () => Characteristic>,
  };
}

export interface EnergyCharacteristics {
  Volts: WithUUID<new () => Characteristic>;
  Amperes: WithUUID<new () => Characteristic>;
  Watts: WithUUID<new () => Characteristic>;
  KiloWattHours: WithUUID<new () => Characteristic>;
}