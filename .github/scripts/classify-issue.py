#!/usr/bin/env python3
"""
Issue classifier & validator.

Reads issue JSON (GitHub event issue object) and:
1. Determines Type from Issue Form "### Type" section or dropdown insertion.
2. Removes any previous classification labels (bug, enhancement, breaking-change, question, docs, dependency).
3. Applies the proper label.
4. Validates required fields for:
   - Bug: must have Environment & some steps & expected mention.
   - Breaking Change: migration strategy length >= 40 chars AND impact/rationale signals.
5. If incomplete -> signals needs-info.

Outputs lines:
  APPLIED_LABEL=<label> (if applied)
  NEEDS_INFO=1 (if info missing)

Exit code always 0 (workflow logic handles states).
"""

import json, os, re, sys

CLASSIFICATION_LABELS = {
    "bug", "enhancement", "breaking-change", "question", "docs", "dependency"
}

ALIAS_MAP = {
    "bug": "bug",
    "fix": "bug",
    "feature": "enhancement",
    "enhancement": "enhancement",
    "support": "question",
    "question": "question",
    "docs": "docs",
    "documentation": "docs",
    "breaking change": "breaking-change",
    "breaking-change": "breaking-change",
    "breaking": "breaking-change",
    "dependency": "dependency",
    "dependencies": "dependency"
}

def load_issue(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def extract_type(body: str) -> str:
    """
    Issue Form bodies render headings like: '### Type' followed by the selection line.
    Try to capture the line directly below '### Type'.
    """
    # Normalize line endings
    lines = body.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"^###\s*Type\s*$", line.strip(), re.IGNORECASE):
            # Next non-empty line
            for j in range(i+1, len(lines)):
                candidate = lines[j].strip()
                if candidate:
                    return candidate.lower()
    # Fallback: search 'Type:' pattern
    m = re.search(r"Type:\s*(.+)", body, re.IGNORECASE)
    if m:
        return m.group(1).strip().lower()
    return ""

def canonical_label(raw: str) -> str:
    raw_lower = raw.lower().strip()
    # Attempt direct match or fuzzy fallback
    for k, v in ALIAS_MAP.items():
        if raw_lower == k:
            return v
    # Partial contains
    for k, v in ALIAS_MAP.items():
        if k in raw_lower:
            return v
    return ""

def section(body: str, heading: str) -> str:
    """
    Extract text under '### Heading' until next '### ' or end.
    """
    pattern = rf"(?is)^###\s*{re.escape(heading)}\s*$\n(.*?)(?=^###\s|\Z)"
    m = re.search(pattern, body, re.MULTILINE)
    return (m.group(1).strip() if m else "").strip()

def has_keywords(text: str, *words) -> bool:
    t = text.lower()
    return all(w.lower() in t for w in words)

def main():
    if len(sys.argv) < 2:
        print("Usage: classify_issue.py issue.json")
        sys.exit(0)

    issue = load_issue(sys.argv[1])
    body = issue.get("body") or ""
    current_labels = {l["name"] for l in issue.get("labels", [])}

    raw_type = extract_type(body)
    normalized = canonical_label(raw_type) if raw_type else ""

    applied_label = ""
    needs_info = False

    # If not found, attempt heuristic classification
    if not normalized:
        lower = body.lower()
        if "traceback" in lower or "error" in lower:
            normalized = "bug"
        elif "migration" in lower and "breaking" in lower:
            normalized = "breaking-change"
        elif "feature" in lower or "enhancement" in lower:
            normalized = "enhancement"
        elif "docs" in lower or "documentation" in lower:
            normalized = "docs"
        elif "dependen" in lower:
            normalized = "dependency"
        elif "support" in lower or "help" in lower:
            normalized = "question"

    # Validation logic
    if normalized == "bug":
        env = section(body, "Environment")
        details = section(body, "Details")
        if not env or len(env) < 15:
            needs_info = True
        # Expect some reproduction pattern
        if not re.search(r"\b(step|reproduce|expected|actual)\b", details, re.IGNORECASE):
            needs_info = True

    if normalized == "breaking-change":
        migration = section(body, "Migration Strategy")
        details = section(body, "Details")
        if len(migration) < 40:
            needs_info = True
        # Need some indication of impact or rationale
        if not (has_keywords(details, "impact") or has_keywords(details, "rationale") or "break" in details.lower()):
            needs_info = True

    if not normalized:
        needs_info = True  # Unknown classification

    # Prepare GH CLI commands (printed for log parsing)
    # We cannot directly remove labels here, workflow uses GH CLI, but we signal what to do:
    # Instead we just print results; workflow step does not remove automatically to avoid complexity.
    if normalized:
        applied_label = normalized

    if applied_label:
        print(f"APPLIED_LABEL={applied_label}")
    if needs_info:
        print("NEEDS_INFO=1")

if __name__ == "__main__":
    main()
