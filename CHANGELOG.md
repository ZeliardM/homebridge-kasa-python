# Changelog

## [2.8.0](https://github.com/ZeliardM/homebridge-kasa-python/releases/tag/v2.8.0) (2025-09-05)

### What's Changed

- Complete Rewrite of Device Discovery
- Update dependencies
- Rewrite and refactor platform.ts, utils.ts, deviceManager.ts, and kasaApi.py to handle devices as they are discovered.
- Updated pythonChecker.ts and runCommand in utils.ts to handle user profiles.
- Bump to v2.8.0-beta.0
- Update task handling for shutdown
- Update logging
- Update dependencies
- Bump to v2.8.0-beta.1
- Add dictionary check for hsv values
- Bump to v2.8.0-beta.2
- EventEmitter maxListener update
- Update axiosError handling
- Update color_temp and hsv handling
- Update requirements and dependencies
- Bump to v2.8.0-beta.3
- Improved color temp handling
- Improve brightness and fan speed handling
- Update dependencies
- Bump to v2.8.0-beta.4
- Add homebrew checking to user path for python
- Update requirements and dependencies
- Finish updating dependencies
- Fix lint and import issue with newer homebridge install
- Bump to v2.8.0-beta.5
- Add strictValidation and update dependencies and requirements
- Add user configurable Python Path to config
- Update config.sample.json
- Bump to v2.8.0-beta.6
- Add support for L535E Bulbs
- Added manual support for TS15 Matter Switches, waiting on fixture file from user
- Fix brew environment check errors
- Fix pythonChecker error logging
- Fix error reporting for Python version check
- Fix isShuttingDown check for periodicDiscovery
- Bump to v2.8.0-beta.7
- Add KL400L10 support
- Update dependencies
- Bump to v2.8.0-beta.8
- Add anyio to requirements due to now missing on many user reports
- Bump to v2.8.0-beta.9
- Add include mac address features
- Added manual support for P400M Power Strip, waiting on fixture file from user
- Update dependencies
- Bump to v2.8.0-beta.10
- Update node typescript config
- Create OS agnostic pythonChecker.ts and update related files
- Fix Homebridge version check logging
- Bump to v2.8.0-beta.11
- Fix Homebridge version check
- Additional logging for getPythonHome
- Added support for S500 Wall Switch
- Bump to v2.8.0-beta.12
- Implement Energy Usages for PowerStrip and Plug
- Bump to v2.8.0-beta.13
- Merge branch 'v2.8.0-beta' into latest

**Full Changelog**: https://github.com/ZeliardM/homebridge-kasa-python/compare/v2.7.2...v2.8.0