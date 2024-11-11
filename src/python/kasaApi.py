import asyncio, eventlet, eventlet.wsgi, json, sys
from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from kasa import Discover, Device

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

device_cache = {}

UNSUPPORTED_TYPES = {
    'SMART.IPCAMERA',
    'IOT.SMARTBULB',
    'SMART.KASAHUB',
    'SMART.TAPOBULB',
    'SMART.TAPOHUB'
}

def custom_device_serializer(device):
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

async def discover_devices(username=None, password=None, additional_networks=None):
    devices = {}
    if additional_networks:
        additional_networks = [f"{'.'.join(network.split('.')[:-1])}.255" for network in additional_networks]
    networks = ["255.255.255.255"] + (additional_networks or [])
    
    for network in networks:
        try:
            discovered_devices = await Discover.discover(target=network, username=username, password=password)
            devices.update(discovered_devices)
        except Exception as e:
            app.logger.error(f"Error discovering devices on network {network}: {str(e)}")

    all_device_info = {}
    tasks = []

    for ip, dev in devices.items():
        try:
            if hasattr(dev, 'device_type') and dev.sys_info['mic_type'] not in UNSUPPORTED_TYPES:
                tasks.append(update_device_info(ip, dev))
        except KeyError:
            continue

    try:
        results = await asyncio.gather(*tasks)
    except Exception:
        return {}

    for ip, info in results:
        all_device_info[ip] = info

    return all_device_info

async def update_device_info(ip, dev: Device):
    try:
        await dev.update()
        device_info = custom_device_serializer(dev)
        device_config = dev.config.to_dict()
        device_cache[ip] = {
            "device_info": device_info,
            "device_config": device_config
        }
        return ip, device_cache[ip]
    except Exception:
        return ip, {}

async def get_device_info(device_config):
    dev = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        device_info = custom_device_serializer(dev)
        return {"device_info": device_info}
    finally:
        await dev.disconnect()

async def control_device(device_config, action, child_num=None):
    kasa_device = await Device.connect(config=Device.Config.from_dict(device_config))
    try:
        if child_num is not None:
            child = kasa_device.children[child_num]
            await getattr(child, action)()
        else:
            await getattr(kasa_device, action)()
        return {"status": "success", f"is_{action.split('_')[1]}": True}
    except Exception as e:
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
    additional_networks = request.json.get('additionalNetworks', [])
    devices_info = run_async(discover_devices, username, password, additional_networks)
    return jsonify(devices_info)

@app.route('/getSysInfo', methods=['POST'])
def get_sys_info_route():
    data = request.json
    device_config = data['device_config']
    device_info = run_async(get_device_info, device_config)
    return jsonify(device_info)

@app.route('/controlDevice', methods=['POST'])
def control_device_route():
    data = request.json
    device_config = data['device_config']
    action = data['action']
    child_num = data.get('child_num')
    result = run_async(control_device, device_config, action, child_num)
    return jsonify(result)

if __name__ == '__main__':
    port = int(sys.argv[1])
    app.logger.info(f"Starting server on port {port}")
    eventlet.wsgi.server(eventlet.listen(('127.0.0.1', port)), app)