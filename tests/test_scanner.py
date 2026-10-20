"""Each test builds a tiny fake repo in a temp folder and checks one resolution rule."""

from textwrap import dedent

from aftershock.graph import build_graph, callers
from aftershock.scanner import Scanner


def make_repo(tmp_path, files: dict[str, str]):
    for rel, code in files.items():
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(dedent(code))
    return build_graph(Scanner(tmp_path).scan())


def test_direct_call_in_same_module(tmp_path):
    g = make_repo(tmp_path, {"app/a.py": """
        def helper(): pass
        def main(): helper()
    """})
    assert g.has_edge("app.a.main", "app.a.helper")


def test_from_import_with_alias(tmp_path):
    g = make_repo(tmp_path, {
        "app/utils.py": "def save(): pass",
        "app/service.py": """
            from app.utils import save as persist
            def run(): persist()
        """,
    })
    assert g.has_edge("app.service.run", "app.utils.save")


def test_module_import_attribute_call(tmp_path):
    g = make_repo(tmp_path, {
        "app/utils.py": "def save(): pass",
        "app/service.py": """
            import app.utils as u
            def run(): u.save()
        """,
    })
    assert g.has_edge("app.service.run", "app.utils.save")


def test_relative_import(tmp_path):
    g = make_repo(tmp_path, {
        "app/__init__.py": "",
        "app/core/__init__.py": "",
        "app/core/db.py": "def connect(): pass",
        "app/core/boot.py": """
            from .db import connect
            def start(): connect()
        """,
    })
    assert g.has_edge("app.core.boot.start", "app.core.db.connect")


def test_self_method_call(tmp_path):
    g = make_repo(tmp_path, {"app/repo.py": """
        class Repo:
            def _query(self): pass
            def find(self): return self._query()
    """})
    assert g.has_edge("app.repo.Repo.find", "app.repo.Repo._query")


def test_function_passed_as_reference(tmp_path):
    g = make_repo(tmp_path, {
        "app/auth.py": "def current_user(): pass",
        "app/routes.py": """
            from fastapi import APIRouter, Depends
            from app.auth import current_user
            router = APIRouter()

            @router.get("/me")
            def me(user=Depends(current_user)): return user
        """,
    })
    assert g.nodes["app.routes.me"]["kind"] == "route"
    assert g.has_edge("app.routes.me", "app.auth.current_user")


def test_transitive_callers_with_distance(tmp_path):
    g = make_repo(tmp_path, {"app/chain.py": """
        def c(): pass
        def b(): c()
        def a(): b()
        def unrelated(): pass
    """})
    assert callers(g, "app.chain.c") == {"app.chain.b": 1, "app.chain.a": 2}


def test_builtins_are_ignored(tmp_path):
    g = make_repo(tmp_path, {"app/x.py": """
        def f(): print(len([1]))
    """})
    assert g.out_degree("app.x.f") == 0
