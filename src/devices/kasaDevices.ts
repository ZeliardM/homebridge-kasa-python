export type KasaDevice = Plug | Powerstrip | Switch;

export interface SysInfo {
  active?: number;
  alias: string;
  brightness?: number;
  children?: ChildDevice[];
  child_num: number;
  color_temp?: number;
  device_id: string;
  device_type: string;
  host: string;
  hw_ver: string;
  hsv?: HSV[];
  mac: string;
  state?: boolean;
  sw_ver: string;
  [key: string]: string | number | boolean | ChildDevice[] | HSV[] | undefined;
}

export interface DiscoveryInfo {
  model: string;
}

export interface FeatureInfo {
  brightness?: boolean;
  color_temp?: boolean;
  hsv?: boolean;
}

export interface ChildDevice {
  active?: number;
  alias: string;
  brightness?: number;
  color_temp?: number;
  hsv?: HSV[];
  id: string;
  state: boolean;
  [key: string]: string | number | boolean | HSV[] | undefined;
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
  disc_info: DiscoveryInfo;
  feature_info: FeatureInfo;
  device_config: DeviceConfig;
}

export interface Plug {
  sys_info: SysInfo;
  disc_info: DiscoveryInfo;
  feature_info: FeatureInfo;
  device_config: DeviceConfig;
}

export interface Powerstrip {
  sys_info: SysInfo;
  disc_info: DiscoveryInfo;
  feature_info: FeatureInfo;
  device_config: DeviceConfig;
}

export interface Switch {
  sys_info: SysInfo;
  disc_info: DiscoveryInfo;
  feature_info: FeatureInfo;
  device_config: DeviceConfig;
}

export const Plugs = [
  'EP10(US)',
  'EP25(US)',
  'HS100(UK)',
  'HS100(US)',
  'HS103(US)',
  'HS105(US)',
  'HS110(EU)',
  'HS110(US)',
  'KP100(US)',
  'KP105(UK)',
  'KP115(EU)',
  'KP115(US)',
  'KP125(US)',
  'KP125M(US)',
  'KP401(US)',
  'P100(US)',
  'P110(EU)',
  'P110(UK)',
  'P110M(AU)',
  'P115(EU)',
  'P125M(US)',
  'P135(US)',
  'TP15(US)',
];

export const Powerstrips = [
  'EP40(US)',
  'EP40M(US)',
  'HS107(US)',
  'HS300(US)',
  'KP200(US)',
  'KP303(UK)',
  'KP303(US)',
  'KP400(US)',
  'P300(EU)',
  'P304M(UK)',
  'TP25(US)',
];

export const Switches = [
  'ES20M(US)',
  'HS200(US)',
  'HS210(US)',
  'HS220(US)',
  'KP405(US)',
  'KS200M(US)',
  'KS205(US)',
  'KS220(US)',
  'KS220M(US)',
  'KS225(US)',
  'KS230(US)',
  'KS240(US)',
  'S500D(US)',
  'S505(US)',
  'S505D(US)',
];

export const Bulbs = [
  'KL110(US)',
  'KL120(US)',
  'KL125(US)',
  'KL130(EU)',
  'KL130(US)',
  'KL135(US)',
  'KL50(US)',
  'KL60(UN)',
  'KL60(US)',
  'LB110(US)',
  'L510B(EU)',
  'L510E(US)',
  'L530E(EU)',
  'L530E(US)',
  'L630(EU)',
];

export const Lightstrips = [
  'KL400L5(US)',
  'KL420L5(US)',
  'KL430(UN)',
  'KL430(US)',
  'L900-10(EU)',
  'L900-10(US)',
  'L900-5(EU)',
  'L920-5(EU)',
  'L920-5(US)',
  'L930-5(US)',
];

export const Unsupported = [
  'KH100(EU)',
  'KH100(UK)',
  'H100(EU)',
  'H200(EU)',
  'H200(US)',
  'KE100(EU)',
  'KE100(UK)',
  'S200B(EU)',
  'S200B(US)',
  'S200D(EU)',
  'T100(EU)',
  'T110(EU)',
  'T110(US)',
  'T300(EU)',
  'T310(EU)',
  'T310(US)',
  'T315(EU)',
  'T315(US)',
  'C210(EU)',
  'TC65',
];