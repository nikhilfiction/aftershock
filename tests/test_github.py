"""The pull request comment, against a small fake of the GitHub API."""

import json
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from aftershock.cli import main
from aftershock.github import MARKER, GitHubError, publish, upsert_comment

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "shop_api"


class FakeGitHub:
    """Stores comments in memory and answers the three endpoints we use."""

    def __init__(self, status: int = 200):
        self.comments: list[dict] = [{"id": 1, "body": "Looks good to me"}]
        self.requests: list[tuple[str, str]] = []
        self.status = status
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, code, payload):
                raw = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _body(self):
                return json.loads(self.rfile.read(int(self.headers["Content-Length"])))

            def do_GET(self):
                fake.requests.append(("GET", self.path))
                if fake.status != 200:
                    return self._send(fake.status, {"message": "Resource not accessible by integration"})
                self._send(200, fake.comments if "page=1" in self.path else [])

            def do_POST(self):
                fake.requests.append(("POST", self.path))
                assert self.headers["Authorization"] == "Bearer t0ken"
                comment = {"id": len(fake.comments) + 1, "body": self._body()["body"]}
                fake.comments.append(comment)
                self._send(201, comment)

            def do_PATCH(self):
                fake.requests.append(("PATCH", self.path))
                cid = int(self.path.rsplit("/", 1)[1])
                comment = next(c for c in fake.comments if c["id"] == cid)
                comment["body"] = self._body()["body"]
                self._send(200, comment)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture
def github():
    fake = FakeGitHub()
    yield fake
    fake.close()


def test_creates_then_updates_one_comment(github):
    assert upsert_comment("acme/shop", 12, "### first", "t0ken", github.url) == "created"
    assert upsert_comment("acme/shop", 12, "### second", "t0ken", github.url) == "updated"
    ours = [c for c in github.comments if MARKER in c["body"]]
    assert len(ours) == 1 and ours[0]["body"].endswith("### second")
    assert github.comments[0]["body"] == "Looks good to me"          # other people's comments untouched


def test_permission_error_explains_the_fix():
    fake = FakeGitHub(status=403)
    try:
        with pytest.raises(GitHubError, match="pull-requests: write"):
            upsert_comment("acme/shop", 12, "x", "t0ken", fake.url)
    finally:
        fake.close()


def test_publish_outside_a_pull_request_only_writes_the_summary(tmp_path, monkeypatch):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    for name in ("GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_EVENT_PATH"):
        monkeypatch.delenv(name, raising=False)
    status = publish("### report")
    assert summary.read_text() == "### report\n"
    assert "skipped the PR comment" in status


def test_cli_diff_posts_to_the_pull_request(tmp_path, monkeypatch, github, capsys):
    repo = tmp_path / "shop"
    shutil.copytree(EXAMPLE, repo, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    run = lambda *a: subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], cwd=repo,
                                    check=True, capture_output=True)
    run("init", "-q", "-b", "main")
    run("add", ".")
    run("commit", "-qm", "init")
    run("checkout", "-qb", "feature")
    auth = repo / "app/auth.py"
    auth.write_text(auth.read_text().replace('"bad token"', '"invalid token"'))
    run("commit", "-qam", "change")

    event = tmp_path / "event.json"
    event.write_text(json.dumps({"pull_request": {"number": 42}}))
    monkeypatch.setenv("GITHUB_TOKEN", "t0ken")
    monkeypatch.setenv("GITHUB_REPOSITORY", "acme/shop")
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
    monkeypatch.setenv("GITHUB_API_URL", github.url)
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "summary.md"))

    code = main(["diff", str(repo), "--base", "main...HEAD", "--github", "--fail-above", "90"])
    assert code == 0
    assert ("POST", "/repos/acme/shop/issues/42/comments") in github.requests
    posted = github.comments[-1]["body"]
    assert posted.startswith(MARKER) and "decode_token" in posted
    assert "created the comment on PR #42" in capsys.readouterr().err
    assert "Blast radius" in (tmp_path / "summary.md").read_text()
