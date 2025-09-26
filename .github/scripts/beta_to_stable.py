#!/usr/bin/env python3
"""
Create/update a PR that promotes beta -> latest for the next stable version (vX.Y.Z),
auto-detected from the most recently published beta prerelease tag.

Behavior:
- Discover the latest published beta prerelease (not draft, prerelease==true, tag like vX.Y.Z-beta.N, target_commitish=beta).
- Derive the base stable version vX.Y.Z from that tag.
- Create or update a PR from head=beta to base=latest:
  - title: "Release: vX.Y.Z"
  - body: includes note about the detected beta tag
  - labels: stable-conversion, workflow
- Uses GitHub REST API only (no gh CLI).
"""
import os
import re
import sys
from typing import Optional, Tuple, Dict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

BETA_TAG_RE = re.compile(r"^(v\d+\.\d+\.\d+)-beta\.(\d+)$")

def _expect_env(name: str) -> str:
    v = os.environ.get(name, "")
    if not v:
        print(f"::error::{name} is required")
        sys.exit(1)
    return v

def _find_latest_published_beta(repo: str, token: str) -> Tuple[str, str]:
    """
    Returns (beta_tag, base_stable_tag) from the latest published beta prerelease targeting 'beta'.
    """
    page = 1
    latest: Optional[Dict] = None
    while page <= 50:
        code, data = common.github_api(repo, token, f"/releases?per_page=100&page={page}")
        if code != 200 or not isinstance(data, list) or not data:
            break
        for rel in data:
            if rel.get("draft") or not rel.get("prerelease"):
                continue
            tag = (rel.get("tag_name") or "").strip()
            if not tag or "-beta." not in tag:
                continue
            target = (rel.get("target_commitish") or "").strip()
            if target and target != "beta":
                continue
            latest = rel
            break
        if latest or len(data) < 100:
            break
        page += 1
    if not latest:
        print("::error::No published beta prerelease found (tag like vX.Y.Z-beta.N targeting beta).")
        sys.exit(1)
    beta_tag = (latest.get("tag_name") or "").strip()
    m = BETA_TAG_RE.match(beta_tag)
    if not m:
        print(f"::error::Latest prerelease tag '{beta_tag}' is not a valid beta tag.")
        sys.exit(1)
    base_stable = m.group(1)
    return beta_tag, base_stable

def _ensure_no_published_stable(repo: str, token: str, stable_tag: str):
    code, rel = common.github_api(repo, token, f"/releases/tags/{stable_tag}")
    if code == 200 and isinstance(rel, dict) and not rel.get("draft", False) and not rel.get("prerelease", False):
        print(f"::warning::A published stable release for {stable_tag} already exists. Proceeding to create/update PR anyway.")

def main():
    token = _expect_env("GITHUB_TOKEN")
    repo = _expect_env("GITHUB_REPOSITORY")
    beta_tag, stable_tag = _find_latest_published_beta(repo, token)
    _ensure_no_published_stable(repo, token, stable_tag)
    code, pulls = common.github_api(repo, token, "/pulls?state=open&base=latest")
    if code != 200 or not isinstance(pulls, list):
        print("::error::Unable to list PRs for base=latest")
        sys.exit(1)
    existing = None
    for pr in pulls:
        base_ref = (pr.get("base") or {}).get("ref", "")
        head_ref = (pr.get("head") or {}).get("ref", "")
        if base_ref == "latest" and head_ref == "beta":
            existing = pr
            break
    title = f"Release: {stable_tag}"
    body = (
        "This PR promotes the current beta branch into the latest branch for a stable release.\n\n"
        "- Source: beta\n- Target: latest\n"
        "- Purpose: Aggregate published betas into a stable draft (CHANGELOG + draft release)\n\n"
        f"Detected from last published beta prerelease: {beta_tag}\n\n"
        "Notes:\n"
        "- Labeled as stable-conversion so validators allow base=latest.\n"
        "- On merge, flow-stable.yml will aggregate beta sections into the stable version and create a draft release.\n\n"
        "<!-- COPILOT-STICKY:STABLE-CONVERSION -->\n"
    )
    if existing:
        number = existing.get("number")
        code, _ = common.github_api(repo, token, f"/pulls/{number}", method="PATCH", data={"title": title, "body": body})
        if code not in (200, 201):
            print("::error::Failed to update existing PR title/body")
            sys.exit(1)
    else:
        code, created = common.github_api(
            repo, token, "/pulls", method="POST",
            data={"title": title, "head": "beta", "base": "latest", "body": body, "draft": False}
        )
        if code not in (200, 201) or not isinstance(created, dict):
            print(f"::error::Failed to create PR: {created}")
            sys.exit(1)
        number = created.get("number")
    labels_payload = {"labels": ["stable-conversion", "workflow"]}
    code, _ = common.github_api(repo, token, f"/issues/{number}/labels", method="POST", data=labels_payload)
    if code not in (200, 201):
        common.github_api(repo, token, f"/issues/{number}/labels", method="PUT", data=labels_payload)
    code, pr = common.github_api(repo, token, f"/pulls/{number}")
    url = pr.get("html_url") if isinstance(pr, dict) else ""
    print(f"::notice::PR ready: {url or f'#{number}'} (stable: {stable_tag}, from beta: {beta_tag})")

if __name__ == "__main__":
    main()