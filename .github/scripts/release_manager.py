#!/usr/bin/env python3
"""
Unified Release Manager (beta + stable):
Actions:
  pr-merged         (update or create beta draft & CHANGELOG)
  publish-beta      (finalize beta section/date + housekeeping entry)
  convert-to-stable (aggregate all published betas of a base into stable draft)
  publish-stable    (finalize stable section/date + housekeeping entry)

Assumptions:
- Only one canonical beta branch: 'beta'
- Tags: vX.Y.Z or vX.Y.Z-beta.N
- Standard categories: Breaking Changes, Featured Changes, Bug Fixes, Other Changes
"""
import os, re, json, sys, argparse, datetime, urllib.request, urllib.error
from dataclasses import dataclass
from typing import Optional, List, Dict, Tuple, Set

# If True, any "Breaking Changes" entries added after a beta release is published
# will be automatically escalated (moved) to the next beta or stable release section.
# Set to False if you want breaking changes to remain in the section where they were
# originally added, even if that section has already been published.
# Change this if your release process requires stricter or looser handling of
# post-publication breaking changes in the changelog.
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
SECTION_RE = re.compile(r"^## \[(v[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?)\]", re.MULTILINE)

@dataclass(order=True, frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    beta: Optional[int] = None
    @classmethod
    def parse(cls, s: str) -> "Version":
        m = SEMVER.match(s)
        if not m: raise ValueError(s)
        a,b,c,d = m.groups()
        return cls(int(a), int(b), int(c), int(d) if d is not None else None)
    def is_beta(self) -> bool: return self.beta is not None
    def tag(self) -> str:
        return f"v{self.major}.{self.minor}.{self.patch}" + (f"-beta.{self.beta}" if self.beta is not None else "")
    def base(self): return Version(self.major, self.minor, self.patch, None)
    def bump_major(self): return Version(self.major+1,0,0)
    def bump_minor(self): return Version(self.major,self.minor+1,0)
    def bump_patch(self): return Version(self.major,self.minor,self.patch+1)
    def next_beta(self): return Version(self.major,self.minor,self.patch,0 if self.beta is None else self.beta+1)

class GitHub:
    def __init__(self, token: str, repo: str):
        self.token = token; self.repo = repo; self.api = f"https://api.github.com/repos/{repo}"
    def _request(self, method: str, path: str, data: Optional[dict]=None) -> dict:
        url = f"{self.api}{path}"
        headers = {
            "Accept":"application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "Content-Type":"application/json"
        }
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as e:
            try: msg = e.read().decode()
            except: msg=str(e)
            print(f"[release-manager] API {e.code}: {msg}", file=sys.stderr)
            return {}
        except Exception as e:
            print(f"[release-manager] API exception: {e}", file=sys.stderr)
            return {}
    def releases(self) -> List[dict]: return self._request("GET","/releases?per_page=100") or []
    def release_by_tag(self, tag: str) -> Optional[dict]:
        r = self._request("GET", f"/releases/tags/{tag}")
        if r.get("message") == "Not Found": return None
        return r or None
    def create_release(self, tag: str, name: str, body: str, draft: bool, prerelease: bool, target: str="beta") -> dict:
        return self._request("POST","/releases", {
            "tag_name": tag, "name": name, "body": body,
            "draft": draft, "prerelease": prerelease, "target_commitish": target
        })
    def update_release(self, release_id: int, **fields) -> dict:
        return self._request("PATCH", f"/releases/{release_id}", fields)

def read_changelog() -> str:
    if not os.path.exists(CHANGELOG_FILE): return "# Changelog\n\n"
    return open(CHANGELOG_FILE,"r",encoding="utf-8").read()

def write_changelog(content: str):
    if not content.endswith("\n"): content += "\n"
    open(CHANGELOG_FILE,"w",encoding="utf-8").write(content)

def list_versions(content: str) -> List[Version]:
    out=[]
    for m in SECTION_RE.finditer(content):
        try: out.append(Version.parse(m.group(1)))
        except: pass
    return sorted(set(out))

def find_section_block(content: str, tag: str) -> str:
    pattern = rf"^## \[{re.escape(tag)}\].*?\n(.*?)(?=^## \[v|\Z)"
    m = re.search(pattern, content, flags=re.S|re.M)
    return m.group(1).strip() if m else ""

def squeeze_blank(text: str) -> str:
    lines=text.splitlines(); out=[]; prev=False
    for l in lines:
        blank = (l.strip()=="")
        if blank and prev: continue
        out.append(l); prev=blank
    return "\n".join(out)

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

def build_section_header(tag: str, add_date: bool, date: Optional[str]=None) -> str:
    repo = os.environ.get("GITHUB_REPOSITORY","")
    base = f"## [{tag}](https://github.com/{repo}/releases/tag/{tag})"
    return f"{base} ({date})" if add_date and date else base

def insert_entry(content: str, version: Version, category: str, entry: str,
                 compare_from: Optional[str], add_date=False, publish_date=None) -> str:
    tag = version.tag()
    repo = os.environ.get("GITHUB_REPOSITORY","")
    header_pattern = f"## [{tag}]"
    lines = content.splitlines()
    header_idx = next((i for i,l in enumerate(lines) if l.startswith(header_pattern)), None)

    if header_idx is None:
        section_header = build_section_header(tag, add_date, publish_date)
        new_sec = [section_header,"", f"### {category}","", entry,""]
        if compare_from:
            new_sec += [f"**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{tag}",""]
        out=[]; inserted=False
        for i,l in enumerate(lines):
            out.append(l)
            if not inserted and l.startswith("# "):
                out+=new_sec; inserted=True
        if not inserted:
            out=["# Changelog",""]+new_sec+out
        return squeeze_blank("\n".join(out))+"\n"

    if add_date and "(" not in lines[header_idx]:
        lines[header_idx] = build_section_header(tag, True, publish_date)

    i=header_idx+1; end=len(lines)
    while i<len(lines):
        if lines[i].startswith("## [v") and not lines[i].startswith(header_pattern):
            end=i; break
        i+=1
    section = lines[header_idx:end]

    cat_header = f"### {category}"
    if cat_header not in section:
        fc_index = next((idx for idx,l in enumerate(section) if l.startswith("**Full Changelog**")), None)
        insert_at = fc_index if fc_index is not None else len(section)
        to_insert=[cat_header,"", entry,""]
        section = section[:insert_at]+to_insert+section[insert_at:]
    else:
        new_sec=[]; j=0; inserted=False
        while j < len(section):
            line=section[j]; new_sec.append(line)
            if line == cat_header and not inserted:
                if j+1>=len(section) or section[j+1].strip()!="":
                    new_sec.append("")
                new_sec.append(entry); inserted=True
            j+=1
        section=new_sec

    if compare_from and not any("**Full Changelog**" in l for l in section):
        section += [f"**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{tag}",""]

    new_content = lines[:header_idx]+section+lines[end:]
    return squeeze_blank("\n".join(new_content))+"\n"

def rename_version_section(content: str, old_tag: str, new_tag: str) -> str:
    repo = os.environ.get("GITHUB_REPOSITORY","")
    old_header=f"## [{old_tag}]"; new_header=build_section_header(new_tag, False)
    lines=content.splitlines()
    for i,l in enumerate(lines):
        if l.startswith(old_header): lines[i]=new_header
        if "**Full Changelog**" in l and l.endswith(f"...{old_tag}"):
            lines[i]=re.sub(rf"\.\.{re.escape(old_tag)}$", f"..{new_tag}", l)
    return "\n".join(lines) + ("\n" if not lines[-1].endswith("\n") else "")

def add_publish_date(content: str, tag: str, date: str) -> str:
    lines=content.splitlines(); prefix=f"## [{tag}]"
    for i,l in enumerate(lines):
        if l.startswith(prefix) and "(" not in l:
            lines[i]=l+f" ({date})"; break
    return "\n".join(lines)+"\n"

def collect_section_categories(block: str) -> Dict[str,List[str]]:
    cats={}; current=None
    for line in block.splitlines():
        if line.startswith("### "):
            current=line[4:].strip(); cats.setdefault(current,[])
        elif line.startswith("- ") and current:
            cats[current].append(line)
    return cats

def build_beta_body(version: Version, changelog: str, latest_stable: Optional[Version]) -> str:
    block=find_section_block(changelog, version.tag())
    cats=collect_section_categories(block)
    if version.beta == 0:
        compare_from = latest_stable.tag() if latest_stable else "v0.0.0"
    else:
        compare_from = f"v{version.major}.{version.minor}.{version.patch}-beta.{version.beta-1}"
    ordered=[c for c in CATEGORY_ORDER if c in cats]+[c for c in cats if c not in CATEGORY_ORDER]
    if not ordered:
        body_sections="## Other Changes\n\n_No changes in this beta release._"
    else:
        parts=[]
        for c in ordered:
            parts.append(f"## {c}\n")
            parts.extend(cats[c]); parts.append("")
        body_sections="\n".join(parts).strip()
    repo=os.environ.get("GITHUB_REPOSITORY","")
    return f"Beta Release - {version.tag()}\n\n{body_sections}\n\n**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{version.tag()}"

def build_stable_body(version: Version, changelog: str, prev_stable: Version) -> str:
    block=find_section_block(changelog, version.tag())
    cats=collect_section_categories(block)
    ordered=[c for c in CATEGORY_ORDER if c in cats]+[c for c in cats if c not in CATEGORY_ORDER]
    parts=[]
    if ordered:
        for c in ordered:
            parts.append(f"## {c}\n")
            parts.extend(cats[c]); parts.append("")
    else:
        parts=["## Other Changes","","_No changes in this release._",""]
    repo=os.environ.get("GITHUB_REPOSITORY","")
    parts.append(f"**Full Changelog**: https://github.com/{repo}/compare/{prev_stable.tag()}...{version.tag()}")
    return "\n".join(parts).strip()

def latest_versions(changelog: str) -> Tuple[Optional[Version], Optional[Version]]:
    versions=list_versions(changelog)
    stable=[v for v in versions if not v.is_beta()]
    beta=[v for v in versions if v.is_beta()]
    return (max(stable) if stable else None, max(beta) if beta else None)

def find_unpublished_beta_draft(gh: GitHub) -> Optional[Version]:
    for r in gh.releases():
        if r.get("draft") and r.get("prerelease") and "beta" in r.get("tag_name",""):
            try: return Version.parse(r["tag_name"])
            except: continue
    return None

def is_published(gh: GitHub, version: Version) -> bool:
    rel=gh.release_by_tag(version.tag())
    return bool(rel) and not rel.get("draft", False)

def bump_base(latest_stable: Optional[Version], bump: str) -> Version:
    base=latest_stable or Version(0,0,0)
    if bump=="major": return base.bump_major()
    if bump=="minor": return base.bump_minor()
    return base.bump_patch()

def decide_beta_target(gh: GitHub, latest_stable: Optional[Version],
                       latest_published_beta: Optional[Version],
                       existing_unpublished: Optional[Version],
                       labels: List[str]) -> Tuple[Version,bool]:
    bump = bump_type(labels)
    required_base = bump_base(latest_stable, bump)
    if existing_unpublished:
        if not is_published(gh, existing_unpublished):
            if required_base > existing_unpublished.base():
                return Version(required_base.major, required_base.minor, required_base.patch, 0), True
            return existing_unpublished, False
    if latest_published_beta is None:
        return Version(required_base.major, required_base.minor, required_base.patch, 0), False
    if bump=="major" and ESCALATE_BREAKING_POST_PUBLISH:
        new_base=latest_published_beta.base().bump_major()
        return Version(new_base.major,new_base.minor,new_base.patch,0), False
    if required_base > latest_published_beta.base():
        return Version(required_base.major, required_base.minor, required_base.patch,0), False
    return latest_published_beta.next_beta(), False

def git_config():
    os.system('git config --local user.email "action@github.com"')
    os.system('git config --local user.name "GitHub Action"')

def git_commit(message: str):
    git_config()
    diff = os.popen("git diff --name-only").read().strip().splitlines()
    if "CHANGELOG.md" in diff:
        os.system("git add CHANGELOG.md")
        os.system(f'git commit -m "{message}" || true')
        os.system("git push || true")

def cmd_pr_merged(args):
    if args.base_branch != "beta":
        print("[release-manager] PR base not beta, ignoring.")
        return
    gh=GitHub(args.github_token, args.repo)
    labels=json.loads(args.pr_labels or "[]")
    content=read_changelog()
    latest_stable,_=latest_versions(content)

    published_beta_versions=[]
    for r in gh.releases():
        tn=r.get("tag_name","")
        if "beta" in tn and not r.get("draft") and r.get("prerelease"):
            try: published_beta_versions.append(Version.parse(tn))
            except: pass
    latest_published_beta=max(published_beta_versions) if published_beta_versions else None
    existing_unpublished=find_unpublished_beta_draft(gh)

    category=categorize(labels)
    entry=f"- {args.pr_title} @{args.pr_author} [#{args.pr_number}]"
    target_version, replace = decide_beta_target(
        gh, latest_stable, latest_published_beta, existing_unpublished, labels
    )

    if replace and existing_unpublished and existing_unpublished.tag() != target_version.tag():
        content=rename_version_section(content, existing_unpublished.tag(), target_version.tag())
        old_rel=gh.release_by_tag(existing_unpublished.tag())
        if old_rel and old_rel.get("id"):
            gh.update_release(old_rel["id"], tag_name=target_version.tag(), name=target_version.tag())
        print(f"[release-manager] Escalated draft to {target_version.tag()}")

    if f"## [{target_version.tag()}]" not in content:
        compare_from = (latest_stable.tag() if target_version.beta == 0 and latest_stable else
                        f"v{target_version.major}.{target_version.minor}.{target_version.patch}-beta.{target_version.beta-1}"
                        if target_version.beta and target_version.beta >0 else None)
        content=insert_entry(content, target_version, category, entry, compare_from, add_date=False)
    else:
        section_block=find_section_block(content, target_version.tag())
        needs_compare="**Full Changelog**" not in section_block
        compare_from=None
        if needs_compare:
            compare_from = (latest_stable.tag() if target_version.beta==0 and latest_stable else
                            f"v{target_version.major}.{target_version.minor}.{target_version.patch}-beta.{target_version.beta-1}"
                            if target_version.beta and target_version.beta>0 else None)
        content=insert_entry(content, target_version, category, entry, compare_from, add_date=False)

    write_changelog(content)
    git_commit(f"Update CHANGELOG.md for beta PR #{args.pr_number}")

    rel=gh.release_by_tag(target_version.tag())
    body=build_beta_body(target_version, content, latest_stable)
    if rel and rel.get("id"):
        gh.update_release(rel["id"], body=body, name=target_version.tag())
    else:
        gh.create_release(target_version.tag(), target_version.tag(), body, draft=True, prerelease=True)
    print(f"[release-manager] Updated beta draft {target_version.tag()}")

def cmd_finalize_beta(args):
    gh=GitHub(args.github_token, args.repo)
    v=Version.parse(args.version)
    content=read_changelog()
    entry=f"- Update CHANGELOG.md for beta release {v.tag()} @github-actions [beta-release]"
    content=insert_entry(content, v, "Other Changes", entry, None, add_date=False)
    date=datetime.datetime.utcnow().strftime("%Y-%m-%d")
    content=add_publish_date(content, v.tag(), date)
    write_changelog(content)
    git_commit(f"Finalize beta release {v.tag()} in CHANGELOG.md")
    latest_stable,_=latest_versions(content)
    body=build_beta_body(v, content, latest_stable)
    rel=gh.release_by_tag(v.tag())
    if rel and rel.get("id"):
        gh.update_release(rel["id"], body=body)
    print(f"[release-manager] Beta release finalized {v.tag()}")

def cmd_convert_betas(args):
    gh=GitHub(args.github_token, args.repo)
    base_version=Version.parse(args.version)
    content=read_changelog()
    if f"## [{base_version.tag()}]" in content:
        print("[release-manager] Stable section already exists, abort.")
        return
    releases=gh.releases()
    betas=[]
    for r in releases:
        tn=r.get("tag_name","")
        if tn.startswith(base_version.tag()+"-beta.") and not r.get("draft") and r.get("prerelease"):
            try: betas.append(Version.parse(tn))
            except: pass
    if not betas:
        print("[release-manager] No published betas to convert.")
        return
    aggregated={c:[] for c in CATEGORY_ORDER}; seen=set()
    for b in sorted(betas):
        block=find_section_block(content, b.tag())
        cats=collect_section_categories(block)
        for cat, entries in cats.items():
            if cat not in aggregated: aggregated[cat]=[]
            for e in entries:
                if e.endswith("[beta-release]"): continue
                if e not in seen:
                    aggregated[cat].append(e); seen.add(e)

    repo=os.environ.get("GITHUB_REPOSITORY","")
    header=build_section_header(base_version.tag(), add_date=False)
    prev_stable,_=latest_versions(content)
    prev_stable = prev_stable or Version(0,0,0)
    parts=[header,""]
    for cat in CATEGORY_ORDER:
        if aggregated.get(cat):
            parts.append(f"### {cat}"); parts.append("")
            parts.extend(aggregated[cat]); parts.append("")
    parts+=["### Other Changes","",
            f"- Convert beta releases ({', '.join(b.tag() for b in sorted(betas))}) to regular release {base_version.tag()} @github-actions [beta-to-release]","",
            f"**Full Changelog**: https://github.com/{repo}/compare/{prev_stable.tag()}...{base_version.tag()}",""]
    lines=content.splitlines(); out=[]; inserted=False
    for l in lines:
        out.append(l)
        if not inserted and l.startswith("# "):
            out+=[""]+parts; inserted=True
    if not inserted:
        out=["# Changelog",""]+parts+out
    content=squeeze_blank("\n".join(out))+"\n"
    write_changelog(content)
    git_commit(f"Add stable draft section {base_version.tag()} to CHANGELOG.md")
    body=build_stable_body(base_version, content, prev_stable)
    rel=gh.release_by_tag(base_version.tag())
    if rel and rel.get("draft"):
        gh.update_release(rel["id"], body=body, name=base_version.tag())
    else:
        gh.create_release(base_version.tag(), base_version.tag(), body, draft=True, prerelease=False, target="latest")
    print(f"[release-manager] Created stable draft {base_version.tag()}")

def cmd_finalize_stable(args):
    gh=GitHub(args.github_token, args.repo)
    v=Version.parse(args.version)
    if v.is_beta():
        print("[release-manager] Use publish-beta for beta tags.")
        return
    content=read_changelog()
    entry=f"- Update CHANGELOG.md for release {v.tag()} @github-actions [release]"
    content=insert_entry(content, v, "Other Changes", entry, None, add_date=False)
    date=datetime.datetime.utcnow().strftime("%Y-%m-%d")
    content=add_publish_date(content, v.tag(), date)
    write_changelog(content)
    git_commit(f"Finalize stable release {v.tag()} in CHANGELOG.md")
    versions=[x for x in list_versions(content) if not x.is_beta()]
    versions_sorted=sorted(versions)
    prev=Version(0,0,0)
    if len(versions_sorted)>1 and versions_sorted[-1]==v:
        prev=versions_sorted[-2]
    body=build_stable_body(v, content, prev)
    rel=gh.release_by_tag(v.tag())
    if rel and rel.get("id"):
        gh.update_release(rel["id"], body=body)
    print(f"[release-manager] Stable release finalized {v.tag()}")

def main():
    ap=argparse.ArgumentParser()
    sub=ap.add_subparsers(dest="action", required=True)
    m=sub.add_parser("pr-merged")
    m.add_argument("--github-token", required=True)
    m.add_argument("--repo", required=True)
    m.add_argument("--pr-title", required=True)
    m.add_argument("--pr-author", required=True)
    m.add_argument("--pr-number", required=True)
    m.add_argument("--pr-labels", default="[]")
    m.add_argument("--base-branch", required=True)
    fb=sub.add_parser("publish-beta")
    fb.add_argument("--github-token", required=True)
    fb.add_argument("--repo", required=True)
    fb.add_argument("--version", required=True)
    cb=sub.add_parser("convert-to-stable")
    cb.add_argument("--github-token", required=True)
    cb.add_argument("--repo", required=True)
    cb.add_argument("--version", required=True)
    fs=sub.add_parser("publish-stable")
    fs.add_argument("--github-token", required=True)
    fs.add_argument("--repo", required=True)
    fs.add_argument("--version", required=True)
    args=ap.parse_args()
    if args.action == "pr-merged": cmd_pr_merged(args)
    elif args.action == "publish-beta": cmd_finalize_beta(args)
    elif args.action == "convert-to-stable": cmd_convert_betas(args)
    elif args.action == "publish-stable": cmd_finalize_stable(args)
    else: print("[release-manager] Unknown action")

if __name__ == "__main__":
    main()
