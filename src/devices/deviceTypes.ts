import type { Characteristic, CharacteristicValue, WithUUID } from 'homebridge';

import type KasaPythonPlatform from '../platform.js';

export interface Energy {
  current: number;
  voltage: number;
  power: number;
  total: number;
  today: number;
  month: number;
}

export interface HSV {
  hue: number;
  saturation: number;
}

export interface ChildDevice {
  alias: string;
  brightness?: number;
  color_temp?: number;
  energy?: Energy;
  fan_speed_level?: number;
  hsv?: HSV;
  id: string;
  state: boolean;
  [key: string]: string | number | boolean | Energy | HSV | undefined;
}

export interface SysInfo {
  alias: string;
  brightness?: number;
  children?: ChildDevice[];
  child_num: number;
  color_temp?: number;
  device_id: string;
  device_type: string;
  energy?: Energy;
  fan_speed_level?: number;
  host: string;
  hw_ver: string;
  hsv?: HSV;
  mac: string;
  model: string;
  state?: boolean;
  sw_ver: string;
  [key: string]: string | number | boolean | ChildDevice[] | Energy | HSV | undefined;
}

export interface FeatureInfo {
  brightness?: boolean;
  color_temp?: boolean;
  energy?: boolean;
  fan?: boolean;
  hsv?: boolean;
}

export interface LightBulb {
  sys_info: SysInfo;
  feature_info: FeatureInfo;
  last_seen: Date;
  offline: boolean;
}
export interface Plug {
  sys_info: SysInfo;
  feature_info: FeatureInfo;
  last_seen: Date;
  offline: boolean;
}
export interface PowerStrip {
  sys_info: SysInfo;
  feature_info: FeatureInfo;
  last_seen: Date;
  offline: boolean;
}
export interface Switch {
  sys_info: SysInfo;
  feature_info: FeatureInfo;
  last_seen: Date;
  offline: boolean;
}

export type KasaDevice = LightBulb | Plug | PowerStrip | Switch;

export interface DeviceConfig {
  host: string;
  timeout: number;
  credentials?: {
    username: string;
    password: string;
  };
  connection_type: {
    device_family: string;
    encryption_type: string;
    https: boolean;
  };
  uses_http: boolean;
}

export interface ConfigDevice {
  host: string;
}

export const Plugs = [
  'EP10', 'EP25', 'HS100', 'HS103', 'HS105', 'HS110', 'KP100', 'KP105', 'KP115', 'KP125', 'KP125M',
  'KP401', 'P100', 'P105', 'P110', 'P110M', 'P115', 'P125M', 'P135', 'TP10', 'TP15',
];
export const PowerStrips = [
  'EP40', 'EP40M', 'HS107', 'HS300', 'KP200', 'KP303', 'KP400', 'P210M', 'P300', 'P304M', 'P306',
  'P316M', 'P400M', 'TP25',
];
export const Switches = [
  'ES20M', 'HS200', 'HS210', 'HS220', 'KP405', 'KS200', 'KS200M', 'KS205', 'KS220', 'KS220M', 'KS225',
  'KS230', 'KS240', 'S210', 'S220', 'S500', 'S500D', 'S505', 'S505D', 'S515D', 'TS15',
];
export const LightBulbs = [
  'KL110', 'KL110B', 'KL120', 'KL125', 'KL130', 'KL135', 'KL50', 'KL60', 'LB100', 'LB110', 'LB130', 'L430C',
  'L430P', 'L510', 'L510 Series', 'L530', 'L535', 'L630', 'KL400L5', 'KL400L10', 'KL420L5', 'KL430', 'L900',
  'L920', 'L930',
];
export const Unsupported = [
  'C100', 'C110', 'C210', 'C220', 'C225', 'C325WB', 'C520WS', 'C720', 'TC65', 'TC70', 'D100C', 'D130',
  'D230', 'RV20 Max Plus', 'RV30 Max', 'KH100', 'H100', 'H200', 'KE100', 'S200B', 'S200D', 'T100',
  'T110', 'T300', 'T310', 'T315',
];

export interface DescriptorContext {
  platform: KasaPythonPlatform;
  device: SysInfo;
  child?: ChildDevice;
  alias: string;
}

export interface CharacteristicDescriptor {
  type: WithUUID<new () => Characteristic>;
  name?: string;
  writable?: boolean;
  syncGroup?: string;
  debouncePolls?: number;
  syncHomeKitValueAfterSet?: boolean;
  getInitial(context: DescriptorContext): CharacteristicValue;
  getCurrent(context: DescriptorContext): CharacteristicValue;
  applySet?(value: CharacteristicValue, context: DescriptorContext): Promise<void>;
}