#!/usr/bin/env python3
"""
Single-script issue handler with two modes:
- MODE=classify: determine canonical label (bug/enhancement/question/breaking-change/docs/dependency/internal/workflow),
  decide needs-info, and produce hints.
- MODE=validate: enforce presence of a classification label, fail if needs-info is present or
  minimal content is missing. Outputs messages for the workflow to post to the sticky.

Both modes fetch the live issue via the GitHub API to avoid stale event payloads.
"""
import json
import os
import re
import sys
from typing import List

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

MAP = {
    "bug": "bug",
    "fix": "bug",
    "feature": "enhancement",
    "enhancement": "enhancement",
    "support": "question",
    "question": "question",
    "breaking change": "breaking-change",
    "breaking-change": "breaking-change",
    "breaking": "breaking-change",
    "docs": "docs",
    "documentation": "docs",
    "dependency": "dependency",
    "dependencies": "dependency",
    "internal": "internal",
    "workflow": "workflow",
    "ci": "workflow",
    "housekeeping": "internal",
    "chore": "internal",
}
CLASSIFICATION = {"bug", "enhancement", "question", "breaking-change", "docs", "dependency", "internal", "workflow"}

def _section(body: str, title: str) -> str:
    pat = rf"(?is)^###\s*{re.escape(title)}\s*$\n(.*?)(?=^###\s|\Z)"
    mm = re.search(pat, body, re.MULTILINE)
    return (mm.group(1).strip() if mm else "").strip()

def _guess_kind(body: str) -> str:
    m = re.search(r"(?im)^###\s*Type\s*$", body)
    if m:
        lines = body.splitlines()
        try:
            idx = next(i for i, l in enumerate(lines) if re.match(r"(?im)^###\s*Type\s*$", l))
            for j in range(idx + 1, len(lines)):
                candidate = lines[j].strip()
                if candidate:
                    return candidate.lower()
        except StopIteration:
            pass
    lower = body.lower()
    if any(k in lower for k in ("traceback", "error", "stack")):
        return "bug"
    if "migration" in lower and "break" in lower:
        return "breaking change"
    if "feature" in lower or "enhancement" in lower:
        return "feature"
    if any(k in lower for k in ("docs", "documentation", "readme")):
        return "docs"
    if "dependen" in lower:
        return "dependency"
    if any(k in lower for k in ("support", "help", "question")):
        return "support"
    if any(k in lower for k in ("workflow", "github actions", "ci", "pipeline")):
        return "workflow"
    if any(k in lower for k in ("internal", "housekeeping", "chore")):
        return "internal"
    return ""

def _first_existing_classification(labels: List[str]) -> str:
    for l in labels:
        ll = (l or "").lower()
        if ll in CLASSIFICATION:
            return ll
    return ""

def do_classify(token: str, repo: str, num: str) -> dict:
    code, issue = common.github_api(repo, token, f"/issues/{num}")
    if code != 200 or not isinstance(issue, dict):
        return {
            "ok": True,
            "applied_label": "",
            "needs_info": True,
            "messages": [f"Unable to fetch issue #{num} (status {code})."],
            "current_labels": [],
        }
    body = issue.get("body") or ""
    current_labels = [(l.get("name") or "") for l in issue.get("labels", [])]
    kind = _guess_kind(body)
    canonical = MAP.get(kind, "")
    if not canonical:
        existing = _first_existing_classification(current_labels)
        if existing:
            canonical = existing
    needs_info = False
    messages: List[str] = []

    def msg(s: str):
        messages.append(s)

    if canonical == "bug":
        env = _section(body, "Environment")
        details = _section(body, "Details")
        if len(env) < 15:
            needs_info = True
            msg("Environment section missing or too short for bug.")
        if not re.search(r"\b(step|reproduce|expected|actual)\b", details, re.IGNORECASE):
            needs_info = True
            msg("Details should include reproduction steps and expected vs actual.")
    elif canonical == "breaking-change":
        migration = _section(body, "Migration Strategy")
        details = _section(body, "Details")
        if len(migration) < 30:
            needs_info = True
            msg("Migration Strategy needs >=30 chars.")
        if not re.search(r"(impact|rationale|break)", details, re.IGNORECASE):
            needs_info = True
            msg("Details should mention impact or rationale for breaking change.")
    elif canonical in ("enhancement", "question", "docs", "dependency", "internal", "workflow"):
        if not body or len(body.strip()) < 20:
            needs_info = True
            msg("Please provide more details about this request.")
    if not canonical:
        needs_info = True
        msg("Unable to classify issue type automatically. Please select a type or clarify in the description.")
    return {
        "ok": True,
        "applied_label": canonical,
        "needs_info": needs_info,
        "messages": messages,
        "current_labels": current_labels,
    }

def do_validate(token: str, repo: str, num: str) -> dict:
    code, issue = common.github_api(repo, token, f"/issues/{num}")
    if code != 200 or not isinstance(issue, dict):
        return {"ok": False, "messages": [f"Unable to fetch issue #{num} (status {code})."]}
    body = issue.get("body") or ""
    labels = [(l.get("name") or "").lower() for l in issue.get("labels", [])]
    ok = True
    messages: List[str] = []
    if not any(l in CLASSIFICATION for l in labels):
        ok = False
        messages.append(f"Missing classification label. Need one of: {', '.join(sorted(CLASSIFICATION))}. Current: {', '.join(labels)}")
    if "breaking-change" in labels:
        migration = _section(body, "Migration Strategy")
        details = _section(body, "Details")
        if len(migration) < 30:
            ok = False
            messages.append("Breaking change: Migration Strategy too short (<30 chars).")
        if not re.search(r"(impact|rationale|break)", details, re.IGNORECASE):
            ok = False
            messages.append("Breaking change: Details should mention impact or rationale.")
    if "needs-info" in labels:
        ok = False
        messages.append("Issue still marked as needs-info. Please provide the requested information.")
    if len(body.strip()) < 10:
        ok = False
        messages.append("Issue body is too short. Please add details.")
    return {"ok": ok, "messages": messages}

def main():
    mode = (os.getenv("MODE") or "").strip().lower()
    token = os.getenv("GITHUB_TOKEN") or ""
    repo = os.getenv("GITHUB_REPOSITORY", "")
    num = os.getenv("ISSUE_NUMBER", "")
    if not token or not repo or not num:
        if mode == "classify":
            print(
                json.dumps(
                    {
                        "ok": True,
                        "applied_label": "",
                        "needs_info": True,
                        "messages": ["Missing environment (token/repo/issue number)."],
                        "current_labels": [],
                    }
                )
            )
        else:
            print(json.dumps({"ok": False, "messages": ["Missing environment (token/repo/issue number)."]}))
        return
    if mode == "classify":
        print(json.dumps(do_classify(token, repo, num)))
    elif mode == "validate":
        print(json.dumps(do_validate(token, repo, num)))
    else:
        print(json.dumps({"ok": False, "messages": [f"Unknown MODE '{mode}'. Use classify or validate."]}))
        sys.exit(1)

if __name__ == "__main__":
    main()