#!/usr/bin/env python3
"""
Single-script release handler with four modes:

- MODE=pr-merge
    * PR merged path (beta base, or stable-conversion beta->latest)

- MODE=commit-push
    * Manual commit(s) pushed directly to beta (non-PR commits)

- MODE=finalize
    * Finalize changelog + release body for a published GitHub Release

- MODE=rollback
    * Rollback finalize + release state after failed npm publish
"""
import datetime
import json
import os
import re
import sys
import tempfile

from dataclasses import dataclass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

from common import Context

CHANGELOG_FILE = "CHANGELOG.md"
CATEGORY_ORDER = [
    "Breaking Changes",
    "Featured Changes",
    "Bug Fixes",
    "Other Changes",
]

def _now_date_utc() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d")

def _repo() -> str:
    return os.environ.get("GITHUB_REPOSITORY", "")

def _header_has_date(line: str) -> bool:
    return bool(re.search(r"\(\d{4}-\d{2}-\d{2}\)\s*$", line))

@dataclass(order=True, frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    beta: int | None = None

    @classmethod
    def parse(cls, s: str) -> "Version":
        m = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$").match(s)
        if not m:
            raise ValueError(s)
        a, b, c, d = m.groups()
        return cls(int(a), int(b), int(c), int(d) if d is not None else None)

    def is_beta(self) -> bool:
        return self.beta is not None

    def tag(self) -> str:
        return f"v{self.major}.{self.minor}.{self.patch}" + (
            f"-beta.{self.beta}" if self.beta is not None else ""
        )

    def base(self) -> "Version":
        return Version(self.major, self.minor, self.patch, None)

    def bump_major(self) -> "Version":
        return Version(self.major + 1, 0, 0)

    def bump_minor(self) -> "Version":
        return Version(self.major, self.minor + 1, 0)

    def bump_patch(self) -> "Version":
        return Version(self.major, self.minor, self.patch + 1)

    def next_beta(self) -> "Version":
        return Version(
            self.major,
            self.minor,
            self.patch,
            0 if self.beta is None else self.beta + 1,
        )

def _version_sort_key(v: Version) -> tuple[int, int, int, int]:
    return (
        v.major,
        v.minor,
        v.patch,
        10_000 if v.beta is None else v.beta,
    )

def _read_changelog() -> str:
    if not os.path.exists(CHANGELOG_FILE):
        return "# Changelog\n\n"
    return open(CHANGELOG_FILE, "r", encoding="utf-8").read()

def _write_changelog(content: str) -> None:
    if not content.endswith("\n"):
        content += "\n"
    open(CHANGELOG_FILE, "w", encoding="utf-8").write(content)

def _list_versions(content: str) -> list[Version]:
    out: list[Version] = []
    for m in re.compile(
        r"^## \[(v[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?)\]", re.MULTILINE
    ).finditer(content):
        try:
            out.append(Version.parse(m.group(1)))
        except Exception:
            pass
    return sorted(set(out), key=_version_sort_key)

def _find_section_block(content: str, tag: str) -> str:
    pattern = rf"^## \[{re.escape(tag)}\].*?\n(.*?)(?=^## \[v|\Z)"
    m = re.search(pattern, content, flags=re.S | re.M)
    return m.group(1).strip() if m else ""

def _squeeze_blank(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    prev_blank = False
    for l in lines:
        blank = l.strip() == ""
        if blank and prev_blank:
            continue
        out.append(l)
        prev_blank = blank
    return "\n".join(out)

def _release_matches_tag(rel: dict, tag: str) -> bool:
    if not isinstance(rel, dict):
        return False
    tag = (tag or "").strip()
    if not tag:
        return False
    if not rel.get("draft"):
        tn = (rel.get("tag_name") or "").strip()
        if not tn:
            return False
        return tn == tag or tn.lstrip("v") == tag.lstrip("v")
    name = (rel.get("name") or "").strip()
    if not name:
        tn = (rel.get("tag_name") or "").strip()
        return tn == tag or tn.lstrip("v") == tag.lstrip("v")
    return name == tag or name.lstrip("v") == tag.lstrip("v")

def _categorize_pr(labels: list[str]) -> str:
    low = {l.lower() for l in labels}
    if low & {"breaking-change"}:
        return "Breaking Changes"
    if low & {"enhancement", "feature"}:
        return "Featured Changes"
    if low & {"fix", "bug", "bugfix"}:
        return "Bug Fixes"
    if low & {"docs", "documentation"}:
        return "Other Changes"
    return "Other Changes"

def _categorize_commit(msg: str) -> str:
    if not msg:
        return "Other Changes"
    m = re.match(r"^\s*\[([^\]]+)\]\s*(.*)$", msg)
    tag_block = m.group(1).strip().lower() if m else ""
    if tag_block:
        parts = [p.strip() for p in tag_block.split(",") if p.strip()]
        if any(p in ("breaking", "breaking-change", "breaking_changes") for p in parts):
            return "Breaking Changes"
        if any(p in ("feature", "enhancement") for p in parts):
            return "Featured Changes"
        if any(p in ("bug", "fix", "bugfix") for p in parts):
            return "Bug Fixes"
    return "Other Changes"

def _labels_from_commit(msg: str) -> list[str]:
    if not msg:
        return []
    m = re.match(r"^\s*\[([^\]]+)\]\s*(.*)$", msg)
    tag_block = m.group(1).strip().lower() if m else ""
    if not tag_block:
        return []
    out: list[str] = []
    parts = [p.strip() for p in tag_block.split(",") if p.strip()]
    for token in parts:
        if token in ("breaking", "breaking-change", "breaking_changes"):
            out.append("breaking-change")
        elif token in ("feature", "enhancement"):
            out.append("feature")
        elif token in ("bug", "fix", "bugfix"):
            out.append("fix")
    return out

def _build_commit_entry(display: str, commit_sha: str, repo: str, author: str) -> str:
    sha7 = commit_sha[:7]
    author_display = author or "unknown"
    if author_display and not author_display.startswith("@") and " " not in author_display:
        author_display = f"@{author_display}"
    return (
        f"- {display} "
        f"[{sha7}](https://github.com/{repo}/commit/{commit_sha}) "
        f"({author_display})"
    )

def _bump_type(labels: list[str]) -> str:
    low = {l.lower() for l in labels}
    if low & {"breaking-change"}:
        return "major"
    if low & {"enhancement", "feature"}:
        return "minor"
    return "patch"

def _build_section_header(tag: str, add_date: bool, date: str | None = None) -> str:
    base = f"## [{tag}](https://github.com/{_repo()}/releases/tag/{tag})"
    return f"{base} ({date})" if add_date and date else base

def _normalize_section_spacing(section: list[str]) -> list[str]:
    if not section:
        return section[:]
    fc_idx = None
    for i, l in enumerate(section):
        if l.startswith("**Full Changelog**"):
            fc_idx = i
            break
    header = section[0]
    body = section[1:fc_idx] if fc_idx is not None else section[1:]
    fc_line = section[fc_idx] if fc_idx is not None else None
    out: list[str] = [header, ""]
    i = 0
    while i < len(body):
        line = body[i]
        if line.startswith("### "):
            out.append(line)
            out.append("")
            i += 1
            items: list[str] = []
            while i < len(body):
                cur = body[i]
                if cur.startswith("### ") or cur.startswith("**Full Changelog**"):
                    break
                if cur.startswith("- "):
                    items.append(cur)
                i += 1
            out.extend(items)
            if items:
                out.append("")
        else:
            i += 1
    if fc_line:
        if out and out[-1] != "":
            out.append("")
        out.append(fc_line)
        out.append("")
    normalized: list[str] = []
    prev_blank = False
    for l in out:
        is_blank = l.strip() == ""
        if is_blank and prev_blank:
            continue
        normalized.append(l)
        prev_blank = is_blank
    return normalized

def _insert_entry(
    content: str,
    version: Version,
    category: str,
    entry: str,
    compare_from: str | None,
    *,
    add_date: bool = False,
    publish_date: str | None = None,
) -> str:
    tag = version.tag()
    header_pattern = f"## [{tag}]"
    lines = content.splitlines()
    header_idx = next(
        (i for i, l in enumerate(lines) if l.startswith(header_pattern)), None
    )
    if header_idx is None:
        section_header = _build_section_header(tag, add_date, publish_date)
        new_sec = [section_header, "", f"### {category}", "", entry, ""]
        if compare_from:
            new_sec += [
                f"**Full Changelog**: https://github.com/{_repo()}/compare/{compare_from}...{tag}",
                "",
            ]
        out: list[str] = []
        inserted = False
        for l in lines:
            out.append(l)
            if not inserted and l.startswith("# "):
                out += new_sec
                inserted = True
        if not inserted:
            out = ["# Changelog", ""] + new_sec + out
        return _squeeze_blank("\n".join(out)) + "\n"
    if add_date and not _header_has_date(lines[header_idx]):
        lines[header_idx] = f"{lines[header_idx]} ({publish_date})"
    i = header_idx + 1
    end = len(lines)
    while i < len(lines):
        if lines[i].startswith("## [v") and not lines[i].startswith(header_pattern):
            end = i
            break
        i += 1
    section = lines[header_idx:end]
    if entry in section:
        normalized = _normalize_section_spacing(section)
        new_content = lines[:header_idx] + normalized + lines[end:]
        return _squeeze_blank("\n".join(new_content)) + "\n"
    cat_header = f"### {category}"

    def section_category_positions(
        sec_lines: list[str],
    ) -> tuple[list[tuple[int, int]], int | None]:
        cat_pos: list[tuple[int, int]] = []
        fc_idx: int | None = None
        for idx, l in enumerate(sec_lines):
            if l.startswith("### "):
                cname = l[4:].strip()
                prio = CATEGORY_ORDER.index(cname) if cname in CATEGORY_ORDER else 999
                cat_pos.append((idx, prio))
            if fc_idx is None and l.startswith("**Full Changelog**"):
                fc_idx = idx
        return cat_pos, fc_idx
    has_cat = any(l.strip() == cat_header for l in section)
    if not has_cat:
        cat_pos, fc_idx = section_category_positions(section)
        desired_prio = (
            CATEGORY_ORDER.index(category) if category in CATEGORY_ORDER else 999
        )
        insertion_local_idx: int | None = None
        for idx, prio in cat_pos:
            if prio > desired_prio:
                insertion_local_idx = idx
                break
        if insertion_local_idx is None:
            insertion_local_idx = fc_idx if fc_idx is not None else len(section)
        to_insert = [cat_header, "", entry, ""]
        section = (
            section[:insertion_local_idx]
            + to_insert
            + section[insertion_local_idx:]
        )
    else:
        cat_idx = next(i for i, l in enumerate(section) if l.strip() == cat_header)
        i = cat_idx + 1
        items: list[str] = []
        while i < len(section):
            cur = section[i]
            if cur.startswith("### ") or cur.startswith("**Full Changelog**"):
                break
            if cur.startswith("- "):
                items.append(cur)
            i += 1
        commits = [it for it in items if "/commit/" in it]
        prs = [it for it in items if "/commit/" not in it]
        is_commit = "/commit/" in entry
        is_housekeeping = ("[beta-release]" in entry) or ("[release]" in entry)
        if is_commit:
            commits.insert(0, entry)
        elif not is_housekeeping:
            prs.append(entry)

            def _pr_sort_key(line: str) -> int:
                m = re.search(r"#(\d+)\]", line)
                if not m:
                    m = re.search(r"/pull/(\d+)", line)
                return int(m.group(1)) if m else 10**9

            prs = sorted(prs, key=_pr_sort_key, reverse=True)
        if is_housekeeping:
            new_block: list[str] = [cat_header, "", entry, ""]
        else:
            new_block = [cat_header, ""]
        new_block.extend(commits)
        new_block.extend(prs)
        new_block.append("")
        section = section[:cat_idx] + new_block + section[i:]
    if compare_from and not any("**Full Changelog**" in l for l in section):
        section += [
            f"**Full Changelog**: https://github.com/{_repo()}/compare/{compare_from}...{tag}",
            "",
        ]
    section = _normalize_section_spacing(section)
    new_content = lines[:header_idx] + section + lines[end:]
    return _squeeze_blank("\n".join(new_content)) + "\n"

def _rename_version_section(content: str, old_tag: str, new_tag: str) -> str:
    old_header = f"## [{old_tag}]"
    new_header = _build_section_header(new_tag, False)
    lines = content.splitlines()
    for i, l in enumerate(lines):
        if l.startswith(old_header):
            lines[i] = new_header
        if "**Full Changelog**" in l and l.endswith(f"...{old_tag}"):
            lines[i] = re.sub(
                rf"\.\.{re.escape(old_tag)}$", f"..{new_tag}", l
            )
    return "\n".join(lines) + "\n"

def _add_publish_date(content: str, tag: str, date: str) -> str:
    lines = content.splitlines()
    prefix = f"## [{tag}]"
    for i, l in enumerate(lines):
        if l.startswith(prefix) and not _header_has_date(l):
            lines[i] = l + f" ({date})"
            break
    return "\n".join(lines) + "\n"

def _collect_section_categories(block: str) -> dict[str, list[str]]:
    cats: dict[str, list[str]] = {}
    current: str | None = None
    for line in block.splitlines():
        if line.startswith("### "):
            current = line[4:].strip()
            cats.setdefault(current, [])
        elif line.startswith("- ") and current:
            cats[current].append(line)
    return cats

def _build_beta_body(version: Version, changelog: str) -> str:
    block = _find_section_block(changelog, version.tag())
    cats = _collect_section_categories(block)
    if version.beta == 0:
        prev_stable, _ = _latest_versions(changelog)
        compare_from = prev_stable.tag() if prev_stable else "v0.0.0"
    else:
        prev_beta = Version(
            version.major, version.minor, version.patch, version.beta - 1
        )
        compare_from = prev_beta.tag()
    ordered = [c for c in CATEGORY_ORDER if c in cats] + [
        c for c in cats if c not in CATEGORY_ORDER
    ]
    if not ordered:
        body_sections = "### Other Changes\n\n_No changes in this beta release._"
    else:
        parts: list[str] = []
        for c in ordered:
            parts.append(f"### {c}\n")
            parts.extend(cats[c])
            parts.append("")
        body_sections = "\n".join(parts).strip()
    full_changelog_line = (
        f"**Full Changelog**: https://github.com/{_repo()}/compare/{compare_from}..."
        f"{version.tag()}"
    )
    return f"{body_sections}\n\n{full_changelog_line}"

def _build_stable_body(version: Version, changelog: str, prev_stable: Version) -> str:
    block = _find_section_block(changelog, version.tag())
    cats = _collect_section_categories(block)
    ordered = [c for c in CATEGORY_ORDER if c in cats] + [
        c for c in cats if c not in CATEGORY_ORDER
    ]
    parts: list[str] = []
    if ordered:
        for c in ordered:
            parts.append(f"### {c}\n")
            parts.extend(cats[c])
            parts.append("")
    else:
        parts = ["### Other Changes", "", "_No changes in this release._", ""]
    parts.append(
        f"**Full Changelog**: https://github.com/{_repo()}/compare/{prev_stable.tag()}..."
        f"{version.tag()}"
    )
    return "\n".join(parts).strip()

def _latest_versions(changelog: str) -> tuple[Version | None, Version | None]:
    versions = _list_versions(changelog)
    stable = [v for v in versions if not v.is_beta()]
    beta = [v for v in versions if v.is_beta()]
    latest_stable = max(stable, key=_version_sort_key) if stable else None
    latest_beta = max(beta, key=_version_sort_key) if beta else None
    return latest_stable, latest_beta

def _section_is_published(content: str, tag: str) -> bool:
    prefix = f"## [{tag}]"
    for l in content.splitlines():
        if l.startswith(prefix):
            return _header_has_date(l)
    return False

def _latest_published_beta(content: str) -> Version | None:
    versions = _list_versions(content)
    betas = [v for v in versions if v.is_beta() and _section_is_published(content, v.tag())]
    return max(betas, key=_version_sort_key) if betas else None

def _find_latest_unpublished_beta_draft(content: str) -> Version | None:
    versions = _list_versions(content)
    drafts: list[Version] = []
    for v in versions:
        if not v.is_beta():
            continue
        if _section_is_published(content, v.tag()):
            continue
        drafts.append(v)
    return max(drafts, key=_version_sort_key) if drafts else None

def _base_bump_level(latest_stable: Version | None, base: Version) -> str:
    if latest_stable is None:
        return "major"
    if base.major > latest_stable.major:
        return "major"
    if base.major == latest_stable.major and base.minor > latest_stable.minor:
        return "minor"
    return "patch"

def _collect_betas(
    content: str,
    prev_stable: Version | None,
    target_stable: Version,
) -> list[Version]:
    versions = _list_versions(content)
    betas: list[Version] = []
    for v in versions:
        if not v.is_beta():
            continue
        base = v.base()
        if prev_stable is not None and base <= prev_stable.base():
            continue
        if base > target_stable.base():
            continue
        betas.append(v)
    return sorted(betas, key=_version_sort_key)

def _bump_base(latest_stable: Version | None, bump: str) -> Version:
    base = latest_stable or Version(0, 0, 0)
    if bump == "major":
        return base.bump_major()
    if bump == "minor":
        return base.bump_minor()
    return base.bump_patch()

def _decide_beta_target(
    content: str,
    latest_stable: Version | None,
    labels: list[str],
) -> tuple[Version, bool, Version | None]:
    required_bump = _bump_type(labels)
    required_base = _bump_base(latest_stable, required_bump)
    latest_published_beta = _latest_published_beta(content)
    existing_unpublished = _find_latest_unpublished_beta_draft(content)

    def _v(v: Version | None) -> str:
        return v.tag() if v else "None"

    print(
        "[release-manager] _decide_beta_target: "
        f"latest_stable={_v(latest_stable)}, "
        f"latest_published_beta={_v(latest_published_beta)}, "
        f"existing_unpublished={_v(existing_unpublished)}, "
        f"bump={required_bump}, required_base={required_base.tag()}"
    )
    if existing_unpublished:
        draft_base = existing_unpublished.base()
        draft_bump = _base_bump_level(latest_stable, draft_base)
        if draft_bump == "patch":
            if required_bump == "patch":
                print(
                    "[release-manager] _decide_beta_target: reusing existing patch draft "
                    f"{existing_unpublished.tag()} for patch bump"
                )
                return existing_unpublished, False, existing_unpublished
            new_base = _bump_base(latest_stable, required_bump)
            target = Version(new_base.major, new_base.minor, new_base.patch, 0)
            print(
                "[release-manager] _decide_beta_target: migrating patch draft "
                f"{existing_unpublished.tag()} -> {target.tag()} for {required_bump} bump"
            )
            return target, True, existing_unpublished
        if draft_bump == "minor":
            if required_bump in ("patch", "minor"):
                print(
                    "[release-manager] _decide_beta_target: reusing existing minor draft "
                    f"{existing_unpublished.tag()} for {required_bump} bump"
                )
                return existing_unpublished, False, existing_unpublished
            new_base = _bump_base(latest_stable, "major")
            target = Version(new_base.major, new_base.minor, new_base.patch, 0)
            print(
                "[release-manager] _decide_beta_target: migrating minor draft "
                f"{existing_unpublished.tag()} -> {target.tag()} for major bump"
            )
            return target, True, existing_unpublished
        if draft_bump == "major":
            print(
                "[release-manager] _decide_beta_target: reusing existing major draft "
                f"{existing_unpublished.tag()} for {required_bump} bump"
            )
            return existing_unpublished, False, existing_unpublished
    if latest_published_beta is not None:
        published_base = latest_published_beta.base()
        if required_base > published_base:
            target = Version(
                required_base.major, required_base.minor, required_base.patch, 0
            )
            print(
                "[release-manager] _decide_beta_target: starting new base from "
                f"published {latest_published_beta.tag()} -> {target.tag()}"
            )
            return target, False, None
        target = latest_published_beta.next_beta()
        print(
            "[release-manager] _decide_beta_target: continuing published base "
            f"{published_base.tag()} with next beta -> {target.tag()}"
        )
        return target, False, None
    target = Version(required_base.major, required_base.minor, required_base.patch, 0)
    print(
        "[release-manager] _decide_beta_target: no betas yet; starting "
        f"new series at {target.tag()}"
    )
    return target, False, None

def _beta_compare_from(
    target_version: Version,
    latest_stable: Version | None,
) -> str | None:
    if target_version.beta == 0:
        return latest_stable.tag() if latest_stable else "v0.0.0"
    if target_version.beta and target_version.beta > 0:
        return (
            f"v{target_version.major}.{target_version.minor}."
            f"{target_version.patch}-beta.{target_version.beta - 1}"
        )
    return None

def _escalate_beta_draft(
    context: Context,
    content: str,
    existing_unpublished: Version,
    target_version: Version,
    *,
    reason: str,
) -> str:
    if existing_unpublished.tag() == target_version.tag():
        return content
    if f"## [{existing_unpublished.tag()}]" in content:
        content = _rename_version_section(
            content, existing_unpublished.tag(), target_version.tag()
        )
    old_tag = existing_unpublished.tag()
    old_rel = common.gh_release(context.github_repository, context.github_token, tag=old_tag)
    if old_rel and old_rel.get("id"):
        common.gh_release_update(
            context.github_repository,
            context.github_token,
            int(old_rel["id"]),
            tag_name=target_version.tag(),
            name=target_version.tag(),
        )
    common.git_delete_tag(old_tag)
    print(
        f"[release-manager] Escalated draft {old_tag} -> {target_version.tag()} "
        f"({reason})."
    )
    return content

def _create_beta_entry(
    context: Context,
    content: str,
    labels: list[str],
    category: str,
    entry: str,
    *,
    reason: str,
) -> tuple[str, Version]:
    latest_stable, _ = _latest_versions(content)
    target_version, replace, existing_unpublished = _decide_beta_target(
        content,
        latest_stable,
        labels,
    )
    if replace and existing_unpublished:
        content = _escalate_beta_draft(
            context,
            content,
            existing_unpublished,
            target_version,
            reason=reason,
        )
        latest_stable, _ = _latest_versions(content)
    compare_from = _beta_compare_from(target_version, latest_stable)
    if f"## [{target_version.tag()}]" in content:
        section_block = _find_section_block(content, target_version.tag())
        if "**Full Changelog**" in section_block:
            compare_from = None
    content = _insert_entry(
        content, target_version, category, entry, compare_from, add_date=False
    )
    return content, target_version

def _aggregate_betas_to_stable(
    content: str, target: Version, betas: list[Version]
) -> tuple[str, list[str]]:
    aggregated: dict[str, list[str]] = {c: [] for c in CATEGORY_ORDER}
    seen: set[str] = set()
    included_tags: list[str] = []
    for b in betas:
        block = _find_section_block(content, b.tag())
        if not block:
            continue
        included_tags.append(b.tag())
        cats = _collect_section_categories(block)
        for cat, entries in cats.items():
            if cat not in aggregated:
                aggregated[cat] = []
            for e in entries:
                if e.endswith("[beta-release] (@github-actions)"):
                    continue
                if e not in seen:
                    aggregated[cat].append(e)
                    seen.add(e)
    if included_tags:
        note = (
            f"- Convert beta releases ({', '.join(included_tags)}) "
            f"to regular release {target.tag()} [beta-to-release] (@github-actions)"
        )
        aggregated.setdefault("Other Changes", []).append(note)
    header = _build_section_header(target.tag(), add_date=False)
    prev_stable, _ = _latest_versions(content)
    prev_stable = prev_stable or Version(0, 0, 0)
    parts: list[str] = [header, ""]
    for cat in CATEGORY_ORDER:
        if aggregated.get(cat):
            parts.append(f"### {cat}")
            parts.append("")
            parts.extend(aggregated[cat])
            parts.append("")
    parts += [
        f"**Full Changelog**: https://github.com/{_repo()}"
        f"/compare/{prev_stable.tag()}...{target.tag()}",
        "",
    ]
    lines = content.splitlines()
    out: list[str] = []
    inserted = False
    for l in lines:
        out.append(l)
        if not inserted and l.startswith("# "):
            out += [""] + parts
            inserted = True
    if not inserted:
        out = ["# Changelog", ""] + parts + out
    new_content = _squeeze_blank("\n".join(out)) + "\n"
    return new_content, included_tags

def _ensure_repo_node_version(version: Version, context: str) -> None:
    target = version.tag().lstrip("v")
    if common.npm_pkg_set_version(target):
        common.git_commit_files(
            ["package.json", "package-lock.json"],
            f"Align package versions to {version.tag()} ({context})",
        )

def _upsert_release(
    context: Context,
    tag: str,
    body: str,
    *,
    draft: bool,
    prerelease: bool,
    target_commitish: str | None = None,
) -> None:
    rel = common.gh_release(context.github_repository, context.github_token, tag=tag)
    if not rel:
        for r in common.gh_releases(context.github_repository, context.github_token, max_pages=50):
            if _release_matches_tag(r, tag):
                rel = r
                break
    updated = False
    if rel and rel.get("id"):
        rel_id = int(rel["id"])
        print(
            f"[release-manager] Found existing release id={rel_id} for tag {tag}; updating."
        )
        fields: dict[str, any] = {"body": body, "name": tag}
        if rel.get("draft"):
            fields["tag_name"] = tag
        fields["draft"] = bool(draft)
        fields["prerelease"] = bool(prerelease)
        try:
            common.gh_release_update(context.github_repository, context.github_token, rel_id, **fields)
            updated = True
        except Exception as e:
            print(
                f"[release-manager] Warning: update_release failed for id={rel_id}: {e}",
                file=sys.stderr,
            )
    if not updated:
        print(
            f"[release-manager] Creating release {tag} "
            f"(draft={draft}, prerelease={prerelease})."
        )
        try:
            common.gh_release_create(
                context.github_repository,
                context.github_token,
                tag,
                target_commitish=target_commitish or "beta",
                draft=draft,
                prerelease=prerelease,
                name=tag,
                body=body,
            )
            _reconcile_duplicate_releases(context, tag)
        except Exception as e:
            print(
                f"[release-manager] ERROR: create_release failed for {tag}: {e}",
                file=sys.stderr,
            )

def _reconcile_duplicate_releases(context: Context, tag: str) -> None:
    try:
        all_rels = common.gh_releases(context.github_repository, context.github_token, max_pages=50)
        matches = [r for r in all_rels if _release_matches_tag(r, tag)]
        print(
            f"[release-manager] reconcile: found {len(matches)} releases matching tag {tag}"
        )
        for r in matches:
            print(
                "[release-manager] reconcile: "
                f"id={r.get('id')} tag={r.get('tag_name')} name={r.get('name')} "
                f"created_at={r.get('created_at')} draft={r.get('draft')} "
                f"prerelease={r.get('prerelease')}"
            )
        if len(matches) <= 1:
            return
        if any(r.get("created_at") for r in matches):
            preferred = max(matches, key=lambda x: x.get("created_at") or "")
        else:
            preferred = max(matches, key=lambda x: x.get("id") or 0)
        preferred_id = preferred.get("id")
        for r in matches:
            try:
                if r.get("id") != preferred_id:
                    print(
                        "[release-manager] Deleting duplicate release "
                        f"id={r.get('id')} tag={r.get('tag_name')} name={r.get('name')}"
                    )
                    common.gh_release_delete(context.github_repository, context.github_token, int(r.get("id")))
            except Exception as e_del:
                print(
                    "[release-manager] Warning: failed to delete duplicate release "
                    f"id={r.get('id')}: {e_del}",
                    file=sys.stderr,
                )
    except Exception as e:
        print(
            f"[release-manager] Warning: could not reconcile duplicate releases: {e}",
            file=sys.stderr,
        )

def _load_labels(path: str) -> list[str]:
    labels: list[str] = []
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            loaded = json.load(f)
        labels = [str(l).strip().lower() for l in loaded if l]
    except Exception as e:
        print(f"[release-manager] ERROR reading labels file {path}: {e}")
        return []
    print(f"[release-manager] Loaded labels: {labels}")
    return labels

def _finalize_common(context: Context, v: Version, *, is_beta: bool) -> None:
    content = _read_changelog()
    hk_label = "beta-release" if is_beta else "release"
    entry = (
        f"- Update CHANGELOG.md for "
        f"{'beta release' if is_beta else 'release'} {v.tag()} [{hk_label}] (@github-actions)"
    )
    content = _insert_entry(content, v, "Other Changes", entry, None, add_date=False)
    content = _add_publish_date(content, v.tag(), _now_date_utc())
    _write_changelog(content)
    common.git_commit_files(
        [CHANGELOG_FILE],
        f"Finalize {'beta' if is_beta else 'stable'} release {v.tag()} in CHANGELOG.md",
    )
    common.git_force_tag(v.tag())
    if is_beta:
        body = _build_beta_body(v, content)
    else:
        versions = [x for x in _list_versions(content) if not x.is_beta()]
        versions_sorted = sorted(versions, key=_version_sort_key)
        prev = Version(0, 0, 0)
        if len(versions_sorted) > 1 and versions_sorted[-1] == v:
            prev = versions_sorted[-2]
        body = _build_stable_body(v, content, prev)
    rel = common.gh_release(context.github_repository, context.github_token, tag=v.tag())
    if rel and rel.get("id"):
        common.gh_release_update(context.github_repository, context.github_token, int(rel["id"]), body=body)

def _rollback_changelog_finalize_metadata(tag: str, target_branch: str | None) -> bool:
    path = CHANGELOG_FILE
    if not os.path.exists(path):
        print("[rollback] CHANGELOG.md not found; skipping.")
        return False
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()
    header_re = re.compile(rf"^## \[{re.escape(tag)}\].*$")
    next_header_re = re.compile(r"^## \[v[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?\]")
    start = None
    for i, l in enumerate(lines):
        if header_re.match(l):
            start = i
            break
    if start is None:
        print(f"[rollback] Section for {tag} not found; skipping.")
        return False
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if next_header_re.match(lines[j]):
            end = j
            break
    new_header = re.sub(r"\s*\(\d{4}-\d{2}-\d{2}\)\s*$", "", lines[start])
    changed = False
    if new_header != lines[start]:
        lines[start] = new_header
        changed = True
    hk_re = re.compile(
        rf"^- +Update CHANGELOG\.md for (?:beta release|release) {re.escape(tag)}.*@github-actions.*$"
    )
    keep: list[str] = []
    for idx in range(start + 1, end):
        if hk_re.match(lines[idx]):
            changed = True
            continue
        keep.append(lines[idx])
    if not changed:
        print(f"[rollback] No finalize metadata to remove for {tag}")
        return False
    sec = [lines[start]] + keep
    sec_start = 1
    sec_end = len(sec)
    i = sec_start
    while i < sec_end:
        line = sec[i]
        if line.startswith("### Other Changes"):
            j = i + 1
            has_bullets = False
            while j < sec_end:
                cur = sec[j]
                if cur.startswith("### "):
                    break
                if cur.startswith("**Full Changelog**"):
                    break
                if cur.startswith("- "):
                    has_bullets = True
                    break
                j += 1
            if not has_bullets:
                remove_end = i + 1
                while remove_end < sec_end and sec[remove_end].strip() == "":
                    remove_end += 1
                sec = sec[:i] + sec[remove_end:]
                sec_end = len(sec)
                continue
        i += 1
    new_lines = lines[:start] + sec + lines[end:]
    out_lines: list[str] = []
    prev_blank = False
    for l in new_lines:
        is_blank = l.strip() == ""
        if is_blank and prev_blank:
            continue
        out_lines.append(l)
        prev_blank = is_blank
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")
    print(f"[rollback] CHANGELOG.md updated for {tag}")
    if target_branch:
        try:
            common.git_fetch(target_branch, depth=0)
            common.git_checkout_ref(target_branch, create_branch_from=target_branch)
            common.git_commit_files(
                [CHANGELOG_FILE],
                f"Rollback finalize metadata for {tag} due to npm publish failure",
            )
            print(f"[rollback] Pushed CHANGELOG rollback to {target_branch}.")
        except Exception as e:
            print(f"::warning::Failed to push CHANGELOG rollback: {e}")
    return True

def _clean_finalize_lines(text: str, tag: str) -> str:
    hk_re = re.compile(
        rf"^- +Update CHANGELOG\.md for (?:beta release|release) {re.escape(tag)}.*@github-actions.*$"
    )
    return "\n".join([l for l in text.splitlines() if not hk_re.match(l)]).strip()

def _write_labels_temp(labels: list[str]) -> str:
    try:
        tf = tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8", suffix=".json")
        json.dump(labels, tf)
        tf.flush()
        tf.close()
        return tf.name
    except Exception as e:
        print(f"[release-manager] Warning: unable to write temp labels file: {e}")
        return ""

def _handle_rollback(context: Context) -> None:
    print("::warning::npm publish failed; beginning rollback sequence...")
    tag = context.tag
    rel = common.gh_release(context.github_repository, context.github_token, tag=tag)
    rel_name = None
    rel_body = None
    prerelease_flag = None
    target = None
    if rel:
        target = rel.get("target_commitish") or None
        rel_name = rel.get("name")
        rel_body = rel.get("body") or ""
        prerelease_flag = (
            bool(rel.get("prerelease"))
            if rel.get("prerelease") is not None
            else None
        )
        rel_id = rel.get("id")
        if rel_id:
            rel_id_int = int(rel_id)
            if not bool(rel.get("draft")):
                try:
                    deleted = common.gh_release_delete(context.github_repository, context.github_token, rel_id_int)
                    print(f"[rollback] Deleted published release (id={rel_id_int}): {deleted}")
                except Exception as e:
                    print(
                        f"::warning::Failed to delete release id={rel_id_int}: {e}"
                    )
            else:
                try:
                    updated = common.gh_release_update(
                        context.github_repository,
                        context.github_token,
                        rel_id_int,
                        draft=True,
                        prerelease=rel.get("prerelease", False),
                    )
                    if updated:
                        print(f"[rollback] Converted release to draft (id={rel_id_int})")
                except Exception as e:
                    print(
                        f"::warning::Failed to convert release to draft id={rel_id_int}: {e}"
                    )
    else:
        print(
            "[rollback] No release found by tag; continuing with "
            "tag deletion/CHANGELOG rollback."
        )
    if tag:
        common.git_delete_tag(tag)
    _rollback_changelog_finalize_metadata(tag, context.target_branch or target)
    try:
        if prerelease_flag is None:
            prerelease_flag = True if (target and target == "beta") else False
        cleaned_body = None
        if rel_body is not None:
            cleaned_body = _clean_finalize_lines(rel_body, tag) or None
        release_name = rel_name or tag
        created = common.gh_release_create(
            context.github_repository,
            context.github_token,
            tag,
            target_commitish=target or None,
            draft=True,
            prerelease=bool(prerelease_flag),
            name=release_name,
            body=cleaned_body,
        )
        if created:
            print(
                f"[rollback] Recreated draft release for {tag} "
                f"(prerelease={prerelease_flag})"
            )
        else:
            print(f"::warning::Could not recreate draft release for {tag}")
    except Exception as e:
        print(f"::warning::Failed to recreate draft release: {e}")

def _handle_finalize(context: Context) -> None:
    if not context.tag:
        print("::error::TAG is required for finalize")
        sys.exit(1)
    v = Version.parse(context.tag)
    if context.is_beta:
        _finalize_common(context, v, is_beta=True)
        print(f"[release-manager] Beta release finalized {v.tag()}")
    else:
        if v.is_beta():
            print("[release-manager] Use beta TAG with IS_BETA=true for beta finalize.")
            sys.exit(1)
        _finalize_common(context, v, is_beta=False)
        print(f"[release-manager] Stable release finalized {v.tag()}")

def _handle_commit_push(context: Context) -> None:
    head_before = context.head_before
    head_after = context.head_after
    if not head_after or re.fullmatch(r"0+", head_after):
        print("[release-manager] No actionable commit SHA provided; exiting.")
        return
    common.git_fetch("HEAD")
    shas = common.git_rev_list_range(head_before, head_after)
    if not shas:
        print(
            f"[release-manager] No commits found in range {head_before}..{head_after}; "
            f"falling back to single commit {head_after}"
        )
        shas = [head_after]
    else:
        print(
            f"[release-manager] Processing {len(shas)} commit(s) "
            f"from range {head_before}..{head_after}"
        )
    content = _read_changelog()
    final_target_version: Version | None = None
    added_manual_any = False
    first_sha7: str | None = None
    last_sha7: str | None = None
    processed_prs: set[int] = set()
    for sha in shas:
        sha7 = sha[:7]
        try:
            pulls = common.gh_commit_pulls(context.github_repository, context.github_token, sha)
        except Exception as exc:
            print(
                f"[release-manager] Warning: commits/{sha}/pulls lookup failed: {exc}",
                file=sys.stderr,
            )
            pulls = []
        if pulls:
            pr_nums = ", ".join(str(p.get("number")) for p in pulls)
            processed_this_sha = False
            for p in pulls:
                pr_num = p.get("number")
                if not pr_num:
                    continue
                try:
                    pr_num_int = int(pr_num)
                except Exception:
                    continue
                if pr_num_int in processed_prs:
                    print(f"[release-manager] PR #{pr_num_int} already processed; skipping for commit {sha7}.")
                    continue
                code, pr = common.github_api(context.github_repository, context.github_token, f"/pulls/{pr_num_int}")
                if code != 200 or not isinstance(pr, dict):
                    pr = p if isinstance(p, dict) else {}
                pr_user = (pr.get("user") or {}).get("login") or ""
                if "dependabot" in str(pr_user).lower() and pr.get("merged") is True:
                    print(f"[release-manager] Commit {sha7} is part of Dependabot PR #{pr_num_int}; delegating to PR merge handler.")
                    label_code, label_data = common.github_api(context.github_repository, context.github_token, f"/issues/{pr_num_int}/labels")
                    if label_code == 200 and isinstance(label_data, list):
                        labels_list = [((l.get("name") or "").lower()) for l in label_data]
                    else:
                        labels_list = [((l.get("name") or "").lower()) for l in pr.get("labels", []) if isinstance(l, dict)]
                    labels_path = _write_labels_temp(labels_list)
                    try:
                        pr_context = Context(
                            github_repository=context.github_repository,
                            github_token=context.github_token,
                            mode="pr-merge",
                        )
                        pr_context.pull_request_author = pr_user
                        pr_context.pull_request_branch = (pr.get("base") or {}).get("ref", "") or ""
                        pr_context.pull_request_number = str(pr_num_int)
                        pr_context.pull_request_title = pr.get("title") or ""
                        pr_context.pull_request_labels = labels_path
                        _handle_pr_merge(pr_context)
                        processed_prs.add(pr_num_int)
                        content = _read_changelog()
                        _, last_beta = _latest_versions(content)
                        final_target_version = last_beta or final_target_version
                        if first_sha7 is None:
                            first_sha7 = sha7
                        last_sha7 = sha7
                        processed_this_sha = True
                        break
                    finally:
                        if labels_path and os.path.exists(labels_path):
                            try:
                                os.unlink(labels_path)
                            except Exception:
                                pass
            if processed_this_sha:
                print(f"[release-manager] Commit {sha7} handled via Dependabot PR; skipping manual commit handling.")
                continue
            print(f"[release-manager] Commit {sha7} is part of PR(s) {pr_nums}; skipping manual changelog entry.")
            continue
        subject = common.git_get_commit_subject(sha) or sha
        display = subject or sha
        if isinstance(subject, str) and (
            re.match(r"^\s*Merge branch\b", subject, re.IGNORECASE)
            or re.search(r"(?:Finalize stable release|Align package versions|Update CHANGELOG.md)", subject, re.IGNORECASE)
        ):
            print(
                f"[release-manager] Skipping housekeeping commit {sha7}: "
                f"'{subject}'"
            )
            continue
        category = _categorize_commit(subject)
        derived_labels = _labels_from_commit(subject)
        author_display: str | None = None
        try:
            code, commit_info = common.github_api(
                context.github_repository, context.github_token, f"/commits/{sha}"
            )
            if code == 200 and isinstance(commit_info, dict):
                author_obj = commit_info.get("author") or {}
                if isinstance(author_obj, dict) and author_obj.get("login"):
                    author_display = f"@{author_obj['login']}"
                else:
                    nested = commit_info.get("commit", {}).get("author", {})
                    if isinstance(nested, dict) and nested.get("name"):
                        author_display = nested.get("name")
        except Exception:
            author_display = None
        if not author_display:
            author_display = common.git_get_commit_author_name(sha) or None
        automation_users = {"@actions-user"}
        if author_display and author_display.lower() in automation_users:
            print(f"[release-manager] Skipping automated commit {sha7} by {author_display}.")
            continue
        entry = _build_commit_entry(
            display, sha, context.github_repository, author_display or "unknown"
        )
        reason = f"manual commit {sha7}"
        content, target_version = _create_beta_entry(
            context=context,
            content=content,
            labels=derived_labels,
            category=category,
            entry=entry,
            reason=reason,
        )
        final_target_version = target_version
        added_manual_any = True
        if first_sha7 is None:
            first_sha7 = sha7
        last_sha7 = sha7
        print(
            f"[release-manager] Staged manual commit {sha7} into beta draft "
            f"{target_version.tag()} ({category})."
        )
    if not added_manual_any or final_target_version is None:
        print("[release-manager] No manual commits required changelog entries; exiting.")
        return
    _write_changelog(content)
    if first_sha7 == last_sha7:
        msg = f"Update CHANGELOG.md for manual commit {first_sha7}"
        version_context = f"manual commit {first_sha7}"
    else:
        msg = f"Update CHANGELOG.md for manual commits {first_sha7}..{last_sha7}"
        version_context = f"manual commits {first_sha7}..{last_sha7}"
    common.git_commit_files([CHANGELOG_FILE], msg)
    _ensure_repo_node_version(final_target_version, context=version_context)
    body = _build_beta_body(final_target_version, content)
    _upsert_release(
        context,
        final_target_version.tag(),
        body,
        draft=True,
        prerelease=True,
        target_commitish="beta",
    )
    if first_sha7 == last_sha7:
        print(
            f"[release-manager] Updated beta draft {final_target_version.tag()} "
            f"from manual commit {first_sha7}"
        )
    else:
        print(
            f"[release-manager] Updated beta draft {final_target_version.tag()} "
            f"from manual commits {first_sha7}..{last_sha7}"
        )

def _handle_pr_merge(context: Context) -> None:
    labels = _load_labels(context.pull_request_labels)
    if context.pull_request_branch == "latest" and "stable-conversion" in labels:
        m = re.search(r"v\d+\.\d+\.\d+", context.pull_request_title or "")
        if not m:
            print(
                "[release-manager] Stable conversion PR title must include "
                "version like vX.Y.Z"
            )
            return
        target_stable = Version.parse(m.group(0))
        content = _read_changelog()
        prev_stable, _ = _latest_versions(content)
        betas = _collect_betas(content, prev_stable, target_stable)
        if not betas:
            print(
                "[release-manager] No published betas found to convert in range; aborting."
            )
            return
        content, included = _aggregate_betas_to_stable(content, target_stable, betas)
        _write_changelog(content)
        common.git_commit_files(
            [CHANGELOG_FILE],
            f"Update CHANGELOG.md for stable PR #{context.pull_request_number}",
        )
        _ensure_repo_node_version(
            target_stable,
            context=f"stable PR #{context.pull_request_number}",
        )
        prev = prev_stable or Version(0, 0, 0)
        body = _build_stable_body(target_stable, content, prev)
        _upsert_release(
            context,
            target_stable.tag(),
            body,
            draft=True,
            prerelease=False,
            target_commitish="latest",
        )
        print(
            "[release-manager] Created/updated stable draft "
            f"{target_stable.tag()} targeted to latest; included betas: {included}"
        )
        return
    if context.pull_request_branch != "beta":
        print("[release-manager] PR base not beta, ignoring.")
        return
    content = _read_changelog()
    category = _categorize_pr(labels)
    pr_author_display = (
        context.pull_request_author
        if str(context.pull_request_author).startswith("@")
        else f"@{context.pull_request_author}"
    )
    entry = (
        f"- {context.pull_request_title} "
        f"[#{context.pull_request_number}](https://github.com/{context.github_repository}/pull/{context.pull_request_number}) "
        f"({pr_author_display})"
    )
    reason = f"beta PR #{context.pull_request_number}"
    content, target_version = _create_beta_entry(
        context=context,
        content=content,
        labels=labels,
        category=category,
        entry=entry,
        reason=reason,
    )
    _write_changelog(content)
    common.git_commit_files(
        [CHANGELOG_FILE],
        f"Update CHANGELOG.md for beta PR #{context.pull_request_number}",
    )
    _ensure_repo_node_version(target_version, context=f"beta PR #{context.pull_request_number}")
    body = _build_beta_body(target_version, content)
    _upsert_release(
        context,
        target_version.tag(),
        body,
        draft=True,
        prerelease=True,
        target_commitish="beta",
    )
    print(f"[release-manager] Updated beta draft {target_version.tag()}")

def main() -> None:
    mode = os.environ.get("MODE")
    github_token = os.environ.get("GITHUB_TOKEN")
    github_repository = os.environ.get("GITHUB_REPOSITORY")
    context = Context(
        github_token=github_token, github_repository=github_repository, mode=mode
    )
    if mode == "pr-merge":
        context.pull_request_author = os.environ.get("PULL_REQUEST_AUTHOR")
        context.pull_request_branch = os.environ.get("PULL_REQUEST_BRANCH")
        context.pull_request_labels = os.environ.get("PULL_REQUEST_LABELS")
        context.pull_request_number = os.environ.get("PULL_REQUEST_NUMBER")
        context.pull_request_title = os.environ.get("PULL_REQUEST_TITLE")
        _handle_pr_merge(context)
    elif mode == "commit-push":
        context.head_before = os.environ.get("HEAD_BEFORE")
        context.head_after = os.environ.get("HEAD_AFTER")
        _handle_commit_push(context)
    elif mode == "finalize":
        context.tag = os.environ.get("TAG")
        context.is_beta = str(os.environ.get("IS_BETA")).lower() == "true"
        _handle_finalize(context)
    elif mode == "rollback":
        context.tag = os.environ.get("TAG")
        context.target_branch = os.environ.get("TARGET_BRANCH")
        _handle_rollback(context)
    sys.exit(0)

if __name__ == "__main__":
    main()