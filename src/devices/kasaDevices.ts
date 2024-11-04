export type KasaDevice = Plug | Powerstrip | Switch;

interface DeviceCommonInfo {
  alias: string;
  host: string;
  is_off: boolean;
  is_on: boolean;
  sys_info: SysInfo;
}

export interface SysInfo {
  sw_ver: string;
  hw_ver: string;
  model: string;
  deviceId: string;
  mic_type: string;
  mac: string;
  led_off: number;
  relay_state: number;
  err_code: number;
  children?: ChildPlug[];
  child_num?: number;
}

export interface ChildPlug {
  id: string;
  state: number;
  alias: string;
}

export interface DeviceConfig {
  host: string;
  timeout: number;
  connection_type: {
    device_family: string;
    encryption_type: string;
  };
  uses_http: boolean;
}

export interface Plug extends DeviceCommonInfo {
  children?: ChildPlug[];
  device_config: DeviceConfig;
}

export interface Powerstrip extends DeviceCommonInfo {
  sys_info: SysInfo & { children: ChildPlug[]; child_num: number };
  device_config: DeviceConfig;
}

export interface Switch extends DeviceCommonInfo {
  device_config: DeviceConfig;
}

export const Switches = [
  'ES20M(US)',
  'HS200(US)',
  'HS210(US)',
  'HS220(US)',
  'KP405(US)',
  'KS200M(US)',
  'KS205(US)',
  'KS220M(US)',
  'KS225(US)',
  'KS230(US)',
  'KS240(US)',
];