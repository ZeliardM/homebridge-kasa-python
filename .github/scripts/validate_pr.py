#!/usr/bin/env python3
"""
PR Validation:
- Base branch must be 'beta'
- Needs at least one classification label: bug, fix, enhancement, feature, breaking-change, docs, dependency
- If breaking-change: require markers with >= 60 chars explanation
- Skip for github-actions[bot]
Outputs JSON error summary to stdout for workflow consumption.
"""
import json, os, sys

CLASSIFICATION = {"bug","fix","enhancement","feature","breaking-change","docs","dependency"}
START = "BREAKING_CHANGE_EXPLANATION_START"
END = "BREAKING_CHANGE_EXPLANATION_END"

def fail(message, code="validation_failed"):
    payload = {"ok": False, "code": code, "message": message}
    print(json.dumps(payload))
    sys.exit(1)

def ok():
    print(json.dumps({"ok": True}))
    sys.exit(0)

def main():
    actor = os.getenv("GITHUB_ACTOR","")
    path = os.getenv("GITHUB_EVENT_PATH")
    if not path or not os.path.isfile(path):
        fail("Missing GITHUB_EVENT_PATH", "internal")

    with open(path,"r",encoding="utf-8") as f:
        event = json.load(f)

    pr = event.get("pull_request")
    if not pr:
        fail("Not a pull_request event", "internal")

    if actor == "github-actions[bot]":
        ok()

    base = pr.get("base",{}).get("ref","")
    if base != "beta":
        fail(f'Invalid base branch "{base}". Must be "beta".', "bad_base")

    labels = [ (l.get("name") or "").lower() for l in pr.get("labels",[]) ]
    body = pr.get("body") or ""

    if not any(l in CLASSIFICATION for l in labels):
        fail(f"No classification label found. Need one of: {', '.join(sorted(CLASSIFICATION))}. Current: {labels or '[]'}", "missing_label")

    if "breaking-change" in labels:
        s = body.find(START); e = body.find(END)
        if s == -1 or e == -1 or e <= s:
            fail(f'breaking-change label requires markers:\n{START}\n...explanation...\n{END}', "breaking_markers")
        segment = body[s+len(START):e].strip()
        if len(segment) < 60:
            fail(f'Breaking change explanation too short ({len(segment)} chars). Provide rationale + migration steps.', "breaking_short")

    ok()

if __name__ == "__main__":
    main()
