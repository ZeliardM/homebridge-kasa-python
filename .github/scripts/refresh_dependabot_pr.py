#!/usr/bin/env python3
"""
Refresh retargeted Dependabot PR branches from beta.

This script is intended for Dependabot PRs that were originally opened
against the default "latest" branch and then retargeted to "beta" by the
workflow. For supported npm lockfile-only PRs, it rebuilds the PR branch from
origin/beta and reapplies the security fix using `npm audit fix
--package-lock-only`, then force-pushes the refreshed branch so the next
`synchronize` workflow run can validate and auto-merge it cleanly.

If the regenerated branch has no package changes after rebuilding from beta,
the script creates an empty refresh commit so the PR can still move forward as
an updated beta-only branch.
"""
import json
import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import common

from common import Context


SUPPORTED_FILES = {"package-lock.json"}


def _npm_executable() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def _emit_outputs(**values: str) -> None:
    output_path = os.getenv("GITHUB_OUTPUT") or ""
    if not output_path:
        return
    with open(output_path, "a", encoding="utf-8") as fh:
        for key, value in values.items():
            fh.write(f"{key}={value}\n")


def _finish(*, refreshed: bool, status: str, reason: str) -> dict:
    payload = {
        "refreshed": refreshed,
        "status": status,
        "reason": reason,
    }
    _emit_outputs(
        refreshed="true" if refreshed else "false",
        status=status,
        reason=reason.replace("\n", " ").strip(),
    )
    print(json.dumps(payload))
    return payload


def _github_context() -> Context:
    return Context(
        github_repository=os.getenv("GITHUB_REPOSITORY", ""),
        github_token=os.getenv("GITHUB_TOKEN", ""),
        pull_request_number=os.getenv("PULL_REQUEST_NUMBER", ""),
        pull_request_title=os.getenv("PULL_REQUEST_TITLE", ""),
        pull_request_branch=os.getenv("PULL_REQUEST_BRANCH", ""),
        pull_request_author=os.getenv("PULL_REQUEST_AUTHOR", ""),
    )


def _fetch_pr(context: Context) -> dict:
    code, pr = common.github_api(
        context.github_repository,
        context.github_token,
        f"/pulls/{context.pull_request_number}",
    )
    if code != 200 or not isinstance(pr, dict):
        raise RuntimeError(
            f"Unable to fetch PR #{context.pull_request_number} (status {code})."
        )
    return pr


def _fetch_changed_files(context: Context) -> list[str]:
    files = common.gh_list_paginated(
        context.github_repository,
        context.github_token,
        f"/pulls/{context.pull_request_number}/files",
    )
    out: list[str] = []
    for item in files:
        filename = item.get("filename")
        if isinstance(filename, str) and filename:
            out.append(filename)
    return out


def _git_dirty_paths() -> list[str]:
    proc = common.run(
        ["git", "status", "--porcelain"],
        capture=True,
        check=False,
        quiet=True,
    )
    stdout = getattr(proc, "stdout", "") or ""
    paths: list[str] = []
    for raw_line in stdout.splitlines():
        line = raw_line.rstrip()
        if not line:
            continue
        path = line[3:] if len(line) > 3 else line
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        paths.append(path)
    return paths


def _commit_refresh(message: str, *, allow_empty: bool) -> None:
    common.run(["git", "config", "--local", "user.email", "action@github.com"], check=False)
    common.run(["git", "config", "--local", "user.name", "GitHub Action"], check=False)
    if allow_empty:
        common.run(["git", "commit", "--allow-empty", "-m", message], check=True)
        return
    common.run(["git", "add", "package-lock.json", "package.json"], check=False)
    common.run(["git", "commit", "-m", message], check=True)


def _push_branch(head_ref: str, *, dry_run: bool) -> None:
    if dry_run:
        print(f"[refresh] DRY_RUN enabled; skipping push to {head_ref}")
        return
    common.run(
        ["git", "push", "--force-with-lease", "origin", f"HEAD:refs/heads/{head_ref}"],
        check=True,
    )


def _should_refresh(pr: dict, changed_files: list[str], original_base_ref: str) -> tuple[bool, str]:
    author = (((pr.get("user") or {}).get("login")) or "").strip()
    current_base = (((pr.get("base") or {}).get("ref")) or "").strip()
    if author != "dependabot[bot]":
        return False, f'PR author is "{author}" instead of "dependabot[bot]".'
    if original_base_ref != "latest":
        return False, f'Original base was "{original_base_ref}", not "latest".'
    if current_base != "beta":
        return False, f'Current base is "{current_base}", not "beta".'
    if not changed_files:
        return False, "PR has no changed files."
    if set(changed_files) != SUPPORTED_FILES:
        files_text = ", ".join(changed_files)
        return False, f"Unsupported file set for refresh: {files_text}"
    return True, "Supported retargeted npm lockfile PR detected."


def _refresh_npm_lockfile(head_ref: str, pr_number: str, *, dry_run: bool) -> tuple[bool, str]:
    common.run(["git", "fetch", "origin", "beta", head_ref, "--prune"], check=True)
    common.run(["git", "checkout", "-B", head_ref, f"origin/{head_ref}"], check=True)
    common.run(["git", "reset", "--hard", "origin/beta"], check=True)

    audit = common.run(
        [_npm_executable(), "audit", "fix", "--package-lock-only"],
        check=False,
    )
    if audit.returncode != 0:
        raise RuntimeError(
            f"`npm audit fix --package-lock-only` failed with exit code {audit.returncode}."
        )

    dirty_paths = _git_dirty_paths()
    message = f"Refresh Dependabot PR #{pr_number} from beta base"
    if not dirty_paths:
        print("[refresh] No package changes were required after rebuilding from beta.")
        _commit_refresh(f"{message} (no package changes required)", allow_empty=True)
        _push_branch(head_ref, dry_run=dry_run)
        return True, "Rebuilt branch from beta and created an empty refresh commit."

    unsupported_dirty = [p for p in dirty_paths if p not in {"package-lock.json", "package.json"}]
    if unsupported_dirty:
        raise RuntimeError(
            "Refresh touched unsupported files: " + ", ".join(sorted(unsupported_dirty))
        )

    _commit_refresh(message, allow_empty=False)
    _push_branch(head_ref, dry_run=dry_run)
    changed_text = ", ".join(sorted(dirty_paths))
    return True, f"Rebuilt branch from beta and refreshed {changed_text}."


def main() -> int:
    context = _github_context()
    dry_run = (os.getenv("DRY_RUN", "").strip().lower() in {"1", "true", "yes"})
    original_base_ref = os.getenv("ORIGINAL_PULL_REQUEST_BASE_REF", "").strip()

    if not context.github_repository or not context.github_token or not context.pull_request_number:
        _finish(
            refreshed=False,
            status="skipped",
            reason="Missing required GitHub workflow context.",
        )
        return 0

    try:
        pr = _fetch_pr(context)
        changed_files = _fetch_changed_files(context)
        should_refresh, reason = _should_refresh(pr, changed_files, original_base_ref)
        if not should_refresh:
            _finish(refreshed=False, status="skipped", reason=reason)
            return 0

        head_ref = (((pr.get("head") or {}).get("ref")) or "").strip()
        if not head_ref:
            raise RuntimeError("PR head ref is missing.")

        refreshed, detail = _refresh_npm_lockfile(
            head_ref,
            context.pull_request_number,
            dry_run=dry_run,
        )
        _finish(
            refreshed=refreshed,
            status="refreshed" if refreshed else "skipped",
            reason=detail,
        )
        return 0
    except subprocess.CalledProcessError as exc:
        _finish(
            refreshed=False,
            status="error",
            reason=f"Git command failed: {exc}",
        )
        return 1
    except Exception as exc:
        _finish(
            refreshed=False,
            status="error",
            reason=str(exc),
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
