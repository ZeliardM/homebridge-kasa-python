#!/usr/bin/env python3
"""
Discord notification script for GitHub release events.

Builds a Discord webhook embed from the GitHub release event and posts it.

Required environment variables:
  WEBHOOK_URL       - Discord webhook URL
  DISCORD_TITLE     - Embed title prefix
"""
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

CATEGORY_ORDER = [
    "Breaking Changes",
    "Featured Changes",
    "Bug Fixes",
    "Other Changes",
]

def _trunc_with_ellipsis(s: str, max_len: int) -> str:
    if max_len <= 0:
        return ""
    if len(s) <= max_len:
        return s
    if max_len == 1:
        return "…"
    return s[: max_len - 1] + "…"

def _read_release(evt: dict) -> dict:
    rel = evt.get("release")
    return rel if isinstance(rel, dict) else {}

def _read_release_body(evt: dict) -> str:
    rel = _read_release(evt)
    return str(rel.get("body") or "")

def _read_release_name_or_tag(evt: dict) -> str:
    rel = _read_release(evt)
    name = str(rel.get("name") or "")
    tag = str(rel.get("tag_name") or "")
    return name or tag or ""

def _extract_full_changelog_line(lines: list[str]) -> tuple[str, list[str]]:
    fc_line = ""
    keep: list[str] = []
    for ln in lines:
        if ln.strip().startswith("**Full Changelog**:"):
            fc_line = ln.strip()
        else:
            keep.append(ln)
    return fc_line, keep

def _parse_sections(raw_body: str) -> dict:
    sections: dict = {}
    current = ""
    for ln in raw_body.splitlines():
        ln = ln.replace("\r", "")
        if ln.startswith("### ") or ln.startswith("## "):
            current = ln[4:].strip()
            if current:
                sections.setdefault(current, [])
            continue
        if current and ln.startswith("- "):
            sections[current].append(ln.strip())
    return sections

def _ordered_categories(sections: dict) -> list[str]:
    present = list(sections.keys())
    ordered: list[str] = [c for c in CATEGORY_ORDER if c in sections]
    for c in present:
        if c not in CATEGORY_ORDER:
            ordered.append(c)
    return ordered

def _ensure_changelog_update_bullet(sections: dict, version: str) -> None:
    other = sections.get("Other Changes")
    if other is None:
        sections["Other Changes"] = []
        other = sections["Other Changes"]
    already = any(
        b.startswith("- Update CHANGELOG.md for beta release")
        or b.startswith("- Update CHANGELOG.md for release")
        for b in other
    )
    if already or not version:
        return
    if "beta" in version:
        bullet = f"- Update CHANGELOG.md for beta release {version} [beta-release] (@github-actions)"
    else:
        bullet = f"- Update CHANGELOG.md for release {version} [release] (@github-actions)"
    other.insert(0, bullet)

def _build_event_value_from_body(body: str, name_or_tag: str, field_hard_max: int) -> str:
    lines_all = body.splitlines()
    fc_line, keep_lines = _extract_full_changelog_line(lines_all)
    sections = _parse_sections("\n".join(keep_lines))
    _ensure_changelog_update_bullet(sections, name_or_tag)
    order = _ordered_categories(sections)
    section_lines: dict = {}
    included_counts: dict = {cat: 0 for cat in order}
    for cat in order:
        lines = [f"### {cat}", ""]
        bullets = sections.get(cat, [])
        if bullets:
            lines.append(bullets[0])
            included_counts[cat] = 1
        section_lines[cat] = lines
    progressed = True
    while progressed:
        progressed = False
        for cat in order:
            bullets = sections.get(cat, [])
            idx = included_counts[cat]
            if idx < len(bullets):
                candidate_sections = {k: v[:] for k, v in section_lines.items()}
                candidate_sections[cat].append(bullets[idx])
                candidate_lines: list[str] = []
                if name_or_tag:
                    candidate_lines.append(f"**{name_or_tag}**")
                    candidate_lines.append("")
                for c in order:
                    candidate_lines += candidate_sections[c] + [""]
                if fc_line:
                    candidate_lines.append(fc_line)
                candidate = "\n".join(candidate_lines).strip()
                if len(candidate) <= field_hard_max:
                    section_lines[cat].append(bullets[idx])
                    included_counts[cat] += 1
                    progressed = True
                else:
                    break
    final_sections = {k: v[:] for k, v in section_lines.items()}
    for cat in order:
        bullets = sections.get(cat, [])
        if included_counts[cat] < len(bullets):
            candidate_lines: list[str] = []
            if name_or_tag:
                candidate_lines.append(f"**{name_or_tag}**")
                candidate_lines.append("")
            for c in order:
                candidate_lines += final_sections[c] + [""]
            candidate_lines += ["- …", ""]
            if fc_line:
                candidate_lines.append(fc_line)
            candidate = "\n".join(candidate_lines).strip()
            if len(candidate) <= field_hard_max:
                final_sections[cat].append("- …")
    final_lines: list[str] = []
    if name_or_tag:
        final_lines.append(f"**{name_or_tag}**")
        final_lines.append("")
    for cat in order:
        final_lines += final_sections[cat] + [""]
    if fc_line:
        final_lines.append(fc_line)
    event_val = "\n".join(final_lines).strip()
    if len(event_val) > field_hard_max:
        event_val = _trunc_with_ellipsis(event_val, field_hard_max)
    return event_val

def _post_to_discord(webhook: str, payload: dict) -> int:
    try:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            webhook,
            data=data,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "homebridge-kasa-python/discord-notify",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            print(f"POST -> {resp.status} {resp.reason}")
            return 0
    except urllib.error.HTTPError as e:
        resp_body = ""
        try:
            resp_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        print(
            f"::error::Discord webhook failed {e.code}: {e.reason} | body: {resp_body}",
            file=sys.stderr,
        )
        return 1
    except urllib.error.URLError as e:
        print(f"::error::Request failed: {e}", file=sys.stderr)
        return 1

def main() -> int:
    webhook = os.environ.get("WEBHOOK_URL") or ""
    if not webhook:
        print("::error::WEBHOOK_URL is required", file=sys.stderr)
        return 1
    title = os.environ.get("DISCORD_TITLE") or ""
    repo = os.environ.get("GITHUB_REPOSITORY") or ""
    ref = os.environ.get("GITHUB_REF") or ""
    actor = os.environ.get("GITHUB_ACTOR") or ""
    workflow_name = os.environ.get("GITHUB_WORKFLOW") or ""
    run_id = os.environ.get("GITHUB_RUN_ID") or ""
    server_url = (os.environ.get("GITHUB_SERVER_URL") or "https://github.com").rstrip("/")
    evt = common.read_event()
    body = _read_release_body(evt)
    tag_name = _read_release_name_or_tag(evt)
    rel = _read_release(evt)
    release_url = str(rel.get("html_url") or f"{server_url}/{repo}/releases/tag/{tag_name}")
    event_value = _build_event_value_from_body(
        body=body,
        name_or_tag=tag_name,
        field_hard_max=1024,
    )
    embed_title = f"Success: {title}" if title else "Success"
    embed: dict = {
        "color": 4726621,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "title": embed_title,
        "url": release_url,
        "description": f"Version `{tag_name}`",
        "fields": [
            {"name": "Repository", "value": f"[{repo}]({server_url}/{repo})", "inline": True},
            {"name": "Ref", "value": ref, "inline": True},
            {"name": "Event - release", "value": event_value or "No further information", "inline": False},
            {"name": "Triggered by", "value": actor, "inline": True},
            {"name": "Workflow", "value": f"[{workflow_name}]({server_url}/{repo}/actions/runs/{run_id})", "inline": True},
        ],
    }
    discord_payload: dict = {
        "embeds": [embed],
        "username": "Homebridge",
        "avatar_url": "https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png",
    }
    print(json.dumps(discord_payload, ensure_ascii=False, indent=2))
    return _post_to_discord(webhook, discord_payload)

if __name__ == "__main__":
    sys.exit(main())