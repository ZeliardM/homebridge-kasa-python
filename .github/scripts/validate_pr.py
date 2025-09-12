#!/usr/bin/env python3
"""
PR Validation:
- Base branch must be 'beta'
- Needs at least one classification label: bug, fix, enhancement, feature, breaking-change, docs, dependency
- If breaking-change: require markers with >= MIN_EXPL_CHARS explanation
- Skip for github-actions[bot] and for draft PRs
Prints JSON to stdout:
  { "ok": true } on success
  { "ok": false, "code": "...", "message": "..." } on failure
"""
import json, os, sys

CLASSIFICATION = {"bug","fix","enhancement","feature","breaking-change","docs","dependency"}
START = "BREAKING_CHANGE_EXPLANATION_START"
END = "BREAKING_CHANGE_EXPLANATION_END"
MIN_EXPL_CHARS = 60

def give(payload, code=0):
    print(json.dumps(payload))
    sys.exit(code)

def main():
        actor = os.getenv("GITHUB_ACTOR","")
        path = os.getenv("GITHUB_EVENT_PATH")

        if actor == "github-actions[bot]":
            give({"ok": True}, 0)

        if not path or not os.path.isfile(path):
            give({"ok": False, "code": "internal", "message": "Missing GITHUB_EVENT_PATH"}, 1)

        try:
            with open(path,"r",encoding="utf-8") as f:
                event = json.load(f)
        except Exception as e:
            give({"ok": False, "code": "internal", "message": f"Unable to parse event: {e}"}, 1)

        pr = event.get("pull_request")
        if not pr:
            give({"ok": False, "code": "internal", "message": "Not a pull_request event"}, 1)

        if pr.get("draft") is True:
            give({"ok": True}, 0)

        base = (pr.get("base") or {}).get("ref","")
        if base != "beta":
            give({"ok": False, "code": "bad_base", "message": f'Invalid base branch "{base}". Must be "beta".'}, 1)

        labels = [ (l.get("name") or "").lower() for l in pr.get("labels",[]) ]
        body = pr.get("body") or ""

        if not any(l in CLASSIFICATION for l in labels):
            need = ", ".join(sorted(CLASSIFICATION))
            curr = labels or []
            give({"ok": False, "code": "missing_label",
                  "message": f"No classification label found. Need one of: {need}. Current: {curr}"}, 1)

        if "breaking-change" in labels:
            s = body.find(START); e = body.find(END)
            if s == -1 or e == -1 or e <= s:
                give({"ok": False, "code": "breaking_markers",
                      "message": f'breaking-change label requires markers:\n{START}\n...explanation...\n{END}'}, 1)
            expl = body[s+len(START):e].strip()
            if len(expl) < MIN_EXPL_CHARS:
                give({"ok": False, "code": "breaking_short",
                      "message": f"Breaking change explanation too short ({len(expl)} chars). Provide rationale + migration steps (min {MIN_EXPL_CHARS})."}, 1)

        give({"ok": True}, 0)

if __name__ == "__main__":
    main()