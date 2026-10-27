# Pull Request

<!--
Thank you for your contribution!

Default base branch
- Pull requests should target the 'beta' branch by default.
- If you chose a different base, the workflow will retarget this PR to 'beta', and the build checks
  run only from your next push (or after closing and reopening the PR).

Please complete the sections below to help with review and release notes.
-->

## Summary
<!-- Short description of the change. What does this PR do? -->

## Labels
<!--
Labels are set from the branch name and the changed files when the PR is opened and on every push;
labels added by hand are removed. Name the branch for the change (see CONTRIBUTING.md):
- feat/... or feature/... -> enhancement
- fix/..., hotfix/... or <name>/fix-... -> fix
- bug/... or <name>/bug-... -> bug
- a name containing "breaking" -> breaking-change (then fill in the Breaking Change Explanation below)
docs (*.md), dependency (package.json, package-lock.json, requirements.txt) and workflow (.github/) come from the changed files.
Validation needs at least one label; changing src/ alone adds none.
-->

## Details
<!-- Why is this needed? What problem does it solve? Include links, context, etc. -->

## Testing
<!-- How did you test it? Steps, cases, environments. -->
- [ ] Build OK (`npm run build`)
- [ ] Lint clean
- [ ] Node import OK
- [ ] Python import OK
- [ ] Device(s) tested: <!-- list -->
- [ ] No unrelated changes

## Screenshots / Logs (optional)

## Breaking Change Explanation (REQUIRED if the branch name contains "breaking")
Markers exactly:

BREAKING_CHANGE_EXPLANATION_START
<explanation of what breaks, why unavoidable, migration steps>
BREAKING_CHANGE_EXPLANATION_END

## Checklist
- [ ] Base branch is `beta`
- [ ] Branch name gives the right label (see "Labels" above)
- [ ] Changelog impact understood
- [ ] Docs updated where appropriate
- [ ] Linked issues (if any): #123