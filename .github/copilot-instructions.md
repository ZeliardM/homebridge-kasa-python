# Homebridge Kasa Python - Copilot Instructions

## Repository Overview

This is a Homebridge plugin that bridges TP-Link Kasa/Tapo smart home devices to Apple HomeKit using the Python-Kasa API library. The plugin is written in TypeScript/Node.js but relies on Python scripts for device communication, creating a dual-runtime architecture.

**Key Facts:**
- **Type**: Homebridge plugin (smart home integration)
- **Languages**: TypeScript/Node.js + Python 
- **Target**: Apple HomeKit integration for TP-Link Kasa/Tapo devices
- **Devices Supported**: Plugs, power strips, switches, bulbs, light strips
- **Size**: ~3,000 lines of TypeScript code
- **Architecture**: Node.js platform with Python API bridge

## Environment Requirements

**CRITICAL: This project requires both Node.js AND Python environments to be properly configured.**

**Node.js Requirements:**
- Supported versions: 20, 22, 24
- Uses ES modules (type: "module" in package.json)
- Always run `npm ci` before building (never `npm install`)

**Python Requirements:**
- Supported versions: 3.11, 3.12, 3.13
- Required packages defined in `requirements.txt`
- **ALWAYS install Python dependencies first**:

  ```bash
  python3 -m pip install --upgrade pip
  pip install -r requirements.txt
## Build and Validation Procedures

### Essential Build Sequence (ALWAYS follow this order):

1. **Install Python dependencies (REQUIRED FIRST):**
   ```bash
   python3 -m pip install --upgrade pip
   pip install -r requirements.txt
   ```
   Note: If pip install times out, the packages may already be installed. Verify with:
   ```bash
   python3 -c "import kasa; print('Python kasa import OK')"
   ```

2. **Install Node.js dependencies:**
   ```bash
   npm ci
   ```

3. **Lint the code:**
   ```bash
   npm run lint
   ```

4. **Build the project:**
   ```bash
   npm run build
   ```
   This runs: `npm ci && rimraf -I ./dist && tsc && node copyPythonFiles.js`

5. **Validate the build:**
   ```bash
   # Test Node.js import
   node -e "
   import('./dist/index.js')
     .then(() => console.log('Node import OK'))
     .catch(console.error)
   "
   
   # Test Python imports
   python3 -c "import kasa; print('Python kasa import OK')"
   ```

### Development Commands:

- **Watch mode** (rebuilds on changes): `npm run watch`
- **Test command**: `npm run test` (currently just outputs "No test specified")
- **Lint only**: `npm run lint`

### Common Build Issues and Solutions:

1. **Python import errors**: Always install Python dependencies first
2. **"rimraf command not found"**: Run `npm ci` to install dev dependencies
3. **TypeScript compilation errors**: Check Node.js version compatibility
4. **Missing dist/python files**: The build copies Python files from `src/python/` to `dist/python/`
5. **Pip timeout errors**: Network issues may cause pip install to timeout, but packages may still be installed - verify with import tests
6. **Build timing**: Full clean build takes ~10-15 seconds, incremental builds are faster

## Project Architecture and Layout

### Root Directory Files:
- `package.json` - Node.js dependencies and scripts
- `tsconfig.json` - TypeScript configuration  
- `requirements.txt` - Python dependencies
- `eslint.config.mjs` - ESLint configuration
- `config.schema.json` - Homebridge config schema
- `copyPythonFiles.js` - Custom script to copy Python files to dist
- `nodemon.json` - Development watch configuration

### Source Code Structure:
```
src/
├── index.ts              # Main plugin entry point
├── platform.ts           # Core platform logic
├── config.ts             # Configuration handling
├── settings.ts           # Plugin settings
├── utils.ts              # Utility functions
├── taskQueue.ts          # Task management
├── accessoryInformation.ts # HomeKit accessory info
├── devices/              # Device implementations
│   ├── index.ts          # Device factory
│   ├── create.ts         # Device creation logic
│   ├── deviceManager.ts  # Device management
│   ├── kasaDevices.ts    # Kasa device definitions
│   ├── homekitPlug.ts    # Plug device implementation
│   ├── homekitPowerStrip.ts # Power strip implementation
│   ├── homekitSwitch.ts  # Switch implementation
│   ├── homekitLightBulb.ts # Bulb implementation
│   └── homekitSwitchWithChildren.ts # Multi-outlet switches
└── python/               # Python bridge scripts
    ├── kasaApi.py        # Main Kasa API interface
    ├── startKasaApi.py   # API startup script
    └── pythonChecker.ts  # Python environment validation
```

### Build Output:
- `dist/` - Compiled JavaScript + copied Python files
- `dist/index.js` - Main plugin entry point
- `dist/python/` - Python scripts copied from src

## CI/CD and Validation Pipeline

### GitHub Workflows (.github/workflows/):
- `build.yml` - Main CI pipeline (build, lint, test on Node.js 20/22/24 + Python 3.11/3.12/3.13 matrix)
- `pull-request-check.yml` - PR validation
- `release.yml` - Production releases  
- `beta-release.yml` - Beta releases
- `changelog-release.yml` - Automated changelog generation

### Pre-commit Validation Steps:
1. **Lint check**: `npm run lint` (must pass with 0 warnings)
2. **Build verification**: `npm run build` (must complete successfully)
3. **Import tests**: Both Node.js and Python imports must work
4. **Dependency audit**: `npm audit` (warnings acceptable, errors should be addressed)

### CI Pipeline Replication:
To replicate CI locally, run this exact sequence (tested on Node.js 20.19.4, Python 3.12.3):
```bash
# Install Python dependencies
python3 -m pip install --upgrade pip
pip install -r requirements.txt

# Verify Python dependencies (if pip times out)
python3 -c "import kasa; print('Python Imports OK')"

# Install Node.js dependencies  
npm ci

# Lint
npm run lint

# Build
npm run build

# Test Node.js import
node -e "(async () => { try { await import('./dist/index.js'); console.log('Node Import OK'); } catch (err) { console.error(err); process.exit(1); } })()"

# Test Python dependencies
python3 -c "import kasa; print('Python Imports OK')"
```

## Key Dependencies and Configuration

### Runtime Dependencies (package.json):
- `axios` - HTTP client for API calls
- `eventsource` - Server-sent events
- `ts-essentials` - TypeScript utilities  
- `typescript` - TypeScript compiler

### Python Dependencies (requirements.txt):
> **Note:** Dependency versions may change. Always check `requirements.txt` for the current required versions.
- `python-kasa` - Core Kasa API library
- `quart` - Async web framework
- `uvicorn` - ASGI server
- `anyio` - Async I/O abstraction

### Development Dependencies (package.json `devDependencies`):
> **Note:** These are installed via `npm` and listed under `devDependencies` in `package.json`.
- `eslint` (with TypeScript support) - Linting and code quality
- `rimraf` - Clean builds (cross-platform `rm -rf`)
- `nodemon` - Development watch/reload
- `homebridge` - For local plugin testing
## Device Implementation Patterns

When working with device code:
- **Device factory**: `src/devices/create.ts` handles device creation
- **Base classes**: Each device type has a specific HomeKit implementation
- **Python bridge**: All Kasa API calls go through Python scripts in `src/python/`
- **State management**: Devices maintain state and handle HomeKit characteristic updates

## Common Troubleshooting

1. **Build fails with Python errors**: Ensure Python dependencies are installed first
2. **Import test fails**: Check both Node.js and Python environments are properly set up
3. **Lint failures**: Run `npm run lint` to see specific ESLint violations
4. **Watch mode issues**: Ensure Homebridge is not already running on the system
5. **Platform registration errors**: Check the plugin is properly compiled and index.js exports the registration function

## Testing and Validation

**No formal unit tests exist** - validation relies on:
- Lint checks for code quality
- Build success for compilation validity  
- Import tests for runtime compatibility
- Manual testing with actual Homebridge installation

For manual testing:
1. Use `npm run watch` for development with automatic rebuilds
2. Link the plugin globally with `npm link` (done automatically by watch command)
3. Test with a minimal Homebridge config that includes the plugin

## Important Notes for Agents

- **NEVER skip Python dependency installation** - the build will appear to succeed but runtime will fail
- **Always use `npm ci` not `npm install`** - ensures consistent dependency versions
- **Dual environment complexity** - remember this is not a pure Node.js project
- **Custom build process** - includes Python file copying step that is essential
- **ES modules** - use import/export syntax, not require/module.exports
- **Homebridge patterns** - follow Homebridge plugin conventions for platform registration and accessory creation

Trust these instructions and only search for additional information if the provided details are incomplete or incorrect.