import asyncio
import json
import os
import re
import sys

from kasa import (
    AuthenticationError,
    Credentials,
    Device,
    DeviceConfig,
    DeviceType,
    Discover,
    Module,
    UnsupportedDeviceError,
)
from quart import jsonify, request, Response, Quart
from typing import Any

app = Quart(__name__)

hide_homekit_matter = os.getenv("HIDE_HOMEKIT_MATTER", "false").lower() == "true"
device_cache: dict[str, Device] = {}
device_lock_cache: dict[str, asyncio.Lock] = {}
device_config_cache: dict[str, dict] = {}

device_queue: asyncio.Queue = asyncio.Queue()

UNSUPPORTED_TYPES = {
    DeviceType.Camera.value,
    DeviceType.Sensor.value,
    DeviceType.Hub.value,
    DeviceType.Fan.value,
    DeviceType.Thermostat.value,
    DeviceType.Vacuum.value,
    DeviceType.Chime.value,
    DeviceType.Doorbell.value,
    DeviceType.Unknown.value,
}

def kelvin_to_mired(kelvin: int) -> int:
    if not kelvin or kelvin <= 0:
        return 140
    return max(140, min(round(1_000_000 / kelvin), 500))

def mired_to_kelvin(mired: int) -> int:
    if not mired or mired <= 0:
        return 2500
    return max(2500, min(round(1_000_000 / mired), 6500))

def _percent_to_level(percent: int) -> int:
    mapping = {0: 0, 25: 1, 50: 2, 75: 3, 100: 4}
    return mapping[percent]

def _level_to_percent(level: int) -> int:
    mapping = {0: 0, 1: 25, 2: 50, 3: 75, 4: 100}
    return mapping[level]

def log(message: str, level: str = "INFO", host: str | None = None, alias: str | None = None):
    context = []
    if host:
        context.append(f"host={host}")
    if alias:
        context.append(f"alias={alias}")
    context_str = f" ({', '.join(context)})" if context else ""
    print(f"[Kasa API] {level}: {message}{context_str}", file=sys.stdout if level != "ERROR" else sys.stderr)

def _extract_child_suffix_index(device_id: str) -> int:
    base = device_id.split('_', 1)[1] if '_' in device_id else device_id
    m = re.search(r'(\d{1,2})$', base)
    return int(m.group(1)) if m else 0

def serialize_child(child: Device) -> dict[str, Any]:
    log("Serializing child device", alias=child.alias)
    child_info = {
        "alias": child.alias,
        "id": child.device_id.split('_', 1)[1] if '_' in child.device_id else child.device_id,
        "state": child.features["state"].value,
    }
    light_module = child.modules.get(Module.Light)
    fan_module = child.modules.get(Module.Fan)
    energy_module = child.modules.get(Module.Energy)
    if light_module:
        child_info.update(get_light_info(child))
    if fan_module:
        level = getattr(fan_module, "fan_speed_level")
        percent = _level_to_percent(level)
        child_info.update({
            "fan_speed_level": percent,
        })
    if energy_module:
        child_info.update(get_energy_info(child))
    return child_info

def get_light_info(device: Device) -> dict[str, Any]:
    log("Getting light info for device", alias=device.alias)
    light_module = device.modules.get(Module.Light)
    light_info: dict[str, Any] = {}
    if light_module.has_feature("brightness"):
        light_info["brightness"] = light_module.brightness
    if light_module.has_feature("color_temp"):
        kelvin = light_module.color_temp
        mired = kelvin_to_mired(kelvin) if kelvin and kelvin > 0 else 140
        light_info["color_temp"] = mired
    if light_module.has_feature("hsv"):
        hue, saturation, _ = light_module.hsv
        light_info["hsv"] = {"hue": hue, "saturation": saturation}
    return light_info

def get_energy_info(device: Device) -> dict[str, Any]:
    log("Getting energy info for device", alias=device.alias)
    energy_module = device.modules.get(Module.Energy)
    energy_fields = (
        ("current", "current"),
        ("voltage", "voltage"),
        ("power", "current_consumption"),
        ("total", "consumption_total"),
        ("today", "consumption_today"),
        ("month", "consumption_this_month"),
    )
    energy_dict = {key: getattr(energy_module, attr) for key, attr in energy_fields}
    return {"energy": energy_dict}

def custom_serializer(device: Device) -> dict[str, Any]:
    log("Serializing device", host=device.host, alias=device.alias)
    child_num = len(device.children) if device.children else 0
    sys_info: dict[str, Any] = {
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
    light_module = device.modules.get(Module.Light)
    fan_module = device.modules.get(Module.Fan)
    energy_module = device.modules.get(Module.Energy)
    if child_num > 0:
        sorted_children = sorted(device.children, key=lambda c: _extract_child_suffix_index(c.device_id))
        sys_info["children"] = [serialize_child(child) for child in sorted_children]
    else:
        sys_info.update({"state": device.features["state"].value})
        if light_module:
            sys_info.update(get_light_info(device))
        if fan_module:
            level = getattr(fan_module, "fan_speed_level")
            percent = _level_to_percent(level)
            sys_info.update({
                "fan_speed_level": percent,
            })
        if energy_module:
            sys_info.update(get_energy_info(device))
    feature_info = {
        "brightness": False,
        "color_temp": False,
        "energy": False,
        "fan": False,
        "hsv": False,
    }
    if light_module:
        feature_info.update({
            "brightness": light_module.has_feature("brightness"),
            "color_temp": light_module.has_feature("color_temp"),
            "hsv": light_module.has_feature("hsv"),
        })
    if fan_module:
        feature_info.update({"fan": True})
    if energy_module:
        feature_info.update({"energy": True})
    return {"sys_info": sys_info, "feature_info": feature_info}

async def discover_devices(
    username: str | None = None,
    password: str | None = None,
    additional_broadcasts: list[str] | None = None,
    manual_devices: list[str] | None = None,
    exclude_mac_addresses: list[str] | None = None,
    include_mac_addresses: list[str] | None = None,
) -> None:
    broadcasts = ["255.255.255.255"] + (additional_broadcasts or [])
    credentials = Credentials(username, password) if username and password else None

    if device_cache:
        await close_all_connections()
        log("All existing device connections closed.")

    async def on_discovered(device: Device):
        log("Discovered device", host=device.host, alias=device.alias)
        try:
            await device.update()
            result = await process_device(device)
            if result is not None:
                await device_queue.put(result)
                await safe_disconnect(device)
        except (UnsupportedDeviceError, AuthenticationError) as e:
            log(f"{e.__class__.__name__}", level="ERROR", host=device.host, alias=device.alias)
            await safe_disconnect(device)
        except Exception as e:
            log(f"Device discovery: {e}", level="ERROR", host=device.host, alias=device.alias)
            await safe_disconnect(device)

    async def process_device(device: Device) -> dict[str, Any] | None:
        log("Processing device", host=device.host, alias=device.alias)
        if include_mac_addresses and device.mac not in include_mac_addresses:
            log("Excluding device due to MAC address inclusion", host=device.host, alias=device.alias)
            await safe_disconnect(device)
            return None
        if exclude_mac_addresses and device.mac in exclude_mac_addresses:
            log("Excluding device due to MAC address exclusion", host=device.host, alias=device.alias)
            await safe_disconnect(device)
            return None
        try:
            if hide_homekit_matter:
                homekit_component = device.modules.get(Module.HomeKit)
                matter_component = device.modules.get(Module.Matter)
                if homekit_component or matter_component:
                    if homekit_component:
                        log("Skipping device due to Native HomeKit support", host=device.host, alias=device.alias)
                    if matter_component:
                        log("Skipping device due to Native Matter support", host=device.host, alias=device.alias)
                    await safe_disconnect(device)
                    return None
        except Exception as e:
            log(f"Checking HomeKit and Matter modules: {e}", level="ERROR", host=device.host, alias=device.alias)
            await safe_disconnect(device)
            return None
        device_type = device.device_type.value
        if device_type and device_type not in UNSUPPORTED_TYPES:
            if device.host not in device_cache:
                device_cache[device.host] = device
            if device.host not in device_lock_cache:
                device_lock_cache[device.host] = asyncio.Lock()
            device_info = await create_device_info(device)
            if isinstance(device_info, Exception):
                log(f"Creating device info: {device_info}", level="ERROR", host=device.host, alias=device.alias)
                return await handle_device_error(device.host)
            return device_info
        else:
            log("Skipping unsupported device", host=device.host, alias=device.alias)
            await safe_disconnect(device)
            return None

    async def discover_on_broadcast(broadcast: str):
        log("Discovering on broadcast", host=broadcast)
        try:
            await Discover.discover(
                target=broadcast, credentials=credentials, on_discovered=on_discovered
            )
        except Exception as e:
            log(f"Discovering on broadcast: {e}", level="ERROR", host=broadcast)

    async def discover_manual_device(host: str):
        if host in device_config_cache:
            return
        log("Discovering manual device", host=host)
        device = None
        try:
            device = await Discover.discover_single(host=host, credentials=credentials)
            await on_discovered(device)
        except Exception as e:
            log(f"Discovering manual device: {e}", level="ERROR", host=host)
            if device:
                await safe_disconnect(device)

    discover_tasks = [discover_on_broadcast(bc) for bc in broadcasts]
    manual_discover_tasks = [discover_manual_device(host) for host in (manual_devices or [])]
    await asyncio.gather(*discover_tasks, *manual_discover_tasks, return_exceptions=True)
    await device_queue.put({"status": "discovery_complete"})

async def close_all_connections():
    log("Closing all existing device connections...")
    if device_cache:
        disconnect_tasks = [device.disconnect() for device in device_cache.values()]
        await asyncio.gather(*disconnect_tasks, return_exceptions=True)
        device_cache.clear()

async def create_device_info(device: Device) -> dict[str, Any]:
    log("Creating device info", host=device.host, alias=device.alias)
    try:
        device_info = custom_serializer(device)
        device_config_cache[device.host] = device.config.to_dict()
        all_device_info = {
            "sys_info": device_info["sys_info"],
            "feature_info": device_info["feature_info"],
        }
        return all_device_info
    except Exception as e:
        log(f"Creating device info: {e}", level="ERROR", host=device.host, alias=device.alias)
        return {"error": str(e)}

async def get_sys_info(host: str) -> dict[str, Any]:
    log("Getting sys_info", host=host)
    try:
        device_config_dict = device_config_cache.get(host)
        device_config = DeviceConfig.from_dict(device_config_dict)
        device_lock = device_lock_cache.get(host, asyncio.Lock())
        async with device_lock:
            device = await get_or_connect_device(host, device_config)
            await device.update()
            device_info = custom_serializer(device)
            return {"sys_info": device_info["sys_info"]}
    except Exception as e:
        return await handle_device_error(host, e)

async def get_or_connect_device(host: str, device_config: DeviceConfig) -> Device:
    try:
        device = device_cache.get(host)
        if not device:
            log("Device not in cache, connecting to device", host=host)
            device = await Device.connect(config=device_config)
            device_cache[host] = device
        return device
    except Exception as e:
        log(f"Connect to device: {e}", level="ERROR", host=host)
        try:
            await safe_disconnect(device)
        except Exception:
            pass
        raise

async def control_device(
    host: str,
    feature: str,
    action: str,
    value: Any,
    child_num: int | None = None,
) -> dict[str, Any]:
    log("Controlling device", host=host)
    try:
        device_config_dict = device_config_cache.get(host)
        device_config = DeviceConfig.from_dict(device_config_dict)
        device_lock = device_lock_cache.get(host, asyncio.Lock())
        async with device_lock:
            device = await get_or_connect_device(host, device_config)
            return await perform_device_action(device, feature, action, value, child_num)
    except Exception as e:
        return await handle_device_error(host, e)

async def perform_device_action(
    device: Device,
    feature: str,
    action: str,
    value: Any,
    child_num: int | None = None,
) -> dict[str, Any]:
    try:
        if child_num is not None and device.children:
            sorted_children = sorted(device.children, key=lambda c: _extract_child_suffix_index(c.device_id))
            target = sorted_children[child_num]
        else:
            target = device
        log(f"Performing action={action} on feature={feature}", alias=target.alias)
        light = target.modules.get(Module.Light)
        fan = target.modules.get(Module.Fan)
        if feature == "state":
            await getattr(target, action)()
        elif feature == "brightness" and light and light.has_feature("brightness"):
            await handle_brightness(target, action, value)
        elif feature == "color_temp" and light and light.has_feature("color_temp"):
            await handle_color_temp(target, action, value)
        elif feature == "fan_speed_level" and fan and fan.has_feature("fan_speed_level"):
            await handle_fan_speed_level(target, action, value)
        elif feature == 'hsv' and light and light.has_feature("hsv"):
            await handle_hsv(target, action, feature, value)
        else:
            raise ValueError("Invalid feature or action")
        return {"status": "success"}
    except Exception as e:
        log(f"Error performing action: {e}", level="ERROR", alias=device.alias)
        return {"status": "error", "message": str(e)}

async def handle_brightness(target: Device, action: str, value: int):
    log(f"Handling brightness: action={action}, value={value}", alias=target.alias)
    light = target.modules.get(Module.Light)
    if value == 0:
        await target.turn_off()
        return
    value = max(1, min(value, 100))
    await getattr(light, action)(value)
    if target.is_off:
        await target.turn_on()

async def handle_color_temp(target: Device, action: str, value: int):
    log(f"Handling color temperature: action={action}, value={value}", alias=target.alias)
    light = target.modules.get(Module.Light)
    color_temp = target.modules.get(Module.ColorTemperature)
    mired = max(140, min(value, 500))
    kelvin = mired_to_kelvin(mired)
    if color_temp and hasattr(color_temp, "valid_temperature_range"):
        min_temp, max_temp = color_temp.valid_temperature_range
    else:
        min_temp, max_temp = (2500, 6500)
    kelvin = max(min_temp, min(kelvin, max_temp))
    await getattr(light, action)(kelvin)

async def handle_fan_speed_level(target: Device, action: str, value: int):
    log(f"Handling fan speed level: action={action}, value={value}", alias=target.alias)
    fan = target.modules.get(Module.Fan)
    level = _percent_to_level(value)
    if level == 0:
        await target.turn_off()
        return
    await getattr(fan, action)(level)
    if target.is_off:
        await target.turn_on()

async def handle_hsv(target: Device, action: str, feature: str, value: dict):
    log(f"Handling HSV: action={action}, feature={feature}, value={value}", alias=target.alias)
    light = target.modules.get(Module.Light)
    hsv = light.hsv
    h = value.get("hue", hsv[0])
    s = value.get("saturation", hsv[1])
    v = hsv[2]
    hsv[0] = max(0, min(h, 360))
    hsv[1] = max(0, min(s, 100))
    hsv[2] = max(0, min(v, 100))
    await getattr(light, action)(*hsv)

@app.route('/discover', methods=['POST'])
async def discover_route():
    try:
        username: str = None
        password: str = None
        auth = request.authorization
        if auth:
            username = getattr(auth, "username")
            password = getattr(auth, "password")
        data: dict[str, Any] = await request.get_json()
        additional_broadcasts = data.get('additionalBroadcasts', [])
        manual_devices = data.get('manualDevices', [])
        exclude_mac_addresses = data.get('excludeMacAddresses', [])
        include_mac_addresses = data.get('includeMacAddresses', [])
        asyncio.create_task(discover_devices(
            username, password, additional_broadcasts, manual_devices, exclude_mac_addresses, include_mac_addresses
        ))
        return jsonify({"status": "discovery started"})
    except Exception as e:
        log(f"Discover route: {e}", level="ERROR")
        return jsonify({"error": str(e)}), 500

@app.route('/stream')
async def stream():
    async def event_generator():
        while True:
            try:
                device_data = await device_queue.get()
                log("Sending device data to SSE stream", level="DEBUG")
                yield f"data: {json.dumps(device_data)}\n\n"
            except Exception as e:
                log(f"SSE event generator: {e}", level="ERROR")
    return Response(event_generator(), mimetype="text/event-stream")

@app.route('/getSysInfo', methods=['POST'])
async def get_sys_info_route():
    try:
        data = await request.get_json()
        host = data['host']
        sys_info = await get_sys_info(host)
        return jsonify(sys_info)
    except Exception as e:
        log(f"GetSysInfo route: {e}", level="ERROR")
        return jsonify({"error": str(e)}), 500

@app.route('/controlDevice', methods=['POST'])
async def control_device_route():
    try:
        data: dict[str, Any] = await request.get_json()
        host = data['host']
        feature = data['feature']
        action = data['action']
        value = data.get('value')
        child_num = data.get('child_num')
        result = await control_device(host, feature, action, value, child_num)
        return jsonify(result)
    except Exception as e:
        log(f"ControlDevice route: {e}", level="ERROR")
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
async def health_check():
    return jsonify({"status": "healthy"}), 200

async def safe_disconnect(device: Device | None):
    if device:
        try:
            await device.disconnect()
        except Exception as e:
            log(f"Disconnecting device: {e}", level="ERROR", host=device.host, alias=device.alias)

async def handle_device_error(host: str, error: Exception | None = None) -> dict[str, Any]:
    log(f"Handling device: {error}", level="ERROR", host=host)
    try:
        device_config_dict = device_config_cache.get(host)
        if device_config_dict:
            device_config = DeviceConfig.from_dict(device_config_dict)
            device = await get_or_connect_device(host, device_config)
            await safe_disconnect(device)
        device_cache.pop(host, None)
    except Exception as e:
        log(f"Error handling: {e}", level="ERROR", host=host)
    return {"error": str(error)}

async def disconnect_all_devices(devices: dict[str, Device]):
    for _, device in devices.items():
        await safe_disconnect(device)
        log("Disconnected device", host=device.host, alias=device.alias)

@app.after_serving
async def cleanup():
    log("Cleaning up and disconnecting all devices.")
    await close_all_connections()
    device_lock_cache.clear()
    device_config_cache.clear()