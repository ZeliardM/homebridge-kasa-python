#!/usr/bin/env python3
"""Publish helper with robust rollback for failed npm publish.

Flow:
- Resolve release tag from GitHub event
- Run `release_manager.py` to finalize release metadata
- Ensure package.json matches tag, run `npm ci` and `npm run build`
- Publish to npm and write `NPM_VERSION` to `$GITHUB_OUTPUT`

On failure, rollback does the following (best-effort):
- Delete the published release (or convert to draft)
- Delete the remote tag
- Remove finalize metadata from `CHANGELOG.md` and push the change
- Recreate a draft release with the original name/body cleaned of finalize lines
"""
from __future__ import annotations

import os
import re
import sys
from typing import Any, Dict, Optional, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

def resolve_tag_and_expected_version(evt: Dict[str, Any]) -> Tuple[str, str]:
    release_info = evt.get("release") or {}
    tag = release_info.get("tag_name") or os.environ.get("GITHUB_REF_NAME", "") or ""
    if not tag:
        raise RuntimeError("No tag found from event context")
    expected = tag[1:] if tag.startswith("v") else tag
    return tag, expected

def _rollback_changelog_finalize_metadata(tag: str, target_branch: Optional[str]) -> bool:
    path = "CHANGELOG.md"
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
    hk_re = re.compile(rf"^- +Update CHANGELOG\.md for (?:beta release|release) {re.escape(tag)}.*@github-actions.*$")
    keep = []
    for idx in range(start + 1, end):
        if hk_re.match(lines[idx]):
            changed = True
            continue
        keep.append(lines[idx])
    if not changed:
        print(f"[rollback] No finalize metadata to remove for {tag}")
        return False
    new_section = [lines[start]] + keep
    new_lines = lines[:start] + new_section + lines[end:]
    out_lines = []
    prev_blank = False
    for l in new_lines:
        is_blank = (l.strip() == "")
        if is_blank and prev_blank:
            continue
        out_lines.append(l)
        prev_blank = is_blank

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")
    print(f"[rollback] CHANGELOG.md updated for {tag}")
    if target_branch:
        try:
            common.run(["git", "fetch", "origin", target_branch, "--depth=0"], check=False)
            try:
                common.run(["git", "checkout", "-B", target_branch, f"origin/{target_branch}"], check=True)
            except Exception:
                common.run(["git", "checkout", target_branch], check=False)
            common.run(["git", "config", "user.email", "action@github.com"], check=False)
            common.run(["git", "config", "user.name", "GitHub Action"], check=False)
            common.run(["git", "add", "CHANGELOG.md"], check=False)
            diff_rc = common.run(["git", "diff", "--cached", "--quiet"], check=False).returncode
            if diff_rc != 0:
                common.run(["git", "commit", "-m", f"chore: rollback finalize metadata for {tag} due to npm publish failure"], check=False)
                common.run(["git", "push", "origin", target_branch], check=False)
                print(f"[rollback] Pushed CHANGELOG rollback to {target_branch}.")
        except Exception as e:
            print(f"::warning::Failed to push CHANGELOG rollback: {e}")
    return True

def clean_finalize_lines(text: str, tag: str) -> str:
    hk_re = re.compile(rf"^- +Update CHANGELOG\.md for (?:beta release|release) {re.escape(tag)}.*@github-actions.*$")
    return "\n".join([l for l in text.splitlines() if not hk_re.match(l)]).strip()

def rollback(repo: str, token: str, tag: str, target_branch: Optional[str]):
    print("::warning::npm publish failed; beginning rollback sequence...")
    rel = common.gh_release_by_tag(repo, token, tag)
    rel_name = None
    rel_body = None
    prerelease_flag = None
    target = None
    if rel:
        target = rel.get("target_commitish") or None
        rel_name = rel.get("name")
        rel_body = rel.get("body") or ""
        prerelease_flag = bool(rel.get("prerelease")) if rel.get("prerelease") is not None else None
        rel_id = rel.get("id")
        if rel_id:
            if not bool(rel.get("draft")):
                ok = common.gh_release_delete(repo, token, int(rel_id))
                print(f"[rollback] Deleted published release (id={rel_id}): {ok}")
            else:
                ok = common.gh_release_set_draft(repo, token, int(rel_id), prerelease_flag or False)
                print(f"[rollback] Converted release to draft (id={rel_id}): {ok}")
    else:
        print("[rollback] No release found by tag; continuing with tag deletion/CHANGELOG rollback.")
    if tag:
        common.git_delete_tag(tag)
    _rollback_changelog_finalize_metadata(tag, target_branch)
    try:
        if prerelease_flag is None:
            prerelease_flag = True if (target and target == 'beta') else False

        cleaned_body = None
        if rel_body is not None:
            cleaned_body = clean_finalize_lines(rel_body, tag) or None

        release_name = rel_name or tag
        created = common.gh_release_create(
            repo,
            token,
            tag,
            target_commitish=target or None,
            draft=True,
            prerelease=bool(prerelease_flag),
            name=release_name,
            body=cleaned_body,
        )
        if created:
            print(f"[rollback] Recreated draft release for {tag} (prerelease={prerelease_flag})")
        else:
            print(f"::warning::Could not recreate draft release for {tag}")
    except Exception as e:
        print(f"::warning::Failed to recreate draft release: {e}")

def main():
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not repo:
        print("::error::GITHUB_REPOSITORY is missing")
        sys.exit(1)
    token = os.environ.get("GITHUB_TOKEN") or ""
    if not token:
        print("::error::GITHUB_TOKEN is missing")
        sys.exit(1)
    evt = common.read_event()
    tag, expected_version = resolve_tag_and_expected_version(evt)
    release_info = evt.get("release") or {}
    target_branch = release_info.get("target_commitish") or ""
    dist_tag = os.environ.get("INPUT_DIST_TAG", "")
    try:
        print(f"Resolved tag: {tag}")
        print(f"Expected version from tag: {expected_version}")
        action = "publish-beta" if (bool(release_info.get("prerelease")) and "beta" in tag) else "publish-stable"
        common.run(["python3", ".github/scripts/release_manager.py", action, "--github-token", token, "--repo", repo, "--version", tag], check=True)
        common.run(["git", "fetch", "--tags", "--force", "origin"], check=False)
        cp = common.run(["git", "-c", "advice.detachedHead=false", "checkout", "-f", f"tags/{tag}"], check=False)
        if cp.returncode != 0:
            common.run(["git", "checkout", "-f", f"refs/tags/{tag}"], check=False)
        current_ver = common.npm_read_version()
        print(f"package.json version: {current_ver}")
        print(f"expected version:     {expected_version}")
        if current_ver != expected_version:
            common.npm_set_version_no_git_tag(expected_version)
            current_ver = common.npm_read_version()
            print(f"Updated package.json version -> {current_ver}")
        if current_ver != expected_version:
            raise RuntimeError(f"package.json version ({current_ver}) does not match expected version from tag ({expected_version})")
        common.run("npm ci")
        common.run("npm run build")
        pub_cmd = ["npm", "publish", "--access", "public", "--provenance"] + (["--tag", dist_tag] if dist_tag else [])
        common.run(pub_cmd)
        version_out = common.npm_read_version()
        gh_out = os.environ.get("GITHUB_OUTPUT")
        if gh_out:
            with open(gh_out, "a", encoding="utf-8") as f:
                f.write(f"NPM_VERSION={version_out}\n")
        print(f"::notice::Publish succeeded: {version_out}")
    except Exception as e:
        print(f"::error::Publish failed: {e}")
        try:
            rollback(repo, token, tag, target_branch)
        except Exception as re:
            print(f"::warning::Rollback encountered an error: {re}")
        sys.exit(1)

if __name__ == "__main__":
    main()