import asyncio, eventlet, eventlet.wsgi, math, os, requests, sys
from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from kasa import Credentials, Discover, Device, Module, UnsupportedDeviceError
from loguru import logger

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

logging_server_url = os.getenv('LOGGING_SERVER_URL')

class RemoteLogger:
    def __init__(self, url):
        self.url = url

    def write(self, message):
        if message.strip():
            requests.post(self.url, json={"level": "debug", "message": message.strip()})

logger.add(RemoteLogger(logging_server_url), level="DEBUG")

app.logger = logger

UNSUPPORTED_TYPES = {
    'SMART.IPCAMERA',
    'SMART.KASAHUB',
    'SMART.TAPOHUB'
}

def serialize_child(child: Device):
    return {
        "alias": child.alias,
        **({"brightness": getattr(child.modules[Module.Light], "brightness")} if child.modules[Module.Light].is_dimmable else {}),
        **({"color_temp": getattr(child.modules[Module.Light], "color_temp")} if child.modules[Module.Light].is_variable_color_temp else {}),
        **({"hsv": {
            "hue": getattr(child.modules[Module.Light], "hsv")[0],
            "saturation": getattr(child.modules[Module.Light], "hsv")[1]
        }} if child.modules[Module.Light].is_color else {}),
        "id": child.device_id.split("_", 1)[1],
        "state": child.features["state"].value
    }

def custom_sysinfo_config_serializer(device: Device):
    app.logger.debug(f"Serializing device: {device.host}")

    child_num = device.children.count if device.children else 0

    sys_info = {
        "alias": device.alias if device.alias else f'{device.device_type}_{device.host}',
        "child_num": child_num,
        "device_id": device.sys_info["deviceId"] or device.sys_info["device_id"],
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
            "state": device.features["state"].value,
            **({"brightness": getattr(device.modules[Module.Light], "brightness")} if device.modules[Module.Light].is_dimmable else {}),
            **({"color_temp": getattr(device.modules[Module.Light], "color_temp")} if device.modules[Module.Light].is_variable_color_temp else {}),
            **({"hsv": {
                "hue": getattr(device.modules[Module.Light], "hsv")[0],
                "saturation": getattr(device.modules[Module.Light], "hsv")[1]
            }} if device.modules[Module.Light].is_color else {})
        })

    device_config = {
        "host": device.config.host,
        "timeout": device.config.timeout,
        **({"credentials": {
            "username": device.config.credentials.username,
            "password": device.config.credentials.password
        }} if device.config.credentials else {}),
        "connection_type": {
            "device_family": device.config.connection_type.device_family.value,
            "encryption_type": device.config.connection_type.encryption_type.value,
            "https": device.config.connection_type.https
        },
        "uses_http": device.config.uses_http
    }

    return {
        "sys_info": sys_info,
        "device_config": device_config
    }

def custom_discovery_feature_serializer(device: Device):
    app.logger.debug(f"Serializing device for discovery: {device.host}")
    disc_info = {
        "model": device._discovery_info["device_model"] or device.sys_info["model"]
    }

    app.logger.debug(f"Serializing device features: {device.host}")
    feature_info = {
        **({"brightness": device.modules[Module.Light].is_dimmable} if Module.Light in device.modules else {}),
        **({"color_temp": device.modules[Module.Light].is_variable_color_temp} if Module.Light in device.modules else {}),
        **({"hsv": device.modules[Module.Light].is_color} if Module.Light in device.modules else {})
    }

    return {
        "disc_info": disc_info,
        "feature_info": feature_info
    }

async def discover_devices(username=None, password=None, additional_broadcasts=None, manual_devices=None):
    app.logger.debug("Starting device discovery")
    devices = {}
    broadcasts = ["255.255.255.255"] + (additional_broadcasts or [])
    creds = Credentials(username, password) if username and password else None

    async def on_discovered(device: Device):
        try:
            await device.update()
            app.logger.debug(f"Discovered device  has been updated: {device.host}")
        except UnsupportedDeviceError as e:
            app.logger.warning(f"Unsupported device found during discovery: {device.host} - {str(e)}")
        except Exception as e:
            app.logger.error(f"Error updating device during discovery: {device.host} - {str(e)}")

    async def discover_on_broadcast(broadcast):
        try:
            app.logger.debug(f"Starting discovery on broadcast: {broadcast}")
            discovered_devices = await Discover.discover(target=broadcast, credentials=creds, on_discovered=on_discovered)
            for ip, dev in discovered_devices.items():
                if ip not in devices:
                    devices[ip] = dev
                    app.logger.debug(f"Added device {ip} from broadcast {broadcast} to devices list")
            app.logger.debug(f"Discovered {len(discovered_devices)} devices on broadcast {broadcast}")
        except Exception as e:
            app.logger.error(f"Error processing broadcast {broadcast}: {str(e)}", exc_info=True)

    async def discover_manual_device(host):
        if host in devices:
            app.logger.debug(f"Device {host} already exists in devices list, skipping.")
            return
        try:
            app.logger.debug(f"Starting discovery for device: {host}")
            discovered_device = await Discover.discover_single(host=host, credentials=creds)
            await on_discovered(discovered_device)
            devices[host] = discovered_device
            app.logger.debug(f"Discovered device: {host}")
        except UnsupportedDeviceError as e:
            app.logger.warning(f"Unsupported device found during discovery: {host} - {str(e)}")
        except Exception as e:
            app.logger.error(f"Error discovering device {host}: {str(e)}", exc_info=True)

    await asyncio.gather(*(discover_on_broadcast(broadcast) for broadcast in broadcasts))
    await asyncio.gather(*(discover_manual_device(host) for host in manual_devices))

    all_device_info = {}
    tasks = []

    for ip, dev in devices.items():
        dev: Device
        try:
            components = await dev._raw_query("component_nego")
            component_list = components.get("component_nego", {}).get("component_list", [])
            homekit_component = next((item for item in component_list if item.get("id") == "homekit"), None)
            if homekit_component:
                app.logger.debug(f"Native HomeKit Support found for device {ip} and was not added to update tasks")
                continue
        except Exception:
            app.logger.debug(f"Native HomeKit Support not found for device {ip}")

        try:
            dev_type = dev.sys_info.get("mic_type") or dev.sys_info.get("type")
            if dev_type and dev_type not in UNSUPPORTED_TYPES:
                tasks.append(create_device_info(ip, dev))
                app.logger.debug(f"Device {ip} added to update tasks")
            else:
                app.logger.debug(f"Device {ip} is unsupported and was not added to update tasks")
        except Exception as e:
            app.logger.error(f"Error adding device {ip} to update tasks: {str(e)}")

    try:
        results = await asyncio.gather(*tasks)
    except Exception as e:
        app.logger.error(f"Error updating device info: {str(e)}")
        return {}

    for ip, info in results:
        all_device_info[ip] = info

    app.logger.debug(f"Device discovery completed with {len(all_device_info)} devices found")
    return all_device_info

async def create_device_info(ip, dev: Device):
    created_device_info = {}
    app.logger.debug(f"Creating device info for {ip}")
    try:
        device_info = custom_sysinfo_config_serializer(dev)
        sys_info = device_info["sys_info"]
        device_config = device_info["device_config"]
        device_info = custom_discovery_feature_serializer(dev)
        disc_info = device_info["disc_info"]
        feature_info = device_info["feature_info"]
        created_device_info[ip] = {
            "sys_info": sys_info,
            "disc_info": disc_info,
            "feature_info": feature_info,
            "device_config": device_config
        }
        app.logger.debug(f"Created device info for {ip}")
        return ip, created_device_info[ip]
    except Exception as e:
        app.logger.error(f"Error creating device info for {ip}: {str(e)}")
        return ip, {}

async def get_sys_info(device_config):
    app.logger.debug(f"Getting sys info for device: {device_config['host']}")
    dev = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        if not dev.alias:
            app.logger.warning(f"Alias not found for device {dev.host}. Reconnecting and updating...")
            await dev.disconnect()
            dev = await Device.connect(config=Device.Config.from_dict(device_config))
        device = custom_sysinfo_config_serializer(dev)
        sys_info = device["sys_info"]
        return {"sys_info": sys_info}
    except Exception as e:
        app.logger.error(f"Error getting sys info: {str(e)}")
        return {}
    finally:
        await dev.disconnect()

async def control_device(device_config, feature, action, value, child_num=None):
    app.logger.debug(f"Controlling device: {device_config['host']}, feature: {feature}, action: {action}, child_num: {child_num if child_num is not None else 'N/A'}")

    dev = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        target = dev.children[child_num] if child_num is not None else dev

        if feature == "state":
            await getattr(target, action)()
        elif feature == "brightness":
            await handle_brightness(target, action, value)
        elif feature == "color_temp":
            await handle_color_temp(target, action, value)
        elif feature in ["hue", "saturation"]:
            await handle_hsv(target, action, feature, value)
        else:
            raise Exception(f"Unsupported feature: {feature}")

        app.logger.debug(f"Controlled device {device_config['host']} with feature: {feature}, action: {action}, child_num: {child_num if child_num is not None else 'N/A'}")
        return {"status": "success"}
    except Exception as e:
        app.logger.error(f"Error controlling device {device_config['host']}: {str(e)}")
        return {"status": "error", "message": str(e)}
    finally:
        await dev.disconnect()

async def handle_brightness(target: Device, action, value):
    if value == 0:
        await target.turn_off()
    elif value > 0 and value < 100:
        light = target.modules[Module.Light]
        await getattr(light, action)(value)
    else:
        await target.turn_on()

async def handle_color_temp(target: Device, action, value):
    light = target.modules[Module.Light]
    range = light.valid_temperature_range
    if value < range[0]:
        value = range[0]
    elif value > range[1]:
        value = range[1]
    await getattr(light, action)(value)

async def handle_hsv(target: Device, action, feature, value):
    light = target.modules[Module.Light]
    hsv_value = {feature: value[feature]}
    await getattr(light, action)(hsv_value)

def run_async(func, *args):
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(func(*args))

@app.route('/discover', methods=['POST'])
def discover():
    try:
        auth = request.authorization
        username = f'{auth.username}' if auth else None
        password = f'{auth.password}' if auth else None
        additional_broadcasts = request.json.get('additionalBroadcasts', [])
        manual_devices = request.json.get('manualDevices', [])
        app.logger.debug(f"Starting device discovery with additionalBroadcasts: {additional_broadcasts} and manualDevices: {manual_devices}")
        devices_info = run_async(discover_devices, username, password, additional_broadcasts, manual_devices)
        app.logger.debug(f"Device discovery completed with {len(devices_info)} devices found")
        return jsonify(devices_info)
    except Exception as e:
        app.logger.error(f"An error occurred during device discovery: {str(e)}", exc_info=True)
        return jsonify({"error": str(e)}), 500

@app.route('/getSysInfo', methods=['POST'])
def get_sys_info_route():
    data = request.json
    device_config = data['device_config']
    credentials = device_config.get('credentials')
    device_config.update({'credentials': Credentials(username=credentials['username'], password=credentials['password'])} if credentials else {})
    app.logger.debug(f"Getting system info for device: {device_config['host']}")
    sys_info = run_async(get_sys_info, device_config)
    return jsonify(sys_info)

@app.route('/controlDevice', methods=['POST'])
def control_device_route():
    data = request.json
    device_config = data['device_config']
    credentials = device_config.get('credentials')
    device_config.update({'credentials': Credentials(username=credentials['username'], password=credentials['password'])} if credentials else {})
    feature = data['feature']
    action = data['action']
    value = data['value']
    child_num = data.get('child_num')
    app.logger.debug(f"Controlling device: {device_config['host']}, action: {action}, child_num: {child_num}")
    result = run_async(control_device, device_config, feature, action, value, child_num)
    return jsonify(result)

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({"status": "healthy"}), 200

if __name__ == '__main__':
    port = int(sys.argv[1])
    app.logger.info(f"Starting server on port {port}")
    eventlet.wsgi.server(eventlet.listen(('127.0.0.1', port)), app)