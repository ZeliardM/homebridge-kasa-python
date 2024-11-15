import asyncio, eventlet, eventlet.wsgi, json, os, requests, sys
from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from kasa import Discover, Device
from loguru import logger

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# Configure loguru to send logs to the logging server
logging_server_url = os.getenv('LOGGING_SERVER_URL')

class RemoteLogger:
    def __init__(self, url):
        self.url = url

    def write(self, message):
        if message.strip():
            requests.post(self.url, json={"level": "debug", "message": message.strip()})

logger.add(RemoteLogger(logging_server_url), level="DEBUG")

# Replace app.logger with loguru logger
app.logger = logger

device_cache = {}

UNSUPPORTED_TYPES = {
    'SMART.IPCAMERA',
    'IOT.SMARTBULB',
    'SMART.KASAHUB',
    'SMART.TAPOBULB',
    'SMART.TAPOHUB'
}

def custom_device_serializer(device):
    app.logger.debug(f"Serializing device: {device}")
    def is_serializable(value):
        try:
            json.dumps(value)
            return True
        except TypeError:
            return False

    serialized_data = {}
    for attr in dir(device):
        if not attr.startswith("_") and not callable(getattr(device, attr)) and not asyncio.iscoroutine(getattr(device, attr)):
            value = getattr(device, attr)
            if is_serializable(value):
                serialized_data[attr] = value
    return serialized_data

async def discover_devices(username=None, password=None, additional_broadcasts=None, manual_devices=None):
    app.logger.debug("Starting device discovery")
    devices = {}
    broadcasts = ["255.255.255.255"] + (additional_broadcasts or [])
    
    for broadcast in broadcasts:
        try:
            app.logger.debug(f"Discovering devices on broadcast: {broadcast}")
            discovered_devices = await Discover.discover(target=broadcast, username=username, password=password)
            discovered_devices = {ip: dev for ip, dev in discovered_devices.items() if hasattr(dev, 'device_type')}
            devices.update(discovered_devices)
            app.logger.debug(f"Discovered {len(discovered_devices)} devices on broadcast {broadcast}")
        except Exception as e:
            app.logger.error(f"Error discovering devices on broadcast {broadcast}: {str(e)}")

    if manual_devices:
        for host in manual_devices:
            try:
                app.logger.debug(f"Discovering manual device: {host}")
                discovered_device = await Discover.discover_single(host=host, username=username, password=password)
                if discovered_device and hasattr(discovered_device, 'device_type'):
                    devices[host] = discovered_device
                    app.logger.debug(f"Discovered manual device: {host}")
                else:
                    app.logger.warning(f"Manual device not found or missing device_type: {host}")
            except Exception as e:
                app.logger.error(f"Error discovering manual device {host}: {str(e)}")

    all_device_info = {}
    tasks = []

    for ip, dev in devices.items():
        try:
            dev_type = dev.sys_info.get("mic_type") or dev.sys_info.get("type")
            if hasattr(dev, 'device_type') and (dev_type and dev_type not in UNSUPPORTED_TYPES):
                tasks.append(update_device_info(ip, dev))
        except KeyError:
            continue

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
        await dev.update()
        device_info = custom_device_serializer(dev)
        device_config = dev.config.to_dict()
        device_cache[ip] = {
            "device_info": device_info,
            "device_config": device_config
        }
        app.logger.debug(f"Updated device info for {ip}")
        return ip, device_cache[ip]
    except Exception as e:
        app.logger.error(f"Error updating device info for {ip}: {str(e)}")
        return ip, {}

async def get_device_info(device_config):
    app.logger.debug(f"Getting device info for config: {device_config}")
    dev = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        await dev.update()
        if not dev.alias:
            app.logger.warning(f"Alias not found for device {dev.host}. Reconnecting and updating...")
            await dev.disconnect()
            dev = await Device.connect(config=Device.Config.from_dict(device_config))
            await dev.update()
        device_info = custom_device_serializer(dev)
        return {"device_info": device_info}
    finally:
        await dev.disconnect()

async def control_device(device_config, action, child_num=None):
    if child_num is not None:
        app.logger.debug(f"Controlling device with config: {device_config}, action: {action}, child_num: {child_num}")
    else:
        app.logger.debug(f"Controlling device with config: {device_config}, action: {action}")

    kasa_device = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        if child_num is not None:
            child = kasa_device.children[child_num]
            await getattr(child, action)()
        else:
            await getattr(kasa_device, action)()
        app.logger.debug(f"Controlled device with action: {action}")
        return {"status": "success", f"is_{action.split('_')[1]}": True}
    except Exception as e:
        app.logger.error(f"Error controlling device: {str(e)}")
        return {"status": "error", "message": str(e)}
    finally:
        await kasa_device.disconnect()

def run_async(func, *args):
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(func(*args))

@app.route('/discover', methods=['POST'])
def discover():
    auth = request.authorization
    username = auth.username if auth else None
    password = auth.password if auth else None
    additional_broadcasts = request.json.get('additionalBroadcasts', [])
    manual_devices = request.json.get('manualDevices', [])
    app.logger.debug(f"Starting device discovery with additionalBroadcasts: {additional_broadcasts} and manualDevices: {manual_devices}")
    devices_info = run_async(discover_devices, username, password, additional_broadcasts, manual_devices)
    app.logger.debug(f"Device discovery completed with {len(devices_info)} devices found")
    return jsonify(devices_info)

@app.route('/getSysInfo', methods=['POST'])
def get_sys_info_route():
    data = request.json
    device_config = data['device_config']
    app.logger.debug(f"Getting system info for device config: {device_config}")
    device_info = run_async(get_device_info, device_config)
    return jsonify(device_info)

@app.route('/controlDevice', methods=['POST'])
def control_device_route():
    data = request.json
    device_config = data['device_config']
    action = data['action']
    child_num = data.get('child_num')
    app.logger.debug(f"Controlling device with config: {device_config}, action: {action}, child_num: {child_num}")
    result = run_async(control_device, device_config, action, child_num)
    return jsonify(result)

if __name__ == '__main__':
    port = int(sys.argv[1])
    app.logger.info(f"Starting server on port {port}")
    eventlet.wsgi.server(eventlet.listen(('127.0.0.1', port)), app)