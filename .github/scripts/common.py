#!/usr/bin/env python3
"""
Common helpers reused across workflow scripts.
"""
import json
import os
import shlex
import subprocess
import urllib.request
import urllib.error

from dataclasses import dataclass
from typing import Any, Sequence, Union

def run(
    cmd: Union[str, Sequence[str]],
    *,
    env: dict[str, str] | None = None,
    check: bool = True,
    cwd: str | None = None,
    quiet: bool = False,
    capture: bool = False,
    stdout=None,
    stderr=None,
    text: bool = True,
) -> subprocess.CompletedProcess:
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

def squeeze_blank(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    prev_blank = False
    for l in lines:
        blank = l.strip() == ""
        if blank and prev_blank:
            continue
        out.append(l)
        prev_blank = blank
    return "\n".join(out)

def read_event(path: str | None = None) -> dict:
    event_path = path or os.environ.get("GITHUB_EVENT_PATH") or ""
    if not event_path or not os.path.exists(event_path):
        return {}
    try:
        with open(event_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def github_api(
    repo: str,
    token: str,
    path: str,
    method: str = "GET",
    data: dict | None = None,
) -> tuple[int, dict]:
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

def gh_commit_pulls(repo: str, token: str, sha: str) -> list[dict]:
    url = f"https://api.github.com/repos/{repo}/commits/{sha}/pulls"
    headers = {
        "Accept": "application/vnd.github.groot-preview+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": f"release-manager (+https://github.com/{repo})",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode()
        data = json.loads(raw) if raw.strip() else []
        return data if isinstance(data, list) else []

def gh_list_paginated(
    repo: str,
    token: str,
    base_path: str,
    *,
    per_page: int = 100,
    max_pages: int = 50,
) -> list[dict]:
    out: list[dict] = []
    page = 1
    while page <= max_pages:
        sep = "&" if "?" in base_path else "?"
        path = f"{base_path}{sep}per_page={per_page}&page={page}"
        code, batch = github_api(repo, token, path, method="GET")
        if code != 200 or not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < per_page:
            break
        page += 1
    return out

def gh_release(
    repo: str,
    token: str,
    *,
    release_id: int | None = None,
    tag: str | None = None,
) -> dict | None:
    if release_id is not None and tag is not None:
        raise ValueError("Provide only one of release_id or tag")
    if release_id is not None:
        code, data = github_api(repo, token, f"/releases/{release_id}")
        if code == 404:
            return None
        return data if isinstance(data, dict) else None
    if tag is not None:
        code, data = github_api(repo, token, f"/releases/tags/{tag}")
        if code == 404:
            return None
        return data if isinstance(data, dict) else None
    raise ValueError("release_id or tag is required")

def gh_release_create(
    repo: str,
    token: str,
    tag: str,
    target_commitish: str | None = None,
    draft: bool = True,
    prerelease: bool = False,
    name: str | None = None,
    body: str | None = None,
) -> dict | None:
    payload: dict[str, Any] = {
        "tag_name": tag,
        "draft": bool(draft),
        "prerelease": bool(prerelease),
    }
    if target_commitish:
        payload["target_commitish"] = target_commitish
    if name:
        payload["name"] = name
    if body:
        payload["body"] = body
    code, data = github_api(repo, token, "/releases", method="POST", data=payload)
    if 200 <= code < 300 and isinstance(data, dict):
        return data
    print(f"::warning::Failed to create release {tag}: {code} {data}")
    return None

def gh_release_delete(repo: str, token: str, release_id: int) -> bool:
    code, _ = github_api(repo, token, f"/releases/{release_id}", method="DELETE")
    return 200 <= code < 300 or code == 204

def gh_release_update(
    repo: str,
    token: str,
    release_id: int,
    **fields: Any,
) -> dict | None:
    code, data = github_api(
        repo,
        token,
        f"/releases/{release_id}",
        method="PATCH",
        data=fields or {},
    )
    if 200 <= code < 300 and isinstance(data, dict):
        return data
    return None

def gh_releases(repo: str, token: str, *, max_pages: int = 50) -> list[dict]:
    return gh_list_paginated(repo, token, "/releases", max_pages=max_pages)

def git_checkout_ref(ref: str, *, create_branch_from: str | None = None) -> None:
    if create_branch_from:
        try:
            run(["git", "checkout", "-B", ref, f"origin/{create_branch_from}"], check=True)
            return
        except Exception:
            pass
    run(["git", "checkout", ref], check=False)

def git_checkout_tag(tag: str) -> None:
    run(["git", "fetch", "--tags", "--force", "origin"], check=False)
    cp = run(
        ["git", "-c", "advice.detachedHead=false", "checkout", "-f", f"tags/{tag}"],
        check=False,
    )
    if cp.returncode != 0:
        run(["git", "checkout", "-f", f"refs/tags/{tag}"], check=True)

def git_commit_files(files: Sequence[str], message: str) -> None:
    run(["git", "config", "--local", "user.email", "action@github.com"], check=False)
    run(["git", "config", "--local", "user.name", "GitHub Action"], check=False)
    staged_any = False
    for f in files:
        if os.path.exists(f):
            run(["git", "add", f], check=False)
            staged_any = True
    if not staged_any:
        return
    if run(["git", "diff", "--cached", "--quiet"], check=False).returncode == 0:
        return
    run(["git", "commit", "-m", message], check=False)
    run(["git", "push"], check=False)

def git_delete_tag(tag: str) -> None:
    try:
        run(["git", "fetch", "--tags", "--force", "origin"], check=False)
        run(["git", "push", "origin", f":refs/tags/{tag}"], check=False)
    except subprocess.CalledProcessError:
        print(
            f"::warning::[common] Failed to delete tag {tag} "
            f"(it may not exist remotely)"
        )

def git_fetch(ref: str | None = None, *, depth: int | None = None) -> None:
    args = ["git", "fetch", "origin"]
    if ref:
        args.append(ref)
    if depth is not None:
        args.append(f"--depth={depth}")
    run(args, check=False)

def git_force_tag(tag: str) -> None:
    try:
        run(["git", "fetch", "--tags"], check=False)
        run(["git", "tag", "-f", tag], check=True)
        run(["git", "push", "--force", "origin", tag], check=True)
        print(f"[common] Tag {tag} updated to HEAD")
    except subprocess.CalledProcessError as e:
        print(f"::warning::[common] Failed to update tag {tag}: {e}")

def git_get_commit_author_name(sha: str) -> str:
    proc = run(
        ["git", "show", "-s", "--format=%aN", sha],
        capture=True,
        check=False,
    )
    return proc.stdout.strip() if proc and getattr(proc, "stdout", None) else ""

def git_get_commit_subject(sha: str) -> str:
    proc = run(
        ["git", "show", "-s", "--format=%s", sha],
        capture=True,
        check=False,
    )
    return proc.stdout.strip() if proc and getattr(proc, "stdout", None) else ""

def git_rev_list_range(before: str, after: str) -> list[str]:
    proc = run(
        ["git", "rev-list", "--reverse", f"{before}..{after}"],
        capture=True,
        check=False,
    )
    if not proc or not getattr(proc, "stdout", None):
        return []
    return [s for s in proc.stdout.strip().split() if s]

def npm_available() -> bool:
    try:
        run(
            ["npm", "--version"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            quiet=True,
        )
        return True
    except Exception:
        return False

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

def npm_read_version() -> str:
    with open("package.json", "r", encoding="utf-8") as f:
        data = json.load(f)
    v = data.get("version", "")
    if not isinstance(v, str) or not v:
        raise RuntimeError("package.json is missing a valid version")
    return v

def npm_set_version_no_git_tag(new_ver: str) -> None:
    run(["npm", "version", new_ver, "--no-git-tag-version"])

@dataclass
class Context:
    github_repository: str
    github_token: str
    head_after: str = ""
    head_before: str = ""
    is_beta: bool = False
    issue_number: str = ""
    mode: str = ""
    pull_request_author: str = ""
    pull_request_branch: str = ""
    pull_request_labels: str = ""
    pull_request_number: str = ""
    pull_request_title: str = ""
    tag: str = ""
    target_branch: str = ""