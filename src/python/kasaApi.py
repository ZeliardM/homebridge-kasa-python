import asyncio, eventlet, eventlet.wsgi, os, requests, sys
from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from kasa import Credentials, Discover, Device, UnsupportedDeviceException
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

device_cache = {}

UNSUPPORTED_TYPES = {
    'SMART.IPCAMERA',
    'IOT.SMARTBULB',
    'SMART.KASAHUB',
    'SMART.TAPOBULB',
    'SMART.TAPOHUB'
}

def custom_device_serializer(device: Device):
    app.logger.debug(f"Serializing device: {device.host}")

    child_num = len(device.children) if device.children else 0

    sys_info = {
        "alias": device.alias,
        "child_num": child_num,
        "device_id": device.sys_info.get("deviceId") or device.sys_info.get("device_id"),
        "device_type": device.config.connection_type.device_family.value,
        "host": device.host,
        "hw_ver": device.hw_info["hw_ver"],
        "is_off": device.is_off,
        "is_on": device.is_on,
        "mac": device.hw_info["mac"],
        "sw_ver": device.sys_info.get("sw_ver") or device.sys_info.get("fw_ver")
    }

    if child_num > 0:
        sys_info["children"] = [
            {
                "id": child.device_id.split("_", 1)[1],
                "state": child.features["state"].value,
                "alias": child.alias
            } for child in device.children
        ]
    else:
        sys_info["state"] = device.features["state"].value

    device_config = {
        "host": device.config.host,
        "timeout": device.config.timeout,
        "connection_type": {
            "device_family": device.config.connection_type.device_family.value,
            "encryption_type": device.config.connection_type.encryption_type.value,
            "https": device.config.connection_type.https
        },
        "uses_http": device.config.uses_http
    }

    if device.config.credentials:
        device_config["credentials"] = {
            "username": device.config.credentials.username,
            "password": device.config.credentials.password
        }

    return {
        "sys_info": sys_info,
        "device_config": device_config
    }

def custom_discovery_serializer(device: Device):
    app.logger.debug(f"Serializing device for discovery: {device.host}")
    disc_info = {
        "model": device._discovery_info.get("model")
    }

    return {
        "disc_info": disc_info
    }

async def discover_devices(username=None, password=None, additional_broadcasts=None, manual_devices=None):
    app.logger.debug("Starting device discovery")
    devices = {}
    broadcasts = ["255.255.255.255"] + (additional_broadcasts or [])
    creds = Credentials(username, password) if username and password else None

    async def on_discovered(device: Device):
        try:
            await device.update()
            app.logger.debug(f"Discovered device: {device.host}")
        except UnsupportedDeviceException as e:
            app.logger.warning(f"Unsupported device found during discovery: {device.host} - {str(e)}")
        except Exception as e:
            app.logger.error(f"Error updating device during discovery: {device.host} - {str(e)}")

    async def discover_on_broadcast(broadcast):
        try:
            app.logger.debug(f"Starting discovery on broadcast: {broadcast}")
            discovered_devices = await Discover.discover(target=broadcast, credentials=creds, on_discovered=on_discovered)
            for ip, dev in discovered_devices.items():
                devices[ip] = dev
                app.logger.debug(f"Added device {ip} from broadcast {broadcast} to devices list")
            app.logger.debug(f"Discovered {len(discovered_devices)} devices on broadcast {broadcast}")
        except Exception as e:
            app.logger.error(f"Error processing broadcast {broadcast}: {str(e)}", exc_info=True)

    async def discover_manual_device(host):
        if host in devices:
            app.logger.debug(f"Manual device {host} already exists in devices, skipping.")
            return
        try:
            app.logger.debug(f"Discovering manual device: {host}")
            discovered_device = await Discover.discover_single(host=host, credentials=creds)
            await discovered_device.update()
            devices[host] = discovered_device
            app.logger.debug(f"Discovered manual device: {host} with device type {discovered_device.device_type}")
        except UnsupportedDeviceException as e:
            app.logger.warning(f"Unsupported device found during manual discovery: {host} - {str(e)}")
        except Exception as e:
            app.logger.error(f"Error discovering manual device {host}: {str(e)}", exc_info=True)

    await asyncio.gather(*(discover_on_broadcast(broadcast) for broadcast in broadcasts))
    await asyncio.gather(*(discover_manual_device(host) for host in manual_devices))

    all_device_info = {}
    tasks = []

    for ip, dev in devices.items():
        dev: Device
        try:
            dev_type = dev.sys_info.get("mic_type") or dev.sys_info.get("type")
            if dev_type and dev_type not in UNSUPPORTED_TYPES:
                tasks.append(update_device_info(ip, dev))
                app.logger.debug(f"Device {ip} with type {dev_type} added to update tasks")
            else:
                app.logger.debug(f"Device {ip} with type {dev_type} is unsupported and was not added to update tasks")
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

async def update_device_info(ip, dev: Device):
    app.logger.debug(f"Updating device info for {ip}")
    try:
        device = custom_device_serializer(dev)
        sys_info = device["sys_info"]
        device_config = device["device_config"]
        device = custom_discovery_serializer(dev)
        disc_info = device["disc_info"]
        device_cache[ip] = {
            "sys_info": sys_info,
            "disc_info": disc_info,
            "device_config": device_config
        }
        app.logger.debug(f"Updated device info for {ip}")
        return ip, device_cache[ip]
    except Exception as e:
        app.logger.error(f"Error updating device info for {ip}: {str(e)}")
        return ip, {}

async def get_sys_info(device_config):
    app.logger.debug(f"Getting sys info for device: {device_config['host']}")
    dev = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        if not dev.alias:
            app.logger.warning(f"Alias not found for device {dev.host}. Reconnecting and updating...")
            await dev.disconnect()
            dev = await Device.connect(config=Device.Config.from_dict(device_config))
        device = custom_device_serializer(dev)
        sys_info = device["sys_info"]
        return {"sys_info": sys_info}
    except Exception as e:
        app.logger.error(f"Error getting sys info: {str(e)}")
        return {}
    finally:
        await dev.disconnect()

async def control_device(device_config, action, child_num=None):
    if child_num is not None:
        app.logger.debug(f"Controlling device: {device_config['host']}, action: {action}, child_num: {child_num}")
    else:
        app.logger.debug(f"Controlling device: {device_config['host']}, action: {action}")

    dev = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        if child_num is not None:
            child = dev.children[child_num]
            await getattr(child, action)()
        else:
            await getattr(dev, action)()
        app.logger.debug(f"Controlled device {device_config['host']} with action: {action}")
        return {"status": "success", f"is_{action.split('_')[1]}": True}
    except Exception as e:
        app.logger.error(f"Error controlling device {device_config['host']}: {str(e)}")
        return {"status": "error", "message": str(e)}
    finally:
        await dev.disconnect()

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
    action = data['action']
    child_num = data.get('child_num')
    app.logger.debug(f"Controlling device: {device_config['host']}, action: {action}, child_num: {child_num}")
    result = run_async(control_device, device_config, action, child_num)
    return jsonify(result)

if __name__ == '__main__':
    port = int(sys.argv[1])
    app.logger.info(f"Starting server on port {port}")
    eventlet.wsgi.server(eventlet.listen(('127.0.0.1', port)), app)