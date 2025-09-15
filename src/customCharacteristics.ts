import type { API, Characteristic, WithUUID } from 'homebridge';

export const EnergyCharacteristics = {
  VOLTS: 'Volts',
  AMPERES: 'Amperes',
  WATTS: 'Watts',
  KILOWATT_HOURS: 'KilowattHours',
} as const;

export interface CustomCharacteristics {
  Volts: WithUUID<new () => Characteristic>;
  Amperes: WithUUID<new () => Characteristic>;
  Watts: WithUUID<new () => Characteristic>;
  KilowattHours: WithUUID<new () => Characteristic>;
}

export function createCustomCharacteristics(api: API): CustomCharacteristics {
  const { Characteristic, Formats, Perms, Units } = api.hap;

  // Custom characteristic for Volts
  const Volts = class extends Characteristic {
    static readonly UUID: string = 'E863F10A-079E-48FF-8F27-9C2605A29F52';

    constructor() {
      super(EnergyCharacteristics.VOLTS, Volts.UUID, {
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
    static readonly UUID: string = 'E863F126-079E-48FF-8F27-9C2605A29F52';

    constructor() {
      super(EnergyCharacteristics.AMPERES, Amperes.UUID, {
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
    static readonly UUID: string = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

    constructor() {
      super(EnergyCharacteristics.WATTS, Watts.UUID, {
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
    static readonly UUID: string = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

    constructor() {
      super(EnergyCharacteristics.KILOWATT_HOURS, KilowattHours.UUID, {
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
