#!/usr/bin/env python3
"""
Unified Release Manager (beta + stable)
Actions:
    - pr-merged      (beta path; AND stable-conversion path when PR base=latest)
    - publish-beta   (finalize beta section/date + housekeeping entry; retag to include finalize commit)
    - publish-stable (finalize stable section/date + housekeeping entry; retag to include finalize commit)
    - commit-pushed  (process manual pushes to `beta` - add non-PR commits to changelog)
Notes:
- Uses shared helpers from common.py for GitHub API, git/npm commands, and command execution.
"""
import os
import re
import json
import sys
import argparse
import datetime
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Optional, List, Dict, Tuple, Set

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

CHANGELOG_FILE = "CHANGELOG.md"
CATEGORY_ORDER = [
    "Breaking Changes",
    "Featured Changes",
    "Bug Fixes",
    "Other Changes",
]
STABLE_RELEASE_PRIORITY = 10_000
LABEL_BREAKING = {"breaking-change"}
LABEL_FEATURE = {"enhancement", "feature"}
LABEL_FIX = {"fix", "bug", "bugfix"}
LABEL_DOCS = {"docs", "documentation"}
SEMVER = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$")
SECTION_RE = re.compile(r"^## \[(v[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?)\]", re.MULTILINE)
STABLE_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")
_NPM_VERSIONS_CACHE: Optional[Set[str]] = None

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
    beta: Optional[int] = None

    @classmethod
    def parse(cls, s: str) -> "Version":
        m = SEMVER.match(s)
        if not m:
            raise ValueError(s)
        a, b, c, d = m.groups()
        return cls(int(a), int(b), int(c), int(d) if d is not None else None)

    def is_beta(self) -> bool:
        return self.beta is not None

    def tag(self) -> str:
        return f"v{self.major}.{self.minor}.{self.patch}" + (f"-beta.{self.beta}" if self.beta is not None else "")

    def base(self) -> "Version":
        return Version(self.major, self.minor, self.patch, None)

    def bump_major(self) -> "Version":
        return Version(self.major + 1, 0, 0)

    def bump_minor(self) -> "Version":
        return Version(self.major, self.minor + 1, 0)

    def bump_patch(self) -> "Version":
        return Version(self.major, self.minor, self.patch + 1)

    def next_beta(self) -> "Version":
        return Version(self.major, self.minor, self.patch, 0 if self.beta is None else self.beta + 1)

def _version_sort_key(v: Version) -> Tuple[int, int, int, int]:
    return (v.major, v.minor, v.patch, STABLE_RELEASE_PRIORITY if v.beta is None else v.beta)

class GitHub:
    def __init__(self, token: str, repo: str):
        self.token = token
        self.repo = repo

    def _request(self, method: str, path: str, data: Optional[dict] = None):
        code, payload = common.github_api(self.repo, self.token, path, method=method, data=data)
        if isinstance(payload, (dict, list)):
            return payload
        return {}

    def releases(self, per_page: int = 100, max_pages: int = 50) -> List[dict]:
        out: List[dict] = []
        page = 1
        while page <= max_pages:
            batch = self._request("GET", f"/releases?per_page={per_page}&page={page}")
            if not isinstance(batch, list) or not batch:
                break
            out.extend(batch)
            if len(batch) < per_page:
                break
            page += 1
        return out

    def release_by_tag(self, tag: str) -> Optional[dict]:
        r = self._request("GET", f"/releases/tags/{tag}")
        if not r or (isinstance(r, dict) and r.get("message") == "Not Found"):
            return None
        return r

    def release_by_tag_any(self, tag: str) -> Optional[dict]:
        r = self.release_by_tag(tag)
        if r:
            return r
        for rel in self.releases():
            if rel.get("tag_name", "") == tag:
                return rel
        return None

    def create_release(self, tag: str, name: str, body: str, *, draft: bool, prerelease: bool, target: str):
        return self._request("POST", "/releases", {
            "tag_name": tag,
            "name": name,
            "body": body,
            "draft": draft,
            "prerelease": prerelease,
            "target_commitish": target,
        })

    def update_release(self, release_id: int, **fields):
        return self._request("PATCH", f"/releases/{release_id}", fields)

    def delete_release(self, release_id: int):
        return self._request("DELETE", f"/releases/{release_id}")

def _commit_pulls_for_sha(repo: str, token: str, sha: str) -> List[dict]:
    url = f"https://api.github.com/repos/{repo}/commits/{sha}/pulls"
    headers = {
        "Accept": "application/vnd.github.groot-preview+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": f"release-manager (+https://github.com/{repo})",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            data = json.loads(raw) if raw.strip() else []
            return data if isinstance(data, list) else []
    except Exception as exc:
        print(f"[release-manager] Warning: commits/{sha}/pulls lookup failed: {exc}", file=sys.stderr)
        return []

def _read_changelog() -> str:
    if not os.path.exists(CHANGELOG_FILE):
        return "# Changelog\n\n"
    return open(CHANGELOG_FILE, "r", encoding="utf-8").read()

def _write_changelog(content: str):
    if not content.endswith("\n"):
        content += "\n"
    open(CHANGELOG_FILE, "w", encoding="utf-8").write(content)

def _list_versions(content: str) -> List[Version]:
    out = []
    for m in SECTION_RE.finditer(content):
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
    out: List[str] = []
    prev_blank = False
    for l in lines:
        blank = (l.strip() == "")
        if blank and prev_blank:
            continue
        out.append(l)
        prev_blank = blank
    return "\n".join(out)

def _categorize(labels: List[str]) -> str:
    low = {l.lower() for l in labels}
    if low & LABEL_BREAKING:
        return "Breaking Changes"
    if low & LABEL_FEATURE:
        return "Featured Changes"
    if low & LABEL_FIX:
        return "Bug Fixes"
    if low & LABEL_DOCS:
        return "Other Changes"
    return "Other Changes"

def _tag_from_category(category: str) -> str:
    mapping = {
        'Breaking Changes': '[breaking]',
        'Featured Changes': '[feature]',
        'Bug Fixes': '[bug]',
        'Other Changes': '[other]',
    }
    return mapping.get(category, '[other]')

def _categorize_commit_message(msg: str) -> str:
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

def _labels_from_commit_message(msg: str) -> List[str]:
    if not msg:
        return []
    m = re.match(r"^\s*\[([^\]]+)\]\s*(.*)$", msg)
    tag_block = m.group(1).strip().lower() if m else ""
    if not tag_block:
        return []
    out: List[str] = []
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
    return f"- {display} [{sha7}](https://github.com/{repo}/commit/{commit_sha}) ({author_display})"

def _bump_type(labels: List[str]) -> str:
    low = {l.lower() for l in labels}
    if low & LABEL_BREAKING:
        return "major"
    if low & LABEL_FEATURE:
        return "minor"
    return "patch"

def _build_section_header(tag: str, add_date: bool, date: Optional[str] = None) -> str:
    base = f"## [{tag}](https://github.com/{_repo()}/releases/tag/{tag})"
    return f"{base} ({date})" if add_date and date else base

def _normalize_section_spacing(section: List[str]) -> List[str]:
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
    out: List[str] = [header, ""]
    i = 0
    while i < len(body):
        line = body[i]
        if line.startswith("### "):
            out.append(line)
            out.append("")
            i += 1
            items: List[str] = []
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
    normalized: List[str] = []
    prev_blank = False
    for l in out:
        is_blank = (l.strip() == "")
        if is_blank and prev_blank:
            continue
        normalized.append(l)
        prev_blank = is_blank
    return normalized

def _insert_entry(content: str, version: Version, category: str, entry: str,
                  compare_from: Optional[str], *, add_date: bool = False, publish_date: Optional[str] = None) -> str:
    tag = version.tag()
    header_pattern = f"## [{tag}]"
    lines = content.splitlines()
    header_idx = next((i for i, l in enumerate(lines) if l.startswith(header_pattern)), None)
    if header_idx is None:
        section_header = _build_section_header(tag, add_date, publish_date)
        new_sec = [section_header, "", f"### {category}", "", entry, ""]
        if compare_from:
            new_sec += [f"**Full Changelog**: https://github.com/{_repo()}/compare/{compare_from}...{tag}", ""]
        out: List[str] = []
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

    def section_category_positions(sec_lines: List[str]) -> Tuple[List[Tuple[int, int]], Optional[int]]:
        cat_pos: List[Tuple[int, int]] = []
        fc_idx: Optional[int] = None
        for idx, l in enumerate(sec_lines):
            if l.startswith("### "):
                cname = l[4:].strip()
                prio = CATEGORY_ORDER.index(cname) if cname in CATEGORY_ORDER else 999
                cat_pos.append((idx, prio))
            if fc_idx is None and l.startswith("**Full Changelog**"):
                fc_idx = idx
        return cat_pos, fc_idx

    if cat_header not in section:
        cat_pos, fc_idx = section_category_positions(section)
        desired_prio = CATEGORY_ORDER.index(category) if category in CATEGORY_ORDER else 999
        insertion_local_idx: Optional[int] = None
        for idx, prio in cat_pos:
            if prio > desired_prio:
                insertion_local_idx = idx
                break
        if insertion_local_idx is None:
            insertion_local_idx = fc_idx if fc_idx is not None else len(section)
        to_insert = [cat_header, "", entry, ""]
        section = section[:insertion_local_idx] + to_insert + section[insertion_local_idx:]
    else:
        cat_idx = next((i for i, l in enumerate(section) if l == cat_header), None)
        if cat_idx is None:
            new_sec: List[str] = []
            j = 0
            inserted = False
            while j < len(section):
                line = section[j]
                new_sec.append(line)
                if line == cat_header and not inserted:
                    if j + 1 >= len(section) or section[j + 1].strip() != "":
                        new_sec.append("")
                    new_sec.append(entry)
                    inserted = True
                j += 1
            section = new_sec
        else:
            i = cat_idx + 1
            items: List[str] = []
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
            else:
                if is_housekeeping:
                    new_block: List[str] = [cat_header, "", entry, ""]
                    new_block.extend(commits)
                    if commits and prs:
                        pass
                    new_block.extend(prs)
                    new_block.append("")
                    section = section[:cat_idx] + new_block + section[i:]
                else:
                    prs.insert(0, entry)
                    new_block: List[str] = [cat_header, ""]
                    new_block.extend(commits)
                    if commits and prs:
                        pass
                    new_block.extend(prs)
                    new_block.append("")
                    section = section[:cat_idx] + new_block + section[i:]
    if compare_from and not any("**Full Changelog**" in l for l in section):
        section += [f"**Full Changelog**: https://github.com/{_repo()}/compare/{compare_from}...{tag}", ""]
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
            lines[i] = re.sub(rf"\.\.{re.escape(old_tag)}$", f"..{new_tag}", l)
    return "\n".join(lines) + "\n"

def _add_publish_date(content: str, tag: str, date: str) -> str:
    lines = content.splitlines()
    prefix = f"## [{tag}]"
    for i, l in enumerate(lines):
        if l.startswith(prefix) and not _header_has_date(l):
            lines[i] = l + f" ({date})"
            break
    return "\n".join(lines) + "\n"

def _collect_section_categories(block: str) -> Dict[str, List[str]]:
    cats: Dict[str, List[str]] = {}
    current: Optional[str] = None
    for line in block.splitlines():
        if line.startswith("### "):
            current = line[4:].strip()
            cats.setdefault(current, [])
        elif line.startswith("- ") and current:
            cats[current].append(line)
    return cats

def _build_beta_body(version: Version, changelog: str, latest_stable: Optional[Version]) -> str:
    block = _find_section_block(changelog, version.tag())
    cats = _collect_section_categories(block)
    fc_line = None
    for line in block.splitlines():
        if line.startswith("**Full Changelog**"):
            fc_line = line
            break
    if version.beta == 0 and not fc_line:
        compare_from = latest_stable.tag() if latest_stable else "v0.0.0"
    elif not fc_line:
        compare_from = f"v{version.major}.{version.minor}.{version.patch}-beta.{version.beta - 1}"
    else:
        compare_from = None
    ordered = [c for c in CATEGORY_ORDER if c in cats] + [c for c in cats if c not in CATEGORY_ORDER]
    if not ordered:
        body_sections = "### Other Changes\n\n_No changes in this beta release._"
    else:
        parts: List[str] = []
        for c in ordered:
            parts.append(f"### {c}\n")
            parts.extend(cats[c])
            parts.append("")
        body_sections = "\n".join(parts).strip()
    if fc_line:
        full_changelog_line = fc_line
    else:
        full_changelog_line = f"**Full Changelog**: https://github.com/{_repo()}/compare/{compare_from}...{version.tag()}"
    return f"{body_sections}\n\n{full_changelog_line}"

def _build_stable_body(version: Version, changelog: str, prev_stable: Version) -> str:
    block = _find_section_block(changelog, version.tag())
    cats = _collect_section_categories(block)
    ordered = [c for c in CATEGORY_ORDER if c in cats] + [c for c in cats if c not in CATEGORY_ORDER]
    parts: List[str] = []
    if ordered:
        for c in ordered:
            parts.append(f"### {c}\n")
            parts.extend(cats[c])
            parts.append("")
    else:
        parts = ["### Other Changes", "", "_No changes in this release._", ""]
    parts.append(f"**Full Changelog**: https://github.com/{_repo()}/compare/{prev_stable.tag()}...{version.tag()}")
    return "\n".join(parts).strip()

def _latest_versions(changelog: str) -> Tuple[Optional[Version], Optional[Version]]:
    versions = _list_versions(changelog)
    stable = [v for v in versions if not v.is_beta()]
    beta = [v for v in versions if v.is_beta()]
    latest_stable = max(stable, key=_version_sort_key) if stable else None
    latest_beta = max(beta, key=_version_sort_key) if beta else None
    return latest_stable, latest_beta

def _find_unpublished_beta_draft(gh: GitHub) -> Optional[Version]:
    drafts: List[Version] = []
    for r in gh.releases():
        tn = r.get("tag_name", "")
        if r.get("draft") and r.get("prerelease") and "beta" in tn:
            try:
                drafts.append(Version.parse(tn))
            except Exception:
                continue
    return max(drafts, key=_version_sort_key) if drafts else None

def _find_latest_draft_stable(gh: GitHub) -> Optional[Tuple[Version, dict]]:
    candidates: List[Tuple[Version, dict]] = []
    for r in gh.releases():
        tn = r.get("tag_name", "")
        if r.get("draft") and not r.get("prerelease") and STABLE_TAG_RE.match(tn or ""):
            try:
                candidates.append((Version.parse(tn), r))
            except Exception:
                continue
    if not candidates:
        return None
    return max(candidates, key=lambda x: _version_sort_key(x[0]))

def _is_published(gh: GitHub, version: Version) -> bool:
    rel = gh.release_by_tag(version.tag())
    return bool(rel) and not rel.get("draft", False)

def _bump_base(latest_stable: Optional[Version], bump: str) -> Version:
    base = latest_stable or Version(0, 0, 0)
    if bump == "major":
        return base.bump_major()
    if bump == "minor":
        return base.bump_minor()
    return base.bump_patch()

def _decide_beta_target(
    gh: GitHub,
    latest_stable: Optional[Version],
    latest_published_beta: Optional[Version],
    existing_unpublished: Optional[Version],
    labels: List[str],
) -> Tuple[Version, bool]:
    bump = _bump_type(labels)
    required_base = _bump_base(latest_stable, bump)
    if existing_unpublished and not _is_published(gh, existing_unpublished):
        if required_base > existing_unpublished.base():
            return Version(required_base.major, required_base.minor, required_base.patch, 0), True
        return existing_unpublished, False
    if latest_published_beta is not None:
        if required_base > latest_published_beta.base():
            return Version(required_base.major, required_base.minor, required_base.patch, 0), False
        return latest_published_beta.next_beta(), False
    return Version(required_base.major, required_base.minor, required_base.patch, 0), False

def _read_package_name() -> Optional[str]:
    try:
        if not os.path.exists("package.json"):
            return None
        with open("package.json", "r", encoding="utf-8") as f:
            d = json.load(f)
        name = d.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
        return None
    except Exception:
        return None

def _read_package_version() -> Optional[Version]:
    try:
        if not os.path.exists("package.json"):
            return None
        with open("package.json", "r", encoding="utf-8") as f:
            d = json.load(f)
        ver = d.get("version")
        if not isinstance(ver, str) or not ver.strip():
            return None
        s = ver.strip()
        if not s.startswith("v"):
            s = "v" + s
        try:
            return Version.parse(s)
        except Exception:
            return None
    except Exception:
        return None

def _npm_registry_versions(pkg_name: str, timeout: int = 30, *, force_refresh: bool = False) -> Optional[Set[str]]:
    global _NPM_VERSIONS_CACHE
    if not force_refresh and _NPM_VERSIONS_CACHE is not None:
        return _NPM_VERSIONS_CACHE
    try:
        url = f"https://registry.npmjs.org/{urllib.parse.quote(pkg_name)}"
        req = urllib.request.Request(
            url,
            headers={"Accept": "application/vnd.npm.install-v1+json", "User-Agent": "release-manager/1.0"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            data = json.loads(raw)
            versions = data.get("versions", {})
            if isinstance(versions, dict):
                _NPM_VERSIONS_CACHE = set(versions.keys())
                return _NPM_VERSIONS_CACHE
    except Exception as e:
        print(f"[release-manager] npm registry lookup failed for {pkg_name}: {e}", file=sys.stderr)
    return None

def _collect_betas_in_range(
    gh: GitHub,
    prev_stable: Optional[Version],
    target_stable: Version,
    npm_versions: Optional[Set[str]],
    *,
    max_pages: int = 20,
) -> List[Version]:
    betas: List[Version] = []
    for r in gh.releases(max_pages=max_pages):
        if not r.get("prerelease") or r.get("draft"):
            continue
        tn = (r.get("tag_name") or "")
        if "-beta." not in tn:
            continue
        try:
            v = Version.parse(tn)
        except Exception:
            continue
        base = v.base()
        if (prev_stable is None or base > prev_stable) and base <= target_stable:
            if npm_versions is not None and v.tag().lstrip("v") not in npm_versions:
                continue
            betas.append(v)
    return sorted(betas, key=_version_sort_key)

def _aggregate_betas_to_stable(content: str, target: Version, betas: List[Version]) -> Tuple[str, List[str]]:
    aggregated: Dict[str, List[str]] = {c: [] for c in CATEGORY_ORDER}
    seen: Set[str] = set()
    included_tags: List[str] = []
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
        note = f"- Convert beta releases ({', '.join(included_tags)}) to regular release {target.tag()} [beta-to-release] (@github-actions)"
        aggregated.setdefault("Other Changes", []).append(note)
    header = _build_section_header(target.tag(), add_date=False)
    prev_stable, _ = _latest_versions(content)
    prev_stable = prev_stable or Version(0, 0, 0)
    parts: List[str] = [header, ""]
    for cat in CATEGORY_ORDER:
        if aggregated.get(cat):
            parts.append(f"### {cat}")
            parts.append("")
            parts.extend(aggregated[cat])
            parts.append("")
    parts += [f"**Full Changelog**: https://github.com/{_repo()}/compare/{prev_stable.tag()}...{target.tag()}", ""]
    lines = content.splitlines()
    out: List[str] = []
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

def _git_commit_files(files: List[str], message: str):
    common.run(["git", "config", "--local", "user.email", "action@github.com"], check=False)
    common.run(["git", "config", "--local", "user.name", "GitHub Action"], check=False)
    staged_any = False
    for f in files:
        if os.path.exists(f):
            common.run(["git", "add", f], check=False)
            staged_any = True
    if not staged_any:
        return
    if common.run(["git", "diff", "--cached", "--quiet"], check=False).returncode == 0:
        return
    common.run(["git", "commit", "-m", message], check=False)
    common.run(["git", "push"], check=False)

def _ensure_repo_node_version(version: Version, context: str):
    target = version.tag().lstrip("v")
    if common.npm_pkg_set_version(target):
        _git_commit_files(
            ["package.json", "package-lock.json"],
            f"chore: align package versions to {version.tag()} ({context})",
        )

def _upsert_release(gh: GitHub, tag: str, body: str, *, draft: bool, prerelease: bool, target_commitish: Optional[str] = None):
    rel = gh.release_by_tag_any(tag)
    if rel and rel.get("id"):
        fields = {"body": body, "name": tag}
        fields["draft"] = bool(draft)
        fields["prerelease"] = bool(prerelease)
        gh.update_release(rel["id"], **fields)
    else:
        gh.create_release(tag, tag, body, draft=draft, prerelease=prerelease, target=(target_commitish or "beta"))

def _load_labels_arg(args) -> List[str]:
    labels = []
    if getattr(args, "pr_labels_file", None) and args.pr_labels_file and os.path.exists(args.pr_labels_file):
        try:
            with open(args.pr_labels_file, "r", encoding="utf-8-sig") as f:
                loaded = json.load(f)
                labels = [str(l).strip().lower() for l in loaded if l]
                return labels
        except Exception as e:
            print(f"[release-manager] ERROR reading labels file: {e}")
            return []
    else:
        try:
            raw = getattr(args, "pr_labels", "[]")
            loaded = json.loads(raw or "[]")
            labels = [str(l).strip().lower() for l in loaded if l]
        except Exception as e:
            print(f"[release-manager] ERROR parsing pr_labels: {e}")
            return []
    print(f"[release-manager] Loaded labels: {labels}")
    return labels

def _finalize_common(gh: GitHub, v: Version, *, is_beta: bool):
    content = _read_changelog()
    hk_label = "beta-release" if is_beta else "release"
    entry = f"- Update CHANGELOG.md for {'beta release' if is_beta else 'release'} {v.tag()} [{hk_label}] (@github-actions)"
    content = _insert_entry(content, v, "Other Changes", entry, None, add_date=False)
    content = _add_publish_date(content, v.tag(), _now_date_utc())
    _write_changelog(content)
    _git_commit_files(["CHANGELOG.md"], f"Finalize {'beta' if is_beta else 'stable'} release {v.tag()} in CHANGELOG.md")
    common.git_force_tag(v.tag())
    if is_beta:
        latest_stable, _ = _latest_versions(content)
        body = _build_beta_body(v, content, latest_stable)
    else:
        versions = [x for x in _list_versions(content) if not x.is_beta()]
        versions_sorted = sorted(versions, key=_version_sort_key)
        prev = Version(0, 0, 0)
        if len(versions_sorted) > 1 and versions_sorted[-1] == v:
            prev = versions_sorted[-2]
        body = _build_stable_body(v, content, prev)
    rel = gh.release_by_tag_any(v.tag())
    if rel and rel.get("id"):
        gh.update_release(rel["id"], body=body)

def cmd_commit_pushed(args):
    gh = GitHub(args.github_token, args.repo)
    before = (getattr(args, "before", "") or "").strip()
    after = (getattr(args, "after", "") or "").strip()
    if not after or re.fullmatch(r"0+", after):
        print("[release-manager] No actionable commit SHA provided; exiting.")
        return
    common.run(["git", "fetch", "--no-tags", "origin", "HEAD"], check=False)
    proc = common.run(["git", "rev-list", "--reverse", f"{before}..{after}"], capture=True, check=False)
    shas = proc.stdout.strip().split() if proc and getattr(proc, "stdout", None) else []
    if not shas:
        print(f"[release-manager] No commits found in range {before}..{after}; falling back to single commit {after}")
        shas = [after]
    else:
        print(f"[release-manager] Processing {len(shas)} commit(s) from range {before}..{after}")
    for sha in shas:
        sha7 = sha[:7]
        pulls = _commit_pulls_for_sha(args.repo, args.github_token, sha)
        if pulls:
            pr_nums = ", ".join(str(p.get("number")) for p in pulls)
            print(f"[release-manager] Commit {sha7} is part of PR(s) {pr_nums}; skipping manual changelog entry.")
            continue
        subj_proc = common.run(["git", "show", "-s", "--format=%s", sha], capture=True, check=False)
        subject = subj_proc.stdout.strip() if subj_proc and getattr(subj_proc, "stdout", None) else sha
        display = subject or sha
        if isinstance(subject, str) and re.match(r"^\s*Merge branch\b", subject, re.IGNORECASE):
            print(f"[release-manager] Skipping merge-branch commit {sha7}: '{subject}'")
            continue
        category = _categorize_commit_message(subject)
        derived_labels = _labels_from_commit_message(subject)
        content = _read_changelog()
        latest_stable, _ = _latest_versions(content)
        npm_versions: Optional[Set[str]] = None
        pkg = _read_package_name()
        if pkg:
            npm_versions = _npm_registry_versions(pkg, force_refresh=True)
        else:
            print("[release-manager] NPM verification enabled but no package name found; skipping npm check.", file=sys.stderr)
        published_beta_versions: List[Version] = []
        for rel in gh.releases():
            tag_name = rel.get("tag_name", "")
            if "beta" not in tag_name or rel.get("draft") or not rel.get("prerelease"):
                continue
            try:
                version = Version.parse(tag_name)
            except Exception:
                continue
            if npm_versions is not None and version.tag().lstrip("v") not in npm_versions:
                continue
            published_beta_versions.append(version)
        latest_published_beta = max(published_beta_versions, key=_version_sort_key) if published_beta_versions else None
        existing_unpublished = _find_unpublished_beta_draft(gh)
        target_version, replace = _decide_beta_target(gh, latest_stable, latest_published_beta, existing_unpublished, derived_labels)
        pkg_ver = _read_package_version()
        if pkg_ver:
            try:
                if _version_sort_key(pkg_ver) > _version_sort_key(target_version):
                    print(f"[release-manager] package.json version {pkg_ver.tag()} is newer than computed target {target_version.tag()}; using package.json version")
                    target_version = pkg_ver
            except Exception:
                pass
        if replace and existing_unpublished and existing_unpublished.tag() != target_version.tag():
            if f"## [{existing_unpublished.tag()}]" in content:
                content = _rename_version_section(content, existing_unpublished.tag(), target_version.tag())
            old_tag = existing_unpublished.tag()
            old_rel = gh.release_by_tag_any(old_tag)
            if old_rel and old_rel.get("id"):
                gh.update_release(old_rel["id"], tag_name=target_version.tag(), name=target_version.tag())
            common.git_delete_tag(old_tag)
            print(f"[release-manager] Escalated draft {old_tag} -> {target_version.tag()} to capture manual commit.")
        compare_from: Optional[str]
        if target_version.beta == 0:
            compare_from = latest_stable.tag() if latest_stable else "v0.0.0"
        elif target_version.beta and target_version.beta > 0:
            compare_from = f"v{target_version.major}.{target_version.minor}.{target_version.patch}-beta.{target_version.beta - 1}"
        else:
            compare_from = None
        author_display: Optional[str] = None
        try:
            commit_info = gh._request("GET", f"/commits/{sha}")
            if isinstance(commit_info, dict):
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
            try:
                author_proc = common.run(["git", "show", "-s", "--format=%aN", sha], capture=True, check=False)
                author_display = author_proc.stdout.strip() if author_proc and getattr(author_proc, "stdout", None) else None
            except Exception:
                author_display = None
        entry = _build_commit_entry(display, sha, args.repo, author_display or "unknown")
        content = _insert_entry(content, target_version, category, entry, compare_from, add_date=False)
        _write_changelog(content)
        _git_commit_files(["CHANGELOG.md"], f"Update CHANGELOG.md for manual commit {sha7}")
        _ensure_repo_node_version(target_version, context=f"manual commit {sha7}")
        body = _build_beta_body(target_version, content, latest_stable)
        _upsert_release(gh, target_version.tag(), body, draft=True, prerelease=True, target_commitish="beta")
        print(f"[release-manager] Added manual commit {sha7} to beta draft {target_version.tag()} ({category}).")

def cmd_pr_merged(args):
    gh = GitHub(args.github_token, args.repo)
    labels = _load_labels_arg(args)
    if args.base_branch == "latest" and "stable-conversion" in labels:
        m = re.search(r"v\d+\.\d+\.\d+", args.pr_title or "")
        if not m:
            print("[release-manager] Stable conversion PR title must include version like vX.Y.Z")
            return
        target_stable = Version.parse(m.group(0))
        content = _read_changelog()
        prev_stable, _ = _latest_versions(content)
        npm_versions: Optional[Set[str]] = None
        pkg = _read_package_name()
        if pkg:
            npm_versions = _npm_registry_versions(pkg, force_refresh=True)
        betas = _collect_betas_in_range(gh, prev_stable, target_stable, npm_versions)
        if not betas:
            print("[release-manager] No published betas found to convert in range; aborting.")
            return
        content, included = _aggregate_betas_to_stable(content, target_stable, betas)
        _write_changelog(content)
        _git_commit_files(["CHANGELOG.md"], f"Add stable draft section {target_stable.tag()} to CHANGELOG.md (PR #{args.pr_number})")
        _ensure_repo_node_version(target_stable, context=f"convert betas to {target_stable.tag()} (PR #{args.pr_number})")
        body = _build_stable_body(target_stable, content, prev_stable or Version(0, 0, 0))
        _upsert_release(gh, target_stable.tag(), body, draft=True, prerelease=False, target_commitish="latest")
        print(f"[release-manager] Created/updated stable draft {target_stable.tag()} targeted to latest; included betas: {included}")
        return
    if args.base_branch != "beta":
        print("[release-manager] PR base not beta, ignoring.")
        return
    content = _read_changelog()
    latest_stable, _ = _latest_versions(content)
    npm_versions: Optional[Set[str]] = None
    pkg = _read_package_name()
    if pkg:
        npm_versions = _npm_registry_versions(pkg, force_refresh=True)
    else:
        print("[release-manager] NPM_VERIFY_PUBLISHED_BETA is true but no package.json/package name found; skipping npm verification.", file=sys.stderr)
    published_beta_versions: List[Version] = []
    for r in gh.releases():
        tn = r.get("tag_name", "")
        if "beta" in tn and not r.get("draft") and r.get("prerelease"):
            try:
                v = Version.parse(tn)
            except Exception:
                continue
            if npm_versions is not None and v.tag().lstrip("v") not in npm_versions:
                continue
            published_beta_versions.append(v)
    latest_published_beta = max(published_beta_versions, key=_version_sort_key) if published_beta_versions else None
    existing_unpublished = _find_unpublished_beta_draft(gh)
    draft_stable = _find_latest_draft_stable(gh)
    category = _categorize(labels)
    pr_author_display = args.pr_author if str(args.pr_author).startswith("@") else f"@{args.pr_author}"
    entry = f"- {args.pr_title} [#{args.pr_number}](https://github.com/{args.repo}/pull/{args.pr_number}) ({pr_author_display})"
    if draft_stable:
        base_version, stable_rel = draft_stable
        target_version = Version(base_version.major, base_version.minor, base_version.patch, 0)
        if f"## [{base_version.tag()}]" in content:
            content = _rename_version_section(content, base_version.tag(), target_version.tag())
        if existing_unpublished and existing_unpublished.tag() != target_version.tag():
            if f"## [{existing_unpublished.tag()}]" in content:
                content = _rename_version_section(content, existing_unpublished.tag(), target_version.tag())
            old_rel = gh.release_by_tag_any(existing_unpublished.tag())
            if old_rel and old_rel.get("id"):
                gh.update_release(old_rel["id"], tag_name=target_version.tag(), name=target_version.tag(), prerelease=True, draft=True)
            print(f"[release-manager] Rebased existing beta draft to {target_version.tag()}")
        compare_from = latest_stable.tag() if latest_stable else "v0.0.0"
        content = _insert_entry(content, target_version, category, entry, compare_from, add_date=False)
        _write_changelog(content)
        _git_commit_files(["CHANGELOG.md"], f"Convert draft stable {base_version.tag()} to {target_version.tag()} and update CHANGELOG.md for PR #{args.pr_number}")
        _ensure_repo_node_version(target_version, context=f"convert stable draft {base_version.tag()} -> {target_version.tag()} (PR #{args.pr_number})")
        rel = gh.release_by_tag_any(target_version.tag())
        body = _build_beta_body(target_version, content, latest_stable)
        if rel and rel.get("id"):
            gh.update_release(rel["id"], body=body, name=target_version.tag(), prerelease=True, draft=True)
        else:
            gh.create_release(target_version.tag(), target_version.tag(), body, draft=True, prerelease=True)

        if stable_rel.get("id"):
            gh.delete_release(stable_rel["id"])
            print(f"[release-manager] Deleted draft stable release {base_version.tag()}")
        common.git_delete_tag(base_version.tag())
        print(f"[release-manager] Converted draft stable {base_version.tag()} -> beta draft {target_version.tag()}")
        return
    target_version, replace = _decide_beta_target(gh, latest_stable, latest_published_beta, existing_unpublished, labels)
    pkg_ver = _read_package_version()
    if pkg_ver:
        try:
            if _version_sort_key(pkg_ver) > _version_sort_key(target_version):
                print(f"[release-manager] package.json version {pkg_ver.tag()} is newer than computed target {target_version.tag()}; using package.json version")
                target_version = pkg_ver
        except Exception:
            pass
    if replace and existing_unpublished and existing_unpublished.tag() != target_version.tag():
        content = _rename_version_section(content, existing_unpublished.tag(), target_version.tag())
        old_tag = existing_unpublished.tag()
        old_rel = gh.release_by_tag_any(old_tag)
        if old_rel and old_rel.get("id"):
            gh.update_release(old_rel["id"], tag_name=target_version.tag(), name=target_version.tag())
        common.git_delete_tag(old_tag)
        print(f"[release-manager] Escalated draft to {target_version.tag()}")
    if f"## [{target_version.tag()}]" not in content:
        compare_from = (
            latest_stable.tag() if target_version.beta == 0 and latest_stable else
            f"v{target_version.major}.{target_version.minor}.{target_version.patch}-beta.{target_version.beta - 1}"
            if target_version.beta and target_version.beta > 0 else None
        )
        content = _insert_entry(content, target_version, category, entry, compare_from, add_date=False)
    else:
        section_block = _find_section_block(content, target_version.tag())
        needs_compare = "**Full Changelog**" not in section_block
        compare_from = None
        if needs_compare:
            compare_from = (
                latest_stable.tag() if target_version.beta == 0 and latest_stable else
                f"v{target_version.major}.{target_version.minor}.{target_version.patch}-beta.{target_version.beta - 1}"
                if target_version.beta and target_version.beta > 0 else None
            )
        content = _insert_entry(content, target_version, category, entry, compare_from, add_date=False)
    _write_changelog(content)
    _git_commit_files(["CHANGELOG.md"], f"Update CHANGELOG.md for beta PR #{args.pr_number}")
    _ensure_repo_node_version(target_version, context=f"beta PR #{args.pr_number}")
    body = _build_beta_body(target_version, content, latest_stable)
    _upsert_release(gh, target_version.tag(), body, draft=True, prerelease=True, target_commitish="beta")
    print(f"[release-manager] Updated beta draft {target_version.tag()}")

def cmd_finalize_beta(args):
    gh = GitHub(args.github_token, args.repo)
    v = Version.parse(args.version)
    _finalize_common(gh, v, is_beta=True)
    print(f"[release-manager] Beta release finalized {v.tag()}")

def cmd_finalize_stable(args):
    gh = GitHub(args.github_token, args.repo)
    v = Version.parse(args.version)
    if v.is_beta():
        print("[release-manager] Use publish-beta for beta tags.")
        return
    _finalize_common(gh, v, is_beta=False)
    print(f"[release-manager] Stable release finalized {v.tag()}")

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="action", required=True)
    m = sub.add_parser("pr-merged")
    m.add_argument("--github-token", required=True)
    m.add_argument("--repo", required=True)
    m.add_argument("--pr-title", required=True)
    m.add_argument("--pr-author", required=True)
    m.add_argument("--pr-number", required=True)
    m.add_argument("--pr-labels", default="[]")
    m.add_argument("--pr-labels-file", default="")
    m.add_argument("--base-branch", required=True)
    fb = sub.add_parser("publish-beta")
    fb.add_argument("--github-token", required=True)
    fb.add_argument("--repo", required=True)
    fb.add_argument("--version", required=True)
    fs = sub.add_parser("publish-stable")
    fs.add_argument("--github-token", required=True)
    fs.add_argument("--repo", required=True)
    fs.add_argument("--version", required=True)
    mc = sub.add_parser("commit-pushed")
    mc.add_argument("--github-token", required=True)
    mc.add_argument("--repo", required=True)
    mc.add_argument("--before", dest="before", required=False)
    mc.add_argument("--after", dest="after", required=True)
    args = ap.parse_args()
    if args.action == "pr-merged":
        cmd_pr_merged(args)
    elif args.action == "publish-beta":
        cmd_finalize_beta(args)
    elif args.action == "publish-stable":
        cmd_finalize_stable(args)
    elif args.action == "commit-pushed":
        cmd_commit_pushed(args)
    else:
        print("[release-manager] Unknown action")

if __name__ == "__main__":
    main()