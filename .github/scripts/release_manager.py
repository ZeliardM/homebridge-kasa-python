#!/usr/bin/env python3
"""
Unified Release Manager (beta + stable)
Actions:
  - pr-merged      (beta path; AND stable-conversion path when PR base=latest)
  - publish-beta   (finalize beta section/date + housekeeping entry; retag to include finalize commit)
  - publish-stable (finalize stable section/date + housekeeping entry; retag to include finalize commit)
Notes:
- Uses shared helpers from common.py for GitHub API, git/npm commands, and command execution.
- No behavior changes intended; only refactoring and standardization.
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

def _npm_registry_versions(pkg_name: str, timeout: int = 30) -> Optional[Set[str]]:
    global _NPM_VERSIONS_CACHE
    if _NPM_VERSIONS_CACHE is not None:
        return _NPM_VERSIONS_CACHE
    try:
        url = f"https://registry.npmjs.org/{urllib.parse.quote(pkg_name)}"
        req = urllib.request.Request(url, headers={"Accept": "application/vnd.npm.install-v1+json", "User-Agent": "release-manager/1.0"})
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

def _collect_betas_in_range(gh: GitHub, prev_stable: Optional[Version], target_stable: Version,
                            verify_npm: bool) -> List[Version]:
    npm_versions: Optional[Set[str]] = None
    if verify_npm:
        pkg = _read_package_name()
        if pkg:
            npm_versions = _npm_registry_versions(pkg)
    betas: List[Version] = []
    for r in gh.releases():
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
                if e.endswith("[beta-release]"):
                    continue
                if e not in seen:
                    aggregated[cat].append(e)
                    seen.add(e)
    if included_tags:
        note = f"- Convert beta releases ({', '.join(included_tags)}) to regular release {target.tag()} @github-actions [beta-to-release]"
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
    """
    Create or update a release. Only sets target_commitish on create (GitHub ignores it on some updates).
    """
    rel = gh.release_by_tag_any(tag)
    if rel and rel.get("id"):
        fields = {"body": body, "name": tag}
        fields["draft"] = bool(draft)
        fields["prerelease"] = bool(prerelease)
        gh.update_release(rel["id"], **fields)
    else:
        gh.create_release(tag, tag, body, draft=draft, prerelease=prerelease, target=(target_commitish or "beta"))

def _load_labels_arg(args) -> List[str]:
    if getattr(args, "pr_labels_file", None) and args.pr_labels_file and os.path.exists(args.pr_labels_file):
        try:
            with open(args.pr_labels_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
    try:
        raw = getattr(args, "pr_labels", "[]")
        return json.loads(raw or "[]")
    except Exception:
        return []

def _finalize_common(gh: GitHub, v: Version, *, is_beta: bool):
    content = _read_changelog()
    hk_label = "beta-release" if is_beta else "release"
    entry = f"- Update CHANGELOG.md for {'beta release' if is_beta else 'release'} {v.tag()} @github-actions [{hk_label}]"
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

def cmd_pr_merged(args):
    gh = GitHub(args.github_token, args.repo)
    labels = _load_labels_arg(args)
    if args.base_branch == "latest" and any((str(l).lower() == "stable-conversion") for l in labels):
        m = re.search(r"v\d+\.\d+\.\d+", args.pr_title or "")
        if not m:
            print("[release-manager] Stable conversion PR title must include version like vX.Y.Z")
            return
        target_stable = Version.parse(m.group(0))
        content = _read_changelog()
        prev_stable, _ = _latest_versions(content)
        verify_betas = os.environ.get("NPM_VERIFY_PUBLISHED_BETA", "").lower() == "true"
        betas = _collect_betas_in_range(gh, prev_stable, target_stable, verify_betas)
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
    verify_betas = os.environ.get("NPM_VERIFY_PUBLISHED_BETA", "").lower() == "true"
    npm_versions: Optional[Set[str]] = None
    if verify_betas:
        pkg = _read_package_name()
        if pkg:
            npm_versions = _npm_registry_versions(pkg)
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
    entry = f"- {args.pr_title} @{args.pr_author} [#{args.pr_number}]"
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
        if (os.environ.get("DELETE_DRAFT_STABLE_TAG", "").lower() == "true"):
            common.git_delete_tag(base_version.tag())

        print(f"[release-manager] Converted draft stable {base_version.tag()} -> beta draft {target_version.tag()}")
        return
    target_version, replace = _decide_beta_target(gh, latest_stable, latest_published_beta, existing_unpublished, labels)
    if replace and existing_unpublished and existing_unpublished.tag() != target_version.tag():
        content = _rename_version_section(content, existing_unpublished.tag(), target_version.tag())
        old_tag = existing_unpublished.tag()
        old_rel = gh.release_by_tag_any(old_tag)
        if old_rel and old_rel.get("id"):
            gh.update_release(old_rel["id"], tag_name=target_version.tag(), name=target_version.tag())
        if (os.environ.get("DELETE_DRAFT_BETA_TAG", "").lower() == "true"):
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
    args = ap.parse_args()
    if args.action == "pr-merged":
        cmd_pr_merged(args)
    elif args.action == "publish-beta":
        cmd_finalize_beta(args)
    elif args.action == "publish-stable":
        cmd_finalize_stable(args)
    else:
        print("[release-manager] Unknown action")

if __name__ == "__main__":
    main()