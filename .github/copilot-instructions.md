# Homebridge Kasa Python - Copilot Coding Agent Onboarding

## Repository Overview

This repository is a Homebridge platform plugin that bridges TP-Link Kasa/Tapo smart devices (plugs, switches, bulbs, power strips, light strips) to Apple HomeKit. It uses a hybrid architecture: the main orchestration, accessory management, and Homebridge integration is in TypeScript/Node.js; direct device communication and control is handled by Python scripts using the [python-kasa](https://github.com/python-kasa/python-kasa) library, exposed via a local API.

- **Type**: Homebridge plugin for smart home integration
- **Languages**: TypeScript/Node.js (ES Modules), Python 3.11/3.12/3.13
- **Supported Devices**: Plugs, power strips, switches, bulbs, light strips (see README for full list)
- **Target Runtime**: Node.js 20/22/24, Python 3.11/3.12/3.13
- **Size**: ~3,000 lines TypeScript, several Python scripts
- **Main Entry**: `src/index.ts`, `src/platform.ts`
- **Python API Entrypoint**: `src/python/kasaApi.py`, startup: `src/python/startKasaApi.py`
- **Configuration Schema**: `config.schema.json`
- **Linting**: ESLint (config: `eslint.config.mjs`)
- **Build Output**: Compiled JS in `dist/`, Python scripts copied to `dist/python/`

## Environment Setup and Build Instructions

**CRITICAL:** This project **requires both Node.js AND Python environments** set up correctly. All device communication will fail if Python dependencies are missing.

### Environment Setup

1. **Python Setup (ALWAYS FIRST):**
   ```bash
   python3 -m pip install --upgrade pip
   python3 -m pip install -r requirements.txt
   ```
   - If install times out, verify with:
     ```bash
     python3 -c "import kasa; print('Python Import OK')"
     ```

2. **Node.js Setup (Supported: 20/22/24):**
   - Always use **`npm ci`** (never `npm install`)
   ```bash
   npm ci
   ```

### Build, Lint, and Validation (ALWAYS in order):

```bash
npm run lint            # Lint (must pass, zero warnings)
npm run build           # Build (runs: npm ci && rimraf -I ./dist && tsc && node copyPythonFiles.js)
node -e "import('./dist/index.js').then(()=>console.log('Node OK'))"
python3 -c "import kasa; print('Python Import OK')"
```

- **Development/watch**: `npm run watch` (rebuilds and links automatically)
- **Test**: `npm run test` (outputs "No test specified")
- **Lint only**: `npm run lint`

#### Common Troubleshooting

- **Python errors at runtime**: Python dependencies *must* be installed first.
- **rimraf not found**: Run `npm ci` to install dev dependencies.
- **Missing dist/python files**: Build process copies Python files from `src/python/` to `dist/python/`.
- **Pip install timeout**: If network issues, verify using import command above.
- **Build will succeed even if Python deps are missing, but runtime will fail.**

#### Build Timing

- Clean build: ~10-15 seconds; incremental builds are faster.
- Pip install can timeout; verify via import.

## Project Architecture and Layout

**Root files:**
- `package.json` - Node dependencies, scripts
- `tsconfig.json` - TypeScript config  
- `requirements.txt` - Python dependencies
- `eslint.config.mjs` - ESLint config
- `config.schema.json` - Homebridge config schema
- `copyPythonFiles.js` - Copies Python scripts to dist
- `nodemon.json` - Watch config

**Source:**
```
src/
├── index.ts                  # Plugin registration
├── platform.ts               # Main platform logic
├── config.ts                 # Config parsing/validation
├── settings.ts               # Platform/plugin names
├── utils.ts                  # Utility functions
├── taskQueue.ts              # Task management
├── accessoryInformation.ts   # HomeKit accessory info
├── devices/
│   ├── index.ts              # Base accessory class
│   ├── create.ts             # Device creation factory
│   ├── deviceManager.ts      # Device communication manager
│   ├── kasaDevices.ts        # Type definitions
│   ├── homekitPlug.ts        # Plug logic
│   ├── homekitPowerStrip.ts  # Power strip logic
│   ├── homekitSwitch.ts      # Switch logic
│   ├── homekitLightBulb.ts   # Bulb logic
│   └── homekitSwitchWithChildren.ts # Multi-child switches/fans
└── python/
    ├── kasaApi.py            # Python API bridge
    ├── startKasaApi.py       # API server startup
    └── pythonChecker.ts      # Python env validation (Node-side)
```
- **Build output:**  
  - `dist/` - Compiled JS + copied Python files
  - `dist/python/` - Python scripts

## Device Implementation Patterns

- **Device factory:** `src/devices/create.ts` creates HomeKit device instances for discovered Kasa devices.
- **Base class:** `src/devices/index.ts` is the HomeKitDevice base class.
- **Accessory logic:** Device types (plug, bulb, power strip, switch, multi-child) each have dedicated classes.
- **Python bridge:** All device control/state queries use the Python API via HTTP.
- **State management:** Accessories poll and synchronize state with the underlying device.

## CI/CD and Validation Workflows

### Included Workflows

- **build-lint-test.yml**  
  - Runs on push, PR, and workflow_call for `latest` and `beta` branches.
  - Matrix builds: Node.js 20/22/24, Python 3.11/3.12/3.13.
  - Steps: setup environments, install dependencies (Python always before Node), lint, build, test Node.js import, test Python imports, audit dependencies.

- **handle-issue.yml**  
  - Runs on GitHub Issue opened/edited/reopened.
  - Classifies the issue and applies canonical labels.
  - Clears all labels and enforces a single canonical label.
  - Posts sticky comment with classification and validation results.
  - Fails validation if required info/labels are missing; marks with `needs-info` if insufficient.

- **handle-pr.yml**  
  - Runs on PR events.
  - Retargets PR base to `beta` unless stable-conversion (beta->latest) PR.
  - Clears labels (unless stable-conversion), applies labels via labeler, validates base/labels/markers.
  - Sticky comments for validation results.
  - Fails invalid PRs (wrong base, missing classification label, missing breaking change explanation markers).

- **flow-beta.yml**  
  - On PR merged to `beta`, updates changelog, beta draft, and aligns package versions.
  - On beta release published, finalizes changelog section, adds housekeeping entry, retags to include finalize commit.

- **flow-stable.yml**  
  - On stable-conversion PR merged to `latest` (with `stable-conversion` label), aggregates published betas into a stable draft, updates changelog, aligns package versions.
  - On stable release published, finalizes changelog section, adds housekeeping entry, retags release tag to include finalize commit.

- **beta-release.yml**  
  - Runs on published beta releases.
  - Calls build-lint-test then npm-publish workflow (publishes to npm under beta dist-tag).
  - Notifies Discord with trimmed release notes.

- **release.yml**  
  - Runs on published stable releases (base: latest).
  - Calls build-lint-test then npm-publish workflow (publishes to npm).
  - Notifies Discord.

- **beta-to-stable.yml**  
  - Manual workflow_dispatch to create or update a beta→latest PR for the next stable version, auto-detected from latest published beta tag.

- **npm-publish.yml**  
  - Publishes to npm, handles rollback if publish fails (delete tag/release, undo CHANGELOG finalize metadata).

- **discord-notify.yml**  
  - Posts release event to Discord, with trimmed notes and changelog bullets.

- **dependabot-auto-merge.yml**  
  - Auto-labels and merges safe Dependabot PRs (minor/patch, no breaking-change).
  - Posts sticky comment for blocked/auto-merged PRs.

- **codeql.yml**  
  - Runs CodeQL analysis on JS/TS and Python for security and code quality.

- **stale.yml**  
  - Marks issues and PRs as stale after inactivity, closes after additional days unless updated.

### Key Workflow Enforcement Rules

- **All PRs must target `beta` branch** (except stable-conversion PRs from beta→latest, which require the `stable-conversion` label).
- **Labels are cleared and reapplied** for every PR/issue to enforce canonical forms (`bug`, `enhancement`, `breaking-change`, etc.).
- **PR validation**: Base branch, classification labels, breaking-change markers, and explanation length enforced (see `.github/pull_request_template.md`).
- **Issue validation**: Must have canonical label; required sections for bug/breaking-change types; `needs-info` applied if insufficient.
- **Release automation**: On PR merge, changelog and draft release are updated and aligned; on publish, changelog is finalized and NPM publish is triggered.
- **Manual workflow for beta→stable PRs**: Use workflow_dispatch to aggregate published betas into a stable draft.
- **Sticky comments**: Summarize validation/classification status for PRs and issues.

**To replicate CI locally:**
```bash
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
python3 -c "import kasa; print('Python Import OK')"
npm ci
npm run lint
npm run build
node -e "import('./dist/index.js').then(()=>console.log('Node OK'))"
python3 -c "import kasa; print('Python Import OK')"
```

## PR and Issue Handling Workflow

**Branch Model:**
- `latest`: Stable release
- `beta`: Active development (**feature branches must be created from `beta`**)
- **PRs:** Always target `beta`

**PR Checklist:**
- Install Python & Node dependencies, build, lint, import tests **before submitting**
- Label appropriately: `enhancement`, `fix`, `breaking-change`, `docs`, `dependency`
- **One logical change per PR**
- PRs must describe the change and reference relevant issues
- PRs must not include extraneous/unrelated changes

**Issue Handling:**
- Use GitHub Issues for bugs, features, support
- When generating issues, always clarify ambiguity and include relevant context/code references

**Release Flow:**
- Merge PR into `beta` triggers changelog update and beta draft
- Unpublished beta.0 aggregates PRs (single tag per beta)
- After publishing a beta, new changes create beta.(N+1)
- Breaking changes after publish escalate to new major beta.0
- Manual conversion (workflow_dispatch) consolidates betas into a stable draft
- Publishing stable release finalizes changelog

**Changelog:**
- Beta releases mirror only their version’s section
- Stable releases omit “Beta Release -” line
- All changes must be categorized and labeled

**Labels:**
- breaking-change
- enhancement/feature
- fix/bug
- docs/dependency

## Testing and Validation

**No formal unit tests exist.** Validation relies on:
- Lint checks for code quality
- Build success for compilation validity  
- Import tests for runtime compatibility
- Manual Homebridge testing (see README)
- Use `npm run watch` for live development; plugin is linked globally

## Common Troubleshooting

- **Build fails with Python errors:** Ensure Python dependencies are installed first.
- **Import test fails:** Verify both Node.js and Python are properly set up and compatible.
- **Lint failures:** Run `npm run lint` for details.
- **Watch mode issues:** Ensure no conflicting Homebridge instances are running.
- **Platform registration errors:** Confirm plugin is compiled and exports registration function.

## Key Dependencies

- **Node.js:** `axios`, `eventsource`, `ts-essentials`, `typescript`
- **Python:** `python-kasa`, `quart`, `uvicorn`, `anyio`
- **Dev:** `eslint`, `rimraf`, `nodemon`, `homebridge`

## Copilot Coding Agent Guidance

- **Follow these instructions directly for build, validation, PR, and issue workflows.**
- **For PRs:** Always create a feature branch from `beta`, never from `latest` or main.
- **Always run build/lint/import validation sequence before opening a PR.**
- **Label PRs** with the correct category.
- **Issues:** Clarify ambiguity before draft, include context.
- **Code changes:** Follow file structure; device logic in `src/devices/`, Python additions in `src/python/`.
- **Never skip Python dependency installation.**
- **Trust these instructions—search only if information here is incomplete or in error.**
- **Be concise, clear, and thoughtful in all responses, referencing this onboarding if needed.**

## Final Notes

- **Hybrid architecture:** Node.js orchestrates, Python controls devices.
- **Environment setup order is critical.**
- **Lint and build must always pass before PR—no exceptions.**
- **PRs must target `beta`, use feature branches, and be labeled.**
- **Trust these instructions—search only if necessary.**
