#!/usr/bin/env python3
"""
Sync the published stable branch back into beta without discarding beta-only work.

This runs after a stable release publish succeeds. It merges `latest` into `beta`
so beta is no longer behind on GitHub. If release housekeeping files conflict,
the sync keeps beta's in-progress package versions and replaces the stable
CHANGELOG section with the finalized section from latest.
"""
import os
import re
import sys

from pathlib import Path

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import common
import release_manager


CHANGELOG_FILE = "CHANGELOG.md"
KNOWN_CONFLICTS = {
    CHANGELOG_FILE,
    "package.json",
    "package-lock.json",
}


def _bool_env(name: str, default: bool) -> bool:
    raw = str(os.environ.get(name, str(default))).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _run_capture(cmd: list[str]) -> str:
    proc = common.run(cmd, capture=True, check=False)
    return (proc.stdout or "").strip()


def _version_key(version: release_manager.Version) -> tuple[int, int, int, int]:
    return (
        version.major,
        version.minor,
        version.patch,
        10_000 if version.beta is None else version.beta,
    )


def _section_pattern(tag: str) -> re.Pattern[str]:
    return re.compile(
        rf"^## \[{re.escape(tag)}\].*?(?=^## \[v[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?\]|\Z)",
        re.M | re.S,
    )


def _extract_section(content: str, tag: str) -> str:
    match = _section_pattern(tag).search(content)
    return match.group(0).strip() if match else ""


def _remove_section(content: str, tag: str) -> str:
    return _section_pattern(tag).sub("", content).strip() + "\n"


def _upsert_stable_section(
    beta_content: str,
    latest_content: str,
    stable_tag: str,
) -> str:
    stable_version = release_manager.Version.parse(stable_tag)
    stable_section = _extract_section(latest_content, stable_tag)
    if not stable_section:
        raise RuntimeError(f"Could not find {stable_tag} section in latest CHANGELOG.md")

    cleaned = _remove_section(beta_content, stable_tag)
    matches = list(
        re.finditer(
            r"^## \[(v[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?)\].*$",
            cleaned,
            re.M,
        )
    )

    insert_at = len(cleaned)
    for match in matches:
        version = release_manager.Version.parse(match.group(1))
        if _version_key(version) < _version_key(stable_version):
            insert_at = match.start()
            break

    if matches:
        before = cleaned[:insert_at].rstrip()
        after = cleaned[insert_at:].lstrip("\n")
        merged = (
            f"{before}\n\n{stable_section.strip()}\n\n{after}"
            if before
            else f"{stable_section.strip()}\n\n{after}"
        )
    else:
        body = cleaned.strip()
        if body.startswith("# Changelog"):
            merged = f"# Changelog\n\n{stable_section.strip()}\n"
        else:
            merged = f"# Changelog\n\n{stable_section.strip()}\n\n{body}"
    return common.squeeze_blank(merged).strip() + "\n"


def _conflicted_files() -> list[str]:
    output = _run_capture(["git", "diff", "--name-only", "--diff-filter=U"])
    return [line.strip() for line in output.splitlines() if line.strip()]


def _resolve_known_conflicts(stable_tag: str, latest_branch: str) -> None:
    conflicts = _conflicted_files()
    if not conflicts:
        return

    unexpected = [path for path in conflicts if path not in KNOWN_CONFLICTS]
    if unexpected:
        common.run(["git", "merge", "--abort"], check=False)
        raise RuntimeError(
            "Unexpected merge conflicts while syncing latest into beta: "
            + ", ".join(unexpected)
        )

    for path in ("package.json", "package-lock.json"):
        if path in conflicts:
            common.run(["git", "checkout", "--ours", "--", path], check=True)

    if CHANGELOG_FILE in conflicts:
        common.run(["git", "checkout", "--ours", "--", CHANGELOG_FILE], check=True)
        beta_content = Path(CHANGELOG_FILE).read_text(encoding="utf-8")
        latest_content = _run_capture(["git", "show", f"origin/{latest_branch}:{CHANGELOG_FILE}"])
        merged = _upsert_stable_section(beta_content, latest_content, stable_tag)
        Path(CHANGELOG_FILE).write_text(merged, encoding="utf-8")

    common.run(["git", "add", CHANGELOG_FILE, "package.json", "package-lock.json"], check=False)

    remaining = _conflicted_files()
    if remaining:
        common.run(["git", "merge", "--abort"], check=False)
        raise RuntimeError(
            "Conflicts remained after automatic resolution: " + ", ".join(remaining)
        )

    common.run(
        ["git", "commit", "-m", f"Sync latest into beta after stable release {stable_tag}"],
        check=True,
    )


def main() -> None:
    stable_tag = os.environ.get("RELEASE_TAG", "").strip()
    latest_branch = os.environ.get("LATEST_BRANCH", "latest").strip() or "latest"
    beta_branch = os.environ.get("BETA_BRANCH", "beta").strip() or "beta"
    push_enabled = _bool_env("SYNC_PUSH", True)

    if not stable_tag:
        raise RuntimeError("RELEASE_TAG is required")

    stable_version = release_manager.Version.parse(stable_tag)
    if stable_version.is_beta():
        raise RuntimeError("sync_latest_to_beta.py only supports stable release tags")

    common.run(["git", "config", "--local", "user.email", "action@github.com"], check=False)
    common.run(["git", "config", "--local", "user.name", "GitHub Action"], check=False)
    common.run(["git", "fetch", "origin", latest_branch, beta_branch, "--prune"], check=True)
    common.run(["git", "checkout", "--detach", f"origin/{beta_branch}"], check=True)

    if _run_capture(["git", "status", "--porcelain"]):
        raise RuntimeError("Working tree must be clean before syncing latest into beta")

    head_before = _run_capture(["git", "rev-parse", "HEAD"])
    merge = common.run(
        ["git", "merge", "--no-ff", "--no-edit", f"origin/{latest_branch}"],
        check=False,
    )
    if merge.returncode != 0:
        _resolve_known_conflicts(stable_tag, latest_branch)

    head_after = _run_capture(["git", "rev-parse", "HEAD"])
    if head_before == head_after:
        print(
            f"[sync-latest-to-beta] {beta_branch} already contains origin/{latest_branch}; "
            "nothing to push."
        )
        return

    if push_enabled:
        common.run(["git", "push", "origin", f"HEAD:refs/heads/{beta_branch}"], check=True)
        print(
            f"[sync-latest-to-beta] Synced origin/{latest_branch} into {beta_branch} "
            f"after stable release {stable_tag}."
        )
    else:
        print(
            f"[sync-latest-to-beta] Dry run complete for {stable_tag}; "
            f"created local sync commit {head_after[:7]}."
        )


if __name__ == "__main__":
    main()
