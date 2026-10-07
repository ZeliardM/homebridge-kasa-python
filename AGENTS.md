# homebridge-kasa-python

Homebridge plugin (platform `KasaPython`) for TP-Link Kasa and Tapo devices: a TypeScript platform that starts a bundled Quart/Uvicorn Python service, which drives a pinned `python-kasa` from PyPI and talks back over HTTP and SSE. The owner's own plugin, published on npm. Work on `beta`; `latest` is the stable branch.

## Layout

- `src/platform.ts`: platform. `src/devices/`: HomeKit accessories and the TypeScript client for the local API. `src/python/`: the Python service (`kasaApi.py`, `startKasaApi.py`) and `pythonChecker.ts`, which prepares the plugin's venv from `requirements.txt`.
- `.github/`: release automation; the workflows call stdlib-only Python 3 scripts in `.github/scripts/`.

## Build and test

```bash
npm run lint    # eslint over src, zero warnings
npm run build   # npm ci, tsc, then copies src/python into dist/python
node -e "import('./dist/index.js').then(() => console.log('import OK'))"
npm pack --dry-run   # when package contents change
```

There are no unit tests. CI runs Node 22, 24 and 26 with Python 3.11 to 3.14: it installs `requirements.txt`, lints, builds, imports `dist/index.js` and imports every module in `requirements.txt`. Validate the TypeScript and Python halves separately for what you changed, and say what was not covered.

Deploy: `homebridge-deploy --plugin homebridge-kasa-python` (only after my yes).

## Rules

- Branch from `beta` and target PRs at `beta`. `latest` changes only through the beta-to-stable workflow.
- Start commit messages with a bracketed label: `[enhancement]` or `[feature]`, `[bug]` or `[fix]`, `[breaking-change]`, `[other]`. The release scripts sort changelog entries by it.
- Don't edit `CHANGELOG.md` or bump `version` by hand: the workflows do both.
- Homebridge lifecycle, config and schema, accessory UUID and cache identity, services, characteristics, polling and process orchestration stay in TypeScript. HTTP/SSE serialization, `python-kasa` object caches and locks, and dispatch stay in `src/python/`. TP-Link wire behaviour belongs in `python-kasa`; don't copy protocol code into this plugin.
- Preserve readiness via `/health`, discovery via `/discover` plus `/stream`, the status and control contracts, stable device and child identity, and false/zero/missing JSON semantics.
- Clean up timers, queues, EventSource and HTTP work, cached devices, Uvicorn and the Python child process deterministically.
- `requirements.txt` lines are `name==version`, optionally with a `python_version` marker; `pythonChecker.ts` parses them.
- The TP-Link account lives in the Homebridge config.
