import type { Characteristic, CharacteristicValue, WithUUID } from 'homebridge';

import type { CharacteristicDescriptor, DescriptorContext, Energy } from './deviceTypes.js';
import type { EnergyCharacteristics } from './energyCharacteristics.js';

export function buildOnDescriptor(
  C: typeof Characteristic,
  setState?: (value: CharacteristicValue, context: DescriptorContext) => Promise<void>,
  syncGroup?: string,
): CharacteristicDescriptor {
  return {
    type: C.On,
    name: 'On',
    writable: true,
    syncGroup,
    syncHomeKitValueAfterSet: !!syncGroup,
    getInitial: context => (context.child ? context.child.state : context.device.state) ?? false,
    getCurrent: context => (context.child ? context.child.state : context.device.state) ?? false,
    applySet: setState
      ? async (value, context) => {
        await setState(value, context);
        const state = Boolean(value);
        if (context.child) {
          context.child.state = state;
        } else {
          context.device.state = state;
        }
      }
      : undefined,
  };
}

export function buildBrightnessDescriptor(
  C: typeof Characteristic,
  setBrightness: (value: number, context: DescriptorContext) => Promise<void>,
): CharacteristicDescriptor {
  return {
    type: C.Brightness,
    name: 'Brightness',
    writable: true,
    getInitial: context => (context.child ? context.child.brightness : context.device.brightness) ?? 0,
    getCurrent: context => (context.child ? context.child.brightness : context.device.brightness) ?? 0,
    applySet: async (value, context) => {
      const brightness = Number(value);
      await setBrightness(brightness, context);
      if (context.child) {
        context.child.brightness = brightness;
      } else {
        context.device.brightness = brightness;
      }
    },
  };
}

export function buildColorTemperatureDescriptor(
  C: typeof Characteristic,
  setColorTemp: (value: number, context: DescriptorContext) => Promise<void>,
): CharacteristicDescriptor {
  return {
    type: C.ColorTemperature,
    name: 'ColorTemperature',
    writable: true,
    getInitial: context => (context.child ? context.child.color_temp : context.device.color_temp) ?? 0,
    getCurrent: context => (context.child ? context.child.color_temp : context.device.color_temp) ?? 0,
    applySet: async (value, context) => {
      const colorTemp = Number(value);
      await setColorTemp(colorTemp, context);
      if (context.child) {
        context.child.color_temp = colorTemp;
      } else {
        context.device.color_temp = colorTemp;
      }
    },
  };
}

export function buildHSVDescriptors(
  C: typeof Characteristic,
  enqueueHSV: (partial: { hue?: number; saturation?: number }, context: DescriptorContext) => Promise<void>,
  syncGroup?: string,
): CharacteristicDescriptor[] {
  return [
    {
      type: C.Hue,
      name: 'Hue',
      writable: true,
      syncGroup,
      syncHomeKitValueAfterSet: !!syncGroup,
      getInitial: context => (context.child ? context.child.hsv?.hue : context.device.hsv?.hue) ?? 0,
      getCurrent: context => (context.child ? context.child.hsv?.hue : context.device.hsv?.hue) ?? 0,
      applySet: async (value, context) => enqueueHSV({ hue: Number(value) }, context),
    },
    {
      type: C.Saturation,
      name: 'Saturation',
      writable: true,
      syncGroup,
      syncHomeKitValueAfterSet: !!syncGroup,
      getInitial: context => (context.child ? context.child.hsv?.saturation : context.device.hsv?.saturation) ?? 0,
      getCurrent: context => (context.child ? context.child.hsv?.saturation : context.device.hsv?.saturation) ?? 0,
      applySet: async (value, context) => enqueueHSV({ saturation: Number(value) }, context),
    },
  ];
}

export function buildOutletInUseDescriptor(
  C: typeof Characteristic,
  useEnergyState: boolean,
  syncGroup?: string,
): CharacteristicDescriptor {
  const energy = (context: DescriptorContext): boolean => {
    const rawPower = context.child ? context.child.energy?.power : context.device.energy?.power;
    const powerWatts = Number(rawPower ?? 0);
    return Number.isFinite(powerWatts) && powerWatts > context.platform.config.energyOptions.powerThreshold;
  };
  const state = (context: DescriptorContext): boolean =>
    (context.child ? context.child.state : context.device.state) ?? false;
  return {
    type: C.OutletInUse,
    name: 'OutletInUse',
    writable: false,
    syncGroup: useEnergyState ? undefined : syncGroup,
    debouncePolls: 2,
    syncHomeKitValueAfterSet: !useEnergyState && !!syncGroup,
    getInitial: (context) => (useEnergyState ? energy(context) : state(context)),
    getCurrent: (context) => (useEnergyState ? energy(context) : state(context)),
  };
}

export function buildEnergyDescriptors(
  energyCharacteristics: EnergyCharacteristics,
): CharacteristicDescriptor[] {
  const definitions: Array<[WithUUID<new () => Characteristic>, keyof Energy, string]> = [
    [energyCharacteristics.Volts, 'voltage', 'Volts'],
    [energyCharacteristics.Amperes, 'current', 'Amperes'],
    [energyCharacteristics.Watts, 'power', 'Watts'],
    [energyCharacteristics.KiloWattHours, 'total', 'KiloWattHours'],
  ];
  return definitions.map(([characteristicType, field, label]) => ({
    type: characteristicType,
    name: label,
    writable: false,
    getInitial: context => (context.child ? context.child.energy?.[field] : context.device.energy?.[field]) ?? 0,
    getCurrent: context => (context.child ? context.child.energy?.[field] : context.device.energy?.[field]) ?? 0,
  }));
}

export function buildFanActiveDescriptor(
  C: typeof Characteristic,
  setActive: (active: boolean, context: DescriptorContext) => Promise<void>,
): CharacteristicDescriptor {
  return {
    type: C.Active,
    name: 'Active',
    writable: true,
    getInitial: context => ((context.child ? context.child.state : context.device.state) ? C.Active.ACTIVE : C.Active.INACTIVE),
    getCurrent: context => ((context.child ? context.child.state : context.device.state) ? C.Active.ACTIVE : C.Active.INACTIVE),
    applySet: async (value, context) => {
      const active = value === C.Active.ACTIVE;
      await setActive(active, context);
      if (context.child) {
        context.child.state = active;
      } else {
        context.device.state = active;
      }
    },
  };
}

export function buildFanRotationDescriptor(
  C: typeof Characteristic,
  setRotation: (fan_speed_level: number, context: DescriptorContext) => Promise<void>,
): CharacteristicDescriptor {
  return {
    type: C.RotationSpeed,
    name: 'RotationSpeed',
    writable: true,
    syncHomeKitValueAfterSet: true,
    getInitial: context => (context.child ? context.child.fan_speed_level : context.device.fan_speed_level) ?? 0,
    getCurrent: context => (context.child ? context.child.fan_speed_level : context.device.fan_speed_level) ?? 0,
    applySet: async (value, context) => {
      const fan_speed_level = Math.min(100, Math.ceil(Math.max(0, Number(value) || 0) / 25) * 25) as 0 | 25 | 50 | 75 | 100;
      await setRotation(fan_speed_level, context);
      if (context.child) {
        context.child.fan_speed_level = fan_speed_level;
        context.child.state = fan_speed_level > 0;
      } else {
        context.device.fan_speed_level = fan_speed_level;
        context.device.state = fan_speed_level > 0;
      }
    },
  };
}