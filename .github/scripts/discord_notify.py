#!/usr/bin/env python3
"""
Generate and send Discord notification for GitHub Release events with a compact, balanced changelog.

Features:
- Reads the GitHub event JSON from GITHUB_EVENT_PATH.
- Builds a balanced/truncated changelog from release body, preserving category coverage.
- Reserves space for a bold release name line in the "Event - <event>" embed field.
- Composes a Discord embed with details (Repository, Ref, Event, Triggered by, Workflow).
- Enforces Discord limits (title<=256, description<=4096, field name<=256, field value<=1024).
- Sends payload directly to Discord webhook(s).

Usage example:
  python3 .github/scripts/discord_notify.py \\
    --webhook "$DISCORD_WEBHOOK" \\
    --status "Success" \\
    --title "Kasa Python Beta Release" \\
    --description-prefix "Version `vX.Y.Z`" \\
    --username "Homebridge" \\
    --avatar-url "https://..." \\
    --color "4726621" \\
    --reserve-name-line
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple, Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

MAX_EMBED_TITLE_LENGTH = 256
MAX_EMBED_DESCRIPTION_LENGTH = 4096
MAX_EMBED_FIELD_NAME_LENGTH = 256
MAX_EMBED_FIELD_VALUE_LENGTH = 1024
DEFAULT_CONTENT_MAX = 900
DEFAULT_HARD_MAX = 1024
CATEGORY_ORDER = [
    "Breaking Changes",
    "Featured Changes",
    "Bug Fixes",
    "Other Changes",
]
STATUS_PREFIX = {
    "success": "Success",
    "failure": "Failure",
    "cancelled": "Cancelled",
}

def trunc_with_ellipsis(s: str, max_len: int) -> str:
    if max_len <= 0:
        return ""
    if len(s) <= max_len:
        return s
    if max_len == 1:
        return "…"
    return s[: max_len - 1] + "…"

def _read_event() -> dict:
    return common.read_event()

def _read_release(evt: dict) -> dict:
    return evt.get("release") or {}

def _read_release_body(evt: dict) -> str:
    rel = _read_release(evt)
    return rel.get("body") or "" if isinstance(rel, dict) else ""

def _read_release_name_or_tag(evt: dict) -> str:
    rel = _read_release(evt)
    if isinstance(rel, dict):
        name = rel.get("name") or ""
        tag = rel.get("tag_name") or ""
        return name or tag or ""
    return ""

def _read_tag(evt: dict) -> str:
    rel = _read_release(evt)
    return rel.get("tag_name") or ""

def _read_release_html_url(evt: dict, repo: str, tag: str) -> str:
    rel = _read_release(evt)
    url = rel.get("html_url") or ""
    if url:
        return url
    if repo and tag:
        return f"https://github.com/{repo}/releases/tag/{tag}"
    return ""

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

def _flatten_content_lines(chunks: Dict[str, List[str]], order: List[str]) -> List[str]:
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

def build_balanced_description(body: str, content_max: int = DEFAULT_CONTENT_MAX,
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
    content_lines_cache = _flatten_content_lines(chunks, order)

    def try_apply(cat: str, bullet: str) -> bool:
        nonlocal content_lines_cache
        chunks[cat].append(bullet)
        proposed_lines = _flatten_content_lines(chunks, order)
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
                proposed_lines = _flatten_content_lines(chunks, order)
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

def parse_color(value: str) -> Optional[int]:
    if not value:
        return None
    v = value.strip().lower()
    try:
        if v.startswith("0x"):
            return int(v, 16)
        return int(v, 10)
    except Exception:
        return None

def post_discord(webhook: str, payload: dict) -> Tuple[int, str]:
    req = urllib.request.Request(
        webhook,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.getcode(), r.read().decode("utf-8", "replace")
    except Exception as e:
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            body = str(e)
        return 0, body

def fit_embed(embed: dict) -> dict:
    if embed.get("title"):
        t = embed["title"]
        if len(t) > MAX_EMBED_TITLE_LENGTH:
            embed["title"] = trunc_with_ellipsis(t, MAX_EMBED_TITLE_LENGTH)
    if embed.get("description"):
        d = embed["description"]
        if len(d) > MAX_EMBED_DESCRIPTION_LENGTH:
            embed["description"] = trunc_with_ellipsis(d, MAX_EMBED_DESCRIPTION_LENGTH)
    if embed.get("fields"):
        for f in embed["fields"]:
            if "name" in f and len(f["name"]) > MAX_EMBED_FIELD_NAME_LENGTH:
                f["name"] = trunc_with_ellipsis(f["name"], MAX_EMBED_FIELD_NAME_LENGTH)
            if "value" in f and len(f["value"]) > MAX_EMBED_FIELD_VALUE_LENGTH:
                f["value"] = trunc_with_ellipsis(f["value"], MAX_EMBED_FIELD_VALUE_LENGTH)
    return embed

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--webhook", help="Discord webhook URL (or multiple separated by newlines)", default=os.environ.get("DISCORD_WEBHOOK"))
    ap.add_argument("--status", default="Success", help="Success | Failure | Cancelled")
    ap.add_argument("--title", required=True, help="Embed title (without status prefix)")
    ap.add_argument("--description-prefix", default="", help="Embed description; if empty, will use `Version <tag>`")
    ap.add_argument("--url", default="", help="URL to link from embed title; defaults to release URL")
    ap.add_argument("--username", default="", help="Webhook username override")
    ap.add_argument("--avatar-url", default="", help="Webhook avatar URL override")
    ap.add_argument("--color", default="", help='Embed color; decimal or hex like 0xFFFFFF')
    ap.add_argument("--reserve-name-line", action="store_true", help="Reserve space for bold release name and a newline in Event field")
    ap.add_argument("--reserve-extra", type=int, default=0, help="Additional characters to reserve")
    ap.add_argument("--content-max", type=int, default=DEFAULT_CONTENT_MAX, help="Pre-Full Changelog max for body")
    ap.add_argument("--hard-max", type=int, default=DEFAULT_HARD_MAX, help="Absolute max characters for the final body")
    ap.add_argument("--nocontext", action="store_true", help="Suppress context fields (Repository, Ref, Event, Triggered by, Workflow)")
    ap.add_argument("--notimestamp", action="store_true", help="Suppress timestamp in embed")
    ap.add_argument("--noprefix", action="store_true", help="Do not add status prefix to title")
    ap.add_argument("--nodetail", action="store_true", help="Equivalent to --nocontext and --noprefix")
    ap.add_argument("--nofail", action="store_true", help="Do not fail on delivery errors")
    args = ap.parse_args()
    if not args.webhook:
        print("::error::webhook not provided", file=sys.stderr)
        sys.exit(0 if args.nofail else 1)
    if args.nodetail:
        args.nocontext = True
        args.noprefix = True
    evt = _read_event()
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    actor = os.environ.get("GITHUB_ACTOR", "")
    workflow = os.environ.get("GITHUB_WORKFLOW", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    event_name = os.environ.get("GITHUB_EVENT_NAME", "release")
    tag = _read_tag(evt)
    rel_url = _read_release_html_url(evt, repo, tag)
    url = args.url or rel_url or (f"https://github.com/{repo}" if repo else "")
    if args.description_prefix:
        description = args.description_prefix
    else:
        description = f"Version `{tag}`" if tag else ""
    body = _read_release_body(evt)
    reserve = 0
    if args.reserve_name_line:
        name_or_tag = _read_release_name_or_tag(evt)
        if name_or_tag:
            reserve += len(f"**{name_or_tag}**")
        if (body or "").strip():
            reserve += 1
    reserve += max(0, int(args.reserve_extra or 0))
    effective_hard = max(1, args.hard_max - reserve)
    trimmed_body = build_balanced_description(body, content_max=args.content_max, hard_max=effective_hard).replace("\r\n", "\n").strip()
    name_or_tag = _read_release_name_or_tag(evt)
    name_line = f"**{name_or_tag}**" if name_or_tag else ""
    event_value = name_line if not trimmed_body else (f"{name_line}\n{trimmed_body}" if name_line else trimmed_body)
    if len(event_value) > MAX_EMBED_FIELD_VALUE_LENGTH:
        event_value = trunc_with_ellipsis(event_value, MAX_EMBED_FIELD_VALUE_LENGTH)
    embed: Dict[str, Any] = {}
    color_int = parse_color(args.color)
    if color_int is not None:
        embed["color"] = color_int
    if not args.notimestamp:
        embed["timestamp"] = datetime.now(timezone.utc).isoformat()
    title = args.title
    if not args.noprefix:
        pref = STATUS_PREFIX.get(str(args.status or "").lower(), str(args.status or ""))
        title = f"{pref}: {title}" if title else pref
    if title:
        embed["title"] = trunc_with_ellipsis(title, MAX_EMBED_TITLE_LENGTH)
    if url:
        embed["url"] = url
    if description:
        embed["description"] = trunc_with_ellipsis(description, MAX_EMBED_DESCRIPTION_LENGTH)
    if not args.nocontext:
        owner_repo_url = f"https://github.com/{repo}" if repo else ""
        workflow_url = f"https://github.com/{repo}/actions/runs/{run_id}" if repo and run_id else ""
        fields = [
            {
                "name": "Repository",
                "value": f"[{repo}]({owner_repo_url})" if repo else "Unknown",
                "inline": True,
            },
            {
                "name": "Ref",
                "value": f"refs/tags/{tag}" if tag else "Unknown",
                "inline": True,
            },
            {
                "name": f"Event - {event_name}",
                "value": event_value or "No further information",
                "inline": False,
            },
            {
                "name": "Triggered by",
                "value": actor or "Unknown",
                "inline": True,
            },
            {
                "name": "Workflow",
                "value": f"[{workflow}]({workflow_url})" if workflow_url else (workflow or "Unknown"),
                "inline": True,
            },
        ]
        for f in fields:
            f["name"] = trunc_with_ellipsis(f["name"], MAX_EMBED_FIELD_NAME_LENGTH)
            f["value"] = trunc_with_ellipsis(f["value"], MAX_EMBED_FIELD_VALUE_LENGTH)
        embed["fields"] = fields
    embed = fit_embed(embed)
    payload: Dict[str, Any] = {"embeds": [embed]}
    if args.username:
        payload["username"] = args.username
    if args.avatar_url:
        payload["avatar_url"] = args.avatar_url
    webhooks = [w.strip() for w in str(args.webhook).splitlines() if w.strip()]
    if not webhooks:
        print("::error::No valid webhook endpoints provided", file=sys.stderr)
        sys.exit(0 if args.nofail else 1)
    any_error = False
    for wh in webhooks:
        code, resp = post_discord(wh, payload)
        ok = 200 <= code < 300
        print(f"[discord_notify] POST {wh[:40]}… -> {code} {('OK' if ok else 'ERROR')}")
        if not ok:
            print(resp, file=sys.stderr)
            any_error = True
    if any_error and not args.nofail:
        sys.exit(1)

if __name__ == "__main__":
    main()