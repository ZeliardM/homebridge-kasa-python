#!/usr/bin/env python3
"""
Generate trimmed release notes for Discord embeds with balanced category representation.

- Reads the GitHub event JSON (GITHUB_EVENT_PATH) and extracts the release body and tag.
- Expects the body to contain only "### {Category}" headers with "-" bullets,
  followed by a "**Full Changelog**: ..." line.
- Ensures each present category is represented (at least one bullet) when space allows.
- Trims content to a strict maximum BEFORE adding the Full Changelog line
  (default --content-max=900 chars), then appends the Full Changelog.
- Guarantees the final message does not exceed --hard-max (default 1024).
- Emits multi-line GitHub Actions output "body<<EOF ... EOF" to GITHUB_OUTPUT.
"""

import argparse
import json
import os
from typing import Dict, List, Tuple

DEFAULT_CONTENT_MAX = 900
DEFAULT_HARD_MAX = 1024

CATEGORY_ORDER = [
    "Breaking Changes",
    "Featured Changes",
    "Bug Fixes",
    "Other Changes",
]

def _read_event_body() -> Tuple[str, str]:
    event_path = os.environ.get("GITHUB_EVENT_PATH") or ""
    tag = ""
    body = ""
    if event_path and os.path.exists(event_path):
        try:
            with open(event_path, "r", encoding="utf-8") as f:
                evt = json.load(f)
            rel = evt.get("release") or {}
            if isinstance(rel, dict):
                tag = rel.get("tag_name") or ""
                body = rel.get("body") or ""
        except Exception:
            pass
    return tag, body

def _extract_full_changelog_line(lines: List[str]) -> Tuple[str, List[str]]:
    fc_line = ""
    keep: List[str] = []
    for ln in lines:
        if ln.strip().startswith("**Full Changelog**:"):
            fc_line = ln.strip()
        else:
            keep.append(ln)
    return fc_line, keep

def _parse_sections(raw_body: str) -> Dict[str, List[str]]:
    sections: Dict[str, List[str]] = {}
    current: str = ""
    for ln in raw_body.splitlines():
        ln = ln.replace("\r", "")
        if ln.startswith("### "):
            current = ln[4:].strip()
            if current:
                sections.setdefault(current, [])
            continue
        if current and ln.startswith("- "):
            sections[current].append(ln.strip())
    return sections

def _ordered_categories(sections: Dict[str, List[str]]) -> List[str]:
    present = list(sections.keys())
    ordered: List[str] = [c for c in CATEGORY_ORDER if c in sections]
    for c in present:
        if c not in CATEGORY_ORDER:
            ordered.append(c)
    return ordered

def _flatten_content_lines(tag: str, chunks: Dict[str, List[str]], order: List[str]) -> List[str]:
    lines: List[str] = []
    first_cat_added = False
    for cat in order:
        block = chunks.get(cat, [])
        has_bullets = any(x.startswith("- ") for x in block)
        if not has_bullets:
            continue
        if first_cat_added:
            lines.append("")
        lines.extend(block)
        first_cat_added = True
    return lines

def _text_len(lines: List[str]) -> int:
    return len("\n".join(lines))

def build_balanced_description(tag: str, body: str, content_max: int = DEFAULT_CONTENT_MAX,
                               hard_max: int = DEFAULT_HARD_MAX) -> str:
    lines_all = body.splitlines()
    fc_line, keep_lines = _extract_full_changelog_line(lines_all)
    sections = _parse_sections("\n".join(keep_lines))
    order = _ordered_categories(sections)
    chunks: Dict[str, List[str]] = {}
    included_counts: Dict[str, int] = {}
    for cat in order:
        chunks[cat] = [f"### {cat}", ""]
        included_counts[cat] = 0
    content_lines_cache = _flatten_content_lines(tag, chunks, order)

    def try_apply(cat: str, bullet: str) -> bool:
        nonlocal content_lines_cache
        chunks[cat].append(bullet)
        proposed_lines = _flatten_content_lines(tag, chunks, order)
        proposed_len = _text_len(proposed_lines)
        if proposed_len <= content_max:
            included_counts[cat] += 1
            content_lines_cache = proposed_lines
            return True
        chunks[cat].pop()
        return False

    for cat in order:
        bullets = sections.get(cat, [])
        if bullets:
            try_apply(cat, bullets[0])
    while True:
        progressed = False
        for cat in order:
            bullets = sections.get(cat, [])
            idx = included_counts.get(cat, 0)
            if idx >= len(bullets):
                continue
            if try_apply(cat, bullets[idx]):
                progressed = True
        if not progressed:
            break
    remaining = any(included_counts.get(cat, 0) < len(sections.get(cat, [])) for cat in order)
    if remaining:
        for cat in reversed(order):
            if included_counts.get(cat, 0) > 0:
                chunks[cat].append("- …")
                proposed_lines = _flatten_content_lines(tag, chunks, order)
                if _text_len(proposed_lines) <= content_max:
                    content_lines_cache = proposed_lines
                    break
                chunks[cat].pop()
    content_lines = content_lines_cache
    content_text = "\n".join(content_lines)
    final_lines = content_lines[:]
    if fc_line:
        if final_lines and final_lines[-1] != "":
            final_lines.append("")
        final_lines.append(fc_line)
    final_text = "\n".join(final_lines)
    if len(final_text) > hard_max:
        reserve = len(fc_line) + 1 if fc_line else 0
        allowed = max(0, hard_max - reserve)
        if len(content_text) > allowed:
            if allowed >= 2:
                trimmed = content_text[: max(0, allowed - 2)].rstrip()
                content_text = trimmed + "…"
            else:
                content_text = content_text[:allowed]
        if fc_line:
            final_text = content_text + ("\n" if content_text else "") + fc_line
        else:
            final_text = content_text
        if len(final_text) > hard_max:
            final_text = final_text[: hard_max - 1] + "…"
    return final_text

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--content-max", type=int, default=DEFAULT_CONTENT_MAX,
                    help="Max characters for the content BEFORE Full Changelog is appended")
    ap.add_argument("--hard-max", type=int, default=DEFAULT_HARD_MAX,
                    help="Absolute maximum characters for the final description (including Full Changelog)")
    args = ap.parse_args()
    tag, body = _read_event_body()
    desc = build_balanced_description(tag, body, content_max=args.content_max, hard_max=args.hard_max)
    out_path = os.environ.get("GITHUB_OUTPUT")
    if out_path:
        with open(out_path, "a", encoding="utf-8") as f:
            f.write("body<<EOF\n")
            f.write(desc)
            f.write("\nEOF\n")
    else:
        print(desc)

if __name__ == "__main__":
    main()