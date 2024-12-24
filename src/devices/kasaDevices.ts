export type KasaDevice = LightBulb | Plug | PowerStrip | Switch;

export interface SysInfo {
  alias: string;
  brightness?: number;
  children?: ChildDevice[];
  child_num: number;
  color_temp?: number;
  device_id: string;
  device_type: string;
  host: string;
  hw_ver: string;
  hsv?: HSV;
  mac: string;
  model: string;
  state?: boolean;
  sw_ver: string;
  [key: string]: string | number | boolean | ChildDevice[] | HSV | undefined;
}

export interface FeatureInfo {
  brightness?: boolean;
  color_temp?: boolean;
  hsv?: boolean;
}

export interface ChildDevice {
  alias: string;
  brightness?: number;
  color_temp?: number;
  hsv?: HSV;
  id: string;
  state: boolean;
  [key: string]: string | number | boolean | HSV | undefined;
}

export interface HSV {
  hue: number;
  saturation: number;
}

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
  alias: string;
}

export interface LightBulb {
  sys_info: SysInfo;
  feature_info: FeatureInfo;
  device_config: DeviceConfig;
  last_seen: Date;
  offline: boolean;
}

export interface Plug {
  sys_info: SysInfo;
  feature_info: FeatureInfo;
  device_config: DeviceConfig;
  last_seen: Date;
  offline: boolean;
}

export interface PowerStrip {
  sys_info: SysInfo;
  feature_info: FeatureInfo;
  device_config: DeviceConfig;
  last_seen: Date;
  offline: boolean;
}

export interface Switch {
  sys_info: SysInfo;
  feature_info: FeatureInfo;
  device_config: DeviceConfig;
  last_seen: Date;
  offline: boolean;
}

export const Plugs = [
  'EP10',
  'EP25',
  'HS100',
  'HS103',
  'HS105',
  'HS110',
  'KP100',
  'KP105',
  'KP115',
  'KP125',
  'KP125M',
  'KP401',
  'P100',
  'P110',
  'P110M',
  'P115',
  'P125M',
  'P135',
  'TP15',
];

export const PowerStrips = [
  'EP40',
  'EP40M',
  'HS107',
  'HS300',
  'KP200',
  'KP303',
  'KP400',
  'P210M',
  'P300',
  'P304M',
  'P306',
  'TP25',
];

export const Switches = [
  'ES20M',
  'HS200',
  'HS210',
  'HS220',
  'KP405',
  'KS200',
  'KS200M',
  'KS205',
  'KS220',
  'KS220M',
  'KS225',
  'KS230',
  'KS240',
  'S500D',
  'S505',
  'S505D',
];

export const LightBulbs = [
  'KL110',
  'KL120',
  'KL125',
  'KL130',
  'KL135',
  'KL50',
  'KL60',
  'LB110',
  'L510B',
  'L510E',
  'L530E',
  'L630',
  'KL400L5',
  'KL420L5',
  'KL430',
  'L900-10',
  'L900-5',
  'L920-5',
  'L930-5',
];

export const Unsupported = [
  'C100',
  'C210',
  'C225',
  'C325WB',
  'C520WS',
  'TC65',
  'TC70',
  'KH100',
  'H100',
  'H200',
  'KE100',
  'S200B',
  'S200D',
  'T100',
  'T110',
  'T300',
  'T310',
  'T315',
];