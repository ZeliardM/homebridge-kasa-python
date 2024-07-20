import asyncio
from kasa import Discover
import json

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

async def discover_devices():
    devices = await Discover.discover()
    all_device_info = {}
    for ip, dev in devices.items():
        dev = await Discover.discover_single(ip)
        await dev.update()

        device_info = custom_device_serializer(dev)
        device_config = dev.config.to_dict()

        all_device_info[f"{ip}"] = {
            "device_info": device_info,
            "device_config": device_config
        }

    try:
        json_data = json.dumps(all_device_info, indent=4)
        print(json_data)
    except TypeError as e:
        print(f"Error serializing device information: {e}")

if __name__ == "__main__":
    asyncio.run(discover_devices())