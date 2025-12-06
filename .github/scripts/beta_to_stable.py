#!/usr/bin/env python3
"""
Promote the latest published beta prerelease into a stable PR.
- Auto-detects latest beta tag vX.Y.Z-beta.N
- Creates/updates PR from beta -> latest
- Adds labels: stable-conversion
"""
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

from common import Context

def _latest_beta(repo: str, token: str):
    for page in range(1, 51):
        code, releases = common.github_api(repo, token, f"/releases?per_page=100&page={page}")
        if code != 200 or not releases:
            break
        for r in releases:
            tag = r.get("tag_name", "").strip()
            if r.get("draft") or not r.get("prerelease"):
                continue
            if "-beta." not in tag or r.get("target_commitish") != "beta":
                continue
            m = re.match(r"^(v\d+\.\d+\.\d+)-beta\.(\d+)$", tag)
            if not m:
                continue
            return tag, m.group(1)
        if len(releases) < 100:
            break
    print("::error::No published beta prerelease found.")
    sys.exit(1)

def _ensure_stable_not_published(repo: str, token: str, stable_tag: str):
    code, rel = common.github_api(repo, token, f"/releases/tags/{stable_tag}")
    if code == 200 and not rel.get("draft") and not rel.get("prerelease"):
        print(f"::warning::Stable release {stable_tag} exists. Continuing...")

def main():
    github_repository = os.environ.get("GITHUB_REPOSITORY")
    github_token = os.environ.get("GITHUB_TOKEN")
    context = Context(github_repository=github_repository, github_token=github_token)
    beta_tag, stable_tag = _latest_beta(context.github_repository, context.github_token)
    _ensure_stable_not_published(context.github_repository, context.github_token, stable_tag)
    code, pulls = common.github_api(context.github_repository, context.github_token, "/pulls?state=open&base=latest")
    if code != 200 or not isinstance(pulls, list):
        print("::error::Unable to list PRs")
        sys.exit(1)
    existing = next(
        (
            pr
            for pr in pulls
            if pr.get("base", {}).get("ref") == "latest"
            and pr.get("head", {}).get("ref") == "beta"
        ),
        None,
    )
    title = f"Release: {stable_tag}"
    body = (
        "This PR promotes the current beta branch into the latest branch for a stable release.\n\n"
        f"Detected from last published beta prerelease: {beta_tag}\n"
        "<!-- COPILOT-STICKY:STABLE-CONVERSION -->\n"
    )
    pr = existing
    if existing:
        number = existing.get("number")
        code, _ = common.github_api(
            context.github_repository,
            context.github_token,
            f"/pulls/{number}",
            method="PATCH",
            data={"title": title, "body": body},
        )
        if code not in (200, 201):
            print("::error::Failed to update PR")
            sys.exit(1)
    else:
        code, pr = common.github_api(
            context.github_repository,
            context.github_token,
            "/pulls",
            method="POST",
            data={"title": title, "head": "beta", "base": "latest", "body": body, "draft": False},
        )
        if code not in (200, 201) or not isinstance(pr, dict):
            print(f"::error::Failed to create PR: {pr}")
            sys.exit(1)
        number = pr.get("number")
    labels = {"labels": ["stable-conversion"]}
    code, _ = common.github_api(context.github_repository, context.github_token, f"/issues/{number}/labels", method="POST", data=labels)
    if code not in (200, 201):
        common.github_api(context.github_repository, context.github_token, f"/issues/{number}/labels", method="PUT", data=labels)
    pr_url = pr.get("html_url") if pr else f"#{number}"
    print(f"::notice::PR ready: {pr_url} (stable: {stable_tag}, from beta: {beta_tag})")

if __name__ == "__main__":
    main()