import type { Characteristic, Formats, Perms, Units, WithUUID } from 'homebridge';

export interface CustomCharacteristics {
  Volts: WithUUID<new () => Characteristic>;
  Amperes: WithUUID<new () => Characteristic>;
  Watts: WithUUID<new () => Characteristic>;
  KilowattHours: WithUUID<new () => Characteristic>;
}

export function createCustomCharacteristics(api: any): CustomCharacteristics {
  const { Characteristic, Formats, Perms, Units } = api.hap;

  // Custom characteristic for Volts
  const Volts = class extends Characteristic {
    static readonly UUID: string = 'E863F10A-079E-48FF-8F27-9C2605A29F52';

    constructor() {
      super('Volts', Volts.UUID, {
        format: Formats.FLOAT,
        unit: Units.NONE, // Volts
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
      super('Amperes', Amperes.UUID, {
        format: Formats.FLOAT,
        unit: Units.NONE, // Amperes
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
      super('Watts', Watts.UUID, {
        format: Formats.FLOAT,
        unit: Units.NONE, // Watts
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
      super('KilowattHours', KilowattHours.UUID, {
        format: Formats.FLOAT,
        unit: Units.NONE, // kWh
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
