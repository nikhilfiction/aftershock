"""Reading diffs, mapping them to symbols, and the full git flow."""

import shutil
import subprocess
from pathlib import Path
from textwrap import dedent

from aftershock.analysis import analyze
from aftershock.diff import changes_from_git, changes_from_text, parse_diff
from aftershock.graph import build_graph
from aftershock.scanner import Scanner

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "shop_api"


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=repo, check=True,
                   capture_output=True)


# ---------------------------------------------------------------- parse_diff

def test_parse_modified_line():
    files = parse_diff(dedent("""\
        --- a/app/x.py
        +++ b/app/x.py
        @@ -9 +9 @@ def f():
        -    return 1
        +    return 2
    """))
    assert files["app/x.py"].changed_lines == {9}


def test_parse_pure_deletion_marks_line_above():
    files = parse_diff(dedent("""\
        --- a/app/x.py
        +++ b/app/x.py
        @@ -5 +4,0 @@ def f():
        -    print("debug")
    """))
    assert files["app/x.py"].changed_lines == {4}


def test_parse_deleted_function_is_not_marked_as_a_line_change():
    files = parse_diff(dedent("""\
        --- a/app/x.py
        +++ b/app/x.py
        @@ -11,2 +10,0 @@ def f():
        -def g():
        -    pass
    """))
    change = files["app/x.py"]
    assert change.changed_lines == set()
    assert change.removed_defs == {"g"}


def test_parse_new_and_deleted_files():
    files = parse_diff(dedent("""\
        --- /dev/null
        +++ b/app/new.py
        @@ -0,0 +1,2 @@
        +def fresh():
        +    pass
        --- a/app/old.py
        +++ /dev/null
        @@ -1,2 +0,0 @@
        -def stale():
        -    pass
    """))
    assert files["app/new.py"].is_new and files["app/new.py"].changed_lines == {1, 2}
    assert files["app/old.py"].is_deleted


# ---------------------------------------------------------------- mapping

def test_changed_line_maps_to_the_innermost_symbol(tmp_path):
    (tmp_path / "app").mkdir()
    (tmp_path / "app/x.py").write_text(dedent("""\
        class Repo:
            def find(self):
                return 1
    """))
    result = Scanner(tmp_path).scan()
    diff = "--- a/app/x.py\n+++ b/app/x.py\n@@ -3 +3 @@\n-        return 0\n+        return 1\n"
    assert changes_from_text(diff, result).changed == ["app.x.Repo.find"]


def test_prefix_when_scanning_a_subfolder(tmp_path):
    (tmp_path / "app").mkdir()
    (tmp_path / "app/x.py").write_text("def f():\n    return 1\n")
    result = Scanner(tmp_path).scan()
    diff = "--- a/backend/app/x.py\n+++ b/backend/app/x.py\n@@ -2 +2 @@\n-    return 0\n+    return 1\n"
    assert changes_from_text(diff, result, prefix="backend/").changed == ["app.x.f"]


# ---------------------------------------------------------------- full git flow

def test_git_flow_on_example_app(tmp_path):
    repo = tmp_path / "shop"
    shutil.copytree(EXAMPLE, repo, ignore=shutil.ignore_patterns("__pycache__"))
    git(repo, "init", "-q")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")

    pricing = repo / "app/services/pricing.py"
    pricing.write_text(pricing.read_text().replace("), 2)", "), 1)"))
    orders = repo / "app/services/orders.py"
    orders.write_text(orders.read_text().split("\n\ndef list_orders")[0] + "\n")

    result = Scanner(repo).scan()
    changes = changes_from_git(repo, result, "HEAD")
    assert changes.changed == ["app.services.pricing.apply_discount"]
    assert [d.qualified_name for d in changes.deleted] == ["app.services.orders.list_orders"]

    a = analyze(build_graph(result), changes.changed, 3, changes.deleted, result)
    names = {s.name for s in a.affected}
    assert "app.routes.orders.place_order" in names           # reached through the pricing change
    assert "app.routes.orders.my_orders" in names             # broken by the deletion
    assert a.deleted[0].still_called_by == ["app.routes.orders.my_orders"]
    assert "tests/test_shop.py::test_order_total_applies_discount" in a.tests_to_run
    assert a.risk.level == "high"


def test_git_flow_scanning_a_subfolder(tmp_path):
    repo = tmp_path / "mono"
    shutil.copytree(EXAMPLE, repo / "backend", ignore=shutil.ignore_patterns("__pycache__"))
    git(repo, "init", "-q")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")

    auth = repo / "backend/app/auth.py"
    auth.write_text(auth.read_text().replace('raise PermissionError("bad token")', 'raise ValueError("bad")'))

    result = Scanner(repo / "backend").scan()
    assert changes_from_git(repo / "backend", result).changed == ["app.auth.decode_token"]
