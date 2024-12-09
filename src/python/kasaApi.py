import asyncio
import sys
import uvicorn
from typing import Any, Dict, List, Optional

from kasa import Credentials, Device, Discover, Module, UnsupportedDeviceError
from quart import Quart, jsonify, request

app = Quart(__name__)

UNSUPPORTED_TYPES = {
    'SMART.IPCAMERA',
    'SMART.KASAHUB',
    'SMART.TAPOHUB'
}

def get_light_info(light_module: Module) -> Dict[str, Any]:
    try:
        light_info = {}
        if light_module.is_dimmable:
            light_info["brightness"] = light_module.brightness
        if light_module.is_variable_color_temp:
            light_info["color_temp"] = light_module.color_temp
        if light_module.is_color:
            hue, saturation, _ = light_module.hsv
            light_info["hsv"] = {"hue": hue, "saturation": saturation}
        return light_info
    except Exception as e:
        raise ValueError(f"Error getting light info: {e}")

def serialize_child(child: Device) -> Dict[str, Any]:
    try:
        child_info = {
            "alias": child.alias,
            "id": child.device_id.split("_", 1)[1],
            "state": child.features["state"].value
        }
        light_module = child.modules.get(Module.Light)
        if light_module:
            child_info.update(get_light_info(light_module))
        return child_info
    except Exception as e:
        raise ValueError(f"Error serializing child device {child.alias}: {e}")

def custom_sysinfo_config_serializer(device: Device) -> Dict[str, Any]:
    try:
        child_num = len(device.children) if device.children else 0

        sys_info = {
            "alias": device.alias or f'{device.device_type}_{device.host}',
            "child_num": child_num,
            "device_id": device.device_id if device.mac != device.device_id else device.sys_info.get("deviceId"),
            "device_type": device.config.connection_type.device_family.value,
            "host": device.host,
            "hw_ver": device.hw_info["hw_ver"],
            "mac": device.mac,
            "sw_ver": device.hw_info["sw_ver"],
        }

        if child_num > 0:
            sys_info["children"] = [serialize_child(child) for child in device.children]
        else:
            sys_info.update({
                "state": device.features["state"].value
            })
            light_module = device.modules.get(Module.Light)
            if light_module:
                sys_info.update(get_light_info(light_module))

        device_config = {
            "host": device.config.host,
            "timeout": device.config.timeout,
            "uses_http": device.config.uses_http,
            **({"credentials": {
                "username": device.config.credentials.username,
                "password": device.config.credentials.password
            }} if device.config.credentials else {}),
            "connection_type": {
                "device_family": device.config.connection_type.device_family.value,
                "encryption_type": device.config.connection_type.encryption_type.value,
                "https": device.config.connection_type.https
            }
        }

        return {
            "sys_info": sys_info,
            "device_config": device_config
        }
    except Exception as e:
        raise ValueError(f"Error serializing sysinfo config for device {device.host}: {e}")

def custom_discovery_feature_serializer(device: Device) -> Dict[str, Any]:
    try:
        disc_info = {
            "model": device._discovery_info.get("device_model") or device.sys_info.get("model")
        }

        feature_info = {}
        light_module = device.modules.get(Module.Light)
        if light_module:
            feature_info = {
                "brightness": light_module.is_dimmable,
                "color_temp": light_module.is_variable_color_temp,
                "hsv": light_module.is_color
            }

        return {
            "disc_info": disc_info,
            "feature_info": feature_info
        }
    except Exception as e:
        raise ValueError(f"Error serializing discovery feature for device {device.host}: {e}")

async def discover_devices(
    username: Optional[str] = None,
    password: Optional[str] = None,
    additional_broadcasts: Optional[List[str]] = None,
    manual_devices: Optional[List[str]] = None
) -> Dict[str, Any]:
    try:
        devices = {}
        broadcasts = ["255.255.255.255"] + (additional_broadcasts or [])
        creds = Credentials(username, password) if username and password else None

        async def on_discovered(device: Device):
            try:
                await device.update()
            except UnsupportedDeviceError as e:
                raise ValueError(f"Unsupported device during discovery: {device.host} - {e}")
            except Exception as e:
                raise ValueError(f"Error updating device during discovery: {device.host} - {e}")

        async def discover_on_broadcast(broadcast: str):
            try:
                discovered = await Discover.discover(
                    target=broadcast,
                    credentials=creds,
                    on_discovered=on_discovered
                )
                devices.update(discovered)
            except Exception as e:
                raise ValueError(f"Error during broadcast discovery {broadcast}: {e}")

        async def discover_manual_device(host: str):
            if host in devices:
                return
            try:
                device = await Discover.discover_single(host=host, credentials=creds)
                await on_discovered(device)
                devices[host] = device
            except UnsupportedDeviceError as e:
                raise ValueError(f"Unsupported manual device: {host} - {e}")
            except Exception as e:
                raise ValueError(f"Error discovering manual device {host}: {e}")

        discover_tasks = [discover_on_broadcast(bc) for bc in broadcasts]
        manual_discover_tasks = [discover_manual_device(host) for host in (manual_devices or [])]
        await asyncio.gather(*discover_tasks, *manual_discover_tasks)

        all_device_info = {}
        update_tasks = []

        for ip, dev in devices.items():
            try:
                components = await dev._raw_query("component_nego")
                component_list = components.get("component_nego", {}).get("component_list", [])
                homekit_component = next((item for item in component_list if item.get("id") == "homekit"), None)
                if homekit_component:
                    continue
            except Exception:
                pass

            dev_type = dev.sys_info.get("mic_type") or dev.sys_info.get("type")
            if dev_type and dev_type not in UNSUPPORTED_TYPES:
                update_tasks.append(create_device_info(ip, dev))

        results = await asyncio.gather(*update_tasks, return_exceptions=True)

        for result in results:
            if isinstance(result, Exception):
                continue
            ip, info = result
            all_device_info[ip] = info

        return all_device_info
    except Exception as e:
        raise ValueError(f"Error during device discovery: {e}")

async def create_device_info(ip: str, dev: Device):
    try:
        sys_info_data = custom_sysinfo_config_serializer(dev)
        feature_info_data = custom_discovery_feature_serializer(dev)
        device_info = {
            "sys_info": sys_info_data["sys_info"],
            "disc_info": feature_info_data["disc_info"],
            "feature_info": feature_info_data["feature_info"],
            "device_config": sys_info_data["device_config"]
        }
        return ip, device_info
    except Exception as e:
        raise ValueError(f"Error creating device info for {ip}: {e}")

async def get_sys_info(device_config: Dict[str, Any]) -> Dict[str, Any]:
    dev = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        device = custom_sysinfo_config_serializer(dev)
        return {"sys_info": device["sys_info"]}
    except Exception as e:
        raise ValueError(f"Error getting sys info for device {device_config['host']}: {e}")
    finally:
        await dev.disconnect()

async def control_device(
    device_config: Dict[str, Any],
    feature: str,
    action: str,
    value: Any,
    child_num: Optional[int] = None
) -> Dict[str, Any]:
    dev = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        target = dev.children[child_num] if child_num is not None else dev
        light = target.modules.get(Module.Light)

        if feature == "state":
            await getattr(target, action)()
        elif feature == "brightness" and light:
            await handle_brightness(target, action, value)
        elif feature == "color_temp" and light:
            await handle_color_temp(target, action, value)
        elif feature in ["hue", "saturation"] and light:
            await handle_hsv(target, action, feature, value)
        else:
            raise ValueError(f"Unsupported feature or missing module: {feature}")

        target.update()
        return {"status": "success"}
    except Exception as e:
        raise ValueError(f"Error controlling device {device_config['host']}: {e}")
    finally:
        await dev.disconnect()

async def handle_brightness(target: Device, action: str, value: int):
    try:
        light = target.modules.get(Module.Light)
        if value == 0:
            await target.turn_off()
        elif 0 < value <= 100:
            await getattr(light, action)(value)
        else:
            await target.turn_on()
    except Exception as e:
        raise ValueError(f"Error handling brightness for device {target.host}: {e}")

async def handle_color_temp(target: Device, action: str, value: int):
    try:
        light = target.modules.get(Module.Light)
        min_temp, max_temp = light.valid_temperature_range
        value = max(min(value, max_temp), min_temp)
        await getattr(light, action)(value)
    except Exception as e:
        raise ValueError(f"Error handling color temperature for device {target.host}: {e}")

async def handle_hsv(target: Device, action: str, feature: str, value: Dict[str, int]):
    try:
        light = target.modules.get(Module.Light)
        hsv = list(light.hsv)
        if feature == "hue":
            hsv[0] = value["hue"]
        elif feature == "saturation":
            hsv[1] = value["saturation"]
        await getattr(light, action)(tuple(hsv))
    except Exception as e:
        raise ValueError(f"Error handling HSV for device {target.host}: {e}")

@app.route('/discover', methods=['POST'])
async def discover_route():
    try:
        auth = request.authorization
        username = auth.username if auth else None
        password = auth.password if auth else None
        data = await request.get_json()
        additional_broadcasts = data.get('additionalBroadcasts', [])
        manual_devices = data.get('manualDevices', [])
        devices_info = await discover_devices(username, password, additional_broadcasts, manual_devices)
        return jsonify(devices_info)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/getSysInfo', methods=['POST'])
async def get_sys_info_route():
    try:
        data = await request.get_json()
        device_config = data['device_config']
        sys_info = await get_sys_info(device_config)
        return jsonify(sys_info)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/controlDevice', methods=['POST'])
async def control_device_route():
    try:
        data = await request.get_json()
        device_config = data['device_config']
        feature = data['feature']
        action = data['action']
        value = data.get('value')
        child_num = data.get('child_num')
        result = await control_device(device_config, feature, action, value, child_num)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
async def health_check():
    return jsonify({"status": "healthy"}), 200

if __name__ == '__main__':
    port = int(sys.argv[1])
    uvicorn.run(app, host="0.0.0.0", port=port, loop="asyncio")