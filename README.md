<p align="center" style="text-align:center;">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150" style="display:block; margin:auto;">

</p>

<span align="center">

# Homebridge Kasa Python Plug-In

</span>

<p align="center">
  <a href="https://github.com/ZeliardM/homebridge-kasa-python/blob/latest/LICENSE"><img src="https://badgen.net/badge/license/MIT" alt="mit license"></a>
  <a href="https://www.npmjs.com/package/homebridge-kasa-python"><img src="https://badgen.net/npm/v/homebridge-kasa-python/latest?label=latest" alt="npm version"></a>
  <a href="https://pypi.org/project/python-kasa/"><img src="https://badgen.net/badge/Python/3.9%20%7C%203.10%20%7C%203.11%20%7C%203.12%20%7C%203.13/blue?label=latest-Python" alt="PyPI pyversions"></a>
  <a href="https://www.npmjs.com/package/homebridge-kasa-python"><img src="https://badgen.net/npm/v/homebridge-kasa-python/beta?label=beta" alt="npm version"></a>
  <a href="https://pypi.org/project/python-kasa/"><img src="https://badgen.net/badge/Python/3.11%20%7C%203.12%20%7C%203.13/cyan?label=beta-Python" alt="PyPI pyversions"></a>
  <a href="https://www.npmjs.com/package/homebridge-kasa-python"><img src="https://badgen.net/npm/dt/homebridge-kasa-python" alt="npm downloads total"></a>
  <a href="https://www.paypal.me/ZeliardM/USD/"><img src="https://badgen.net/badge/donate/paypal/E69138" alt="donate"></a>
  <a href="https://github.com/sponsors/ZeliardM"><img src="https://badgen.net/badge/donate/github/E69138" alt="donate"></a>
  <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://badgen.net/badge/homebridge/verified/purple" alt="homebridge verified"></a>
</p>

<div align="center">

> ## IMPORTANT!!!
>With Beta v2.7.0, Support for anything less than Python v3.11 will be dropped. As of right now, the Homebridge Docker Image comes with Python 3.10. It is in the process of being updated to come with Python 3.12, but there is no ETA on that release yet.

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
<div align="center">
<table style="border-collapse: collapse; border: 1px solid black;">
  <thead>
    <tr>
      <th align="center" style="border: 1px solid black; padding: 8px;">Category</th>
      <th align="center" style="border: 1px solid black; padding: 8px;">Model</th>
      <th align="center" style="border: 1px solid black; padding: 8px;">Hardware Version</th>
      <th align="center" style="border: 1px solid black; padding: 8px;">Firmware Version</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" rowspan="36" style="border: 1px solid black; padding: 8px;">Plugs</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">EP10</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.2</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">EP25</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">2.6 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.1*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.2*</td>
    </tr>
    <tr>
      <td align="center" rowspan="4" style="border: 1px solid black; padding: 8px;">HS100</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (UK)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.6</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">4.1 (UK)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.5</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.5.6</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">HS103</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.5.7</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">2.1 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.2</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.4</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">HS105</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.5.6</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">HS110</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.5</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">4.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.4</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.6</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">KP100</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">3.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.1</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KP105</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (UK)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.7</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">KP115</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.16</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.17</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.21</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">KP125</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.6</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KP125M</td>
      <td align="center" rowspan="2"style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.3*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.3*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">KP401</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.0</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">P100</td>
      <td align="center" rowspan="3"style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.3.7</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.4.0</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">P110</td>
      <td align="center" rowspan="2"style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.7</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (UK)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.3.0</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">P110M</td>
      <td align="center" rowspan="1"style="border: 1px solid black; padding: 8px;">1.0 (AU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">P115</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">P125M</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">P135</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">TP15</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3</td>
    </tr>
    <tr>
      <td align="center" rowspan="20" style="border: 1px solid black; padding: 8px;">Power Strips</td>
      <td align="center" rowspan="1" style="border: 1px solid black; padding: 8px;">EP40</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.2</td>
    </tr>
    <tr>
      <td align="center" rowspan="1" style="border: 1px solid black; padding: 8px;">EP40M</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">HS107</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.8</td>
    </tr>
    <tr>
      <td align="center" rowspan="4" style="border: 1px solid black; padding: 8px;">HS300</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.10</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.21</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.12</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">KP200</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">3.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">KP303</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (UK)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.9</td>
    </tr>
    <tr>
      <td align="center" rowspan="4" style="border: 1px solid black; padding: 8px;">KP400</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.10</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.6</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">3.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.4</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">P300</td>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.7</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.13</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.15</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">P304M</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (UK)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">TP25</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.2</td>
    </tr>
    <tr>
      <td align="center" rowspan="31" style="border: 1px solid black; padding: 8px;">Switches</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">ES20M</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.8</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.11</td>
    </tr>
    <tr>
      <td align="center" rowspan="5" style="border: 1px solid black; padding: 8px;">HS200</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.5.7</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">3.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.5</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">5.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.2</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.11</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">5.26 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3*</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">HS210</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.5.8</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.5</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">HS220</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.5.7</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">3.26 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.1*</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KP405</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.6</td>
    </tr>
    <tr>
      <td align="center" rowspan="4" style="border: 1px solid black; padding: 8px;">KS200M</td>
      <td align="center" rowspan="4" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.8</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.10</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.11</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.12</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KS205</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.2*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">KS220</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.13</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">KS220M</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.4</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KS225</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.2*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">KS230</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.14</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">KS240</td>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.4*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.7*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">S500D</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">S505</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.2</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">S505D</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0</td>
    </tr>
    <tr>
      <td align="center" rowspan="39" style="border: 1px solid black; padding: 8px;">Light Bulbs</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">KL110</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.8.11</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KL120</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.8.6</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.8.11</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">KL125</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.20 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.7</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">4.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KL130</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.8.8</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.8.11</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KL135</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.6</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.15</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">KL50</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.13</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KL60</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (UN)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.4</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.13</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">LB110</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.8.11</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">L501B</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">3.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">L510E</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">3.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.2</td>
    </tr>
    <tr>
      <td align="center" rowspan="4" style="border: 1px solid black; padding: 8px;">L530E</td>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">3.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.6</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.6</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">L630</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.2</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">KL400L5</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.5</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.8</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">KL420L5</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.2</td>
    </tr>
    <tr>
      <td align="center" rowspan="5" style="border: 1px solid black; padding: 8px;">KL430</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.0 (UN)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.8</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.10</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">2.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.8</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.9</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.11</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">L900-10</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.17</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.11</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">L900-5</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.17</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0</td>
    </tr>
    <tr>
      <td align="center" rowspan="4" style="border: 1px solid black; padding: 8px;">L920-5</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.7</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.3</td>
    </tr>
    <tr>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.0</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.3</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">L930-5</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (US)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.1.2</td>
    </tr>
  </tbody>
</table>
</div>

### Credits
-   Huge thanks to rytilahti and all the developers at python-kasa for the [Python-Kasa API](https://github.com/python-kasa/python-kasa), plasticrake for the [Unofficial API documentation](https://github.com/plasticrake/tplink-smarthome-api), and maxileith for [Excellent Python Implementation](https://github.com/maxileith/homebridge-appletv-enhanced).