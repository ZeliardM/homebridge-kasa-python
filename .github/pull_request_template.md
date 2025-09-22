# Pull Request

<!--
Thank you for your contribution!

Default base branch
- Pull requests should target the 'beta' branch by default.
- If you chose a different base, the workflow will retarget this PR to 'beta'.

Please complete the sections below to help with review and release notes.
-->

## Summary
<!-- Short description of the change. What does this PR do? -->

## Type (choose at least one classification)
<!-- At least one of these is required by validation -->
- [ ] fix (bug fix)
- [ ] bug
- [ ] enhancement / feature
- [ ] docs
- [ ] dependency
- [ ] breaking-change
- [ ] internal / workflow

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

## Breaking Change Explanation (REQUIRED if breaking-change label)
Markers exactly:

BREAKING_CHANGE_EXPLANATION_START
<explanation of what breaks, why unavoidable, migration steps>
BREAKING_CHANGE_EXPLANATION_END

## Checklist
- [ ] Base branch is `beta`
- [ ] Classification labels applied (see “Type” above)
- [ ] Changelog impact understood
- [ ] Docs updated where appropriate
- [ ] Linked issues (if any): #123