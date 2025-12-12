#!/usr/bin/env python3
"""Single-script publish handler.

- Resolving the release tag from the GitHub event
- Checking out the tag
- Ensuring package.json's version matches the tag
- Publishing to npm with the correct dist-tag
- Writing NPM_VERSION to $GITHUB_OUTPUT on success

On failure, rollback is delegated to `release_manager.py` in MODE=rollback.
"""
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
import common

from common import Context

def _resolve_tag_and_expected_version(evt: dict) -> tuple[str, str]:
    release_info = evt.get("release") or {}
    tag = release_info.get("tag_name")
    if not tag:
        raise RuntimeError("No tag found from event context")
    expected = tag[1:] if tag.startswith("v") else tag
    return tag, expected

def _delegate_rollback(context: Context) -> None:
    print("::warning::npm publish failed; delegating rollback to release_manager.py...")
    env = os.environ.copy()
    env["GITHUB_REPOSITORY"] = context.github_repository
    env["GITHUB_TOKEN"] = context.github_token
    env["MODE"] = "rollback"
    env["TAG"] = context.tag
    if context.target_branch:
        env["TARGET_BRANCH"] = context.target_branch
    try:
        common.run(
            ["python3", ".github/scripts/release_manager.py"],
            check=True,
            env=env,
        )
    except Exception as e:
        print(f"::warning::Rollback via release_manager.py encountered an error: {e}")

def main() -> None:
    github_repository = os.environ.get("GITHUB_REPOSITORY")
    github_token = os.environ.get("GITHUB_TOKEN")
    context = Context(github_repository=github_repository, github_token=github_token)
    evt = common.read_event()
    tag, expected_version = _resolve_tag_and_expected_version(evt)
    release_info = evt.get("release")
    context.tag = tag
    context.target_branch = release_info.get("target_commitish")
    npm_tag = os.environ.get("NPM_TAG")
    try:
        print(f"[publish] Resolved tag: {tag}")
        print(f"[publish] Expected version from tag: {expected_version}")
        if not common.npm_available():
            raise RuntimeError("npm is not available on PATH")
        common.git_checkout_tag(tag)
        current_ver = common.npm_read_version()
        print(f"[publish] package.json version: {current_ver}")
        print(f"[publish] expected version: {expected_version}")
        if current_ver != expected_version:
            print("[publish] package.json version mismatch; updating via npm version --no-git-tag-version")
            common.npm_set_version_no_git_tag(expected_version)
            current_ver = common.npm_read_version()
            print(f"[publish] Updated package.json version -> {current_ver}")
        if current_ver != expected_version:
            raise RuntimeError(
                f"package.json version ({current_ver}) does not match expected "
                f"version from tag ({expected_version})"
            )
        publish_cmd = "npm publish --provenance --access public"
        if npm_tag:
            publish_cmd = f"npm publish --tag {npm_tag} --provenance --access public"
        common.run(publish_cmd)
        version_out = common.npm_read_version()
        gh_out = os.environ.get("GITHUB_OUTPUT")
        if gh_out:
            with open(gh_out, "a", encoding="utf-8") as f:
                f.write(f"NPM_VERSION={version_out}\n")
        print(f"::notice::Publish succeeded: {version_out}")
    except Exception as e:
        print(f"::error::Publish failed: {e}")
        _delegate_rollback(context)
        sys.exit(1)

if __name__ == "__main__":
    main()