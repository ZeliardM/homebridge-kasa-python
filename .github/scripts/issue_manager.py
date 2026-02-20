#!/usr/bin/env python3
"""
Single-script issue handler with two modes:

- MODE=classify:
    * Determine canonical label (bug/enhancement/question/breaking-change/docs/dependency/internal/workflow)
    * Decide needs-info based on template completion and body length.

- MODE=validate:
    * Enforce presence of a classification label
    * Fail if needs-info is still present or minimal content is missing
    * Returns messages used by the workflow to build a sticky comment
"""
import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

from common import Context

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
CLASSIFICATION = {
    "bug",
    "enhancement",
    "question",
    "breaking-change",
    "docs",
    "dependency",
    "internal",
    "workflow",
}

def _section(body: str, title: str) -> str:
    lines = body.splitlines()
    in_section = False
    collected: list[str] = []
    for line in lines:
        if re.match(rf"^###\s*{re.escape(title)}\s*$", line, re.IGNORECASE):
            in_section = True
            continue
        if in_section:
            if re.match(r"^###\s", line):
                break
            collected.append(line)
    return "\n".join(collected).strip()

def _guess_kind(body: str) -> str:
    m = re.search(r"(?im)^###\s*Type\s*$", body)
    if m:
        lines = body.splitlines()
        try:
            idx = next(
                i
                for i, l in enumerate(lines)
                if re.match(r"(?im)^###\s*Type\s*$", l)
            )
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

def _first_existing_classification(labels: list[str]) -> str:
    for l in labels:
        ll = (l or "").lower()
        if ll in CLASSIFICATION:
            return ll
    return ""

def _handle_classify(context: Context) -> dict:
    code, issue = common.github_api(context.github_repository, context.github_token, f"/issues/{context.issue_number}")
    if code != 200 or not isinstance(issue, dict):
        return {
            "ok": True,
            "applied_label": "",
            "needs_info": True,
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
    if canonical == "bug":
        env = _section(body, "Environment")
        details = _section(body, "Details")
        if len(env) < 15:
            needs_info = True
        if not re.search(r"\b(step|reproduce|expected|actual)\b", details, re.IGNORECASE):
            needs_info = True
    elif canonical == "breaking-change":
        migration = _section(body, "Migration Strategy")
        details = _section(body, "Details")
        if len(migration) < 30:
            needs_info = True
        if not re.search(r"(impact|rationale|break)", details, re.IGNORECASE):
            needs_info = True
    elif canonical in ("enhancement", "question", "docs", "dependency", "internal", "workflow"):
        if not body or len(body.strip()) < 20:
            needs_info = True
    if not canonical:
        needs_info = True
    return {
        "ok": True,
        "applied_label": canonical,
        "needs_info": needs_info,
    }

def _handle_validate(context: Context) -> dict:
    code, issue = common.github_api(context.github_repository, context.github_token, f"/issues/{context.issue_number}")
    if code != 200 or not isinstance(issue, dict):
        return {
            "ok": False,
            "messages": [f"Unable to fetch issue #{context.issue_number} (status {code})."],
        }
    body = issue.get("body") or ""
    labels = [(l.get("name") or "").lower() for l in issue.get("labels", [])]
    ok = True
    messages: list[str] = []
    if not any(l in CLASSIFICATION for l in labels):
        ok = False
        messages.append(
            "Missing classification label. Need one of: "
            + ", ".join(sorted(CLASSIFICATION))
            + f". Current: {', '.join(labels)}"
        )
    if "breaking-change" in labels:
        migration = _section(body, "Migration Strategy")
        details = _section(body, "Details")
        if len(migration) < 30:
            ok = False
            messages.append("Breaking change: Migration Strategy too short (<30 chars).")
        if not re.search(r"(impact|rationale|break)", details, re.IGNORECASE):
            ok = False
            messages.append(
                "Breaking change: Details should mention impact or rationale."
            )
    if "needs-info" in labels:
        ok = False
        messages.append(
            "Issue is still marked as needs-info. Please provide the requested information."
        )
    if len(body.strip()) < 10:
        ok = False
        messages.append("Issue body is too short. Please add more details.")
    return {"ok": ok, "messages": messages}

def main():
    github_repository = os.getenv("GITHUB_REPOSITORY")
    github_token = os.getenv("GITHUB_TOKEN")
    issue_number = os.getenv("ISSUE_NUMBER")
    mode = os.getenv("MODE")
    context = Context(github_token=github_token, github_repository=github_repository, mode=mode, issue_number=issue_number)
    if mode == "classify":
        result = _handle_classify(context)
        print(json.dumps(result))
    elif mode == "validate":
        result = _handle_validate(context)
        print(json.dumps(result))
    sys.exit(0)

if __name__ == "__main__":
    main()