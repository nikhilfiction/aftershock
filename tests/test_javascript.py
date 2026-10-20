"""JavaScript and TypeScript: the Node scanner, diffs, test commands, tracing and the API."""

import shutil
from pathlib import Path

import pytest

from aftershock.analysis import analyze, command_for_tests
from aftershock.diff import changes_between, changes_from_text
from aftershock.graph import build_graph
from aftershock.javascript import JsError, js_module_name, js_symbols_of
from aftershock.project import scan_project
from tests.conftest import needs_node
from tests.test_api import api_client, git

pytestmark = needs_node

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "shop_js"


def write(root: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def links(result, kind=None) -> set[tuple[str, str]]:
    return {(e.source, e.target) for e in result.edges if kind is None or e.kind == kind}


@pytest.fixture(scope="module")
def shop():
    return scan_project(EXAMPLE)


# ---------------------------------------------------------------- the scanner

def test_names_follow_the_python_style():
    assert js_module_name("src/services/orders.ts") == "src.services.orders"
    assert js_module_name("src/orders/orders.service.ts") == "src.orders.orders_service"


def test_example_symbols_routes_and_tests(shop):
    s = shop.symbols
    assert s["src.services.orders.createOrder"].kind == "function"
    assert s["src.services.pricing.orderTotal"].kind == "function"          # const orderTotal = (...) =>
    assert s["src.db.OrderStore.insert"].kind == "method"
    assert s["src.db.store"].kind == "variable"
    assert s["src.routes.orders.POST /orders"].route == "POST /orders"
    assert s["src.routes.users.GET /users/me"].kind == "route"
    test = s["tests.shop_test.orders > lists only my orders"]
    assert test.is_test and test.test_name == "orders lists only my orders"
    assert (test.start_line, test.end_line) == (44, 49)
    assert shop.meta["languages"] == ["typescript"] and shop.meta["test_runner"] == "vitest"


def test_example_links(shop):
    calls = links(shop, "calls")
    # a method call on an object whose type is a class in another file
    assert ("src.services.orders.createOrder", "src.db.OrderStore.insert") in calls
    # an inline route handler belongs to the route
    assert ("src.routes.orders.POST /orders", "src.services.orders.createOrder") in calls
    # a named handler is used by its route
    assert ("src.routes.users.GET /users/me", "src.routes.users.me") in links(shop, "references")
    assert ("src.services.pricing.orderTotal", "src.services.pricing.applyDiscount") in calls
    assert ("src.routes.orders", "src.services.orders") in links(shop, "imports")
    # the event bus hides this one from the code
    assert ("src.services.orders.createOrder", "src.services.hooks.sendReceipt") not in links(shop)


def test_frameworks_and_module_styles(tmp_path):
    write(tmp_path, {
        "package.json": '{"devDependencies": {"jest": "30"}}',
        "src/orders/orders.controller.ts": (
            "import { OrdersService } from './orders.service';\n"
            "@Controller('orders')\n"
            "export class OrdersController {\n"
            "  constructor(private readonly service: OrdersService) {}\n"
            "  @Get(':id')\n"
            "  findOne(id: string) { return this.service.find(id); }\n"
            "}\n"),
        "src/orders/orders.service.ts": (
            "export class Base { log() {} }\n"
            "export class OrdersService extends Base {\n"
            "  find(id: string) { this.log(); return helpers.format(id); }\n"
            "}\n"
            "export const helpers = {\n"
            "  format(id: string) { return `#${id}`; },\n"
            "  upper: (s: string) => s.toUpperCase(),\n"
            "};\n"),
        "app/api/orders/[id]/route.ts": (
            "import { OrdersService } from '../../../../src/orders/orders.service';\n"
            "export async function GET() { return new OrdersService().find('1'); }\n"),
        "lib/legacy.js": (
            "const { format } = require('./util');\n"
            "exports.render = function (x) { return format(x); };\n"),
        "lib/util.js": "function format(x) { return String(x); }\nmodule.exports = { format };\n",
        "server.js": (
            "const fastify = require('fastify')();\n"
            "const { render } = require('./lib/legacy');\n"
            "fastify.route({ method: 'POST', url: '/render', handler: (req) => render(req.body) });\n"),
    })
    result = scan_project(tmp_path)
    s = result.symbols
    assert s["src.orders.orders_controller.OrdersController.findOne"].route == "GET /orders/:id"
    assert s["app.api.orders.[id].route.GET"].route == "GET /api/orders/[id]"
    assert s["server.POST /render"].route == "POST /render"
    assert s["src.orders.orders_service.helpers.format"].kind == "method"
    calls = links(result, "calls")
    assert ("src.orders.orders_controller.OrdersController.findOne", "src.orders.orders_service.OrdersService.find") in calls
    assert ("src.orders.orders_service.OrdersService.find", "src.orders.orders_service.Base.log") in calls
    assert ("src.orders.orders_service.OrdersService.find", "src.orders.orders_service.helpers.format") in calls
    assert ("lib.legacy.render", "lib.util.format") in calls                  # CommonJS require
    assert ("server.POST /render", "lib.legacy.render") in calls
    assert ("src.orders.orders_service.OrdersService", "src.orders.orders_service.Base") in links(result, "inherits")
    assert result.meta["languages"] == ["typescript", "javascript"] and result.meta["test_runner"] == "jest"


def test_python_and_typescript_in_one_project(tmp_path):
    write(tmp_path, {
        "api/app.py": "def health():\n    return 'ok'\n",
        "web/src/client.ts": "export function load() { return fetch('/health'); }\n",
    })
    result = scan_project(tmp_path)
    assert {"api.app.health", "web.src.client.load"} <= set(result.symbols)
    assert result.meta["languages"] == ["python", "typescript"]


def test_without_node_python_still_scans(tmp_path, monkeypatch):
    write(tmp_path, {"app.py": "def a():\n    pass\n", "web/x.ts": "export const y = 1;\n"})
    monkeypatch.setattr("aftershock.javascript.shutil.which", lambda name: None)
    result = scan_project(tmp_path)
    assert "app.a" in result.symbols and "web.x.y" not in result.symbols
    assert "needs Node.js" in result.meta["warnings"][0]
    (tmp_path / "app.py").unlink()
    with pytest.raises(JsError):
        scan_project(tmp_path)


# ---------------------------------------------------------------- diffs and test commands

@pytest.fixture
def shop_git(tmp_path) -> Path:
    """The TypeScript example as a git repo; `feature` deletes listOrders (still
    used by GET /orders) and changes how prices round."""
    repo = tmp_path / "shop-js"
    shutil.copytree(EXAMPLE, repo, ignore=shutil.ignore_patterns("node_modules", ".aftershock-trace.json"))
    git(repo, "init", "-q", "-b", "main")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")
    git(repo, "checkout", "-qb", "feature")
    orders = repo / "src/services/orders.ts"
    orders.write_text(orders.read_text().split("\nexport function listOrders")[0])
    pricing = repo / "src/services/pricing.ts"
    pricing.write_text(pricing.read_text().replace("* 100) / 100", "* 10) / 10"))
    git(repo, "commit", "-qam", "feature")
    return repo


def test_branch_that_deletes_a_used_function(shop_git):
    result = scan_project(shop_git)
    changes = changes_between(shop_git, "main", "feature", result)
    assert changes.changed == ["src.services.pricing.applyDiscount"]
    assert [d.qualified_name for d in changes.deleted] == ["src.services.orders.listOrders"]
    a = analyze(build_graph(result), changes.changed, 3, changes.deleted, result)
    assert a.risk.level == "high"
    assert a.deleted[0].still_called_by == ["src.routes.orders.GET /orders"]
    assert a.deleted[0].call_sites[0].line == 13
    assert {s.route for s in a.routes} == {"GET /orders", "POST /orders"}
    assert a.tests_to_run == ["tests/shop.test.ts::pricing applies the discount"]
    assert a.test_command == "npx vitest run tests/shop.test.ts -t '^(pricing applies the discount)$'"


def test_pasted_diff_finds_deleted_functions_by_their_lines(shop):
    diff = (
        "diff --git a/src/services/orders.ts b/src/services/orders.ts\n"
        "--- a/src/services/orders.ts\n+++ b/src/services/orders.ts\n"
        "@@ -11,3 +10,0 @@\n"
        "-export function listOrdersOld(userId: number): Order[] {\n"
        "-  return store.forUser(userId);\n"
        "-}\n"
    )
    changes = changes_from_text(diff, shop)
    assert [d.qualified_name for d in changes.deleted] == ["src.services.orders.listOrdersOld"]


def test_old_file_versions_are_read_without_the_project():
    old = js_symbols_of({"src/a.ts": "export function gone() {}\nexport class Kept { run() {} }\n"})
    assert [s.qualified_name for s in old["src/a.ts"]] == ["src.a", "src.a.gone", "src.a.Kept", "src.a.Kept.run"]


def test_test_commands_per_runner():
    tests = ["tests/test_a.py::test_x", "web/a.test.ts::cart adds (v1.2)", "web/b.test.ts::cart empties"]
    assert command_for_tests(tests, "vitest").splitlines() == [
        "pytest tests/test_a.py::test_x",
        "npx vitest run web/a.test.ts web/b.test.ts -t '^(cart adds \\(v1\\.2\\)|cart empties)$'",
    ]
    assert command_for_tests(tests[2:], "jest") == "npx jest web/b.test.ts -t '^(cart empties)$'"
    assert command_for_tests(tests[2:], "node") == "node --test web/b.test.ts"


# ---------------------------------------------------------------- tracing (needs the example's node_modules)

needs_install = pytest.mark.skipif(not (EXAMPLE / "node_modules").is_dir(),
                                   reason="run `npm ci` in examples/shop_js first")


@needs_install
def test_tracing_finds_the_hidden_listener(tmp_path):
    from aftershock.project import trace_project
    from aftershock.tracing import merge_trace

    outcome = trace_project(EXAMPLE, tmp_path / "trace.json", install=False)
    assert outcome.problems == []
    trace = outcome.trace
    assert trace["tests_run"] == 3 and trace["tests_failed"] == 0
    pairs = {(a, b) for a, b, *_ in trace["edges"]}
    assert ("src.services.orders.createOrder", "src.services.hooks.sendReceipt") in pairs
    # a request the test sent over HTTP is credited to the test
    assert ("tests.shop_test.orders > sends a receipt when an order is placed", "src.routes.orders.POST /orders") in pairs

    result = scan_project(EXAMPLE)
    merge_trace(result, trace)
    a = analyze(build_graph(result), ["src.services.hooks.sendReceipt"], 3)
    assert a.hidden_dependencies == ["src.services.orders.createOrder", "src.routes.orders.POST /orders"]
    assert "tests/shop.test.ts::orders sends a receipt when an order is placed" in a.tests_to_run
    # the original files were not touched
    assert "__aftershockRun" not in (EXAMPLE / "src/services/orders.ts").read_text()


@needs_install
def test_api_scans_and_traces_a_typescript_folder(tmp_path):
    from aftershock.api.app import create_app
    from aftershock.api.settings import Settings

    settings = Settings(database_url=f"sqlite:///{tmp_path}/t.db", redis_url="", data_dir=tmp_path / "data")
    client = api_client(create_app(settings))
    repo_id = client.post("/repos", json={"url": str(EXAMPLE)}).json()["id"]
    snap = client.post(f"/repos/{repo_id}/scan", json={"dynamic": True}).json()["snapshot"]
    snap = client.get(f"/snapshots/{snap['id']}").json()
    assert snap["status"] == "ready" and snap["has_dynamic"], snap
    assert snap["languages"] == ["typescript"] and snap["test_runner"] == "vitest"

    stats = client.get(f"/snapshots/{snap['id']}/stats").json()
    assert stats["routes"] == 4 and stats["tests"] == 3 and stats["runtime_only"] >= 1

    report = client.post(f"/snapshots/{snap['id']}/blast-radius", json={"targets": ["sendReceipt"]}).json()["report"]
    assert report["hidden_dependencies"][0] == "src.services.orders.createOrder"
    assert report["test_command"].startswith("npx vitest run tests/shop.test.ts -t ")

    source = client.get(f"/snapshots/{snap['id']}/source", params={"path": "src/services/hooks.ts", "start": 6, "end": 8})
    assert source.json()["lines"][0] == "export function sendReceipt(order: Order): void {"
    assert client.get(f"/snapshots/{snap['id']}/source", params={"path": "package.json"}).status_code == 400


def test_cli_on_typescript(capsys):
    from aftershock.cli import main

    assert main(["callers", str(EXAMPLE), "applyDiscount"]) == 0
    out = capsys.readouterr().out
    assert "src.routes.orders.POST /orders [POST /orders]" in out
    assert "npx vitest run tests/shop.test.ts" in out

