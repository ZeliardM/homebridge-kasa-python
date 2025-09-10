#!/usr/bin/env python3
"""
Simplified Unified Release Manager

Implements the streamlined strategy:

Beta Flow:
- On PR merged to any beta* branch:
    * Determine target beta version:
        - If unpublished draft beta.0 exists: append categories/entries there (same tag).
        - If labels require a higher base (breaking-change > feature > patch) than the current unpublished draft’s base, replace that draft with new base beta.0 (migrate existing entries).
        - If no unpublished draft:
            - If no published betas for that base yet: create base beta.0 comparing last stable.
            - Else (published betas exist for that base): increment beta.(N+1) comparing to previous beta.
            - If breaking-change after publication and ESCALATE_BREAKING_POST_PUBLISH=True: start new MAJOR base beta.0 comparing to last stable.
- Bodies are always:
    Beta Release - vX.Y.Z-beta.N

    ## Category A
    - entry

    ## Category B
    - entry

    **Full Changelog**: compare/<from>...<tag>
- While beta.0 (unpublished) is being aggregated, compare link stays last stable release (or v0.0.0).
- Publishing a beta adds a “Update CHANGELOG.md for beta release … [beta-release]” entry under Other Changes and re-syncs the release body.

Stable Flow:
- convert-to-stable consolidates all published betas for a base into a new stable draft; stable section mirrors categories; adds conversion entry.
- Publishing stable adds “Update CHANGELOG.md for release … [release]”.
- Stable body format (no Beta Release - prefix):
    ## Breaking Changes
    - entry
    ...
    **Full Changelog**: compare/<prev_stable>...<stable_tag>

Escalation:
- breaking-change label triggers major bump logic depending on unpublished vs published state.

Assumptions:
- Only standard library used.
- CHANGELOG headings: each version has dedicated section; no “Unreleased” sections.

NOTE: This script intentionally does NOT maintain an [Unreleased] section.
"""

import os, re, json, sys, argparse, datetime, urllib.request, urllib.error
from dataclasses import dataclass
from typing import Optional, List, Dict, Tuple

# ---------------- Configuration ----------------
ESCALATE_BREAKING_POST_PUBLISH = True
CHANGELOG_FILE = "CHANGELOG.md"

CATEGORY_ORDER = [
    "Breaking Changes",
    "Featured Changes",
    "Bug Fixes",
    "Other Changes",
]

LABEL_BREAKING = {"breaking-change"}
LABEL_FEATURE = {"enhancement", "feature"}
LABEL_FIX = {"fix", "bug", "bugfix", "docs", "documentation", "dependency"}

SEMVER = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$")

# ---------------- Data Structures ----------------
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
        a,b,c,d = m.groups()
        return cls(int(a), int(b), int(c), int(d) if d is not None else None)

    def is_beta(self) -> bool:
        return self.beta is not None

    def tag(self) -> str:
        if self.beta is None:
            return f"v{self.major}.{self.minor}.{self.patch}"
        return f"v{self.major}.{self.minor}.{self.patch}-beta.{self.beta}"

    def base(self) -> "Version":
        return Version(self.major, self.minor, self.patch, None)

    def bump_major(self) -> "Version":
        return Version(self.major+1, 0, 0)

    def bump_minor(self) -> "Version":
        return Version(self.major, self.minor+1, 0)

    def bump_patch(self) -> "Version":
        return Version(self.major, self.minor, self.patch+1)

    def next_beta(self) -> "Version":
        if self.beta is None:
            return Version(self.major, self.minor, self.patch, 0)
        return Version(self.major, self.minor, self.patch, self.beta+1)

# ---------------- GitHub API ----------------
class GitHub:
    def __init__(self, token: str, repo: str):
        self.token = token
        self.repo = repo
        self.api = f"https://api.github.com/repos/{repo}"

    def _request(self, method: str, path: str, data: Optional[dict]=None) -> dict:
        url = f"{self.api}{path}"
        headers = {
            "Accept":"application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "Content-Type":"application/json"
        }
        body = None
        if data is not None:
            body = json.dumps(data).encode()
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as r:
                raw = r.read().decode()
                if raw.strip():
                    return json.loads(raw)
                return {}
        except urllib.error.HTTPError as e:
            try:
                msg = e.read().decode()
            except:
                msg = str(e)
            print(f"GitHub API error {e.code}: {msg}", file=sys.stderr)
            return {}
        except Exception as e:
            print(f"GitHub API exception: {e}", file=sys.stderr)
            return {}

    def releases(self) -> List[dict]:
        return self._request("GET", "/releases?per_page=100") or []

    def release_by_tag(self, tag: str) -> Optional[dict]:
        r = self._request("GET", f"/releases/tags/{tag}")
        if r.get("message") == "Not Found":
            return None
        return r or None

    def create_release(self, tag: str, name: str, body: str, draft: bool, prerelease: bool, target: str="beta") -> dict:
        return self._request("POST", "/releases", {
            "tag_name": tag,
            "name": name,
            "body": body,
            "draft": draft,
            "prerelease": prerelease,
            "target_commitish": target
        })

    def update_release(self, release_id: int, **fields) -> dict:
        return self._request("PATCH", f"/releases/{release_id}", fields)

# ---------------- Changelog Utilities ----------------
def read_changelog() -> str:
    if not os.path.exists(CHANGELOG_FILE):
        return "# Changelog\n\n"
    return open(CHANGELOG_FILE, "r", encoding="utf-8").read()

def write_changelog(content: str):
    if not content.endswith("\n"):
        content += "\n"
    open(CHANGELOG_FILE, "w", encoding="utf-8").write(content)

SECTION_RE = re.compile(r"^## \[(v[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?)\]", re.MULTILINE)

def list_versions(content: str) -> List[Version]:
    out=[]
    for m in SECTION_RE.finditer(content):
        try:
            out.append(Version.parse(m.group(1)))
        except:
            pass
    return sorted(set(out))

def find_section_block(content: str, tag: str) -> str:
    pattern = rf"^## \[{re.escape(tag)}\].*?\n(.*?)(?=^## \[v|\Z)"
    m = re.search(pattern, content, flags=re.S|re.M)
    return m.group(1).strip() if m else ""

def categorize(labels: List[str]) -> str:
    low = {l.lower() for l in labels}
    if low & LABEL_BREAKING: return "Breaking Changes"
    if low & LABEL_FEATURE: return "Featured Changes"
    if low & LABEL_FIX: return "Bug Fixes"
    return "Other Changes"

def bump_type(labels: List[str]) -> str:
    low = {l.lower() for l in labels}
    if low & LABEL_BREAKING: return "major"
    if low & LABEL_FEATURE: return "minor"
    return "patch"

def squeeze_blank(text: str) -> str:
    lines = text.splitlines()
    out=[]
    prev_blank=False
    for l in lines:
        blank = (l.strip()=="")
        if blank and prev_blank: continue
        out.append(l)
        prev_blank=blank
    return "\n".join(out)

def insert_entry(content: str, version: Version, category: str, entry: str, compare_from: Optional[str]) -> str:
    tag = version.tag()
    repo = os.environ.get("GITHUB_REPOSITORY","")
    today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
    section_header = f"## [{tag}](https://github.com/{repo}/releases/tag/{tag}) ({today})"
    if f"## [{tag}]" not in content:
        # insert after main header at top
        lines = content.splitlines()
        out=[]; inserted=False
        for line in lines:
            out.append(line)
            if not inserted and line.startswith("# "):
                out += ["", section_header, "", f"### {category}", "", entry, ""]
                if compare_from:
                    out += [f"**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{tag}", ""]
                inserted=True
        if not inserted:
            out = ["# Changelog","", section_header,"", f"### {category}","", entry,""]
            if compare_from:
                out += [f"**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{tag}",""]
        return squeeze_blank("\n".join(out)) + "\n"
    # update existing
    lines = content.splitlines()
    out=[]; in_sec=False; added=False
    i=0
    while i < len(lines):
        line=lines[i]
        if line.startswith(f"## [{tag}]"):
            out.append(section_header)
            in_sec=True
            i+=1
            continue
        if in_sec and line.startswith("## [v") and not line.startswith(f"## [{tag}]"):
            # end of section
            if not added:
                out += [f"### {category}","", entry,""]
            if compare_from and not any("**Full Changelog**" in x for x in out[-6:]):
                out += [f"**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{tag}",""]
            out.append(line)
            in_sec=False
            i+=1
            continue
        if in_sec:
            if line == f"### {category}":
                # insert entry after header blank
                out.append(line)
                if i+1 >= len(lines) or lines[i+1].strip() != "":
                    out.append("")
                out.append(entry)
                added=True
                i+=1
                continue
        out.append(line)
        i+=1
    if in_sec:
        if not added:
            out += [f"### {category}","", entry,""]
        if compare_from and not any("**Full Changelog**" in x for x in out[-6:]):
            out += [f"**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{tag}",""]
    return squeeze_blank("\n".join(out)) + "\n"

def collect_section_categories(block: str) -> Dict[str,List[str]]:
    cats={}
    current=None
    for line in block.splitlines():
        if line.startswith("### "):
            current=line[4:].strip()
            cats.setdefault(current,[])
        elif line.startswith("- ") and current:
            cats[current].append(line)
    return cats

def build_beta_body(current: Version, changelog: str, latest_stable: Optional[Version]) -> str:
    block = find_section_block(changelog, current.tag())
    cats = collect_section_categories(block)
    # determine compare_from
    if current.beta == 0:
        compare_from = latest_stable.tag() if latest_stable else "v0.0.0"
    else:
        compare_from = f"v{current.major}.{current.minor}.{current.patch}-beta.{current.beta-1}"
    ordered = [c for c in CATEGORY_ORDER if c in cats] + [c for c in cats if c not in CATEGORY_ORDER]
    if not ordered:
        body_sections = "## Other Changes\n\n_No changes in this beta release._"
    else:
        parts=[]
        for c in ordered:
            parts.append(f"## {c}\n")
            parts.extend(cats[c])
            parts.append("")
        body_sections = "\n".join(parts).strip()
    repo = os.environ.get("GITHUB_REPOSITORY","")
    return f"Beta Release - {current.tag()}\n\n{body_sections}\n\n**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{current.tag()}"

def build_stable_body(version: Version, changelog: str, prev_stable: Version) -> str:
    block = find_section_block(changelog, version.tag())
    cats = collect_section_categories(block)
    ordered = [c for c in CATEGORY_ORDER if c in cats] + [c for c in cats if c not in CATEGORY_ORDER]
    parts=[]
    for c in ordered:
        parts.append(f"## {c}\n")
        parts.extend(cats[c])
        parts.append("")
    if not ordered:
        parts = ["## Other Changes","","_No changes in this release._",""]
    repo = os.environ.get("GITHUB_REPOSITORY","")
    parts.append(f"**Full Changelog**: https://github.com/{repo}/compare/{prev_stable.tag()}...{version.tag()}")
    return "\n".join(parts).strip()

# ---------------- Version Decision Logic ----------------
def latest_versions(changelog: str) -> Tuple[Optional[Version], Optional[Version]]:
    versions = list_versions(changelog)
    stable = [v for v in versions if not v.is_beta()]
    beta = [v for v in versions if v.is_beta()]
    latest_stable = max(stable) if stable else None
    latest_beta = max(beta) if beta else None
    return latest_stable, latest_beta

def find_unpublished_beta_draft(gh: GitHub) -> Optional[Version]:
    for r in gh.releases():
        if r.get("draft") and r.get("prerelease") and "beta" in r.get("tag_name",""):
            try:
                return Version.parse(r["tag_name"])
            except:
                continue
    return None

def is_published(gh: GitHub, version: Version) -> bool:
    rel = gh.release_by_tag(version.tag())
    return bool(rel) and not rel.get("draft", False)

def bump_base(latest_stable: Optional[Version], bump: str) -> Version:
    base = latest_stable or Version(0,0,0)
    if bump == "major": return base.bump_major()
    if bump == "minor": return base.bump_minor()
    return base.bump_patch()

def decide_beta_target(gh: GitHub,
                       latest_stable: Optional[Version],
                       latest_published_beta: Optional[Version],
                       existing_unpublished: Optional[Version],
                       labels: List[str]) -> Tuple[Version,bool]:
    """
    Return (target_version, replace_unpublished?)
    replace_unpublished = True only when we escalate base for an unpublished draft.
    """
    bump = bump_type(labels)
    required_base = bump_base(latest_stable, bump)

    if existing_unpublished:
        if not is_published(gh, existing_unpublished):
            # unpublished draft present (always beta.0 by our rules)
            if required_base > existing_unpublished.base():
                # escalate & replace
                return Version(required_base.major, required_base.minor, required_base.patch, 0), True
            return existing_unpublished, False

    # no unpublished draft
    if latest_published_beta is None:
        return Version(required_base.major, required_base.minor, required_base.patch, 0), False

    # we do have published betas
    if bump == "major" and ESCALATE_BREAKING_POST_PUBLISH:
        new_base = latest_published_beta.base().bump_major()
        return Version(new_base.major, new_base.minor, new_base.patch, 0), False

    if required_base > latest_published_beta.base():
        return Version(required_base.major, required_base.minor, required_base.patch, 0), False

    return latest_published_beta.next_beta(), False

# ---------------- Core Actions ----------------
def cmd_pr_merged(args):
    gh = GitHub(args.github_token, args.repo)
    labels = json.loads(args.pr_labels or "[]")
    content = read_changelog()
    latest_stable, latest_beta_any = latest_versions(content)

    # Determine latest published beta (ignore unpublished drafts)
    published_beta_versions=[]
    for r in gh.releases():
        tn = r.get("tag_name","")
        if "beta" in tn and not r.get("draft") and r.get("prerelease"):
            try: published_beta_versions.append(Version.parse(tn))
            except: pass
    latest_published_beta = max(published_beta_versions) if published_beta_versions else None
    existing_unpublished = find_unpublished_beta_draft(gh)

    category = categorize(labels)
    entry = f"- {args.pr_title} @{args.pr_author} [#{args.pr_number}]"

    target_version, replace = decide_beta_target(
        gh, latest_stable, latest_published_beta, existing_unpublished, labels
    )

    # If replacing an unpublished draft (escalation)
    if replace and existing_unpublished and existing_unpublished.tag() != target_version.tag():
        # Remove old section (migrate entries)
        old_block = find_section_block(content, existing_unpublished.tag())
        content = remove_version_section(content, existing_unpublished.tag())
        # Insert new base section with migrated categories
        migrated_cats = collect_section_categories(old_block)
        content = ensure_version_section(content, target_version, latest_stable)
        # Re-add migrated entries
        for cat, entries in migrated_cats.items():
            for e in entries:
                content = insert_entry(content, target_version, cat, e, None)
        # Delete old draft release
        old_rel = gh.release_by_tag(existing_unpublished.tag())
        if old_rel and old_rel.get("id"):
            # cannot delete release via script easily without an endpoint inside constraints—safe to ignore
            pass

    # Ensure version section exists
    if f"## [{target_version.tag()}]" not in content:
        compare_from = None
        if target_version.beta == 0:
            compare_from = latest_stable.tag() if latest_stable else None
        else:
            compare_from = f"v{target_version.major}.{target_version.minor}.{target_version.patch}-beta.{target_version.beta-1}"
        content = insert_entry(content, target_version, category, entry, compare_from)
    else:
        # Determine compare_from only if section missing link (rare)
        section_block = find_section_block(content, target_version.tag())
        needs_compare = "**Full Changelog**" not in section_block
        compare_from = None
        if needs_compare:
            if target_version.beta == 0:
                compare_from = latest_stable.tag() if latest_stable else None
            else:
                compare_from = f"v{target_version.major}.{target_version.minor}.{target_version.patch}-beta.{target_version.beta-1}"
        content = insert_entry(content, target_version, category, entry, compare_from)

    write_changelog(content)
    git_commit(f"Update CHANGELOG.md for beta PR #{args.pr_number}")

    # Create or update draft release
    existing_rel = gh.release_by_tag(target_version.tag())
    body = build_beta_body(target_version, content, latest_stable)
    if existing_rel and existing_rel.get("id"):
        gh.update_release(existing_rel["id"], body=body, name=target_version.tag())
    else:
        gh.create_release(target_version.tag(), target_version.tag(), body, draft=True, prerelease=True)

def remove_version_section(content: str, tag: str) -> str:
    pattern = rf"^## \[{re.escape(tag)}\].*?(?=^## \[v|\Z)"
    return re.sub(pattern, "", content, flags=re.S|re.M)

def ensure_version_section(content: str, version: Version, latest_stable: Optional[Version]) -> str:
    if f"## [{version.tag()}]" in content:
        return content
    repo = os.environ.get("GITHUB_REPOSITORY","")
    today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
    compare_from = latest_stable.tag() if latest_stable else None
    section_header = f"## [{version.tag()}](https://github.com/{repo}/releases/tag/{version.tag()}) ({today})"
    insert = [section_header,""]
    if compare_from:
        insert += [f"**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{version.tag()}",""]
    lines = content.splitlines()
    out=[]; inserted=False
    for line in lines:
        out.append(line)
        if not inserted and line.startswith("# "):
            out += [""]+insert
            inserted=True
    if not inserted:
        out = ["# Changelog",""]+insert+out
    return squeeze_blank("\n".join(out))+"\n"

def git_config():
    os.system('git config --local user.email "action@github.com"')
    os.system('git config --local user.name "GitHub Action"')

def git_commit(message: str):
    git_config()
    diff = os.popen("git diff --name-only").read().strip()
    if "CHANGELOG.md" in diff:
        os.system("git add CHANGELOG.md")
        os.system(f'git commit -m "{message}" || true')
        os.system("git push || true")

def cmd_finalize_beta(args):
    gh = GitHub(args.github_token, args.repo)
    tag = args.version
    v = Version.parse(tag)
    content = read_changelog()
    entry = f"- Update CHANGELOG.md for beta release {tag} @github-actions [beta-release]"
    content = insert_entry(content, v, "Other Changes", entry, None)
    write_changelog(content)
    git_commit(f"Add changelog entry for beta release {tag} update")
    latest_stable,_ = latest_versions(content)
    body = build_beta_body(v, content, latest_stable)
    rel = gh.release_by_tag(tag)
    if rel and rel.get("id"):
        gh.update_release(rel["id"], body=body)

def cmd_convert_betas(args):
    gh = GitHub(args.github_token, args.repo)
    base_tag = args.version
    base_version = Version.parse(base_tag)
    # gather published betas
    releases = gh.releases()
    betas=[]
    for r in releases:
        tn = r.get("tag_name","")
        if tn.startswith(base_tag+"-beta.") and not r.get("draft") and r.get("prerelease"):
            try: betas.append(Version.parse(tn))
            except: pass
    if not betas:
        print("No published betas for that base")
        return
    content = read_changelog()
    # accumulate categories
    combined: Dict[str,List[str]] = {c:[] for c in CATEGORY_ORDER}
    for b in sorted(betas):
        block = find_section_block(content, b.tag())
        cats = collect_section_categories(block)
        for c, entries in cats.items():
            if c not in combined: combined[c]=[]
            # remove finalizing markers for readability
            cleaned = [re.sub(r' \[beta-release\]$','', e) for e in entries]
            combined[c].extend(cleaned)
    # remove beta sections
    for b in betas:
        content = remove_version_section(content, b.tag())
    # insert stable section
    prev_stable,_ = latest_versions(content)
    prev_stable = prev_stable or Version(0,0,0)
    repo = os.environ.get("GITHUB_REPOSITORY","")
    today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
    header = f"## [{base_tag}](https://github.com/{repo}/releases/tag/{base_tag}) ({today})"
    new_lines=[header,""]
    for c in CATEGORY_ORDER:
        if combined.get(c):
            new_lines += [f"### {c}",""]+combined[c]+[""]
    new_lines += [ "### Other Changes","",
                   f"- Convert beta releases ({', '.join(b.tag() for b in sorted(betas))}) to regular release {base_tag} @github-actions [beta-to-release]","",
                   f"**Full Changelog**: https://github.com/{repo}/compare/{prev_stable.tag()}...{base_tag}",""]
    # insert after main header
    lines = content.splitlines()
    out=[]; inserted=False
    for line in lines:
        out.append(line)
        if not inserted and line.startswith("# "):
            out += [""]+new_lines
            inserted=True
    if not inserted:
        out = ["# Changelog",""]+new_lines+out
    content = squeeze_blank("\n".join(out))+"\n"
    write_changelog(content)
    git_commit(f"Convert beta releases to release {base_tag} in CHANGELOG.md")

    # create/update draft stable release
    body = build_stable_body(base_version, content, prev_stable)
    rel = gh.release_by_tag(base_tag)
    if rel and rel.get("draft"):
        gh.update_release(rel["id"], body=body, name=base_tag)
    else:
        gh.create_release(base_tag, base_tag, body, draft=True, prerelease=False, target="latest")

def cmd_finalize_stable(args):
    gh = GitHub(args.github_token, args.repo)
    tag = args.version
    v = Version.parse(tag)
    if v.is_beta():
        print("Use finalize beta for beta tags")
        return
    content = read_changelog()
    entry = f"- Update CHANGELOG.md for release {tag} @github-actions [release]"
    content = insert_entry(content, v, "Other Changes", entry, None)
    write_changelog(content)
    git_commit(f"Add changelog entry for release {tag} update")
    prev_stable,_ = latest_versions(content)
    # prev_stable now includes this new version; find previous
    versions = [x for x in list_versions(content) if not x.is_beta()]
    versions_sorted = sorted(versions)
    if len(versions_sorted) > 1 and versions_sorted[-1] == v:
        prev = versions_sorted[-2]
    else:
        prev = Version(0,0,0)
    body = build_stable_body(v, content, prev)
    rel = gh.release_by_tag(tag)
    if rel and rel.get("id"):
        gh.update_release(rel["id"], body=body)

# ---------------- CLI ----------------
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
    m.add_argument("--base-branch", required=True)

    fb = sub.add_parser("publish-beta")
    fb.add_argument("--github-token", required=True)
    fb.add_argument("--repo", required=True)
    fb.add_argument("--version", required=True)
    fb.add_argument("--release-body", required=False)

    cb = sub.add_parser("convert-to-stable")
    cb.add_argument("--github-token", required=True)
    cb.add_argument("--repo", required=True)
    cb.add_argument("--version", required=True)

    fs = sub.add_parser("publish-stable")
    fs.add_argument("--github-token", required=True)
    fs.add_argument("--repo", required=True)
    fs.add_argument("--version", required=True)
    fs.add_argument("--release-body", required=False)

    args = ap.parse_args()
    if args.action == "pr-merged":
        # Only act if base branch is beta-like
        if not args.base_branch.startswith("beta"):
            print("Base branch not beta*, ignoring.")
            return
        cmd_pr_merged(args)
    elif args.action == "publish-beta":
        cmd_finalize_beta(args)
    elif args.action == "convert-to-stable":
        cmd_convert_betas(args)
    elif args.action == "publish-stable":
        cmd_finalize_stable(args)
    else:
        print("Unknown action")

if __name__ == "__main__":
    main()
