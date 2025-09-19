#!/usr/bin/env python3
"""
Discord workflow helpers with three subcommands:

1) trim
   - Reads the GitHub Release event payload (GITHUB_EVENT_PATH)
   - Builds a compact, balanced "Event - <event>" field value with:
       * Bold release name or tag on the first line if available
       * Category headings with bullets under their correct categories
       * Adds one bullet per present category (if available)
       * Appends "**Full Changelog**: ..." line at the bottom (if present)
       * Round-robins remaining bullets under correct categories until the Discord field limit (1024 chars) is reached
       * If not all bullets fit, appends "- …" to the last non-empty category (if space allows)
   - Writes Actions output key "body" (multiline <<EOF block)

2) edit-payload
   - Reads the Discord webhook payload JSON (from env WEBHOOK_PAYLOAD or stdin)
   - Replaces the first embed field whose name starts with "Event -"
     with the trimmed value (from env EVENT_VALUE or --event-value)
   - Leaves all other payload content intact
   - Ensures the event field value <= 1024 chars
   - Writes Actions output key "payload" (multiline <<EOF block)
     and also prints the final JSON to stdout

3) post
   - Posts the payload to the Discord webhook using axios (Node.js)
   - Requires:
       * env WEBHOOK_URL (Discord webhook)
       * env WEBHOOK_PAYLOAD (stringified JSON payload)
       * Node.js + "axios" installed (npm i axios)
"""
import argparse
import json
import os
import sys
import tempfile
import textwrap
import subprocess
from typing import Any, Dict, List, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

MAX_EMBED_TITLE_LENGTH = 256
MAX_EMBED_DESCRIPTION_LENGTH = 4096
MAX_EMBED_FIELD_NAME_LENGTH = 256
MAX_EMBED_FIELD_VALUE_LENGTH = 1024
DEFAULT_HARD_MAX = 1024
CATEGORY_ORDER = [
    "Breaking Changes",
    "Featured Changes",
    "Bug Fixes",
    "Other Changes",
]

def trunc_with_ellipsis(s: str, max_len: int) -> str:
    if max_len <= 0:
        return ""
    if len(s) <= max_len:
        return s
    if max_len == 1:
        return "…"
    return s[: max_len - 1] + "…"

def _read_release(evt: Dict[str, Any]) -> Dict[str, Any]:
    rel = evt.get("release")
    return rel if isinstance(rel, dict) else {}

def _read_release_body(evt: Dict[str, Any]) -> str:
    rel = _read_release(evt)
    return str(rel.get("body") or "")

def _read_release_name_or_tag(evt: Dict[str, Any]) -> str:
    rel = _read_release(evt)
    name = str(rel.get("name") or "")
    tag = str(rel.get("tag_name") or "")
    return name or tag or ""

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

def _ordered_categories(sections: Dict[str, List[str]]) -> List[str]:
    present = list(sections.keys())
    ordered: List[str] = [c for c in CATEGORY_ORDER if c in sections]
    for c in present:
        if c not in CATEGORY_ORDER:
            ordered.append(c)
    return ordered

def build_event_value_from_body(body: str, name_or_tag: str, field_hard_max: int) -> str:
    lines_all = body.splitlines()
    fc_line, keep_lines = _extract_full_changelog_line(lines_all)
    sections = _parse_sections("\n".join(keep_lines))
    order = _ordered_categories(sections)
    all_lines: List[str] = []
    if name_or_tag:
        all_lines.append(f"**{name_or_tag}**")
    for idx, cat in enumerate(order):
        if idx > 0 and all_lines:
            all_lines.append("")
        all_lines.append(f"### {cat}")
    included_counts = {cat: 0 for cat in order}
    for cat in order:
        bullets = sections.get(cat, [])
        if bullets:
            all_lines.append(bullets[0])
            included_counts[cat] = 1
    event_val_base = "\n".join(all_lines)
    if fc_line:
        event_val_base += "\n" + fc_line
    if len(event_val_base) > field_hard_max:
        return trunc_with_ellipsis(event_val_base, field_hard_max)
    lines_before_fc = all_lines[:]
    while True:
        progressed = False
        for cat in order:
            bullets = sections.get(cat, [])
            idx = included_counts[cat]
            if idx < len(bullets):
                candidate_lines = lines_before_fc + [bullets[idx]]
                candidate = "\n".join(candidate_lines)
                if fc_line:
                    candidate += "\n" + fc_line
                if len(candidate) <= field_hard_max:
                    lines_before_fc.append(bullets[idx])
                    included_counts[cat] += 1
                    progressed = True
                else:
                    break
        if not progressed:
            break
    remaining = any(included_counts[cat] < len(sections.get(cat, [])) for cat in order)
    final_lines = lines_before_fc[:]
    if remaining and order:
        for cat in reversed(order):
            if included_counts[cat] > 0:
                candidate_lines = final_lines + ["- …"]
                candidate = "\n".join(candidate_lines)
                if fc_line:
                    candidate += "\n" + fc_line
                if len(candidate) <= field_hard_max:
                    final_lines.append("- …")
                break
    event_val = "\n".join(final_lines)
    if fc_line:
        event_val += "\n" + fc_line
    if len(event_val) > field_hard_max:
        event_val = trunc_with_ellipsis(event_val, field_hard_max)
    return event_val

def write_actions_output(key: str, value: str) -> None:
    out_path = os.environ.get("GITHUB_OUTPUT")
    if not out_path:
        return
    with open(out_path, "a", encoding="utf-8") as f:
        f.write(f"{key}<<EOF\n")
        f.write(value)
        f.write("\nEOF\n")

def cmd_trim() -> int:
    evt = common.read_event()
    body = _read_release_body(evt)
    name_or_tag = _read_release_name_or_tag(evt)
    event_value = build_event_value_from_body(
        body=body,
        name_or_tag=name_or_tag,
        field_hard_max=MAX_EMBED_FIELD_VALUE_LENGTH,
    )
    write_actions_output("body", event_value)
    print(event_value)
    return 0

def _load_payload_from_env_or_stdin() -> Dict[str, Any]:
    raw = os.environ.get("WEBHOOK_PAYLOAD")
    if not raw:
        raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except Exception:
        try:
            fixed = raw.replace("'", '"')
            return json.loads(fixed)
        except Exception:
            return {}

def _ensure_event_field(payload: Dict[str, Any], value: str) -> None:
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
    if len(value) > MAX_EMBED_FIELD_VALUE_LENGTH:
        value = trunc_with_ellipsis(value, MAX_EMBED_FIELD_VALUE_LENGTH)
    if idx_event >= 0:
        fields[idx_event]["value"] = value or "No further information"
        fields[idx_event]["inline"] = False
        if "name" in fields[idx_event]:
            nm = str(fields[idx_event]["name"])
            if len(nm) > MAX_EMBED_FIELD_NAME_LENGTH:
                fields[idx_event]["name"] = trunc_with_ellipsis(nm, MAX_EMBED_FIELD_NAME_LENGTH)
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

def cmd_edit_payload(args: argparse.Namespace) -> int:
    event_value = args.event_value or os.environ.get("EVENT_VALUE") or ""
    if not event_value:
        print("::error::EVENT_VALUE not provided (use --event-value or env EVENT_VALUE)", file=sys.stderr)
        return 1
    payload = _load_payload_from_env_or_stdin()
    if not payload:
        print("::error::WEBHOOK_PAYLOAD not provided (env or stdin) or invalid JSON", file=sys.stderr)
        return 1
    _ensure_event_field(payload, event_value)
    final_json = json.dumps(payload, ensure_ascii=False)
    write_actions_output("payload", final_json)
    print(final_json)
    return 0

def cmd_post(args: argparse.Namespace) -> int:
    webhook = args.webhook or os.environ.get("WEBHOOK_URL") or os.environ.get("DISCORD_WEBHOOK") or ""
    if not webhook:
        print("::error::WEBHOOK_URL (or DISCORD_WEBHOOK) not provided", file=sys.stderr)
        return 1
    payload_str = os.environ.get("WEBHOOK_PAYLOAD") or ""
    if not payload_str.strip():
        payload_str = sys.stdin.read()
    if not payload_str.strip():
        print("::error::WEBHOOK_PAYLOAD not provided (env or stdin)", file=sys.stderr)
        return 1
    try:
        _ = json.loads(payload_str)
    except Exception as e:
        print(f"::error::Invalid JSON payload: {e}", file=sys.stderr)
        return 1
    js = textwrap.dedent(
        """
        const axios = require("axios");
        (async () => {
          try {
            const url = process.env.WEBHOOK_URL;
            const raw = process.env.WEBHOOK_PAYLOAD;
            if (!url) throw new Error("WEBHOOK_URL missing");
            if (!raw) throw new Error("WEBHOOK_PAYLOAD missing");
            const payload = JSON.parse(raw);
            const res = await axios.post(url, payload, { timeout: 45000 });
            console.log(`POST -> ${res.status} ${res.statusText}`);
            process.exit(0);
          } catch (e) {
            const status = e?.response?.status;
            const data = e?.response?.data;
            if (status) {
              console.error(`[axios] ERROR ${status}`);
            }
            if (data) {
              try {
                console.error(typeof data === "string" ? data : JSON.stringify(data));
              } catch (_) {
                console.error(String(data));
              }
            }
            console.error(e?.message || String(e));
            process.exit(1);
          }
        })();
        """
    )
    with tempfile.TemporaryDirectory() as td:
        js_path = os.path.join(td, "post.js")
        with open(js_path, "w", encoding="utf-8") as f:
            f.write(js)
        env = os.environ.copy()
        env["WEBHOOK_URL"] = webhook
        env["WEBHOOK_PAYLOAD"] = payload_str
        try:
            proc = subprocess.run(["node", js_path], env=env, check=False)
            return proc.returncode
        except FileNotFoundError:
            print("::error::Node.js not found. Please ensure Node is available in PATH.", file=sys.stderr)
            return 1

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Discord tools for GH Actions")
    sub = p.add_subparsers(dest="cmd", required=True)
    p_trim = sub.add_parser("trim", help="Build a balanced Event field value from release notes")
    p_trim.set_defaults(func=cmd_trim)
    p_edit = sub.add_parser("edit-payload", help="Inject trimmed Event value into webhook payload JSON")
    p_edit.add_argument("--event-value", default="", help="Trimmed Event field value (or set env EVENT_VALUE)")
    p_edit.set_defaults(func=cmd_edit_payload)
    p_post = sub.add_parser("post", help="Post payload to Discord using axios (Node.js required)")
    p_post.add_argument("--webhook", default="", help="Discord webhook URL (or set env WEBHOOK_URL / DISCORD_WEBHOOK)")
    p_post.set_defaults(func=cmd_post)
    return p

def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)

if __name__ == "__main__":
    sys.exit(main())