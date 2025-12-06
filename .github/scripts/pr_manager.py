#!/usr/bin/env python3
"""
Single-script PR handler.

Responsible ONLY for semantic validation of the PR. All environment checks,
fork handling, retargeting, and labeling are done in the workflow.

Rules:
- Skip validation for draft PRs.
- Base branch must be 'beta', except for stable-conversion PRs:
    * base == 'latest'
    * head == 'beta'
    * AND label 'stable-conversion'
- Needs at least one classification label:
    bug, fix, enhancement, feature, breaking-change, docs, dependency, internal, workflow
- If breaking-change label:
    * Require markers:
        BREAKING_CHANGE_EXPLANATION_START
        ...explanation...
        BREAKING_CHANGE_EXPLANATION_END
    * Explanation must be at least 60 characters.

Returns messages used by the workflow to build a sticky comment
"""
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

from common import Context

CLASSIFICATION = {
    "bug",
    "fix",
    "enhancement",
    "feature",
    "breaking-change",
    "docs",
    "dependency",
    "internal",
    "workflow",
}
START = "BREAKING_CHANGE_EXPLANATION_START"
END = "BREAKING_CHANGE_EXPLANATION_END"

def _handle_validate(context: Context) -> dict:
    code, pr = common.github_api(context.github_repository, context.github_token, f"/pulls/{context.pull_request_number}")
    if code != 200 or not isinstance(pr, dict):
        return {
            "ok": False,
            "messages": [f"Unable to fetch PR #{context.pull_request_number} (status {code})."],
        }
    if pr.get("draft") is True:
        return {"ok": False, "messages": [f"PR #{context.pull_request_number} is a draft; skipping validation."]}
    base = (pr.get("base") or {}).get("ref", "") or ""
    head_ref = (pr.get("head") or {}).get("ref", "") or ""
    body = pr.get("body") or ""
    labels: list[str] = []
    label_code, data = common.github_api(context.github_repository, context.github_token, f"/issues/{context.pull_request_number}/labels")
    if label_code == 200 and isinstance(data, list):
        labels = [((l.get("name") or "").lower()) for l in data]
    if not labels:
        labels = [((l.get("name") or "").lower()) for l in pr.get("labels", [])]
    ok = True
    messages: list[str] = []
    is_stable_conversion = (
        base == "latest"
        and head_ref == "beta"
        and "stable-conversion" in labels
    )
    if not (base == "beta" or is_stable_conversion):
        ok = False
        messages.append(
            f'Invalid base branch "{base}". '
            'Pull requests must target "beta", except for stable-conversion PRs '
            '(beta -> latest with the "stable-conversion" label).'
        )
    if not any(l in CLASSIFICATION for l in labels):
        needed = ", ".join(sorted(CLASSIFICATION))
        current = ", ".join(sorted(set(labels))) if labels else "<none>"
        ok = False
        messages.append(
            "Missing classification label. "
            f"Required: one of [{needed}]. Current labels: {current}."
        )
    if "breaking-change" in labels:
        s = body.find(START)
        e = body.find(END)
        if s == -1 or e == -1 or e <= s:
            ok = False
            messages.append(
                "The `breaking-change` label requires explanation markers:\n"
                f"{START}\n"
                "...detailed explanation and migration steps...\n"
                f"{END}"
            )
        else:
            expl = (body[s + len(START) : e]).strip()
            if len(expl) < 60:
                ok = False
                messages.append(
                    f"Breaking change explanation too short ({len(expl)} characters). "
                    f"Provide rationale and migration steps (minimum 60 characters) "
                    f"between {START} and {END}."
                )
    return {"ok": ok, "messages": messages}

def main():
    github_repository = os.getenv("GITHUB_REPOSITORY")
    github_token = os.getenv("GITHUB_TOKEN")
    pull_request_number = os.getenv("PULL_REQUEST_NUMBER")
    context = Context(github_token=github_token, github_repository=github_repository, pull_request_number=pull_request_number)
    result = _handle_validate(context)
    print(json.dumps(result))
    sys.exit(0)

if __name__ == "__main__":
    main()