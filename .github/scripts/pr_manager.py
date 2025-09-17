#!/usr/bin/env python3
"""
PR Validation:
- Base branch must be 'beta'
- EXCEPTION: allow base 'latest' for stable-conversion PRs to promote beta -> latest:
    - head ref must be 'beta'
    - label 'stable-conversion' must be present, OR the PR author/actor is github-actions[bot]
- Needs at least one classification label:
    bug, fix, enhancement, feature, breaking-change, docs, dependency, internal, workflow
- If breaking-change: require markers with >= MIN_EXPL_CHARS explanation bounded by:
    BREAKING_CHANGE_EXPLANATION_START ... BREAKING_CHANGE_EXPLANATION_END
- Skip for draft PRs
"""
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

CLASSIFICATION = {
    "bug", "fix", "enhancement", "feature", "breaking-change", "docs", "dependency", "internal", "workflow",
}
START = "BREAKING_CHANGE_EXPLANATION_START"
END = "BREAKING_CHANGE_EXPLANATION_END"
MIN_EXPL_CHARS = 60

def _give(payload, code=0):
    print(json.dumps(payload))
    sys.exit(code)

def main():
    actor = os.getenv("GITHUB_ACTOR", "")
    event_path = os.getenv("GITHUB_EVENT_PATH")
    if not event_path or not os.path.isfile(event_path):
        _give({"ok": False, "code": "internal", "message": "Missing GITHUB_EVENT_PATH"}, 1)
    try:
        with open(event_path, "r", encoding="utf-8") as f:
            event = json.load(f)
    except Exception as e:
        _give({"ok": False, "code": "internal", "message": f"Unable to parse event: {e}"}, 1)
    pr = event.get("pull_request")
    if not pr:
        _give({"ok": False, "code": "internal", "message": "Not a pull_request event"}, 1)
    if pr.get("draft") is True:
        _give({"ok": True}, 0)
    base = (pr.get("base") or {}).get("ref", "")
    head_ref = (pr.get("head") or {}).get("ref", "")
    author_login = ((pr.get("user") or {}).get("login") or "")
    token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN") or ""
    repo_full = os.getenv("GITHUB_REPOSITORY", "")
    pr_number = pr.get("number")
    body = pr.get("body") or ""
    labels = [((l.get("name") or "").lower()) for l in pr.get("labels", [])]
    if token and repo_full and pr_number:
        code, data = common.github_api(repo_full, token, f"/issues/{pr_number}/labels")
        if code == 200 and isinstance(data, list):
            labels = [((l.get("name") or "").lower()) for l in data]
    is_stable_conversion = (
        base == "latest"
        and head_ref == "beta"
        and ("stable-conversion" in labels or author_login == "github-actions[bot]" or actor == "github-actions[bot]")
    )
    if not (base == "beta" or is_stable_conversion):
        _give({"ok": False, "code": "bad_base", "message": f'Invalid base branch "{base}". Must be "beta".'}, 1)
    if not any(l in CLASSIFICATION for l in labels):
        need = ", ".join(sorted(CLASSIFICATION))
        curr = labels or []
        _give({"ok": False, "code": "missing_label",
               "message": f"No classification label found. Need one of: {need}. Current: {curr}"}, 1)
    if "breaking-change" in labels:
        s = body.find(START)
        e = body.find(END)
        if s == -1 or e == -1 or e <= s:
            _give({"ok": False, "code": "breaking_markers",
                   "message": f'breaking-change label requires markers:\n{START}\n...explanation...\n{END}'}, 1)
        expl = (body[s + len(START):e]).strip()
        if len(expl) < MIN_EXPL_CHARS:
            _give({"ok": False, "code": "breaking_short",
                   "message": f"Breaking change explanation too short ({len(expl)} chars). Provide rationale + migration steps (min {MIN_EXPL_CHARS})."}, 1)
    _give({"ok": True}, 0)

if __name__ == "__main__":
    main()