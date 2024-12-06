import asyncio
import os
import sys
import uvicorn
from typing import Any, Dict, List, Optional

from aiohttp import ClientSession
from kasa import Credentials, Device, Discover, Module, UnsupportedDeviceError
from loguru import logger
from quart import Quart, jsonify, request

app = Quart(__name__)

logging_server_url = os.getenv('LOGGING_SERVER_URL')

class RemoteLogger:
    def __init__(self, url: str):
        self.url = url

    async def write(self, message: str):
        if message.strip():
            async with ClientSession() as session:
                await session.post(self.url, json={"level": "debug", "message": message.strip()})

class AsyncLogHandler:
    def __init__(self, logger_instance, url):
        self.logger_instance = logger_instance
        self.remote_logger = RemoteLogger(url)

    async def async_log_writer(self, message: str):
        await self.remote_logger.write(message)

    def __call__(self, message: str):
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(self.async_log_writer(message))
        else:
            asyncio.run(self.async_log_writer(message))

async_log_handler = AsyncLogHandler(logger, logging_server_url)
logger.add(async_log_handler, level="DEBUG")

UNSUPPORTED_TYPES = {
    'SMART.IPCAMERA',
    'SMART.KASAHUB',
    'SMART.TAPOHUB'
}

def get_light_info(light_module: Module) -> Dict[str, Any]:
    light_info = {}
    if light_module.is_dimmable:
        light_info["brightness"] = light_module.brightness
    if light_module.is_variable_color_temp:
        light_info["color_temp"] = light_module.color_temp
    if light_module.is_color:
        hue, saturation, _ = light_module.hsv
        light_info["hsv"] = {"hue": hue, "saturation": saturation}
    return light_info

def serialize_child(child: Device) -> Dict[str, Any]:
    child_info = {
        "alias": child.alias,
        "id": child.device_id.split("_", 1)[1],
        "state": child.features["state"].value
    }
    light_module = child.modules.get(Module.Light)
    if light_module:
        child_info.update(get_light_info(light_module))
    return child_info

def custom_sysinfo_config_serializer(device: Device) -> Dict[str, Any]:
    logger.debug(f"Serializing device: {device.host}")
    child_num = len(device.children) if device.children else 0

    sys_info = {
        "alias": device.alias or f'{device.device_type}_{device.host}',
        "child_num": child_num,
        "device_id": device.sys_info.get("deviceId") or device.sys_info.get("device_id"),
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

def custom_discovery_feature_serializer(device: Device) -> Dict[str, Any]:
    logger.debug(f"Serializing device features: {device.host}")
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

async def discover_devices(
    username: Optional[str] = None,
    password: Optional[str] = None,
    additional_broadcasts: Optional[List[str]] = None,
    manual_devices: Optional[List[str]] = None
) -> Dict[str, Any]:
    logger.debug("Starting device discovery")
    devices = {}
    broadcasts = ["255.255.255.255"] + (additional_broadcasts or [])
    creds = Credentials(username, password) if username and password else None

    async def on_discovered(device: Device):
        try:
            await device.update()
            logger.debug(f"Device updated: {device.host}")
        except UnsupportedDeviceError as e:
            logger.warning(f"Unsupported device during discovery: {device.host} - {str(e)}")
        except Exception as e:
            logger.error(f"Error updating device during discovery: {device.host} - {str(e)}")

    async def discover_on_broadcast(broadcast: str):
        logger.debug(f"Starting discovery on broadcast: {broadcast}")
        try:
            discovered = await Discover.discover(
                target=broadcast,
                credentials=creds,
                on_discovered=on_discovered
            )
            devices.update(discovered)
            logger.debug(f"Discovered {len(discovered)} devices on broadcast {broadcast}")
        except Exception as e:
            logger.error(f"Error during broadcast discovery {broadcast}: {str(e)}", exc_info=True)

    async def discover_manual_device(host: str):
        if host in devices:
            logger.debug(f"Device {host} already discovered.")
            return
        try:
            logger.debug(f"Discovering manual device: {host}")
            device = await Discover.discover_single(host=host, credentials=creds)
            await on_discovered(device)
            devices[host] = device
            logger.debug(f"Discovered manual device: {host}")
        except UnsupportedDeviceError as e:
            logger.warning(f"Unsupported manual device: {host} - {str(e)}")
        except Exception as e:
            logger.error(f"Error discovering manual device {host}: {str(e)}", exc_info=True)

    discover_tasks = [discover_on_broadcast(bc) for bc in broadcasts]
    manual_discover_tasks = [discover_manual_device(host) for host in (manual_devices or [])]
    await asyncio.gather(*discover_tasks, *manual_discover_tasks)

    all_device_info = {}
    update_tasks = []

    dev: Device
    ip: str
    for ip, dev in devices.items():
        try:
            components = await dev._raw_query("component_nego")
            component_list = components.get("component_nego", {}).get("component_list", [])
            homekit_component = next((item for item in component_list if item.get("id") == "homekit"), None)
            if homekit_component:
                logger.debug(f"Native HomeKit support found for device {ip}, skipping.")
                continue
        except Exception:
            logger.debug(f"No native HomeKit support for device {ip}")

        dev_type = dev.sys_info.get("mic_type") or dev.sys_info.get("type")
        if dev_type and dev_type not in UNSUPPORTED_TYPES:
            update_tasks.append(create_device_info(ip, dev))
            logger.debug(f"Device {ip} added to update tasks")
        else:
            logger.debug(f"Device {ip} is unsupported")

    results = await asyncio.gather(*update_tasks, return_exceptions=True)

    for result in results:
        if isinstance(result, Exception):
            logger.error(f"Error in device info creation: {str(result)}")
            continue
        ip, info = result
        all_device_info[ip] = info

    logger.debug(f"Device discovery completed with {len(all_device_info)} devices")
    return all_device_info

async def create_device_info(ip: str, dev: Device):
    logger.debug(f"Creating device info for {ip}")
    try:
        sys_info_data = custom_sysinfo_config_serializer(dev)
        feature_info_data = custom_discovery_feature_serializer(dev)
        device_info = {
            "sys_info": sys_info_data["sys_info"],
            "disc_info": feature_info_data["disc_info"],
            "feature_info": feature_info_data["feature_info"],
            "device_config": sys_info_data["device_config"]
        }
        logger.debug(f"Created device info for {ip}")
        return ip, device_info
    except Exception as e:
        logger.error(f"Error creating device info for {ip}: {str(e)}")
        return ip, {}

async def get_sys_info(device_config: Dict[str, Any]) -> Dict[str, Any]:
    logger.debug(f"Fetching system info for device: {device_config['host']}")
    dev = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        device = custom_sysinfo_config_serializer(dev)
        return {"sys_info": device["sys_info"]}
    except Exception as e:
        logger.error(f"Error getting system info: {str(e)}")
        return {}
    finally:
        await dev.disconnect()

async def control_device(
    device_config: Dict[str, Any],
    feature: str,
    action: str,
    value: Any,
    child_num: Optional[int] = None
) -> Dict[str, Any]:
    logger.debug(f"Controlling device: {device_config['host']}, feature: {feature}, action: {action}, child_num: {child_num}")
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

        logger.debug(f"Device {device_config['host']} controlled successfully")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error controlling device {device_config['host']}: {str(e)}")
        return {"status": "error", "message": str(e)}
    finally:
        await dev.disconnect()

async def handle_brightness(target: Device, action: str, value: int):
    light = target.modules.get(Module.Light)
    if value == 0:
        await target.turn_off()
    elif 0 < value <= 100:
        await getattr(light, action)(value)
    else:
        await target.turn_on()

async def handle_color_temp(target: Device, action: str, value: int):
    light = target.modules.get(Module.Light)
    min_temp, max_temp = light.valid_temperature_range
    value = max(min(value, max_temp), min_temp)
    await getattr(light, action)(value)

async def handle_hsv(target: Device, action: str, feature: str, value: Dict[str, int]):
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
        logger.debug(f"Received discovery request with broadcasts: {additional_broadcasts} and manual devices: {manual_devices}")
        devices_info = await discover_devices(username, password, additional_broadcasts, manual_devices)
        logger.debug(f"Discovery completed with {len(devices_info)} devices found")
        return jsonify(devices_info)
    except Exception as e:
        logger.exception(f"Error during discovery: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/getSysInfo', methods=['POST'])
async def get_sys_info_route():
    try:
        data = await request.get_json()
        device_config = data['device_config']
        credentials = device_config.get('credentials')
        if credentials:
            device_config['credentials'] = Credentials(
                username=credentials['username'],
                password=credentials['password']
            )
        sys_info = await get_sys_info(device_config)
        return jsonify(sys_info)
    except Exception as e:
        logger.exception(f"Error getting system info: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/controlDevice', methods=['POST'])
async def control_device_route():
    try:
        data = await request.get_json()
        device_config = data['device_config']
        credentials = device_config.get('credentials')
        if credentials:
            device_config['credentials'] = Credentials(
                username=credentials['username'],
                password=credentials['password']
            )
        feature = data['feature']
        action = data['action']
        value = data.get('value')
        child_num = data.get('child_num')
        result = await control_device(device_config, feature, action, value, child_num)
        return jsonify(result)
    except Exception as e:
        logger.exception(f"Error controlling device: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
async def health_check():
    return jsonify({"status": "healthy"}), 200

if __name__ == '__main__':
    port = int(sys.argv[1])
    logger.info(f"Starting server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, loop="asyncio")