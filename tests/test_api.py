"""End-to-end API tests: a real git repo, a real SQLite database, real scans."""

import os
import shutil
import subprocess
from pathlib import Path

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from aftershock.api.app import create_app
from aftershock.api.jobs import work
from aftershock.api.models import Base, Snapshot
from aftershock.api.settings import Settings

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "shop_api"


def api_client(app) -> TestClient:
    """A client whose paths start at /api, where the API lives."""
    return TestClient(app, base_url="http://testserver/api")


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=repo, check=True,
                   capture_output=True)


@pytest.fixture
def shop_repo(tmp_path) -> Path:
    """The example app as a git repo with two branches: main, and `feature` which
    changes pricing and deletes list_orders (still used by a route)."""
    repo = tmp_path / "shop"
    shutil.copytree(EXAMPLE, repo, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    git(repo, "init", "-q", "-b", "main")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")
    git(repo, "checkout", "-qb", "feature")
    pricing = repo / "app/services/pricing.py"
    pricing.write_text(pricing.read_text().replace("), 2)", "), 1)"))
    orders = repo / "app/services/orders.py"
    orders.write_text(orders.read_text().split("\n\ndef list_orders")[0] + "\n")
    git(repo, "commit", "-qam", "feature")
    git(repo, "checkout", "-q", "main")
    return repo


@pytest.fixture
def settings(tmp_path) -> Settings:
    """SQLite by default. Set TEST_DATABASE_URL to run the same tests on PostgreSQL:
    TEST_DATABASE_URL=postgresql+psycopg://user@localhost/aftershock pytest tests/test_api.py"""
    url = os.getenv("TEST_DATABASE_URL")
    if url:
        engine = create_engine(url)
        Base.metadata.drop_all(engine)          # every test starts from empty tables
        engine.dispose()
    else:
        url = f"sqlite:///{tmp_path}/test.db"
    return Settings(database_url=url, redis_url="", data_dir=tmp_path / "data")


@pytest.fixture
def client(settings) -> TestClient:
    return api_client(create_app(settings))


def scan(client: TestClient, repo_id: int, ref: str) -> dict:
    r = client.post(f"/repos/{repo_id}/scan", json={"ref": ref})
    assert r.status_code == 202, r.text
    snap = client.get(f"/snapshots/{r.json()['snapshot']['id']}").json()
    assert snap["status"] == "ready", snap
    return snap


def test_full_flow(client, shop_repo):
    repo = client.post("/repos", json={"url": str(shop_repo), "default_branch": "main"})
    assert repo.status_code == 201, repo.text
    repo_id = repo.json()["id"]
    assert repo.json()["name"] == "shop"

    main = scan(client, repo_id, "main")
    assert len(main["commit_sha"]) == 40 and main["symbol_count"] > 30

    # search
    found = client.get(f"/snapshots/{main['id']}/symbols", params={"q": "decode_token"}).json()
    assert found[0]["name"] == "app.auth.decode_token"

    # by symbol name
    r = client.post(f"/snapshots/{main['id']}/blast-radius", json={"targets": ["decode_token"]})
    assert r.status_code == 200, r.text
    report = r.json()["report"]
    assert report["summary"]["routes"] == 3
    assert {s["name"] for s in report["affected"]} >= {"app.routes.users.me", "app.routes.orders.place_order"}

    # by comparing the feature branch with main, like a pull request
    feature = scan(client, repo_id, "feature")
    r = client.post(f"/snapshots/{feature['id']}/blast-radius", json={"base": "main"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["risk_level"] == "high"
    assert body["report"]["changed"][0]["name"] == "app.services.pricing.apply_discount"
    assert body["report"]["deleted"][0]["still_called_by"] == ["app.routes.orders.my_orders"]

    # saved reports can be fetched again, in any format
    md = client.get(f"/analyses/{body['id']}", params={"format": "markdown"})
    assert md.status_code == 200 and md.text.startswith("### ") and "Will break" in md.text
    assert client.get(f"/analyses/{body['id']}").json()["risk_score"] == body["risk_score"]

    # by pasted diff text
    diff = subprocess.run(["git", "diff", "--unified=0", "main", "feature"], cwd=shop_repo,
                          capture_output=True, text=True, check=True).stdout
    r = client.post(f"/snapshots/{feature['id']}/blast-radius", json={"diff": diff})
    assert r.json()["report"]["changed"][0]["name"] == "app.services.pricing.apply_discount"

    # graph for the UI
    g = client.get(f"/snapshots/{main['id']}/graph", params={"focus": "current_user", "depth": 1}).json()
    ids = {n["id"] for n in g["nodes"]}
    assert {"app.auth.current_user", "app.auth.decode_token", "app.routes.users.me"} <= ids
    assert all(e["confidence"] == "static" for e in g["edges"])
    modules = client.get(f"/snapshots/{main['id']}/graph").json()
    assert all(n["kind"] == "module" for n in modules["nodes"])

    # repo detail lists both snapshots, newest first
    detail = client.get(f"/repos/{repo_id}").json()
    assert [s["ref"] for s in detail["snapshots"]] == ["feature", "main"]


def test_plain_folder_is_scanned_in_place(client, tmp_path):
    folder = tmp_path / "plain"
    shutil.copytree(EXAMPLE, folder, ignore=shutil.ignore_patterns("__pycache__"))
    repo_id = client.post("/repos", json={"url": str(folder)}).json()["id"]
    snap = scan(client, repo_id, "HEAD")
    assert snap["commit_sha"] == "working-tree"
    r = client.post(f"/snapshots/{snap['id']}/blast-radius", json={"base": "main"})
    assert r.status_code == 422 and r.json()["detail"][0]["loc"] == ["body", "base"]   # no git history


def test_subdir_scanning(client, tmp_path):
    mono = tmp_path / "mono"
    shutil.copytree(EXAMPLE, mono / "backend", ignore=shutil.ignore_patterns("__pycache__"))
    git(mono, "init", "-q")
    git(mono, "add", ".")
    git(mono, "commit", "-qm", "init")
    repo_id = client.post("/repos", json={"url": str(mono), "subdir": "backend"}).json()["id"]
    snap = scan(client, repo_id, "HEAD")
    found = client.get(f"/snapshots/{snap['id']}/symbols", params={"q": "create_token"}).json()
    assert found[0]["name"] == "app.auth.create_token"     # module names start inside backend/


def test_validation_errors(client, shop_repo, settings):
    bad_url = client.post("/repos", json={"url": "http://example.com/x.git"})
    assert bad_url.status_code == 422 and bad_url.json()["detail"][0]["loc"] == ["body", "url"]
    assert client.post("/repos", json={"url": "ext::sh -c touch% /tmp/pwned"}).status_code == 422
    bad_sub = client.post("/repos", json={"url": str(shop_repo), "subdir": "../etc"})
    assert bad_sub.json()["detail"][0]["loc"] == ["body", "subdir"]

    repo_id = client.post("/repos", json={"url": str(shop_repo)}).json()["id"]
    assert client.post(f"/repos/{repo_id}/scan", json={"ref": "--upload-pack=evil"}).status_code == 422
    assert client.get("/snapshots/999").status_code == 404
    assert client.get("/repos/999").status_code == 404

    r = client.post(f"/repos/{repo_id}/scan", json={"ref": "no-such-branch"})
    failed = client.get(f"/snapshots/{r.json()['snapshot']['id']}").json()
    assert failed["status"] == "failed" and failed["error"]
    assert client.post(f"/snapshots/{failed['id']}/blast-radius", json={"targets": ["x"]}).status_code == 409

    main = scan(client, repo_id, "main")
    bad = client.post(f"/snapshots/{main['id']}/blast-radius", json={"targets": ["x"], "diff": "y"})
    assert bad.status_code == 422                   # exactly one input allowed
    assert client.post(f"/snapshots/{main['id']}/blast-radius", json={"targets": ["nope"]}).status_code == 404


def test_local_paths_can_be_turned_off(tmp_path, shop_repo, settings):
    settings = Settings(database_url=settings.database_url, data_dir=tmp_path / "d", allow_local_paths=False)
    client = api_client(create_app(settings))
    assert client.post("/repos", json={"url": str(shop_repo)}).status_code == 422


def test_redis_queue_and_worker(settings, shop_repo):
    fake = fakeredis.FakeRedis(decode_responses=True)
    app = create_app(settings, redis_client=fake)
    client = api_client(app)

    repo_id = client.post("/repos", json={"url": str(shop_repo)}).json()["id"]
    r = client.post(f"/repos/{repo_id}/scan", json={"ref": "main"})
    assert r.json()["queue"] == "redis"
    snap_id = r.json()["snapshot"]["id"]
    assert client.get(f"/snapshots/{snap_id}").json()["status"] == "queued"   # nothing ran it yet

    assert work(settings, fake, app.state.session_factory, stop_after=1) == 1
    assert client.get(f"/snapshots/{snap_id}").json()["status"] == "ready"

    # first query loads the graph from the database and stores it in Redis;
    # a fresh API process then gets it from Redis instead of the database
    client.post(f"/snapshots/{snap_id}/blast-radius", json={"targets": ["decode_token"]})
    assert app.state.cache.hits["database"] == 1
    second = create_app(settings, redis_client=fake)
    api_client(second).post(f"/snapshots/{snap_id}/blast-radius", json={"targets": ["decode_token"]})
    assert second.state.cache.hits == {"memory": 0, "redis": 1, "database": 0}


def test_snapshot_not_ready_is_409(client, shop_repo):
    repo_id = client.post("/repos", json={"url": str(shop_repo)}).json()["id"]
    with client.app.state.session_factory() as db:
        snap = Snapshot(repo_id=repo_id, ref="main", status="scanning")
        db.add(snap)
        db.commit()
        snap_id = snap.id
    r = client.get(f"/snapshots/{snap_id}/symbols")
    assert r.status_code == 409 and "scanning" in r.json()["detail"]


def test_dynamic_scan_finds_hidden_dependency(client, shop_repo):
    repo_id = client.post("/repos", json={"url": str(shop_repo), "default_branch": "main"}).json()["id"]
    r = client.post(f"/repos/{repo_id}/scan", json={"ref": "main", "dynamic": True})
    snap = client.get(f"/snapshots/{r.json()['snapshot']['id']}").json()
    assert snap["status"] == "ready" and snap["has_dynamic"], snap
    assert snap["error"] is None

    report = client.post(f"/snapshots/{snap['id']}/blast-radius", json={"targets": ["send_receipt"]}).json()["report"]
    assert report["hidden_dependencies"] == [
        "app.services.hooks.run_hook", "app.services.orders.create_order", "app.routes.orders.place_order",
    ]
    assert report["changed"][0]["reached_by_tests"]          # a test runs it, the tracer saw that
    assert report["summary"]["routes"] == 1
    # the tracer also records where the hidden call happens: `hook(order)` in run_hook
    run_hook = next(s for s in report["affected"] if s["name"] == "app.services.hooks.run_hook")
    assert run_hook["call_line"] == 16
    stats = client.get(f"/snapshots/{snap['id']}/stats").json()
    assert stats["runtime_only"] == 1 and stats["confirmed"] > 0
    assert client.get(f"/snapshots/{snap['id']}").json()["edge_count"] == stats["links"]

    # an edge the scanner also found is now confirmed by the runtime
    g = client.get(f"/snapshots/{snap['id']}/graph", params={"focus": "create_order", "depth": 1}).json()
    conf = {(e["source"], e["target"]): e["confidence"] for e in g["edges"]}
    assert conf[("app.services.orders.create_order", "app.services.hooks.run_hook")] == "both"


def test_tracing_can_be_turned_off(tmp_path, shop_repo, settings):
    off = Settings(database_url=settings.database_url, data_dir=tmp_path / "d2", allow_tracing=False)
    client = api_client(create_app(off))
    repo_id = client.post("/repos", json={"url": str(shop_repo)}).json()["id"]
    r = client.post(f"/repos/{repo_id}/scan", json={"ref": "main", "dynamic": True})
    snap = client.get(f"/snapshots/{r.json()['snapshot']['id']}").json()
    assert snap["status"] == "ready" and not snap["has_dynamic"]
    assert "ALLOW_TRACING" in snap["error"]                   # static results, with the reason shown


def test_folder_inside_a_git_repo_is_scanned_in_place(client, tmp_path):
    # regression: it used to try to clone the sub-folder as if it were a repo
    outer = tmp_path / "project"
    shutil.copytree(EXAMPLE, outer / "examples" / "shop_api", ignore=shutil.ignore_patterns("__pycache__"))
    git(outer, "init", "-q")
    git(outer, "add", ".")
    git(outer, "commit", "-qm", "init")
    repo_id = client.post("/repos", json={"url": str(outer / "examples" / "shop_api")}).json()["id"]
    snap = scan(client, repo_id, "HEAD")
    assert snap["commit_sha"] == "working-tree"


def test_stats_source_and_diff_for_the_ui(client, shop_repo):
    repo_id = client.post("/repos", json={"url": str(shop_repo), "default_branch": "main"}).json()["id"]
    main = scan(client, repo_id, "main")
    feature = scan(client, repo_id, "feature")

    # the repository list carries each repo's scans
    listed = client.get("/repos").json()
    assert [s["ref"] for s in listed[0]["snapshots"]] == ["feature", "main"]

    stats = client.get(f"/snapshots/{main['id']}/stats").json()
    assert (stats["files"], stats["routes"], stats["tests"]) == (14, 4, 3)
    assert stats["read_from_code"] == stats["links"] and stats["runtime_only"] == 0
    assert main["edge_count"] == stats["links"]          # a snapshot counts links, not rows

    # routes carry their method and path, everywhere a symbol appears
    hits = client.get(f"/snapshots/{main['id']}/symbols", params={"q": "place_order"}).json()
    assert hits[0]["route"] == "POST /orders/"

    # a few lines of the exact commit
    src = client.get(f"/snapshots/{main['id']}/source",
                     params={"path": "app/services/pricing.py", "start": 8, "end": 9}).json()
    assert src["lines"] == ["def apply_discount(amount: float) -> float:",
                            "    return round(amount * (1 - settings.discount_rate), 2)"]
    for bad in ("../../etc/passwd.py", "/etc/hosts", "app/../../x.py", "README.md"):
        assert client.get(f"/snapshots/{main['id']}/source", params={"path": bad}).status_code == 400
    assert client.get(f"/snapshots/{main['id']}/source", params={"path": "nope.py"}).status_code == 404

    # a branch comparison: call sites and the diff behind it
    body = client.post(f"/snapshots/{feature['id']}/blast-radius", json={"base": "main"}).json()
    site = body["report"]["deleted"][0]["call_sites"][0]
    assert site == {"caller": "app.routes.orders.my_orders", "file_path": "app/routes/orders.py", "line": 15}
    my_orders = next(s for s in body["report"]["affected"] if s["name"] == "app.routes.orders.my_orders")
    assert (my_orders["route"], my_orders["call_line"]) == ("GET /orders/", 15)
    diff = client.get(f"/analyses/{body['id']}/diff")
    assert diff.status_code == 200
    assert "-def list_orders(user_id: int) -> list[dict]:" in diff.text
    assert "+    return round(amount * (1 - settings.discount_rate), 1)" in diff.text

    by_name = client.post(f"/snapshots/{main['id']}/blast-radius", json={"targets": ["send_receipt"]}).json()
    assert client.get(f"/analyses/{by_name['id']}/diff").status_code == 404


def test_a_database_from_an_older_version_gets_the_new_column(tmp_path):
    from sqlalchemy import inspect, text

    from aftershock.api.models import make_session_factory
    url = f"sqlite:///{tmp_path}/old.db"
    engine = create_engine(url)
    with engine.begin() as conn:     # the symbols table as version 1.0 made it
        conn.execute(text("CREATE TABLE symbols (id INTEGER PRIMARY KEY, snapshot_id INTEGER, qualified_name "
                          "VARCHAR(1000), kind VARCHAR(20), module VARCHAR(1000), file_path VARCHAR(1000), "
                          "start_line INTEGER, end_line INTEGER, is_test BOOLEAN)"))
    make_session_factory(url)
    assert "route" in {c["name"] for c in inspect(create_engine(url)).get_columns("symbols")}
    make_session_factory(url)        # and running it again changes nothing


def test_tests_that_cannot_even_load_give_no_runtime_data(client, shop_repo):
    # on `feature`, a route still imports the deleted list_orders, so pytest cannot load the tests
    repo_id = client.post("/repos", json={"url": str(shop_repo)}).json()["id"]
    r = client.post(f"/repos/{repo_id}/scan", json={"ref": "feature", "dynamic": True})
    snap = client.get(f"/snapshots/{r.json()['snapshot']['id']}").json()
    assert snap["status"] == "ready" and not snap["has_dynamic"]
    assert snap["error"].startswith("No test could run")


def test_one_server_for_the_app_and_the_api(tmp_path, settings):
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><div id=root></div>")
    (web / "assets" / "index-abc123.js").write_text("console.log('app')")
    (web / "favicon.svg").write_text("<svg/>")
    from dataclasses import replace
    site = TestClient(create_app(replace(settings, ui_dir=web)))

    # the API keeps working under /api, docs included
    assert site.get("/api/health").json()["ok"] is True
    assert site.get("/api/repos").json() == []
    assert site.get("/api/openapi.json").json()["info"]["title"] == "Aftershock API"
    assert site.get("/api/docs").status_code == 200

    # every other address is the app: the browser's router decides what to show
    for path in ("/", "/repos/1", "/snapshots/2?base=main"):
        r = site.get(path)
        assert r.status_code == 200 and "<div id=root>" in r.text and r.headers["cache-control"] == "no-cache"
    js = site.get("/assets/index-abc123.js")
    assert js.text == "console.log('app')" and "immutable" in js.headers["cache-control"]
    assert site.get("/favicon.svg").text == "<svg/>"

    # a wrong API address is a 404, not the app; and nothing outside the build is served
    assert site.get("/api/nope").status_code == 404
    (tmp_path / "secret.txt").write_text("SECRET")
    for sneaky in ("/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/%2e%2e/%2e%2e/secret.txt"):
        assert "SECRET" not in site.get(sneaky).text


def test_without_a_build_the_root_says_how_to_make_one(tmp_path, settings):
    from dataclasses import replace
    site = TestClient(create_app(replace(settings, ui_dir=tmp_path / "missing")))
    r = site.get("/")
    assert r.status_code == 200 and "npm run build" in r.text
    assert site.get("/api/health").status_code == 200


def test_files_from_the_old_name_are_kept(tmp_path, monkeypatch):
    from aftershock.cli import carry_over_old_files

    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("DATA_DIR", raising=False)
    (tmp_path / "blast_radius.db").write_text("db")
    (tmp_path / ".blast-radius-data").mkdir()
    carry_over_old_files()
    assert (tmp_path / "aftershock.db").read_text() == "db"
    assert (tmp_path / ".aftershock-data").is_dir() and not (tmp_path / ".blast-radius-data").exists()


def test_demo_sets_up_and_scans_the_examples(tmp_path):
    from aftershock.api.demo import seed_demo

    settings = Settings(database_url=f"sqlite:///{tmp_path}/demo.db", redis_url="", data_dir=tmp_path / "data",
                        demo=True, allow_local_paths=False, allow_tracing=False)
    app = create_app(settings)
    ids = seed_demo(app.state.session_factory, settings, wait=True)
    assert len(ids) == 4                                   # two examples, two branches each
    assert seed_demo(app.state.session_factory, settings) == []     # only into an empty database
    client = api_client(app)

    assert client.get("/health").json()["demo"] is True
    repos = {r["name"]: r for r in client.get("/repos").json()}
    assert set(repos) == {"shop-api", "shop-js"}
    api = {s["ref"]: s for s in repos["shop-api"]["snapshots"]}
    # the examples' tests run even though tracing is off for everything else
    assert api["main"]["status"] == "ready" and api["main"]["has_dynamic"], api["main"]
    assert {s["status"] for s in repos["shop-js"]["snapshots"]} == {"ready"}

    report = client.post(f"/snapshots/{api['feature']['id']}/blast-radius", json={"base": "main"}).json()["report"]
    assert report["deleted"][0]["name"] == "app.services.orders.list_orders"
    assert report["risk"]["level"] == "high"

    assert client.delete(f"/repos/{repos['shop-api']['id']}").status_code == 403
    # a visitor's own repository is read from the code only
    mine = client.post("/repos", json={"url": str(tmp_path)}).status_code
    assert mine == 422                                     # folders on the server are not allowed
