"""Posting the report on a GitHub pull request.

Inside GitHub Actions, GitHub provides:
    GITHUB_TOKEN          (passed in by the workflow)  permission to comment
    GITHUB_REPOSITORY     "owner/name"
    GITHUB_EVENT_PATH     a JSON file describing the event, incl. the PR number
    GITHUB_API_URL        https://api.github.com (or a GitHub Enterprise URL)
    GITHUB_STEP_SUMMARY   a file whose Markdown shows on the workflow run page

The bot keeps ONE comment per pull request: it finds its earlier comment by a
hidden marker and edits it, so each push updates the report instead of
adding another comment.
"""

import json
import os
import urllib.error
import urllib.request

MARKER = "<!-- aftershock-report -->"
MAX_PAGES = 10          # 100 comments per page


class GitHubError(Exception):
    pass


def pr_number_from_event(event_path: str | None) -> int | None:
    if not event_path or not os.path.exists(event_path):
        return None
    with open(event_path) as f:
        event = json.load(f)
    pr = event.get("pull_request") or {}
    return pr.get("number")


def _call(method: str, url: str, token: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "aftershock",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as exc:
        hint = " (does the workflow have `permissions: pull-requests: write`?)" if exc.code in (401, 403) else ""
        raise GitHubError(f"GitHub API {method} {url} failed with {exc.code}{hint}") from exc
    except urllib.error.URLError as exc:
        raise GitHubError(f"Could not reach GitHub: {exc.reason}") from exc


def upsert_comment(repo: str, pr: int, markdown: str, token: str, api: str = "https://api.github.com") -> str:
    """Creates the report comment, or edits the existing one. Returns "created" or "updated"."""
    body = f"{MARKER}\n{markdown}"
    for page in range(1, MAX_PAGES + 1):
        comments = _call("GET", f"{api}/repos/{repo}/issues/{pr}/comments?per_page=100&page={page}", token)
        for c in comments:
            if MARKER in (c.get("body") or ""):
                _call("PATCH", f"{api}/repos/{repo}/issues/comments/{c['id']}", token, {"body": body})
                return "updated"
        if len(comments) < 100:
            break
    _call("POST", f"{api}/repos/{repo}/issues/{pr}/comments", token, {"body": body})
    return "created"


def write_step_summary(markdown: str) -> bool:
    path = os.getenv("GITHUB_STEP_SUMMARY")
    if not path:
        return False
    with open(path, "a") as f:
        f.write(markdown + "\n")
    return True


def publish(markdown: str) -> str:
    """Everything the CLI's --github flag does. Returns a short status line."""
    notes = []
    if write_step_summary(markdown):
        notes.append("wrote the job summary")

    token = os.getenv("GITHUB_TOKEN")
    repo = os.getenv("GITHUB_REPOSITORY")
    pr = pr_number_from_event(os.getenv("GITHUB_EVENT_PATH"))
    if not (token and repo and pr):
        missing = [n for n, v in (("GITHUB_TOKEN", token), ("GITHUB_REPOSITORY", repo), ("a pull_request event", pr)) if not v]
        notes.append(f"skipped the PR comment (missing {', '.join(missing)})")
        return "; ".join(notes)

    action = upsert_comment(repo, pr, markdown, token, os.getenv("GITHUB_API_URL", "https://api.github.com"))
    notes.append(f"{action} the comment on PR #{pr}")
    return "; ".join(notes)
