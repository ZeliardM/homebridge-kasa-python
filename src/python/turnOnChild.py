import asyncio
from kasa import Device
import json
import sys

async def turn_on_child(device_config, child_num):
    try:
        kasa_device = await Device.connect(config=Device.Config.from_dict(device_config))
        await kasa_device.children[child_num].turn_on()
        await kasa_device.update()
        print(json.dumps(kasa_device.children[child_num].is_on))
        await kasa_device.disconnect()
    except Exception as e:
        print(f"Error turning on device: {e}")

if __name__ == "__main__":
    device_config_json = sys.argv[1]
    child_num_json = sys.argv[2]
    device_config = json.loads(device_config_json)
    child_num = json.loads(child_num_json)
    
    asyncio.run(turn_on_child(device_config, child_num))