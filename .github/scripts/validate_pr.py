#!/usr/bin/env python3
"""
Strict PR validation (Python version):

Rules:
  - Base branch MUST be exactly 'beta'
  - Requires at least one classification label (case-insensitive):
        bug, fix, enhancement, feature, breaking-change, docs, dependency
  - If 'breaking-change' label present:
        Body must contain markers:
          BREAKING_CHANGE_EXPLANATION_START
          BREAKING_CHANGE_EXPLANATION_END
        with >= 60 chars of explanation between them (trimmed length)
  - Validation is bypassed for github-actions[bot]

Implementation notes:
  - Reads the event payload directly from GITHUB_EVENT_PATH (no inline JSON echoing)
  - Exits with non-zero status on failure to fail the workflow step
"""

from __future__ import annotations
import json
import os
import sys
from typing import Any, Dict, List

CLASSIFICATION_LABELS = {
    "bug",
    "fix",
    "enhancement",
    "feature",
    "breaking-change",
    "docs",
    "dependency",
}

BREAK_START = "BREAKING_CHANGE_EXPLANATION_START"
BREAK_END = "BREAKING_CHANGE_EXPLANATION_END"


def fail(msg: str) -> None:
    print(f"❌ VALIDATION FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def load_event() -> Dict[str, Any]:
    event_path = os.getenv("GITHUB_EVENT_PATH")
    if not event_path or not os.path.isfile(event_path):
        fail("GITHUB_EVENT_PATH is missing or file not found.")
    try:
        with open(event_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        fail(f"Unable to parse event JSON: {e}")


def main() -> None:
    actor = os.getenv("GITHUB_ACTOR", "")
    event = load_event()

    pr = event.get("pull_request")
    if not pr:
        fail("This workflow must be triggered by a pull_request event (pull_request object missing).")

    if actor == "github-actions[bot]":
        print("Bypassing validation for github-actions[bot].")
        return

    base_ref = pr.get("base", {}).get("ref", "") or ""
    labels = [ (lbl.get("name") or "").lower() for lbl in pr.get("labels", []) ]
    body = pr.get("body") or ""

    # 1. Base branch enforcement
    if base_ref != "beta":
        fail(f'PR base branch "{base_ref}" is invalid. All PRs must target "beta".')

    # 2. Classification label requirement
    if not any(lbl in CLASSIFICATION_LABELS for lbl in labels):
        fail(
            "At least one classification label required "
            f"({', '.join(sorted(CLASSIFICATION_LABELS))}). "
            f"Current labels: {labels if labels else '(none)'}"
        )

    # 3. Breaking change explanation requirement
    if "breaking-change" in labels:
        start_index = body.find(BREAK_START)
        end_index = body.find(BREAK_END)

        if start_index == -1 or end_index == -1 or end_index <= start_index:
            fail(
                "breaking-change label present but explanation markers are missing or malformed.\n"
                f"Include markers:\n{BREAK_START}\n... explanation ...\n{BREAK_END}"
            )

        explanation = body[start_index + len(BREAK_START):end_index].strip()
        if len(explanation) < 60:
            fail(
                "Breaking change explanation too short (<60 chars). "
                f"Length={len(explanation)}. Provide rationale + migration steps."
            )

    print("✅ PR validation passed.")


if __name__ == "__main__":
    main()
