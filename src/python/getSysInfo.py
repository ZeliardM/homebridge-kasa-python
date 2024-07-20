import asyncio
from kasa import Device
import json
import sys

def custom_device_serializer(device):
    device_info = {}
    for attr in dir(device):
        if not attr.startswith("_") and not callable(getattr(device, attr)):
            try:
                json.dumps(getattr(device, attr))
                device_info[attr] = getattr(device, attr)
            except TypeError:
                continue
    return device_info

async def get_sys_info(device_config):
    try:
        dev = await Device.connect(config=Device.Config.from_dict(device_config))
        await dev.update()
        all_device_info = {}

        device_info = custom_device_serializer(dev)

        all_device_info = {
            "device_info": device_info,
        }
        await dev.disconnect()

        json_data = json.dumps(all_device_info, indent=4)
        print(json_data)
    except TypeError as e:
        print(f"Error serializing device information: {e}")

if __name__ == "__main__":
    device_config_json = sys.argv[1].strip("'")
    device_config = json.loads(device_config_json)
    
    asyncio.run(get_sys_info(device_config))