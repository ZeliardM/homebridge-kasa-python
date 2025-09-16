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

import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple, Union, Sequence

def _bool(val: str, default: bool = False) -> bool:
    if val is None:
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")

def run(cmd: Union[str, Sequence[str]], env: Optional[Dict[str,str]] = None, check: bool = True) -> subprocess.CompletedProcess:
    if isinstance(cmd, (list, tuple)):
        printable = " ".join(shlex.quote(str(part)) for part in cmd)
        print(f"$ {printable}")
        return subprocess.run(cmd, check=check, text=True, env=env)
    else:
        print(f"$ {cmd}")
        return subprocess.run(cmd, shell=True, check=check, text=True, env=env)

def read_event() -> Dict[str, Any]:
    path = os.environ.get("GITHUB_EVENT_PATH") or ""
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def pkg_version() -> str:
    with open("package.json", "r", encoding="utf-8") as f:
        data = json.load(f)
    v = data.get("version", "")
    if not isinstance(v, str) or not v:
        raise RuntimeError("package.json is missing a valid version")
    return v

def npm_set_version(new_ver: str):
    run(["npm", "version", new_ver, "--no-git-tag-version"])

def gh_api(url: str, method: str = "GET", token: str = "", data: Optional[dict] = None) -> Tuple[int, Any]:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "release-publish-script",
        "Content-Type": "application/json",
    }
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8")
            code = r.getcode()
            return code, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        try:
            raw = e.read().decode()
            payload = json.loads(raw) if raw.strip() else {}
        except Exception:
            payload = {"message": str(e)}
        return e.code, payload
    except Exception as e:
        return 0, {"message": str(e)}

def gh_release_by_tag(repo: str, token: str, tag: str) -> Optional[dict]:
    code, data = gh_api(f"https://api.github.com/repos/{repo}/releases/tags/{tag}", token=token)
    if code == 404:
        return None
    return data if isinstance(data, dict) else None

def gh_release_delete(repo: str, token: str, release_id: int) -> bool:
    code, _ = gh_api(f"https://api.github.com/repos/{repo}/releases/{release_id}", method="DELETE", token=token)
    return 200 <= code < 300 or code == 204

def gh_release_set_draft(repo: str, token: str, release_id: int, prerelease: bool) -> bool:
    code, _ = gh_api(
        f"https://api.github.com/repos/{repo}/releases/{release_id}",
        method="PATCH",
        token=token,
        data={"draft": True, "prerelease": bool(prerelease)},
    )
    return 200 <= code < 300

def git_delete_tag(tag: str):
    try:
        run(["git", "fetch", "--tags", "--force", "origin"], check=False)
        run(["git", "push", "origin", f":refs/tags/{tag}"], check=False)
    except subprocess.CalledProcessError:
        print(f"::warning::Failed to delete tag {tag} (it may not exist remotely)")

def rollback_changelog_finalize_metadata(tag: str, target_branch: Optional[str]) -> bool:
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
                run(["git", "fetch", "origin", target_branch, "--depth=0"], check=False)
                try:
                    run(["git", "checkout", "-B", target_branch, f"origin/{target_branch}"], check=True)
                except subprocess.CalledProcessError:
                    run(["git", "checkout", target_branch], check=False)
                run(['git', 'config', 'user.email', 'action@github.com'], check=False)
                run(['git', 'config', 'user.name', 'GitHub Action'], check=False)
                run(["git", "add", "CHANGELOG.md"], check=False)
                diff_rc = run(["git", "diff", "--cached", "--quiet"], check=False).returncode
                if diff_rc != 0:
                    run(['git', 'commit', '-m', f'chore: rollback finalize metadata for {tag} due to npm publish failure'], check=False)
                    run(["git", "push", "origin", target_branch], check=False)
                    print(f"[rollback] Pushed CHANGELOG rollback to {target_branch}.")
            except Exception as e:
                print(f"::warning::Failed to push CHANGELOG rollback: {e}")
        return True
    print(f"[rollback] No finalize metadata to remove for {tag}")
    return False

def resolve_tag_and_expected_version(evt: Dict[str, Any]) -> Tuple[str, str]:
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
    evt = read_event()
    tag, expected_version = resolve_tag_and_expected_version(evt)
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
        rel_obj = gh_release_by_tag(repo, token, tag)
        target = None
        if rel_obj and isinstance(rel_obj, dict):
            target = rel_obj.get("target_commitish") or None
            is_draft = bool(rel_obj.get("draft"))
            is_prerelease_r = bool(rel_obj.get("prerelease"))
            rel_id = rel_obj.get("id")
            if rel_id:
                if not is_draft and rollback_delete_release:
                    ok = gh_release_delete(repo, token, int(rel_id))
                    print(f"[rollback] Deleted published release (id={rel_id}): {ok}")
                else:
                    ok = gh_release_set_draft(repo, token, int(rel_id), is_prerelease_r)
                    print(f"[rollback] Converted release to draft (id={rel_id}): {ok}")
        else:
            print("[rollback] No release found by tag; continuing with tag deletion/CHANGELOG rollback.")
        if rollback_delete_tag and tag:
            git_delete_tag(tag)
        rollback_changelog_finalize_metadata(tag, target)

    try:
        print(f"Resolved tag: {tag}")
        print(f"Expected version from tag: {expected_version}")
        if target_branch:
            run(["git", "fetch", "origin", target_branch, "--depth=0"], check=False)
            try:
                run(["git", "checkout", "-B", target_branch, f"origin/{target_branch}"], check=True)
            except subprocess.CalledProcessError:
                run(["git", "checkout", target_branch], check=False)
        action = "publish-beta" if (is_prerelease and "beta" in tag) else "publish-stable"
        run(
            ["python3", ".github/scripts/release_manager.py", action, "--github-token", token, "--repo", repo, "--version", tag],
            check=True
        )
        run(["git", "fetch", "--tags", "--force", "origin"], check=False)
        cp = run(["git", "-c", "advice.detachedHead=false", "checkout", "-f", f"tags/{tag}"], check=False)
        if cp.returncode != 0:
            run(["git", "checkout", "-f", f"refs/tags/{tag}"], check=False)
        current_ver = pkg_version()
        print(f"package.json version: {current_ver}")
        print(f"expected version:     {expected_version}")
        if set_version_from_tag and current_ver != expected_version:
            npm_set_version(expected_version)
            current_ver = pkg_version()
            print(f"Updated package.json version -> {current_ver}")
        if fail_if_mismatch and current_ver != expected_version:
            raise RuntimeError(f"package.json version ({current_ver}) does not match expected version from tag ({expected_version})")
        if install_cmd:
            run(install_cmd)
        if build_cmd:
            run(build_cmd)
        base = ["npm", "publish", "--access", "public", "--provenance"]
        pub_cmd = base + (["--tag", dist_tag] if dist_tag else [])
        if extra_publish_args:
            run(" ".join(shlex.quote(p) for p in pub_cmd) + " " + extra_publish_args)
        else:
            run(pub_cmd)
        version_out = pkg_version()
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