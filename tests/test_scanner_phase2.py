"""Scanner rules added in Phase 2: variables, decorators, local names, broken calls."""

from aftershock.scanner import Scanner
from tests.test_scanner import make_repo


def test_module_variable_is_a_symbol_and_its_users_depend_on_it(tmp_path):
    g = make_repo(tmp_path, {
        "app/config.py": """
            class Settings: pass
            settings = Settings()
        """,
        "app/auth.py": """
            from app.config import settings
            def secret(): return settings.jwt_secret
        """,
    })
    assert g.nodes["app.config.settings"]["kind"] == "variable"
    assert g.has_edge("app.auth.secret", "app.config.settings")
    assert g.has_edge("app.config.settings", "app.config.Settings")   # the variable is built by the class


def test_function_span_starts_at_its_decorator(tmp_path):
    g = make_repo(tmp_path, {"app/r.py": """
        router = object()

        @router.get("/me")
        def me(): pass
    """})
    assert g.nodes["app.r.me"]["start_line"] == 4      # the @router line, not the def line


def test_local_variable_does_not_shadow_into_module_variable(tmp_path):
    g = make_repo(tmp_path, {"app/x.py": """
        data = {}
        def load():
            data = {"fresh": True}
            return data
    """})
    assert not g.has_edge("app.x.load", "app.x.data")


def test_call_to_missing_function_is_recorded_as_unresolved(tmp_path):
    (tmp_path / "app").mkdir()
    (tmp_path / "app/utils.py").write_text("def other(): pass\n")
    (tmp_path / "app/service.py").write_text("from app.utils import save\ndef run(): save()\n")
    result = Scanner(tmp_path).scan()
    assert any(u.caller == "app.service.run" and u.candidate == "app.utils.save" for u in result.unresolved_calls)
    # and it is NOT silently treated as a call to the module app.utils
    assert not any(e.source == "app.service.run" and e.target == "app.utils" for e in result.edges)


def test_self_call_to_missing_method_is_not_guessed(tmp_path):
    g = make_repo(tmp_path, {"app/repo.py": """
        class Repo:
            def find(self): return self.missing()
    """})
    assert g.out_degree("app.repo.Repo.find") == 0


def test_variable_built_by_a_call_with_arguments(tmp_path):
    # regression: a Call's .args (a list) was mistaken for a function's parameters
    g = make_repo(tmp_path, {"app/log.py": """
        def make_logger(name, level=1): pass
        logger = make_logger("app", 2)
    """})
    assert g.has_edge("app.log.logger", "app.log.make_logger")


def test_routes_record_method_and_path_with_the_router_prefix(tmp_path):
    g = make_repo(tmp_path, {"app/routes.py": """
        from fastapi import APIRouter
        from flask import Blueprint
        router = APIRouter(prefix="/orders")
        bp = Blueprint("users", __name__, url_prefix="/users")

        @router.get("/")
        def list_them(): pass

        @router.post("/{order_id}/pay")
        def pay(order_id: int): pass

        @bp.route("/login", methods=["POST"])
        def login(): pass

        @bp.route("/me")
        def me(): pass

        def helper(): pass
    """})
    route = lambda name: g.nodes[f"app.routes.{name}"]["route"]
    assert route("list_them") == "GET /orders/"
    assert route("pay") == "POST /orders/{order_id}/pay"
    assert route("login") == "POST /users/login"
    assert route("me") == "GET /users/me"
    assert route("helper") == ""
