import asyncio
import json
import os
import re
import sys
import time

from kasa import (
    AuthenticationError,
    Credentials,
    Device,
    DeviceConfig,
    DeviceType,
    Discover,
    KasaException,
    LightState,
    Module,
    UnsupportedDeviceError,
)
from kasa.iot import IotDevice
try:
    from kasa.exceptions import _ConnectionError
except ImportError:  # private in python-kasa; the cause chain still has the OSError in most cases
    _ConnectionError = OSError
from quart import jsonify, request, Response, Quart
from typing import Any

app = Quart(__name__)

hide_homekit_matter = os.getenv("HIDE_HOMEKIT_MATTER", "false").lower() == "true"
device_cache: dict[str, Device] = {}
device_lock_cache: dict[str, asyncio.Lock] = {}
device_config_cache: dict[str, dict] = {}

device_queue: asyncio.Queue = asyncio.Queue()
discovery_run = 0

# python-kasa retries a request itself and reopens a dropped socket on the next one, so one failed
# request says little about the connection. It is replaced only after an authentication error, or
# after this many connection failures in a row. A device rejecting a request does not count.
DROP_AFTER_FAILURES = 3
device_failures: dict[str, int] = {}
# A command whose connection was refused or unreachable (what a short Wi-Fi drop looks like) tries
# again after each of these pauses, in seconds, but only while another attempt as long as the last
# one can still finish within the deadline after the first, so HomeKit's 9 s limit is not passed.
COMMAND_RETRY_DELAYS = (1, 2)
COMMAND_RETRY_DEADLINE = 8
# The MAC of the device discovery accepted at each address (identified, filtered and checked for
# native HomeKit/Matter). A connection is only used for that device: after addresses are
# reassigned, a poll of the old address would read whatever device answers there now.
admitted_macs: dict[str, str] = {}


class AddressReassignedError(Exception):
    """A different device than the one accepted answers at this address."""

UNSUPPORTED_TYPES = {
    DeviceType.Camera.value,
    DeviceType.Sensor.value,
    DeviceType.Hub.value,
    DeviceType.Fan.value,
    DeviceType.Thermostat.value,
    DeviceType.Vacuum.value,
    DeviceType.Chime.value,
    DeviceType.Doorbell.value,
    DeviceType.Unknown.value,
}

def kelvin_to_mired(kelvin: int) -> int:
    if not kelvin or kelvin <= 0:
        return 140
    return max(140, min(round(1_000_000 / kelvin), 500))

def mired_to_kelvin(mired: int) -> int:
    if not mired or mired <= 0:
        return 2500
    return max(2500, min(round(1_000_000 / mired), 6500))

def _percent_to_level(percent: int) -> int:
    mapping = {0: 0, 25: 1, 50: 2, 75: 3, 100: 4}
    return mapping[percent]

def _level_to_percent(level: int) -> int:
    mapping = {0: 0, 1: 25, 2: 50, 3: 75, 4: 100}
    return mapping[level]

def log(message: str, level: str = "INFO", host: str | None = None, alias: str | None = None):
    context = []
    if host:
        context.append(f"host={host}")
    if alias:
        context.append(f"alias={alias}")
    context_str = f" ({', '.join(context)})" if context else ""
    print(f"[Kasa API] {level}: {message}{context_str}", file=sys.stdout if level != "ERROR" else sys.stderr)

def _extract_child_suffix_index(device_id: str) -> int:
    base = device_id.split('_', 1)[1] if '_' in device_id else device_id
    m = re.search(r'(\d{1,2})$', base)
    return int(m.group(1)) if m else 0

def serialize_child(child: Device) -> dict[str, Any]:
    log("Serializing child device", alias=child.alias)
    child_info = {
        "alias": child.alias,
        "id": child.device_id.split('_', 1)[1] if '_' in child.device_id else child.device_id,
        "state": child.features["state"].value,
    }
    light_module = child.modules.get(Module.Light)
    fan_module = child.modules.get(Module.Fan)
    energy_module = child.modules.get(Module.Energy)
    if light_module:
        child_info.update(get_light_info(child))
    if fan_module:
        level = getattr(fan_module, "fan_speed_level")
        percent = _level_to_percent(level)
        child_info.update({
            "fan_speed_level": percent,
        })
    if energy_module:
        child_info.update(get_energy_info(child))
    return child_info

def get_light_info(device: Device) -> dict[str, Any]:
    log("Getting light info for device", alias=device.alias)
    light_module = device.modules.get(Module.Light)
    light_info: dict[str, Any] = {}
    if light_module.has_feature("brightness"):
        light_info["brightness"] = light_module.brightness
    if light_module.has_feature("color_temp"):
        kelvin = light_module.color_temp
        mired = kelvin_to_mired(kelvin) if kelvin and kelvin > 0 else 140
        light_info["color_temp"] = mired
    if light_module.has_feature("hsv"):
        hue, saturation, _ = light_module.hsv
        light_info["hsv"] = {"hue": hue, "saturation": saturation}
    return light_info

def get_energy_info(device: Device) -> dict[str, Any]:
    log("Getting energy info for device", alias=device.alias)
    energy_module = device.modules.get(Module.Energy)
    energy_fields = (
        ("current", "current"),
        ("voltage", "voltage"),
        ("power", "current_consumption"),
        ("total", "consumption_total"),
        ("today", "consumption_today"),
        ("month", "consumption_this_month"),
    )
    energy_dict = {key: getattr(energy_module, attr) for key, attr in energy_fields}
    return {"energy": energy_dict}

def custom_serializer(device: Device) -> dict[str, Any]:
    log("Serializing device", host=device.host, alias=device.alias)
    child_num = len(device.children) if device.children else 0
    sys_info: dict[str, Any] = {
        "alias": device.alias or f'{device.device_type}_{device.host}',
        "child_num": child_num,
        "device_id": device.device_id if device.mac != device.device_id else device.sys_info.get("deviceId"),
        "device_type": device.device_type.value,
        "host": device.host,
        "hw_ver": device.device_info.hardware_version,
        "mac": device.mac,
        "model": device.model,
        "sw_ver": device.device_info.firmware_version,
    }
    light_module = device.modules.get(Module.Light)
    fan_module = device.modules.get(Module.Fan)
    energy_module = device.modules.get(Module.Energy)
    if child_num > 0:
        sorted_children = sorted(device.children, key=lambda c: _extract_child_suffix_index(c.device_id))
        sys_info["children"] = [serialize_child(child) for child in sorted_children]
    else:
        sys_info.update({"state": device.features["state"].value})
        if light_module:
            sys_info.update(get_light_info(device))
        if fan_module:
            level = getattr(fan_module, "fan_speed_level")
            percent = _level_to_percent(level)
            sys_info.update({
                "fan_speed_level": percent,
            })
        if energy_module:
            sys_info.update(get_energy_info(device))
    feature_info = {
        "brightness": False,
        "color_temp": False,
        "energy": False,
        "fan": False,
        "hsv": False,
    }
    if light_module:
        feature_info.update({
            "brightness": light_module.has_feature("brightness"),
            "color_temp": light_module.has_feature("color_temp"),
            "hsv": light_module.has_feature("hsv"),
        })
    if fan_module:
        feature_info.update({"fan": True})
    if energy_module:
        feature_info.update({"energy": True})
    return {"sys_info": sys_info, "feature_info": feature_info}

async def discover_devices(
    username: str | None = None,
    password: str | None = None,
    additional_broadcasts: list[str] | None = None,
    manual_devices: list[str] | None = None,
    exclude_mac_addresses: list[str] | None = None,
    include_mac_addresses: list[str] | None = None,
    disable_broadcast: bool = False,
) -> None:
    global discovery_run
    broadcasts = [] if disable_broadcast else ["255.255.255.255"] + (additional_broadcasts or [])
    credentials = Credentials(username, password) if username and password else None

    # A run that outlasts the plugin's stream window (slow or failing devices) must not end the
    # next run's stream with its completion marker. Its late device results stay queued, so a
    # device that answers late is still reported, one run late, instead of never.
    discovery_run += 1
    run = discovery_run
    leftover = []
    while not device_queue.empty():
        item = device_queue.get_nowait()
        if item.get("status") != "discovery_complete":
            leftover.append(item)
    for item in leftover:
        device_queue.put_nowait(item)

    discovered_hosts: set[str] = set()

    async def on_discovered(device: Device):
        if device.host in discovered_hosts:
            log("Device already discovered this run, skipping", level="DEBUG", host=device.host, alias=device.alias)
            await safe_disconnect(device)
            return
        discovered_hosts.add(device.host)
        log("Discovered device", host=device.host, alias=device.alias)
        try:
            async with host_lock(device.host):
                connected = device_cache.get(device.host)
                if connected is not None and (not admitted_here(device.host, device) or device_failures.get(device.host)):
                    # A different device answers here than the one this connection is for, or the
                    # connection's last request failed, so what it last read cannot be trusted.
                    # Connect to the device that answered and check it like any new device.
                    log("Checking this address with a new connection", host=device.host, alias=device.alias)
                    await drop_device(device.host)
                    connected = None
                if connected is not None:
                    # Discovery is for new devices and ones that lost their connection. A device
                    # we are connected to keeps that connection for polling and control, and is
                    # reported as seen from what it last read, without talking to it again.
                    await safe_disconnect(device)
                    result = await create_device_info(connected)
                else:
                    if isinstance(device, IotDevice):
                        # Discovery picks the iot class from the device family alone, so a
                        # strip discovered over KLAP comes back as a plug. Connecting reads
                        # sysinfo first and picks the class from it.
                        discovered = device
                        device = await Device.connect(config=discovered.config)
                        await safe_disconnect(discovered)
                    else:
                        await device.update()
                    result = await process_device(device)
            if result is not None:
                await device_queue.put(result)
        except (UnsupportedDeviceError, AuthenticationError) as e:
            log(f"{e.__class__.__name__}", level="ERROR", host=device.host, alias=device.alias)
            discovered_hosts.discard(device.host)
            await safe_disconnect(device)
        except Exception as e:
            log(f"Device discovery: {e}", level="ERROR", host=device.host, alias=device.alias)
            discovered_hosts.discard(device.host)
            await safe_disconnect(device)

    async def process_device(device: Device) -> dict[str, Any] | None:
        log("Processing device", host=device.host, alias=device.alias)
        if include_mac_addresses and device.mac not in include_mac_addresses:
            log("Excluding device due to MAC address inclusion", host=device.host, alias=device.alias)
            await safe_disconnect(device)
            return None
        if exclude_mac_addresses and device.mac in exclude_mac_addresses:
            log("Excluding device due to MAC address exclusion", host=device.host, alias=device.alias)
            await safe_disconnect(device)
            return None
        try:
            if hide_homekit_matter:
                iot_homekit_module = device.modules.get(Module.IotHomeKit)
                homekit_component = device.modules.get(Module.HomeKit) or (iot_homekit_module and iot_homekit_module.info)
                matter_component = device.modules.get(Module.Matter)
                if homekit_component or matter_component:
                    if homekit_component:
                        log("Skipping device due to Native HomeKit support", host=device.host, alias=device.alias)
                    if matter_component:
                        log("Skipping device due to Native Matter support", host=device.host, alias=device.alias)
                    await safe_disconnect(device)
                    return None
        except Exception as e:
            log(f"Checking HomeKit and Matter modules: {e}", level="ERROR", host=device.host, alias=device.alias)
            await safe_disconnect(device)
            return None
        device_type = device.device_type.value
        if device_type and device_type not in UNSUPPORTED_TYPES:
            # This connection is the device's from now on; polling and control use it.
            device_cache[device.host] = device
            admitted_macs[device.host] = normalized_mac(device)
            device_failures.pop(device.host, None)
            device_info = await create_device_info(device)
            if isinstance(device_info, Exception):
                log(f"Creating device info: {device_info}", level="ERROR", host=device.host, alias=device.alias)
                return await handle_device_error(device.host)
            return device_info
        else:
            log("Skipping unsupported device", host=device.host, alias=device.alias)
            await safe_disconnect(device)
            return None

    async def discover_on_broadcast(broadcast: str):
        log("Discovering on broadcast", host=broadcast)
        try:
            await Discover.discover(
                target=broadcast, credentials=credentials, on_discovered=on_discovered
            )
        except Exception as e:
            log(f"Discovering on broadcast: {e}", level="ERROR", host=broadcast)

    async def discover_manual_device(host: str):
        log("Discovering manual device", host=host)
        device = None
        try:
            device = await Discover.discover_single(host=host, credentials=credentials)
            await on_discovered(device)
        except Exception as e:
            log(f"Discovering manual device: {e}", level="ERROR", host=host)
            if device:
                await safe_disconnect(device)

    discover_tasks = [discover_on_broadcast(bc) for bc in broadcasts]
    manual_discover_tasks = [discover_manual_device(host) for host in (manual_devices or [])]
    await asyncio.gather(*discover_tasks, *manual_discover_tasks, return_exceptions=True)
    if run == discovery_run:
        await device_queue.put({"status": "discovery_complete"})

def host_lock(host: str) -> asyncio.Lock:
    """Serialize every access to one device: polls, control and discovery."""
    return device_lock_cache.setdefault(host, asyncio.Lock())

async def drop_device(host: str):
    """Close and forget a device's connection; the next access or discovery reconnects it."""
    device_failures.pop(host, None)
    await safe_disconnect(device_cache.pop(host, None))

def error_chain(error: BaseException):
    """The error and its causes. Kasa (iot) devices wrap a failed request in another exception."""
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        yield error
        error = error.__cause__

# Failures where the request got no answer: refused, unreachable, reset, timed out, or the device
# closed the connection without replying (EOF on Kasa, a server disconnect on Tapo).
NO_ANSWER_ERRORS = (OSError, EOFError, _ConnectionError)

def is_connection_failure(error: BaseException) -> bool:
    """The request did not get an answer, as opposed to the device answering with an error."""
    return any(isinstance(e, NO_ANSWER_ERRORS) for e in error_chain(error))

def is_quick_connection_failure(error: BaseException) -> bool:
    """Refused or unreachable at once, rather than timed out (TimeoutError is an OSError too)."""
    chain = list(error_chain(error))
    return not any(isinstance(e, TimeoutError) for e in chain) and any(isinstance(e, OSError) for e in chain)

def normalized_mac(device: Device) -> str:
    try:
        return (device.mac or "").replace("-", ":").upper()
    except Exception:
        return ""

def admitted_here(host: str, device: Device) -> bool:
    """Whether this is the device discovery accepted at this address; unknown counts as yes."""
    admitted, mac = admitted_macs.get(host), normalized_mac(device)
    return not admitted or not mac or admitted == mac

def ensure_admitted_here(host: str, device: Device):
    if not admitted_here(host, device):
        raise AddressReassignedError(f"A different device ({device.mac}) answers at {host} now")

async def close_all_connections():
    log("Closing all existing device connections...")
    if device_cache:
        disconnect_tasks = [device.disconnect() for device in device_cache.values()]
        await asyncio.gather(*disconnect_tasks, return_exceptions=True)
        device_cache.clear()

async def create_device_info(device: Device) -> dict[str, Any]:
    log("Creating device info", host=device.host, alias=device.alias)
    try:
        device_info = custom_serializer(device)
        device_config_cache[device.host] = device.config.to_dict()
        all_device_info = {
            "sys_info": device_info["sys_info"],
            "feature_info": device_info["feature_info"],
        }
        return all_device_info
    except Exception as e:
        log(f"Creating device info: {e}", level="ERROR", host=device.host, alias=device.alias)
        return {"error": str(e)}

async def get_sys_info(host: str) -> dict[str, Any]:
    log("Getting sys_info", host=host)
    async with host_lock(host):
        try:
            device_config = DeviceConfig.from_dict(device_config_cache.get(host))
            device = await get_or_connect_device(host, device_config)
            await device.update()
            ensure_admitted_here(host, device)
            device_info = custom_serializer(device)
            device_failures.pop(host, None)
            return {"sys_info": device_info["sys_info"]}
        except Exception as e:
            return await handle_device_error(host, e)

async def get_or_connect_device(host: str, device_config: DeviceConfig) -> Device:
    try:
        device = device_cache.get(host)
        if not device:
            log("Device not in cache, connecting to device", host=host)
            device = await Device.connect(config=device_config)
            device_cache[host] = device
        return device
    except Exception as e:
        log(f"Connect to device: {e}", level="ERROR", host=host)
        try:
            await safe_disconnect(device)
        except Exception:
            pass
        raise

async def control_device(
    host: str,
    feature: str,
    action: str,
    value: Any,
    child_num: int | None = None,
    light_on: bool | None = None,
) -> dict[str, Any]:
    log("Controlling device", host=host)
    async with host_lock(host):
        start = time.monotonic()
        for delay in (*COMMAND_RETRY_DELAYS, None):
            attempt_start = time.monotonic()
            try:
                device_config = DeviceConfig.from_dict(device_config_cache.get(host))
                device = await get_or_connect_device(host, device_config)
                ensure_admitted_here(host, device)
                result = await perform_device_action(device, feature, action, value, child_num, light_on)
                if result.get("status") == "success":
                    device_failures.pop(host, None)
                return result
            except KasaException as e:
                # Every action sets a value, so sending it again after a quick failure is safe. A
                # timeout is not retried here: python-kasa has already spent its retries on it.
                now = time.monotonic()
                if (
                    delay is None
                    or not is_quick_connection_failure(e)
                    or (now - start) + delay + (now - attempt_start) > COMMAND_RETRY_DEADLINE
                ):
                    return await handle_device_error(host, e)
                log(f"Retrying action in {delay} s after a connection failure: {e}", level="DEBUG", host=host)
                await asyncio.sleep(delay)
            except Exception as e:
                return await handle_device_error(host, e)

async def perform_device_action(
    device: Device,
    feature: str,
    action: str,
    value: Any,
    child_num: int | None = None,
    light_on: bool | None = None,
) -> dict[str, Any]:
    """Apply one action. Errors from the device propagate so the caller can retry or count them."""
    try:
        await apply_device_action(device, feature, action, value, child_num, light_on)
    except KasaException:
        raise
    except Exception as e:
        log(f"Error performing action: {e}", level="ERROR", alias=device.alias)
        return {"status": "error", "message": str(e)}
    return {"status": "success"}

async def apply_device_action(
    device: Device,
    feature: str,
    action: str,
    value: Any,
    child_num: int | None = None,
    light_on: bool | None = None,
):
    if child_num is not None and device.children:
        sorted_children = sorted(device.children, key=lambda c: _extract_child_suffix_index(c.device_id))
        target = sorted_children[child_num]
    else:
        target = device
    log(f"Performing action={action} on feature={feature}", alias=target.alias)
    light = target.modules.get(Module.Light)
    fan = target.modules.get(Module.Fan)
    if feature == "state":
        await getattr(target, action)()
    elif feature == "brightness" and light and light.has_feature("brightness"):
        await handle_brightness(target, action, value)
    elif feature == "color_temp" and light and light.has_feature("color_temp"):
        await handle_color_temp(target, action, value, light_on)
    elif feature == "fan_speed_level" and fan and fan.has_feature("fan_speed_level"):
        await handle_fan_speed_level(target, action, value)
    elif feature == 'hsv' and light and light.has_feature("hsv"):
        await handle_hsv(target, action, feature, value, light_on)
    else:
        raise ValueError("Invalid feature or action")

async def handle_brightness(target: Device, action: str, value: int):
    log(f"Handling brightness: action={action}, value={value}", alias=target.alias)
    light = target.modules.get(Module.Light)
    if value == 0:
        await target.turn_off()
        return
    value = max(1, min(value, 100))
    # One command that sets the brightness and turns the light on, for every device type.
    # set_brightness alone does not turn Tapo devices on, and following it with turn_on
    # sends extra commands that can make a dimmer fade back to its previous level.
    await light.set_state(LightState(light_on=True, brightness=value))

async def handle_color_temp(target: Device, action: str, value: int, light_on: bool | None = None):
    log(f"Handling color temperature: action={action}, value={value}", alias=target.alias)
    light = target.modules.get(Module.Light)
    # The light's color_temp feature carries the device's range on both Kasa and Tapo devices;
    # Module.ColorTemperature only exists on Tapo (smart) devices.
    color_temp_feature = light.get_feature("color_temp")
    mired = max(140, min(value, 500))
    kelvin = mired_to_kelvin(mired)
    if color_temp_feature:
        min_temp, max_temp = color_temp_feature.minimum_value, color_temp_feature.maximum_value
    else:
        min_temp, max_temp = (2500, 6500)
    kelvin = max(min_temp, min(kelvin, max_temp))
    if light_on is False:
        # A plain color change turns the bulb on; keep it off and only update the color.
        await light.set_state(LightState(light_on=False, color_temp=kelvin))
        return
    await getattr(light, action)(kelvin)

async def handle_fan_speed_level(target: Device, action: str, value: int):
    log(f"Handling fan speed level: action={action}, value={value}", alias=target.alias)
    fan = target.modules.get(Module.Fan)
    level = _percent_to_level(value)
    if level == 0:
        await target.turn_off()
        return
    await getattr(fan, action)(level)
    if target.is_off:
        await target.turn_on()

async def handle_hsv(target: Device, action: str, feature: str, value: dict, light_on: bool | None = None):
    log(f"Handling HSV: action={action}, feature={feature}, value={value}", alias=target.alias)
    light = target.modules.get(Module.Light)
    current_hsv = light.hsv
    h = value.get("hue", current_hsv[0])
    s = value.get("saturation", current_hsv[1])
    v = current_hsv[2]
    new_h = max(0, min(h, 360))
    new_s = max(0, min(s, 100))
    new_v = max(0, min(v, 100))
    if light_on is False:
        # A plain color change turns the bulb on; keep it off and only update the color.
        await light.set_state(LightState(light_on=False, hue=new_h, saturation=new_s, color_temp=0))
        return
    await getattr(light, action)(new_h, new_s, new_v)

@app.route('/discover', methods=['POST'])
async def discover_route():
    try:
        username: str = None
        password: str = None
        auth = request.authorization
        if auth:
            username = getattr(auth, "username")
            password = getattr(auth, "password")
        data: dict[str, Any] = await request.get_json()
        additional_broadcasts = data.get('additionalBroadcasts', [])
        manual_devices = data.get('manualDevices', [])
        exclude_mac_addresses = data.get('excludeMacAddresses', [])
        include_mac_addresses = data.get('includeMacAddresses', [])
        disable_broadcast = data.get('disableBroadcast', False) is True
        asyncio.create_task(discover_devices(
            username, password, additional_broadcasts, manual_devices, exclude_mac_addresses, include_mac_addresses,
            disable_broadcast,
        ))
        return jsonify({"status": "discovery started"})
    except Exception as e:
        log(f"Discover route: {e}", level="ERROR")
        return jsonify({"error": str(e)}), 500

@app.route('/stream')
async def stream():
    async def event_generator():
        while True:
            try:
                device_data = await device_queue.get()
                log("Sending device data to SSE stream", level="DEBUG")
                yield f"data: {json.dumps(device_data)}\n\n"
            except Exception as e:
                log(f"SSE event generator: {e}", level="ERROR")
    return Response(event_generator(), mimetype="text/event-stream")

@app.route('/getSysInfo', methods=['POST'])
async def get_sys_info_route():
    try:
        data = await request.get_json()
        host = data['host']
        sys_info = await get_sys_info(host)
        return jsonify(sys_info)
    except Exception as e:
        log(f"GetSysInfo route: {e}", level="ERROR")
        return jsonify({"error": str(e)}), 500

@app.route('/controlDevice', methods=['POST'])
async def control_device_route():
    try:
        data: dict[str, Any] = await request.get_json()
        host = data['host']
        feature = data['feature']
        action = data['action']
        value = data.get('value')
        child_num = data.get('child_num')
        light_on = data.get('light_on')
        light_on = light_on if isinstance(light_on, bool) else None
        result = await control_device(host, feature, action, value, child_num, light_on)
        return jsonify(result)
    except Exception as e:
        log(f"ControlDevice route: {e}", level="ERROR")
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
async def health_check():
    return jsonify({"status": "healthy"}), 200

async def safe_disconnect(device: Device | None):
    if device:
        try:
            await device.disconnect()
        except Exception as e:
            log(f"Disconnecting device: {e}", level="ERROR", host=device.host, alias=device.alias)

async def handle_device_error(host: str, error: Exception | None = None) -> dict[str, Any]:
    """Record a failed request. Callers hold the device's lock.

    A short network drop keeps the connection, which python-kasa reopens on the next request.
    After an authentication error, or several connection failures in a row, the connection is
    dropped, and the next poll, command or discovery connects again. A different device
    answering at the address is refused but keeps the connection. A device that answers with
    an error is reachable, so that does not count. Polling marks the device offline if requests
    keep failing.
    """
    log(f"Handling device: {error}", level="ERROR", host=host)
    if isinstance(error, AddressReassignedError):
        # Keep the connection: each poll re-reads the address and is refused again with one
        # request, and discovery reconnects once it finds the device that answers there now.
        pass
    elif isinstance(error, (AuthenticationError, UnsupportedDeviceError)):
        await drop_device(host)
    elif error is not None and is_connection_failure(error):
        failures = device_failures.get(host, 0) + 1
        device_failures[host] = failures
        if failures >= DROP_AFTER_FAILURES:
            await drop_device(host)
    return {"error": str(error)}

async def disconnect_all_devices(devices: dict[str, Device]):
    for _, device in devices.items():
        await safe_disconnect(device)
        log("Disconnected device", host=device.host, alias=device.alias)

@app.after_serving
async def cleanup():
    log("Cleaning up and disconnecting all devices.")
    await close_all_connections()
    device_lock_cache.clear()
    device_config_cache.clear()
    device_failures.clear()
    admitted_macs.clear()