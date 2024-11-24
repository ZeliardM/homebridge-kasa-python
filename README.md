<p align="center" style="text-align:center;">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150" style="display:block; margin:auto;">

</p>

<span align="center">

# Homebridge Kasa Python Plug-In

</span>

<p align="center">
  <a href="https://github.com/ZeliardM/homebridge-kasa-python/blob/latest/LICENSE"><img src="https://badgen.net/badge/license/MIT" alt="mit license"></a>
  <a href="https://www.npmjs.com/package/homebridge-kasa-python"><img src="https://img.shields.io/npm/v/homebridge-kasa-python" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/homebridge-kasa-python"><img src="https://badgen.net/npm/dt/homebridge-kasa-python" alt="npm downloads total"></a>
  <a href="https://www.npmjs.com/package/homebridge-kasa-python"><img src="https://badgen.net/npm/dm/homebridge-kasa-python" alt="npm downloads monthly"></a>
  <a href="https://www.paypal.me/ZeliardM/USD/"><img src="https://badgen.net/badge/donate/paypal/E69138" alt="donate"></a>
  <a href="https://github.com/sponsors/ZeliardM"><img src="https://badgen.net/badge/donate/github/E69138" alt="donate"></a>
  <a href="https://pypi.org/project/python-kasa/"><img src="https://img.shields.io/badge/Python-3.11%20%7C%203.12%20%7C%203.13-blue" alt="PyPI pyversions"></a>
  <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://badgen.net/badge/homebridge/verified/purple" alt="homebridge verified"></a>
</p>

<div align="center">

> ## IMPORTANT!!!
>This Plug-In Has Only Been Configured And Tested On Proxmox LXC. I Have Not Tested This On Any Other Platforms. If You Install It On Another Platform and It Works, Please Let Me Know So It Can Be Added To The List Of Supported Platforms.</p>
>Updates To Code Require Cached Accessories To Be Removed To Update Naming Conventions For Homebridge 2.0 Update.

</div>

This is a [Homebridge](https://github.com/homebridge/homebridge) plug-in based on the Python-Kasa API Library to interact with TP-Link Kasa Devices.

This plug-in will automatically discover your TP-Link Kasa Devices on your network locally only and configure them to be used in HomeKit.

Automatic Discovery is possible only for some devices, some newer devices require the Username and Password for your TP-Link Kasa Cloud Account. Credentials can be provided in the plug-in settings.

### Current Supported and Tested Devices
-   I currently have used this plug-in with the HS300 (US) Power Strip and the KP115 (US) Plug. All other devices are yet to be tested and fully supported. If you have a device that is a plug or power strip and it does work as expected in HomeKit, please let me know and I can add it to the list of tested and supported devices. I don't have a lot of devices so cannot fully test everything.

### Features

-   Automatically discover TP-Link Kasa Devices locally only on your network.
-   Change Device States for Plugs, Change Device States for Power Strips, Change Device State and Supports Dimming for Switches, Change Device State and Supports Hue, Saturation, and Value (HSV), Color, Color Temperature Adjustments, and Dimming for Bulbs and Light Strips that support those options.</p>*NOTE - Not All Functions Are Currently Supported, All Devices and Functions Could Be Supported By The Plug-In In The Furture.*</p>
-   Supported Devices from the API are listed below, Devices with an asterisks ('*') next to the specific firmware will require the Username and Password for your TP-Link Kasa Cloud Account to connect and function correctly.</p>*NOTE - Not All Devices Listed Below Are Supported By This Plug-In. These Devices Are Supported By The Python-Kasa API And Could Be Supported By The Plug-In In The Future.*</p>
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
      <td align="center" rowspan="24" style="border: 1px solid black; padding: 8px;">Plugs</td>
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
      <td align="center" rowspan="15" style="border: 1px solid black; padding: 8px;">Power Strips</td>
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
      <td align="center" rowspan="28" style="border: 1px solid black; padding: 8px;">Wall Switches</td>
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
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0.3</td>
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
      <td align="center" rowspan="14" style="border: 1px solid black; padding: 8px;">Bulbs</td>
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
      <td align="center" rowspan="8" style="border: 1px solid black; padding: 8px;">Light Strips</td>
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
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">Hubs</td>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">KH100</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.2.3*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.5.12*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (UK)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.5.6*</td>
    </tr>
    <tr>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">Hub-Connected Devices</td>
      <td align="center" rowspan="3" style="border: 1px solid black; padding: 8px;">KE100</td>
      <td align="center" rowspan="2" style="border: 1px solid black; padding: 8px;">1.0 (EU)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.4.0*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.8.0*</td>
    </tr>
    <tr>
      <td align="center" style="border: 1px solid black; padding: 8px;">1.0 (UK)</td>
      <td align="center" style="border: 1px solid black; padding: 8px;">2.8.0*</td>
    </tr>
  </tbody>
</table>
</div>

### Credits
-   Huge thanks to rytilahti and all the developers at python-kasa for the [Python-Kasa API](https://github.com/python-kasa/python-kasa), plasticrake for the [Unofficial API documentation](https://github.com/plasticrake/tplink-smarthome-api), and maxileith for [Excellent Python Implementation](https://github.com/maxileith/homebridge-appletv-enhanced).