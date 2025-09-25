# Contributing

Thank you for contributing to homebridge-kasa-python!

## Branch Model
- latest: Stable release branch.
- beta: Active development toward next release.
- Feature branches: Create from beta (not latest) and open PRs targeting beta.

## Pull Requests
1. Install Python deps first:
   ```bash
   python -m pip install --upgrade pip
   python -m pip install -r requirements.txt
   ```
2. Install Node deps: `npm ci`
3. Lint: `npm run lint` (must pass).
4. Build: `npm run build`
5. Sanity imports:
   ```bash
   node -e "import('./dist/index.js').then(()=>console.log('Node OK'))"
   python -c "import kasa; print('Python OK')"
   ```
6. Label appropriately: enhancement, fix, breaking-change, docs, dependency.
7. One logical change per PR.

## Release Flow (Simplified)
- Merge PR into beta -> CHANGELOG updated & draft/update of current beta automatically.
- Unpublished beta.0 aggregates subsequent PRs (single tag).
- After publishing a beta, new changes create beta.(N+1) drafts.
- Breaking change after publish escalates to new major base beta.0 when allowed.
- Manual conversion (workflow_dispatch) consolidates published betas into a stable draft.
- Publishing stable adds finalization entry.

## Changelog & Bodies
- vX.Y.Z-beta.N
  ```

  ## Category
  - entry

  **Full Changelog**: compare/<from>...<to>
  ```
- Stable body omits “-beta.N”.

## Labels
- breaking-change
- enhancement / feature
- fix / bug
- docs / dependency

## Security / Quality
- CodeQL runs weekly and on PRs.
- Dependabot weekly updates target beta.

## Questions
Open a support request issue or discussion.
