# Changelog
## [v2.8.2-beta.0](https://github.com/ZeliardM/homebridge-kasa-python/releases/tag/v2.8.2-beta.0) (2025-09-13)

### Other Changes
- Update CHANGELOG.md for beta release v2.8.2-beta.0 @github-actions [beta-release]

- Fix CHANGELOG.md workflow not syncing properly with GitHub releases, add automated changelog maintenance, consolidate release workflows, implement comprehensive beta management system, optimize workflow code quality, and resolve Unreleased section handling @Copilot [#76]

### Bug Fixes
- Fix publish version matching package version @ZeliardM [#84]

- Complete release workflow consolidation - replace complex inline Python with unified release manager @Copilot [#81]

- Fix workflow issues: stale management, changelog updates, dependabot integration, labeler configuration, draft release section handling, and comprehensive testing validation @Copilot [#80]

**Full Changelog**: https://github.com/ZeliardM/homebridge-kasa-python/compare/v2.8.1...v2.8.2-beta.0

## [v2.8.1](https://github.com/ZeliardM/homebridge-kasa-python/releases/tag/v2.8.1) (2025-09-05)

### Other Changes

- Fix release-drafter.yml @ZeliardM [#74]

### Featured Changes

- Prepare for scoped plugin @ZeliardM [#73]

**Full Changelog**: https://github.com/ZeliardM/homebridge-kasa-python/compare/v2.8.0...v2.8.1

## [v2.8.0](https://github.com/ZeliardM/homebridge-kasa-python/releases/tag/v2.8.0) (2025-09-05)

### Breaking Changes

- Complete Rewrite of Device Discovery

### Featured Changes

- Add user configurable Python Path to config
- Add support for L535E Bulbs
- Added manual support for TS15 Matter Switches, waiting on fixture file from user
- Add KL400L10 support
- Add include mac address features
- Added manual support for P400M Power Strip, waiting on fixture file from user
- Added support for S500 Wall Switch
- Implement Energy Usages for PowerStrip and Plug

### Bug Fixes

- Fix brew environment check errors
- Fix pythonChecker error logging
- Fix error reporting for Python version check
- Fix isShuttingDown check for periodicDiscovery
- Fix lint and import issue with newer homebridge install
- Fix Homebridge version check logging
- Fix Homebridge version check

### Other Changes

- Rewrite and refactor platform.ts, utils.ts, deviceManager.ts, and kasaApi.py to handle devices as they are discovered
- Updated pythonChecker.ts and runCommand in utils.ts to handle user profiles
- Update task handling for shutdown
- Update logging
- Add dictionary check for hsv values
- EventEmitter maxListener update
- Update axiosError handling
- Update color_temp and hsv handling
- Improved color temp handling
- Improve brightness and fan speed handling
- Add homebrew checking to user path for python
- Add strictValidation and update dependencies and requirements
- Update config.sample.json
- Add anyio to requirements due to now missing on many user reports
- Update node typescript config
- Create OS agnostic pythonChecker.ts and update related files
- Additional logging for getPythonHome
- Update dependencies
- Update requirements and dependencies
- Finish updating dependencies
- Merge branch 'v2.8.0-beta' into latest

**Full Changelog**: https://github.com/ZeliardM/homebridge-kasa-python/compare/v2.7.2...v2.8.0
