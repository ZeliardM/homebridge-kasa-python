import asyncio, sys
from typing import Any, Dict, List, Optional

from kasa import AuthenticationError, Credentials, Device, DeviceType, Discover, Module, UnsupportedDeviceError
from quart import Quart, jsonify, request

app = Quart(__name__)

UNSUPPORTED_TYPES = {
    DeviceType.Camera.value,
    DeviceType.Sensor.value,
    DeviceType.Hub.value,
    DeviceType.Fan.value,
    DeviceType.Thermostat.value,
    DeviceType.Vacuum.value,
    DeviceType.Unknown.value,
}

device_cache: Dict[str, Device] = {}
device_locks: Dict[str, asyncio.Lock] = {}

def get_light_info(device: Device) -> Dict[str, Any]:
    print(f"Getting light info for device {device.alias}")
    light_module = device.modules.get(Module.Light)
    light_info = {}
    if light_module.has_feature("brightness"):
        light_info["brightness"] = light_module.brightness
    if light_module.has_feature("color_temp"):
        light_info["color_temp"] = light_module.color_temp
    if light_module.has_feature("hsv"):
        hue, saturation, _ = light_module.hsv
        light_info["hsv"] = {"hue": hue, "saturation": saturation}
    return light_info

def serialize_child(child: Device) -> Dict[str, Any]:
    print(f"Serializing child device {child.alias}")
    child_info = {
        "alias": child.alias,
        "id": child.device_id.split("_", 1)[1],
        "state": child.features["state"].value
    }
    light_module = child.modules.get(Module.Light)
    if light_module:
        child_info.update(get_light_info(child))
    return child_info

def custom_sysinfo_config_serializer(device: Device) -> Dict[str, Any]:
    print(f"Serializing sysinfo and config for device {device.alias}")
    child_num = len(device.children) if device.children else 0

    sys_info = {
        "alias": device.alias or f'{device.device_type}_{device.host}',
        "child_num": child_num,
        "device_id": device.device_id if device.mac != device.device_id else device.sys_info.get("deviceId"),
        "device_type": device.device_type.value,
        "host": device.host,
        "hw_ver": device.device_info.hardware_version,
        "mac": device.mac,
        "model": device.model,
        "sw_ver": device.device_info.firmware_version,
    }

    if child_num > 0:
        sys_info["children"] = [serialize_child(child) for child in device.children]
    else:
        sys_info.update({
            "state": device.features["state"].value
        })
        light_module = device.modules.get(Module.Light)
        if light_module:
            sys_info.update(get_light_info(device))

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

def custom_feature_serializer(device: Device) -> Dict[str, Any]:
    print(f"Serializing features for device {device.alias}")
    feature_info = {}
    light_module = device.modules.get(Module.Light)
    if light_module:
        feature_info = {
            "brightness": light_module.has_feature("brightness"),
            "color_temp": light_module.has_feature("color_temp"),
            "hsv": light_module.has_feature("hsv")
        }

    return {
        "feature_info": feature_info
    }

async def discover_devices(
    username: Optional[str] = None,
    password: Optional[str] = None,
    additional_broadcasts: Optional[List[str]] = None,
    manual_devices: Optional[List[str]] = None
) -> Dict[str, Any]:
    devices = {}
    broadcasts = ["255.255.255.255"] + (additional_broadcasts or [])
    creds = Credentials(username, password) if username and password else None

    if device_cache:
        await close_all_connections()
        print("All exisiting device connections closed.")

    async def on_discovered(device: Device):
        print(f"Discovered device: {device.alias}")
        try:
            await device.update()
        except UnsupportedDeviceError:
            print(f"Unsupported device: {device.host}")
            pass
        except AuthenticationError:
            print(f"Authentication error: {device.host}")
            pass
        except Exception as e:
            print(f"Error during discovery: {e}", file=sys.stderr)

    async def discover_on_broadcast(broadcast: str):
        print(f"Discovering on broadcast: {broadcast}")
        try:
            discovered = await Discover.discover(
                target=broadcast,
                credentials=creds,
                on_discovered=on_discovered
            )
            devices.update(discovered)
        except AuthenticationError:
            pass
        except UnsupportedDeviceError:
            pass
        except Exception as e:
            print(f"Error during broadcast discovery: {e}", file=sys.stderr)

    async def discover_manual_device(host: str):
        if host in devices:
            return
        print(f"Discovering manual device: {host}")
        try:
            device = await Discover.discover_single(host=host, credentials=creds)
            await on_discovered(device)
            devices[host] = device
        except AuthenticationError:
            pass
        except UnsupportedDeviceError:
            pass
        except Exception as e:
            print(f"Error during manual device discovery: {e}", file=sys.stderr)

    discover_tasks = [discover_on_broadcast(bc) for bc in broadcasts]
    manual_discover_tasks = [discover_manual_device(host) for host in (manual_devices or [])]
    await asyncio.gather(*discover_tasks, *manual_discover_tasks)

    all_device_info = {}
    update_tasks = []

    ip: str
    dev: Device
    for ip, dev in devices.items():
        try:
            homekit_component = dev.modules.get(Module.HomeKit, None)
            matter_component = dev.modules.get(Module.Matter, None)
            if homekit_component or matter_component:
                print(f"Skipping device {dev.alias} due to Native HomeKit or Matter support")
                dev.disconnect()
                continue
        except Exception as e:
            print(f"Error checking HomeKit and Matter modules: {e}", file=sys.stderr)

        dev_type = dev.device_type.value
        if dev_type and dev_type not in UNSUPPORTED_TYPES:
            if ip not in device_cache:
                device_cache[ip] = dev
            if ip not in device_locks:
                device_locks[ip] = asyncio.Lock()
            update_tasks.append(create_device_info(ip, dev))
        else:
            print(f"Skipping unsupported device: {ip}")
            dev.disconnect()

    results = await asyncio.gather(*update_tasks, return_exceptions=True)

    for result in results:
        if isinstance(result, Exception):
            print(f"Error creating device info: {result}", file=sys.stderr)
            continue
        ip, info = result
        print(f"Device info created for IP: {ip}")
        all_device_info[ip] = info

    return all_device_info

async def close_all_connections():
    print("Closing all existing device connections...")
    if device_cache:
        disconnect_tasks = [dev.disconnect() for dev in device_cache.values()]
        await asyncio.gather(*disconnect_tasks, return_exceptions=True)
        device_cache.clear()
    if device_locks:
        device_locks.clear()

async def create_device_info(ip: str, dev: Device):
    print("Creating device info for IP: ", ip)
    sys_info_data = custom_sysinfo_config_serializer(dev)
    feature_info_data = custom_feature_serializer(dev)
    device_info = {
        "sys_info": sys_info_data["sys_info"],
        "feature_info": feature_info_data["feature_info"],
        "device_config": sys_info_data["device_config"]
    }
    return ip, device_info

async def get_sys_info(device_config: Dict[str, Any]) -> Dict[str, Any]:
    host = device_config["host"]
    print("Getting sys_info for host: ", host)
    lock = device_locks.get(host, asyncio.Lock())
    async with lock:
        dev = device_cache.get(host)
        if not dev:
            print("Device not in cache, connecting to device at host: ", host)
            dev = await Device.connect(config=Device.Config.from_dict(device_config))
            device_cache[host] = dev
        else:
            try:
                print("Updating device at host: ", host)
                await dev.update()
            except Exception as e:
                print(f"Device update failed: {e}, reconnecting...")
                if dev:
                    dev.disconnect()
                device_cache.pop(host, None)
                dev = await Device.connect(config=Device.Config.from_dict(device_config))
                device_cache[host] = dev
        device = custom_sysinfo_config_serializer(dev)
        return {"sys_info": device["sys_info"]}

async def control_device(
    device_config: Dict[str, Any],
    feature: str,
    action: str,
    value: Any,
    child_num: Optional[int] = None
) -> Dict[str, Any]:
    host = device_config["host"]
    print(f"Controlling device at host: {host}")
    lock = device_locks.get(host, asyncio.Lock())
    async with lock:
        dev = device_cache.get(host)
        if not dev:
            print(f"Device not in cache, connecting to device at host: {host}")
            dev = await Device.connect(config=Device.Config.from_dict(device_config))
            device_cache[host] = dev
        try:
            return await perform_device_action(dev, feature, action, value, child_num)
        except Exception as e:
            print(f"Action failed: {e}, reconnecting...")
            if dev:
                dev.disconnect()
            device_cache.pop(host, None)
            dev = await Device.connect(config=Device.Config.from_dict(device_config))
            device_cache[host] = dev
            return await perform_device_action(dev, feature, action, value, child_num)

async def perform_device_action(dev: Device, feature: str, action: str, value: Any, child_num: Optional[int] = None) -> Dict[str, Any]:
    target = dev.children[child_num] if child_num is not None else dev
    light = target.modules.get(Module.Light)

    print(f"Performing action={action} on feature={feature} for device {target.alias}")
    if feature == "state":
        await getattr(target, action)()
    elif feature == "brightness" and light.has_feature("brightness"):
        await handle_brightness(target, action, value)
    elif feature == "color_temp" and light.has_feature("color_temp"):
        await handle_color_temp(target, action, value)
    elif feature in ["hue", "saturation"] and light.has_feature("hsv"):
        await handle_hsv(target, action, feature, value)
    else:
        raise ValueError("Invalid feature or action")
    return {"status": "success"}

async def handle_brightness(target: Device, action: str, value: int):
    print(f"Handling brightness: action={action}, value={value}")
    light = target.modules.get(Module.Light)
    if value == 0:
        await target.turn_off()
    elif 0 < value <= 100:
        await getattr(light, action)(value)
    else:
        await target.turn_on()

async def handle_color_temp(target: Device, action: str, value: int):
    print(f"Handling color temperature: action={action}, value={value}")
    light = target.modules.get(Module.Light)
    min_temp, max_temp = light.valid_temperature_range
    value = max(min(value, max_temp), min_temp)
    await getattr(light, action)(value)

async def handle_hsv(target: Device, action: str, feature: str, value: Dict[str, int]):
    print(f"Handling HSV: action={action}, feature={feature}, value={value}")
    light = target.modules.get(Module.Light)
    hsv = list(light.hsv)
    if feature == "hue":
        hsv[0] = value["hue"]
    elif feature == "saturation":
        hsv[1] = value["saturation"]
    await getattr(light, action)(tuple(hsv))

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
        print(f"Discover route error: {e}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500

@app.route('/getSysInfo', methods=['POST'])
async def get_sys_info_route():
    try:
        data = await request.get_json()
        device_config = data['device_config']
        sys_info = await get_sys_info(device_config)
        return jsonify(sys_info)
    except Exception as e:
        print(f"GetSysInfo route error: {e}", file=sys.stderr)
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
        print(f"ControlDevice route error: {e}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
async def health_check():
    return jsonify({"status": "healthy"}), 200

@app.after_serving
async def cleanup():
    print("Cleaning up and disconnecting all devices.")
    await close_all_connections()