#!/usr/bin/env python3
"""
Consolidated publisher + rollback manager.

Responsibilities:
- Determine tag and expected version from event context.
- Finalize the draft release (beta or stable): add date to header, add housekeeping entry, retag to include the commit.
- Ensure local checkout is refreshed to the updated tag.
- Optionally set package.json version from tag and/or verify match.
- Run install/build.
- Publish to npm with optional dist-tag and extra args.
- On failure:
  - Resolve release by tag.
  - Either delete published release (default) or convert to draft.
  - Delete the associated tag (default).
  - Roll back finalize metadata in CHANGELOG.md (remove date suffix and housekeeping entry), preserving PR entries.
  - Commit and push the CHANGELOG rollback to the release target branch.

Inputs via environment:
- GH_TOKEN / GITHUB_TOKEN
- GITHUB_REPOSITORY
- GITHUB_REF_NAME
- GITHUB_EVENT_PATH

- INPUT_DIST_TAG
- INPUT_SET_VERSION_FROM_TAG (true/false)
- INPUT_FAIL_IF_MISMATCH (true/false)
- INPUT_INSTALL_CMD
- INPUT_BUILD_CMD
- INPUT_EXTRA_PUBLISH_ARGS
- INPUT_ROLLBACK_DELETE_TAG (true/false)
- INPUT_ROLLBACK_DELETE_RELEASE (true/false)

Outputs:
- Writes NPM_VERSION to $GITHUB_OUTPUT on success.
"""
import os
import re
import shlex
import subprocess
import sys
from typing import Any, Dict, Optional, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

def _bool(val: Optional[str], default: bool = False) -> bool:
    if val is None:
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")

def _rollback_changelog_finalize_metadata(tag: str, target_branch: Optional[str]) -> bool:
    path = "CHANGELOG.md"
    if not os.path.exists(path):
        print("[rollback] CHANGELOG.md not found; skipping.")
        return False
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    lines = content.splitlines()
    changed = False
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
    if new_header != lines[start]:
        lines[start] = new_header
        changed = True
    hk_re = re.compile(
        rf"^- +Update CHANGELOG\.md for (?:beta release|release) {re.escape(tag)} @github-actions \[(?:beta-release|release)\]\s*$"
    )
    keep = []
    for idx in range(start + 1, end):
        if hk_re.match(lines[idx]):
            changed = True
            continue
        keep.append(lines[idx])
    if changed:
        new_section = [lines[start]] + keep
        new_lines = lines[:start] + new_section + lines[end:]
        squeezed = []
        prev_blank = False
        for l in new_lines:
            is_blank = (l.strip() == "")
            if is_blank and prev_blank:
                continue
            squeezed.append(l)
            prev_blank = is_blank
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(squeezed) + "\n")
        print(f"[rollback] CHANGELOG.md updated for {tag}")
        if target_branch:
            try:
                common.run(["git", "fetch", "origin", target_branch, "--depth=0"], check=False)
                try:
                    common.run(["git", "checkout", "-B", target_branch, f"origin/{target_branch}"], check=True)
                except subprocess.CalledProcessError:
                    common.run(["git", "checkout", target_branch], check=False)
                common.run(['git', 'config', 'user.email', 'action@github.com'], check=False)
                common.run(['git', 'config', 'user.name', 'GitHub Action'], check=False)
                common.run(["git", "add", "CHANGELOG.md"], check=False)
                diff_rc = common.run(["git", "diff", "--cached", "--quiet"], check=False).returncode
                if diff_rc != 0:
                    common.run(['git', 'commit', '-m', f'chore: rollback finalize metadata for {tag} due to npm publish failure'], check=False)
                    common.run(["git", "push", "origin", target_branch], check=False)
                    print(f"[rollback] Pushed CHANGELOG rollback to {target_branch}.")
            except Exception as e:
                print(f"::warning::Failed to push CHANGELOG rollback: {e}")
        return True
    print(f"[rollback] No finalize metadata to remove for {tag}")
    return False

def _resolve_tag_and_expected_version(evt: Dict[str, Any]) -> Tuple[str, str]:
    tag = ""
    release_info = evt.get("release") or {}
    if isinstance(release_info, dict):
        tag = release_info.get("tag_name") or ""
    if not tag:
        tag = os.environ.get("GITHUB_REF_NAME", "") or ""
    if not tag:
        raise RuntimeError("No tag found from event context")
    expected = tag[1:] if tag.startswith("v") else tag
    return tag, expected

def main():
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not repo:
        print("::error::GITHUB_REPOSITORY is missing")
        sys.exit(1)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if not token:
        print("::error::GITHUB_TOKEN/GH_TOKEN is missing")
        sys.exit(1)
    evt = common.read_event()
    tag, expected_version = _resolve_tag_and_expected_version(evt)
    release_info = evt.get("release") or {}
    is_prerelease = bool(release_info.get("prerelease"))
    target_branch = release_info.get("target_commitish") or ""
    dist_tag = os.environ.get("INPUT_DIST_TAG", "")
    set_version_from_tag = _bool(os.environ.get("INPUT_SET_VERSION_FROM_TAG", "true"), True) or _bool(os.environ.get("INPUT_SET_VERSION_FROM_RELEASE_TAG", "true"), True)
    fail_if_mismatch = _bool(os.environ.get("INPUT_FAIL_IF_MISMATCH", "true"), True)
    install_cmd = (os.environ.get("INPUT_INSTALL_CMD") or "").strip()
    build_cmd = (os.environ.get("INPUT_BUILD_CMD") or "").strip()
    extra_publish_args = (os.environ.get("INPUT_EXTRA_PUBLISH_ARGS") or "").strip()
    rollback_delete_tag = _bool(os.environ.get("INPUT_ROLLBACK_DELETE_TAG", "true"), True)
    rollback_delete_release = _bool(os.environ.get("INPUT_ROLLBACK_DELETE_RELEASE", "true"), True)

    def do_rollback():
        print("::warning::npm publish failed; beginning rollback sequence...")
        rel_obj = common.gh_release_by_tag(repo, token, tag)
        target = None
        if rel_obj and isinstance(rel_obj, dict):
            target = rel_obj.get("target_commitish") or None
            is_draft = bool(rel_obj.get("draft"))
            is_prerelease_r = bool(rel_obj.get("prerelease"))
            rel_id = rel_obj.get("id")
            if rel_id:
                if not is_draft and rollback_delete_release:
                    ok = common.gh_release_delete(repo, token, int(rel_id))
                    print(f"[rollback] Deleted published release (id={rel_id}): {ok}")
                else:
                    ok = common.gh_release_set_draft(repo, token, int(rel_id), is_prerelease_r)
                    print(f"[rollback] Converted release to draft (id={rel_id}): {ok}")
        else:
            print("[rollback] No release found by tag; continuing with tag deletion/CHANGELOG rollback.")
        if rollback_delete_tag and tag:
            common.git_delete_tag(tag)
        _rollback_changelog_finalize_metadata(tag, target)

    try:
        print(f"Resolved tag: {tag}")
        print(f"Expected version from tag: {expected_version}")
        if target_branch:
            common.run(["git", "fetch", "origin", target_branch, "--depth=0"], check=False)
            try:
                common.run(["git", "checkout", "-B", target_branch, f"origin/{target_branch}"], check=True)
            except subprocess.CalledProcessError:
                common.run(["git", "checkout", target_branch], check=False)
        action = "publish-beta" if (is_prerelease and "beta" in tag) else "publish-stable"
        common.run(
            ["python3", ".github/scripts/release_manager.py", action, "--github-token", token, "--repo", repo, "--version", tag],
            check=True
        )
        common.run(["git", "fetch", "--tags", "--force", "origin"], check=False)
        cp = common.run(["git", "-c", "advice.detachedHead=false", "checkout", "-f", f"tags/{tag}"], check=False)
        if cp.returncode != 0:
            common.run(["git", "checkout", "-f", f"refs/tags/{tag}"], check=False)
        current_ver = common.npm_read_version()
        print(f"package.json version: {current_ver}")
        print(f"expected version:     {expected_version}")
        if set_version_from_tag and current_ver != expected_version:
            common.npm_set_version_no_git_tag(expected_version)
            current_ver = common.npm_read_version()
            print(f"Updated package.json version -> {current_ver}")
        if fail_if_mismatch and current_ver != expected_version:
            raise RuntimeError(f"package.json version ({current_ver}) does not match expected version from tag ({expected_version})")
        if install_cmd:
            common.run(install_cmd)
        if build_cmd:
            common.run(build_cmd)
        base = ["npm", "publish", "--access", "public", "--provenance"]
        pub_cmd = base + (["--tag", dist_tag] if dist_tag else [])
        if extra_publish_args:
            common.run(" ".join(shlex.quote(p) for p in pub_cmd) + " " + extra_publish_args)
        else:
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
            do_rollback()
        except Exception as re:
            print(f"::warning::Rollback encountered an error: {re}")
        sys.exit(1)

if __name__ == "__main__":
    main()