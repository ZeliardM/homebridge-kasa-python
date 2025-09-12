#!/usr/bin/env python3
"""
Issue classifier:
- Reads issue JSON (github.event.issue)
- Determines type (Bug, Feature, Support, Breaking Change, Docs, Dependency)
- Maps to canonical label: bug | enhancement | question | breaking-change | docs | dependency
- Validates required fields depending on type; signals needs-info if insufficient.
Outputs a JSON summary for workflow steps.
"""
import json, os, re

MAP = {
    "bug":"bug",
    "fix":"bug",
    "feature":"enhancement",
    "enhancement":"enhancement",
    "support":"question",
    "question":"question",
    "breaking change":"breaking-change",
    "breaking-change":"breaking-change",
    "breaking":"breaking-change",
    "docs":"docs",
    "documentation":"docs",
    "dependency":"dependency",
    "dependencies":"dependency"
}

def main():
    raw = os.environ.get("ISSUE_JSON","")
    if not raw:
        print(json.dumps({"ok":False,"error":"missing_issue_json"}))
        return
    issue = json.loads(raw)
    body = issue.get("body") or ""
    labels_current = [l.get("name") for l in issue.get("labels",[])]

    # Extract dropdown selection (Issue Forms send '### Type' heading in body when edited manually)
    kind = ""
    m = re.search(r"(?i)^###\s*Type\s*$", body, re.MULTILINE)
    if m:
        lines = body.splitlines()
        idx = lines.index(m.group(0))
        for j in range(idx+1, len(lines)):
            candidate = lines[j].strip()
            if candidate:
                kind = candidate.lower()
                break
    if not kind:
        # fallback heuristic
        lower = body.lower()
        if "traceback" in lower or "error" in lower: kind="bug"
        elif "migration" in lower and "break" in lower: kind="breaking change"
        elif "feature" in lower or "enhancement" in lower: kind="feature"
        elif "docs" in lower or "documentation" in lower: kind="docs"
        elif "dependen" in lower: kind="dependency"
        elif "support" in lower or "help" in lower: kind="support"

    canonical = MAP.get(kind,"")
    needs_info = False
    messages = []

    def msg(s):
        messages.append(s)

    # Extract pseudo-sections
    def section(title):
        pat = rf"(?is)^###\s*{re.escape(title)}\s*$\n(.*?)(?=^###\s|\Z)"
        mm = re.search(pat, body, re.MULTILINE)
        return (mm.group(1).strip() if mm else "").strip()

    if canonical == "bug":
        env = section("Environment")
        details = section("Details")
        if len(env) < 15: needs_info=True; msg("Environment section missing or too short for bug.")
        if not re.search(r"\b(step|reproduce|expected|actual)\b", details, re.IGNORECASE):
            needs_info=True; msg("Details should include reproduction steps and expected vs actual.")
    if canonical == "breaking-change":
        migration = section("Migration Strategy")
        details = section("Details")
        if len(migration) < 30: needs_info=True; msg("Migration Strategy needs >=30 chars.")
        if "impact" not in details.lower() and "rationale" not in details.lower() and "break" not in details.lower():
            needs_info=True; msg("Details should mention impact or rationale for breaking change.")
    if not canonical:
        needs_info=True; msg("Unable to classify issue type automatically.")

    out = {
        "ok": True,
        "applied_label": canonical,
        "needs_info": needs_info,
        "messages": messages,
        "current_labels": labels_current
    }
    print(json.dumps(out))

if __name__ == "__main__":
    main()
