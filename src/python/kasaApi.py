import asyncio, eventlet, eventlet.wsgi, json, os, requests, sys, traceback
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
    creds = Credentials(username, password) if username and password else None
    
    def on_unsupported(ip):
        app.logger.warning(f"Unsupported device found: {ip}")

    for broadcast in broadcasts:
        try:
            app.logger.debug(f"Starting discovery on broadcast: {broadcast}")
            if creds is not None:
                app.logger.debug(f"Using credentials for discovery on broadcast: {broadcast}")
                try:
                    discovered_devices = await Discover.discover(
                        target=broadcast,
                        credentials=creds,
                        on_unsupported=lambda device: on_unsupported(device.host)
                    )
                except Exception as e:
                    app.logger.error(f"Error during discovery with credentials on broadcast {broadcast}: {str(e)}", exc_info=True)
                    app.logger.debug(f"Exception details: {traceback.format_exc()}")
                    continue
            else:
                app.logger.debug(f"Discovering without credentials on broadcast: {broadcast}")
                try:
                    discovered_devices = await Discover.discover(
                        target=broadcast,
                        on_unsupported=lambda device: on_unsupported(device.host)
                    )
                except Exception as e:
                    app.logger.error(f"Error during discovery without credentials on broadcast {broadcast}: {str(e)}", exc_info=True)
                    app.logger.debug(f"Exception details: {traceback.format_exc()}")
                    continue

            for ip, dev in discovered_devices.items():
                app.logger.debug(f"Processing device {ip}")
                device_type = getattr(dev, 'device_type', None)
                if device_type:
                    devices[ip] = dev
                    app.logger.debug(f"Added device {ip} with device type {dev.device_type} from broadcast {broadcast} to devices list")
                else:
                    app.logger.debug(f"Device {ip} from broadcast {broadcast} does not have a device_type and was not added")
            app.logger.debug(f"Discovered {len(discovered_devices)} devices on broadcast {broadcast}")
        except Exception as e:
            app.logger.error(f"Error processing broadcast {broadcast}: {str(e)}", exc_info=True)
            app.logger.debug(f"Exception details: {traceback.format_exc()}")

    if manual_devices:
        for host in manual_devices:
            if host in devices:
                app.logger.debug(f"Manual device {host} already exists in devices, skipping.")
                continue
            try:
                if creds is not None:
                    app.logger.debug(f"Discovering manual device with credentials: {host}")
                    discovered_device = await Discover.discover_single(host=host, credentials=creds)
                else:
                    app.logger.debug(f"Discovering manual device without credentials: {host}")
                    discovered_device = await Discover.discover_single(host=host)
                if discovered_device:
                    device_type = getattr(dev, 'device_type', None)
                    if device_type:
                        devices[host] = discovered_device
                        app.logger.debug(f"Discovered manual device: {host} with device type {dev.device_type}")
                    else:
                        app.logger.warning(f"Manual device {host} is missing device_type and was not added")
                else:
                    app.logger.warning(f"Manual device {host} not found and was not added")
            except UnsupportedDeviceException as e:
                app.logger.warning(f"Unsupported device found during manual discovery: {host} - {str(e)}")
            except Exception as e:
                app.logger.error(f"Error discovering manual device {host}: {str(e)}")

    all_device_info = {}
    tasks = []

    for ip, dev in devices.items():
        try:
            dev_type = dev.sys_info.get("mic_type") or dev.sys_info.get("type")
            if hasattr(dev, 'device_type'):
                if dev_type and dev_type not in UNSUPPORTED_TYPES:
                    tasks.append(update_device_info(ip, dev))
                    app.logger.debug(f"Device {ip} with type {dev_type} added to update tasks")
                else:
                    app.logger.debug(f"Device {ip} with type {dev_type} is unsupported and was not added to update tasks")
            else:
                app.logger.debug(f"Device {ip} does not have a device_type and was not added to update tasks")
        except KeyError:
            app.logger.debug(f"Device {ip} has missing keys in sys_info and was not added to update tasks")
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
    username = f'{auth.username}' if auth else None
    password = f'{auth.password}' if auth else None
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