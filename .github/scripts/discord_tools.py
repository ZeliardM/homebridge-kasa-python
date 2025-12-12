#!/usr/bin/env python3
"""
Discord workflow helpers with three env-driven modes, controlled by MODE:

MODE=trim
  - Reads the GitHub Release event payload (GITHUB_EVENT_PATH)
  - Builds a compact "Event - <event>" field value from the release body:
      * Bold release name or tag on the first line if available
      * Category headings with bullets under their correct categories
      * One bullet per present category initially
      * Appends "**Full Changelog**: ..." at the bottom (if present)
      * Round-robins remaining bullets under correct categories until the Discord field limit (1024 chars) is reached
      * If not all bullets fit, appends "- …" to the last non-empty category (if space allows)
      * Ensures an "Update CHANGELOG.md for (beta) release <version> ..." bullet exists in Other Changes,
        inserting it as the first bullet there if missing
  - Writes Actions output key "body" (multiline <<EOF block)
  - Prints the final trimmed value to stdout

MODE=edit-payload
  - Reads the Discord webhook payload JSON from env WEBHOOK_PAYLOAD
  - Reads the trimmed event value from env EVENT_VALUE
  - Replaces the first embed field whose name starts with "Event -"
    with the trimmed value
  - Ensures the event field value <= 1024 chars
  - Writes Actions output key "edited_payload" (multiline <<EOF block)
  - Prints the final JSON to stdout

MODE=post
  - Posts the payload to the Discord webhook
  - Requires:
      * env WEBHOOK_URL
      * env EDITED_PAYLOAD (stringified JSON payload)
"""
import json
import os
import requests
import sys

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

def _write_actions_output(key: str, value: str) -> None:
    out_path = os.environ.get("GITHUB_OUTPUT")
    if not out_path:
        return
    with open(out_path, "a", encoding="utf-8") as f:
        f.write(f"{key}<<EOF\n")
        f.write(value)
        f.write("\nEOF\n")

def _ensure_event_field(payload: dict, value: str) -> None:
    embeds = payload.get("embeds")
    if not isinstance(embeds, list) or not embeds:
        payload["embeds"] = [{}]
        embeds = payload["embeds"]
    embed = embeds[0] if embeds else {}
    if not isinstance(embed, dict):
        embed = {}
        payload["embeds"] = [embed]
    fields = embed.get("fields")
    if not isinstance(fields, list):
        fields = []
        embed["fields"] = fields
    idx_event = -1
    for i, f in enumerate(fields):
        name = str(f.get("name") or "")
        if name.lower().startswith("event -"):
            idx_event = i
            break
    if len(value) > 1024:
        value = _trunc_with_ellipsis(value, 1024)
    if idx_event >= 0:
        fields[idx_event]["value"] = value or "No further information"
        fields[idx_event]["inline"] = False
        if "name" in fields[idx_event]:
            nm = str(fields[idx_event]["name"])
            if len(nm) > 256:
                fields[idx_event]["name"] = _trunc_with_ellipsis(nm, 256)
        return
    idx_after_ref = -1
    for i, f in enumerate(fields):
        name = str(f.get("name") or "")
        if name.strip().lower() == "ref":
            idx_after_ref = i
            break
    new_field = {
        "name": "Event - release",
        "value": value or "No further information",
        "inline": False,
    }
    if idx_after_ref >= 0:
        fields.insert(idx_after_ref + 1, new_field)
    else:
        fields.append(new_field)

def _handle_trim() -> int:
    evt = common.read_event()
    body = _read_release_body(evt)
    name_or_tag = _read_release_name_or_tag(evt)
    event_value = _build_event_value_from_body(
        body=body,
        name_or_tag=name_or_tag,
        field_hard_max=1024,
    )
    _write_actions_output("body", event_value)
    print(event_value)
    return 0

def _handle_edit_payload() -> int:
    event_value = os.environ.get("EVENT_VALUE")
    payload_raw = os.environ.get("WEBHOOK_PAYLOAD")
    try:
        payload = json.loads(payload_raw)
    except Exception:
        try:
            fixed = payload_raw.replace("'", '"')
            payload = json.loads(fixed)
        except Exception:
            print("::error::WEBHOOK_PAYLOAD was invalid JSON", file=sys.stderr)
            return 1
    _ensure_event_field(payload, event_value)
    final_json = json.dumps(payload, ensure_ascii=False)
    _write_actions_output("edited_payload", final_json)
    print(final_json)
    return 0

def _handle_post() -> int:
    edited_payload_raw = os.environ.get("EDITED_PAYLOAD")
    webhook = os.environ.get("WEBHOOK_URL")
    try:
        edited_payload = json.loads(edited_payload_raw)
    except Exception:
        try:
            fixed = edited_payload_raw.replace("'", '"')
            edited_payload = json.loads(fixed)
        except Exception:
            print("::error::EDITED_PAYLOAD was invalid JSON", file=sys.stderr)
            return 1
    try:
        response = requests.post(webhook, json=edited_payload, timeout=45)
        if response.ok:
            print(f"POST -> {response.status_code} {response.reason}")
            return 0
        print(f"::error::Discord webhook failed {response.status_code}: {response.text}", file=sys.stderr)
        return 1
    except requests.RequestException as e:
        print(f"::error::Request failed: {e}", file=sys.stderr)
        return 1

def main() -> int:
    mode = os.environ.get("MODE")
    if mode == "trim":
        return _handle_trim()
    if mode == "edit-payload":
        return _handle_edit_payload()
    if mode == "post":
        return _handle_post()
    print("::error::MODE must be one of: trim, edit-payload, post", file=sys.stderr)
    return 1

if __name__ == "__main__":
    sys.exit(main())