import asyncio, eventlet, eventlet.wsgi, json, sys
from flask import Flask, request, jsonify
from flask_socketio import SocketIO
from kasa import Discover, Device

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

device_cache = {}

def custom_device_serializer(device):
    def is_serializable(value):
        try:
            json.dumps(value)
            return True
        except TypeError:
            return False

    return {attr: getattr(device, attr) for attr in dir(device)
            if not attr.startswith("_") and not callable(getattr(device, attr))
            and not asyncio.iscoroutine(getattr(device, attr))
            and is_serializable(getattr(device, attr))}

async def discover_devices():
    devices = await Discover.discover()
    all_device_info = {}
    tasks = []
    for ip, dev in devices.items():
        tasks.append(update_device_info(ip, dev))
    results = await asyncio.gather(*tasks)
    for ip, info in results:
        all_device_info[ip] = info
    return all_device_info

async def update_device_info(ip, dev: Device):
    await dev.update()
    device_info = custom_device_serializer(dev)
    device_config = dev.config.to_dict()
    device_cache[ip] = {
        "device_info": device_info,
        "device_config": device_config
    }
    return ip, device_cache[ip]

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

@app.route('/discover', methods=['GET'])
def discover():
    try:
        devices_info = run_async(discover_devices)
        return jsonify(devices_info)
    except Exception as e:
        app.logger.error(f"Error in /discover: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/getSysInfo', methods=['POST'])
def get_sys_info_route():
    try:
        data = request.json
        app.logger.debug(f"Request data: {data}")
        device_config = data['device_config']
        device_info = run_async(get_device_info, device_config)
        return jsonify(device_info)
    except Exception as e:
        app.logger.error(f"Error in /getSysInfo: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/controlDevice', methods=['POST'])
def control_device_route():
    try:
        data = request.json
        app.logger.debug(f"Request data: {data}")
        device_config = data['device_config']
        action = data['action']
        child_num = data.get('child_num')
        result = run_async(control_device, device_config, action, child_num)
        return jsonify(result)
    except Exception as e:
        app.logger.error(f"Error in /controlDevice: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
    port = int(sys.argv[1])
    print(f"Starting server on port {port}")
    eventlet.wsgi.server(eventlet.listen(('127.0.0.1', port)), app)