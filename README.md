<p align="center" style="text-align:center;">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150" style="display:block; margin:auto;">

</p>

<span align="center">

# Homebridge Kasa Python Plug-In

</span>

<p align="center">
  <a href="https://github.com/ZeliardM/homebridge-kasa-python/blob/latest/LICENSE"><img src="https://badgen.net/npm/license/homebridge-kasa-python" alt="mit license"></a>
  <a href="https://www.npmjs.com/package/homebridge-kasa-python/v/latest"><img src="https://badgen.net/npm/v/homebridge-kasa-python/latest?label=npm@latest" alt="latest npm version"></a>
  <a href="https://pypi.org/project/python-kasa/"><img src="https://badgen.net/badge/Python@latest/3.9,%203.10,%203.11,%203.12,%203.13" alt="latest PyPI pyversions"></a>
  <a href="https://www.npmjs.com/package/homebridge-kasa-python/v/beta"><img src="https://badgen.net/npm/v/homebridge-kasa-python/beta?label=npm@beta&color=cyan" alt="beta npm version"></a>
  <a href="https://pypi.org/project/python-kasa/"><img src="https://badgen.net/badge/Python@beta/3.11,%203.12,%203.13?color=cyan" alt="beta PyPI pyversions"></a>
  <a href="https://www.npmjs.com/package/homebridge-kasa-python/v/latest"><img src="https://badgen.net/npm/dt/homebridge-kasa-python" alt="npm downloads total"></a>
  <a href="https://www.paypal.me/ZeliardM/USD/"><img src="https://badgen.net/badge/donate/paypal?color=orange" alt="donate"></a>
  <a href="https://github.com/sponsors/ZeliardM"><img src="https://badgen.net/badge/donate/github?color=orange" alt="donate"></a>
  <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://badgen.net/badge/homebridge/verified?color=purple" alt="homebridge verified"></a>
</p>

<div align="center">

> ## IMPORTANT!!!
>With Beta v2.7.0, Support for anything less than Python v3.11 will be dropped.

</div>

This is a [Homebridge](https://github.com/homebridge/homebridge) plug-in based on the Python-Kasa API Library to interact with TP-Link Kasa/Tapo Devices.

This plug-in will automatically discover your TP-Link Kasa/Tapo Devices on your network locally only and configure them to be used in HomeKit.

Automatic Discovery may be possible only for some devices. If your device is not discovered automatically, try adding the IP Address into the Manual Devices List. Some newer devices require the Username and Password for your TP-Link Kasa/Tapo Cloud Account. Credentials can be enabled and provided in the plug-in settings.

### Current Supported and Tested Devices
-   I currently have used this plug-in with the HS300 (US) Power Strip and the KP115 (US) Plug. All other devices are yet to be tested and fully supported. If you have a device that is a plug or power strip and it does work as expected in HomeKit, please let me know and I can add it to the list of tested and supported devices. I don't have a lot of devices so cannot fully test everything.

### Features

-   Automatically discover TP-Link Kasa/Tapo Devices locally only on your network.
-   Change Device States for Plugs, Change Device States for Power Strips, Change Device State and Supports Dimming for Switches, Change Device State and Supports Hue, Saturation, and Value (HSV), Color, Color Temperature Adjustments, and Dimming for Bulbs and Light Strips that support those options.</p>*NOTE - Not All Functions Are Currently Supported, All Devices and Functions Could Be Supported By The Plug-In In The Furture.*</p>
-   Supported Devices from the API are listed below, Devices with an asterisks ('*') next to the specific firmware will require the Username and Password for your TP-Link Kasa/Tapo Cloud Account to connect and function correctly.</p>*NOTE - Not All Devices Listed Below Are Supported By This Plug-In. These Devices Are Supported By The Python-Kasa API Library And Could Be Supported By The Plug-In In The Future.*</p>

## Kasa devices

Some newer Kasa devices require authentication. These are marked with [*] in the list below.<br>Hub-Connected Devices may work across TAPO/KASA branded hubs even if they don't work across the native apps.

### Plugs

- **EP10**
  - Hardware: 1.0 (US) / Firmware: 1.0.2
- **EP25**
  - Hardware: 2.6 (US) / Firmware: 1.0.1[*]
  - Hardware: 2.6 (US) / Firmware: 1.0.2[*]
- **HS100**
  - Hardware: 1.0 (UK) / Firmware: 1.2.6
  - Hardware: 4.1 (UK) / Firmware: 1.1.0[*]
  - Hardware: 1.0 (US) / Firmware: 1.2.5
  - Hardware: 2.0 (US) / Firmware: 1.5.6
- **HS103**
  - Hardware: 1.0 (US) / Firmware: 1.5.7
  - Hardware: 2.1 (US) / Firmware: 1.1.2
  - Hardware: 2.1 (US) / Firmware: 1.1.4
- **HS105**
  - Hardware: 1.0 (US) / Firmware: 1.5.6
- **HS110**
  - Hardware: 1.0 (EU) / Firmware: 1.2.5
  - Hardware: 4.0 (EU) / Firmware: 1.0.4
  - Hardware: 1.0 (US) / Firmware: 1.2.6
- **KP100**
  - Hardware: 3.0 (US) / Firmware: 1.0.1
- **KP105**
  - Hardware: 1.0 (UK) / Firmware: 1.0.5
  - Hardware: 1.0 (UK) / Firmware: 1.0.7
- **KP115**
  - Hardware: 1.0 (EU) / Firmware: 1.0.16
  - Hardware: 1.0 (US) / Firmware: 1.0.17
  - Hardware: 1.0 (US) / Firmware: 1.0.21
- **KP125**
  - Hardware: 1.0 (US) / Firmware: 1.0.6
- **KP125M**
  - Hardware: 1.0 (US) / Firmware: 1.1.3[*]
  - Hardware: 1.0 (US) / Firmware: 1.2.3[*]
- **KP401**
  - Hardware: 1.0 (US) / Firmware: 1.0.0

### Power Strips

- **EP40**
  - Hardware: 1.0 (US) / Firmware: 1.0.2
- **EP40M**
  - Hardware: 1.0 (US) / Firmware: 1.1.0[*]
- **HS107**
  - Hardware: 1.0 (US) / Firmware: 1.0.8
- **HS300**
  - Hardware: 1.0 (US) / Firmware: 1.0.10
  - Hardware: 1.0 (US) / Firmware: 1.0.21
  - Hardware: 2.0 (US) / Firmware: 1.0.12
  - Hardware: 2.0 (US) / Firmware: 1.0.3
- **KP200**
  - Hardware: 3.0 (US) / Firmware: 1.0.3
- **KP303**
  - Hardware: 1.0 (UK) / Firmware: 1.0.3
  - Hardware: 2.0 (US) / Firmware: 1.0.3
  - Hardware: 2.0 (US) / Firmware: 1.0.9
- **KP400**
  - Hardware: 1.0 (US) / Firmware: 1.0.10
  - Hardware: 2.0 (US) / Firmware: 1.0.6
  - Hardware: 3.0 (US) / Firmware: 1.0.3
  - Hardware: 3.0 (US) / Firmware: 1.0.4

### Wall Switches

- **ES20M**
  - Hardware: 1.0 (US) / Firmware: 1.0.11
  - Hardware: 1.0 (US) / Firmware: 1.0.8
- **HS200**
  - Hardware: 2.0 (US) / Firmware: 1.5.7
  - Hardware: 3.0 (US) / Firmware: 1.1.5
  - Hardware: 5.0 (US) / Firmware: 1.0.11
  - Hardware: 5.0 (US) / Firmware: 1.0.2
  - Hardware: 5.26 (US) / Firmware: 1.0.3[*]
- **HS210**
  - Hardware: 1.0 (US) / Firmware: 1.5.8
  - Hardware: 2.0 (US) / Firmware: 1.1.5
- **HS220**
  - Hardware: 1.0 (US) / Firmware: 1.5.7
  - Hardware: 2.0 (US) / Firmware: 1.0.3
  - Hardware: 3.26 (US) / Firmware: 1.0.1[*]
- **KP405**
  - Hardware: 1.0 (US) / Firmware: 1.0.5
  - Hardware: 1.0 (US) / Firmware: 1.0.6
- **KS200**
  - Hardware: 1.0 (US) / Firmware: 1.0.8
- **KS200M**
  - Hardware: 1.0 (US) / Firmware: 1.0.10
  - Hardware: 1.0 (US) / Firmware: 1.0.11
  - Hardware: 1.0 (US) / Firmware: 1.0.12
  - Hardware: 1.0 (US) / Firmware: 1.0.8
- **KS205**
  - Hardware: 1.0 (US) / Firmware: 1.0.2[*]
  - Hardware: 1.0 (US) / Firmware: 1.1.0[*]
- **KS220**
  - Hardware: 1.0 (US) / Firmware: 1.0.13
- **KS220M**
  - Hardware: 1.0 (US) / Firmware: 1.0.4
- **KS225**
  - Hardware: 1.0 (US) / Firmware: 1.0.2[*]
  - Hardware: 1.0 (US) / Firmware: 1.1.0[*]
- **KS230**
  - Hardware: 1.0 (US) / Firmware: 1.0.14
- **KS240**
  - Hardware: 1.0 (US) / Firmware: 1.0.4[*]
  - Hardware: 1.0 (US) / Firmware: 1.0.5[*]
  - Hardware: 1.0 (US) / Firmware: 1.0.7[*]

### Bulbs

- **KL110**
  - Hardware: 1.0 (US) / Firmware: 1.8.11
- **KL120**
  - Hardware: 1.0 (US) / Firmware: 1.8.11
  - Hardware: 1.0 (US) / Firmware: 1.8.6
- **KL125**
  - Hardware: 1.20 (US) / Firmware: 1.0.5
  - Hardware: 2.0 (US) / Firmware: 1.0.7
  - Hardware: 4.0 (US) / Firmware: 1.0.5
- **KL130**
  - Hardware: 1.0 (EU) / Firmware: 1.8.8
  - Hardware: 1.0 (US) / Firmware: 1.8.11
- **KL135**
  - Hardware: 1.0 (US) / Firmware: 1.0.15
  - Hardware: 1.0 (US) / Firmware: 1.0.6
- **KL50**
  - Hardware: 1.0 (US) / Firmware: 1.1.13
- **KL60**
  - Hardware: 1.0 (UN) / Firmware: 1.1.4
  - Hardware: 1.0 (US) / Firmware: 1.1.13
- **LB110**
  - Hardware: 1.0 (US) / Firmware: 1.8.11

### Light Strips

- **KL400L5**
  - Hardware: 1.0 (US) / Firmware: 1.0.5
  - Hardware: 1.0 (US) / Firmware: 1.0.8
- **KL420L5**
  - Hardware: 1.0 (US) / Firmware: 1.0.2
- **KL430**
  - Hardware: 2.0 (UN) / Firmware: 1.0.8
  - Hardware: 1.0 (US) / Firmware: 1.0.10
  - Hardware: 2.0 (US) / Firmware: 1.0.11
  - Hardware: 2.0 (US) / Firmware: 1.0.8
  - Hardware: 2.0 (US) / Firmware: 1.0.9

### Hubs

- **KH100**
  - Hardware: 1.0 (EU) / Firmware: 1.2.3[*]
  - Hardware: 1.0 (EU) / Firmware: 1.5.12[*]
  - Hardware: 1.0 (UK) / Firmware: 1.5.6[*]

### Hub-Connected Devices

- **KE100**
  - Hardware: 1.0 (EU) / Firmware: 2.4.0[*]
  - Hardware: 1.0 (EU) / Firmware: 2.8.0[*]
  - Hardware: 1.0 (UK) / Firmware: 2.8.0[*]


## Tapo devices

All Tapo devices require authentication.<br>Hub-Connected Devices may work across TAPO/KASA branded hubs even if they don't work across the native apps.

### Plugs

- **P100**
  - Hardware: 1.0.0 (US) / Firmware: 1.1.3
  - Hardware: 1.0.0 (US) / Firmware: 1.3.7
  - Hardware: 1.0.0 (US) / Firmware: 1.4.0
- **P110**
  - Hardware: 1.0 (EU) / Firmware: 1.0.7
  - Hardware: 1.0 (EU) / Firmware: 1.2.3
  - Hardware: 1.0 (UK) / Firmware: 1.3.0
- **P110M**
  - Hardware: 1.0 (AU) / Firmware: 1.2.3
  - Hardware: 1.0 (EU) / Firmware: 1.2.3
- **P115**
  - Hardware: 1.0 (EU) / Firmware: 1.2.3
  - Hardware: 1.0 (US) / Firmware: 1.1.3
- **P125M**
  - Hardware: 1.0 (US) / Firmware: 1.1.0
- **P135**
  - Hardware: 1.0 (US) / Firmware: 1.0.5
  - Hardware: 1.0 (US) / Firmware: 1.2.0
- **TP15**
  - Hardware: 1.0 (US) / Firmware: 1.0.3

### Power Strips

- **P210M**
  - Hardware: 1.0 (US) / Firmware: 1.0.3
- **P300**
  - Hardware: 1.0 (EU) / Firmware: 1.0.13
  - Hardware: 1.0 (EU) / Firmware: 1.0.15
  - Hardware: 1.0 (EU) / Firmware: 1.0.7
- **P304M**
  - Hardware: 1.0 (UK) / Firmware: 1.0.3
- **P306**
  - Hardware: 1.0 (US) / Firmware: 1.1.2
- **TP25**
  - Hardware: 1.0 (US) / Firmware: 1.0.2

### Wall Switches

- **S500D**
  - Hardware: 1.0 (US) / Firmware: 1.0.5
- **S505**
  - Hardware: 1.0 (US) / Firmware: 1.0.2
- **S505D**
  - Hardware: 1.0 (US) / Firmware: 1.1.0

### Bulbs

- **L510B**
  - Hardware: 3.0 (EU) / Firmware: 1.0.5
- **L510E**
  - Hardware: 3.0 (US) / Firmware: 1.0.5
  - Hardware: 3.0 (US) / Firmware: 1.1.2
- **L530E**
  - Hardware: 3.0 (EU) / Firmware: 1.0.6
  - Hardware: 3.0 (EU) / Firmware: 1.1.0
  - Hardware: 3.0 (EU) / Firmware: 1.1.6
  - Hardware: 2.0 (US) / Firmware: 1.1.0
- **L630**
  - Hardware: 1.0 (EU) / Firmware: 1.1.2

### Light Strips

- **L900-10**
  - Hardware: 1.0 (EU) / Firmware: 1.0.17
  - Hardware: 1.0 (US) / Firmware: 1.0.11
- **L900-5**
  - Hardware: 1.0 (EU) / Firmware: 1.0.17
  - Hardware: 1.0 (EU) / Firmware: 1.1.0
- **L920-5**
  - Hardware: 1.0 (EU) / Firmware: 1.0.7
  - Hardware: 1.0 (EU) / Firmware: 1.1.3
  - Hardware: 1.0 (US) / Firmware: 1.1.0
  - Hardware: 1.0 (US) / Firmware: 1.1.3
- **L930-5**
  - Hardware: 1.0 (US) / Firmware: 1.1.2

### Cameras

- **C100**
  - Hardware: 4.0 / Firmware: 1.3.14
- **C210**
  - Hardware: 2.0 (EU) / Firmware: 1.4.2
  - Hardware: 2.0 (EU) / Firmware: 1.4.3
- **C225**
  - Hardware: 2.0 (US) / Firmware: 1.0.11
- **C325WB**
  - Hardware: 1.0 (EU) / Firmware: 1.1.17
- **C520WS**
  - Hardware: 1.0 (US) / Firmware: 1.2.8
- **TC65**
  - Hardware: 1.0 / Firmware: 1.3.9
- **TC70**
  - Hardware: 3.0 / Firmware: 1.3.11

### Hubs

- **H100**
  - Hardware: 1.0 (EU) / Firmware: 1.2.3
  - Hardware: 1.0 (EU) / Firmware: 1.5.10
  - Hardware: 1.0 (EU) / Firmware: 1.5.5
- **H200**
  - Hardware: 1.0 (EU) / Firmware: 1.3.2
  - Hardware: 1.0 (US) / Firmware: 1.3.6

### Hub-Connected Devices

- **S200B**
  - Hardware: 1.0 (EU) / Firmware: 1.11.0
  - Hardware: 1.0 (US) / Firmware: 1.12.0
- **S200D**
  - Hardware: 1.0 (EU) / Firmware: 1.11.0
  - Hardware: 1.0 (EU) / Firmware: 1.12.0
- **T100**
  - Hardware: 1.0 (EU) / Firmware: 1.12.0
- **T110**
  - Hardware: 1.0 (EU) / Firmware: 1.8.0
  - Hardware: 1.0 (EU) / Firmware: 1.9.0
  - Hardware: 1.0 (US) / Firmware: 1.9.0
- **T300**
  - Hardware: 1.0 (EU) / Firmware: 1.7.0
- **T310**
  - Hardware: 1.0 (EU) / Firmware: 1.5.0
  - Hardware: 1.0 (US) / Firmware: 1.5.0
- **T315**
  - Hardware: 1.0 (EU) / Firmware: 1.7.0
  - Hardware: 1.0 (US) / Firmware: 1.8.0

### Credits
-   Huge thanks to rytilahti and all the developers at python-kasa for the [Python-Kasa API](https://github.com/python-kasa/python-kasa), plasticrake for the [Unofficial API documentation](https://github.com/plasticrake/tplink-smarthome-api), and maxileith for [Excellent Python Implementation](https://github.com/maxileith/homebridge-appletv-enhanced).