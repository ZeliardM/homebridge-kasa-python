#!/usr/bin/env python3
"""
Common helpers reused across release and workflow scripts.

Provides:
- run: command runner with consistent logging
- read_event: load the GitHub event payload
- GitHub API helpers: github_api, gh_release_by_tag, gh_release_delete, gh_release_set_draft
- Git helpers: git_force_tag, git_delete_tag
- npm helpers: npm_read_version, npm_set_version_no_git_tag, npm_pkg_set_version, npm_available
"""
import json
import os
import shlex
import subprocess
import urllib.request
import urllib.error
from typing import Any, Dict, Optional, Sequence, Tuple, Union

def run(
    cmd: Union[str, Sequence[str]],
    *,
    env: Optional[Dict[str, str]] = None,
    check: bool = True,
    cwd: Optional[str] = None,
    quiet: bool = False,
    capture: bool = False,
    stdout=None,
    stderr=None,
    text: bool = True,
) -> subprocess.CompletedProcess:
    """
    Run a shell command or argv list with consistent logging.

    - If cmd is a string, runs with shell=True; if a sequence, shell=False.
    - Set quiet=True to suppress the "$ ..." echo.
    - Set capture=True to capture stdout/stderr (overrides stdout/stderr to PIPEs).
    - You can also pass explicit stdout/stderr (e.g., subprocess.DEVNULL).
    """
    shell = isinstance(cmd, str)
    if not quiet:
        printable = cmd if shell else " ".join(shlex.quote(str(p)) for p in cmd)
        print(f"$ {printable}")
    if capture:
        stdout = subprocess.PIPE
        stderr = subprocess.PIPE
    return subprocess.run(
        cmd,
        check=check,
        text=text,
        env=env,
        cwd=cwd,
        shell=shell,
        stdout=stdout,
        stderr=stderr,
    )

def read_event(path: Optional[str] = None) -> Dict[str, Any]:
    event_path = path or os.environ.get("GITHUB_EVENT_PATH") or ""
    if not event_path or not os.path.exists(event_path):
        return {}
    try:
        with open(event_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def github_api(repo: str, token: str, path: str, method: str = "GET", data: Optional[dict] = None) -> Tuple[int, Any]:
    url = f"https://api.github.com/repos/{repo}{path}"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": f"scripts-common (+https://github.com/{repo})",
        "Content-Type": "application/json",
    }
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode("utf-8")
            code = r.getcode()
            try:
                payload = json.loads(raw) if raw.strip() else {}
            except Exception:
                payload = {}
            return code, payload
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
    code, data = github_api(repo, token, f"/releases/tags/{tag}")
    if code == 404:
        return None
    return data if isinstance(data, dict) else None

def gh_release_delete(repo: str, token: str, release_id: int) -> bool:
    code, _ = github_api(repo, token, f"/releases/{release_id}", method="DELETE")
    return 200 <= code < 300 or code == 204

def gh_release_set_draft(repo: str, token: str, release_id: int, prerelease: bool) -> bool:
    code, _ = github_api(repo, token, f"/releases/{release_id}", method="PATCH", data={"draft": True, "prerelease": bool(prerelease)})
    return 200 <= code < 300

def git_force_tag(tag: str):
    try:
        run(["git", "fetch", "--tags"], check=False)
        run(["git", "tag", "-f", tag], check=True)
        run(["git", "push", "--force", "origin", tag], check=True)
        print(f"[common] Tag {tag} updated to HEAD")
    except subprocess.CalledProcessError as e:
        print(f"::warning::[common] Failed to update tag {tag}: {e}")

def git_delete_tag(tag: str):
    try:
        run(["git", "fetch", "--tags", "--force", "origin"], check=False)
        run(["git", "push", "origin", f":refs/tags/{tag}"], check=False)
    except subprocess.CalledProcessError:
        print(f"::warning::[common] Failed to delete tag {tag} (it may not exist remotely)")

def npm_available() -> bool:
    try:
        run(["npm", "--version"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, quiet=True)
        return True
    except Exception:
        return False

def npm_read_version() -> str:
    with open("package.json", "r", encoding="utf-8") as f:
        data = json.load(f)
    v = data.get("version", "")
    if not isinstance(v, str) or not v:
        raise RuntimeError("package.json is missing a valid version")
    return v

def npm_set_version_no_git_tag(new_ver: str):
    run(["npm", "version", new_ver, "--no-git-tag-version"])

def npm_pkg_set_version(new_version_no_v: str) -> bool:
    if not os.path.exists("package.json"):
        print("[common] package.json not found; skipping npm version alignment.")
        return False
    if not npm_available():
        print("[common] npm not available; cannot align package versions.")
        return False
    try:
        run(["npm", "pkg", "set", f"version={new_version_no_v}"], check=True)
        run(["npm", "i", "--package-lock-only"], check=False)
        print(f"[common] Updated package.json version -> {new_version_no_v}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"[common] npm version alignment failed: {e}")
        return False