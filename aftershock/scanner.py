"""Static scanner: turns a folder of Python files into symbols and edges.

Two passes over the code:
  1. collect every symbol (module, class, function, method, module-level
     variable) and each module's import table (local name -> full name)
  2. walk each function body, resolve every call / name it uses, and keep
     the ones that point at a symbol we found in pass 1
"""

import ast
import builtins
from dataclasses import dataclass, field
from pathlib import Path

SKIP_DIRS = {".git", "__pycache__", "venv", ".venv", "env", "node_modules", "build", "dist", ".tox"}
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
BUILTIN_NAMES = set(dir(builtins))
CALLABLE_KINDS = {"function", "route", "method"}


@dataclass
class Symbol:
    qualified_name: str          # e.g. app.routers.users.login_user
    kind: str                    # module | class | function | method | route | variable
    file_path: str               # relative to the scanned folder, always with "/"
    start_line: int              # first decorator line, if it has decorators
    end_line: int
    is_test: bool = False
    module: str = ""             # the module it lives in, e.g. app.routers.users
    route: str = ""              # routes only: method and path as written, e.g. "GET /orders/"
    test_name: str = ""          # JS/TS test cases only: the full title a test runner matches, e.g. "orders lists mine"


@dataclass
class Edge:
    source: str                  # the caller's qualified name
    target: str                  # the callee's qualified name
    kind: str                    # calls | references | imports | inherits
    line: int
    origin: str = "static"       # static = read from code, dynamic = seen while tests ran
    count: int = 1               # how many times it was seen (dynamic edges count real calls)


@dataclass
class UnresolvedCall:
    caller: str                  # who made the call
    candidate: str               # the full name we looked for, e.g. app.utils.save
    line: int


@dataclass
class ScanResult:
    symbols: dict[str, Symbol] = field(default_factory=dict)
    edges: list[Edge] = field(default_factory=list)
    unresolved_calls: list[UnresolvedCall] = field(default_factory=list)
    # facts about the whole scan: {"languages": ["python", "typescript"], "test_runner": "vitest", "warnings": [...]}
    meta: dict = field(default_factory=dict)

    @property
    def unresolved(self) -> int:
        return len(self.unresolved_calls)


# ---------------------------------------------------------------- helpers

def module_name_for(path: Path, root: Path) -> str:
    """app/routers/users.py -> app.routers.users, app/__init__.py -> app"""
    parts = list(path.relative_to(root).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) or root.name


def module_name_for_rel(rel_path: str) -> str:
    """Same as module_name_for, but from a "app/x.py" style string."""
    parts = rel_path[:-3].split("/") if rel_path.endswith(".py") else rel_path.split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def is_test_path(rel_path: str) -> bool:
    parts = rel_path.split("/")
    return "test" in parts[-1] or "tests" in parts


def resolve_relative(module: str, is_package: bool, level: int, target: str | None) -> str:
    """Turns `from ..models import x` into an absolute module path."""
    base = module.split(".")
    # inside app/routers/users.py, level 1 means app.routers
    base = base if is_package else base[:-1]
    if level > 1:
        base = base[: len(base) - (level - 1)]
    return ".".join(base + ([target] if target else []))


def dotted_name(node: ast.AST) -> str | None:
    """a.b.c as an Attribute chain -> "a.b.c". Anything more complex -> None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def is_route_decorator(dec: ast.AST) -> bool:
    """Detects FastAPI/Flask style @router.get("/path") decorators."""
    return (
        isinstance(dec, ast.Call)
        and isinstance(dec.func, ast.Attribute)
        and dec.func.attr in HTTP_METHODS | {"route"}
    )


def _text(node: ast.AST | None) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def router_prefixes(tree: ast.Module) -> dict[str, str]:
    """`router = APIRouter(prefix="/orders")` or `bp = Blueprint(..., url_prefix="/orders")`
    at the top of a file -> {"router": "/orders"}."""
    prefixes = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            for kw in node.value.keywords:
                if kw.arg in ("prefix", "url_prefix") and _text(kw.value) is not None:
                    for name in assigned_names(node):
                        prefixes[name] = _text(kw.value)
    return prefixes


def route_label(fn: ast.AST, prefixes: dict[str, str]) -> str:
    """'GET /orders/' for a function decorated with @router.get("/") under prefix /orders.
    The prefix an app adds when it mounts the router elsewhere is not included."""
    for dec in fn.decorator_list:
        if not is_route_decorator(dec):
            continue
        method = dec.func.attr.upper()
        if method == "ROUTE":                       # Flask: @bp.route("/x", methods=["POST"])
            method = "GET"
            for kw in dec.keywords:
                if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)) and kw.value.elts:
                    method = (_text(kw.value.elts[0]) or "GET").upper()
        path = _text(dec.args[0]) if dec.args else None
        if path is None:
            path = next((_text(kw.value) for kw in dec.keywords if kw.arg in ("path", "rule")), None)
        prefix = prefixes.get(dotted_name(dec.func.value) or "", "")
        return f"{method} {prefix}{path or ''}".strip()
    return ""


def first_line(node: ast.AST) -> int:
    """A function's span starts at its first decorator, not at `def`."""
    decorators = getattr(node, "decorator_list", [])
    return min([node.lineno] + [d.lineno for d in decorators])


def assigned_names(node: ast.AST) -> list[str]:
    """Names created by a top-level `x = ...`, `x: int = ...` or `a, b = ...`."""
    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
    names = []
    for target in targets:
        if isinstance(target, ast.Name):
            names.append(target.id)
        elif isinstance(target, ast.Tuple):
            names.extend(t.id for t in target.elts if isinstance(t, ast.Name))
    return [n for n in names if not n.startswith("__")]


def local_names(fn: ast.AST) -> set[str]:
    """Names assigned inside a function, plus its parameters.

    A local `data = load()` must not be mistaken for a module-level `data`.
    """
    names = {n.id for n in ast.walk(fn) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    # only functions and lambdas have parameters; a Call's .args is its argument list
    args = getattr(fn, "args", None)
    if isinstance(args, ast.arguments):
        for a in args.posonlyargs + args.args + args.kwonlyargs:
            names.add(a.arg)
        if args.vararg:
            names.add(args.vararg.arg)
        if args.kwarg:
            names.add(args.kwarg.arg)
    return names


def symbols_from_tree(tree: ast.Module, module: str, rel: str) -> list[Symbol]:
    """Every symbol defined at the top of one file. Also used to read old versions of a file."""
    is_test = is_test_path(rel)
    last = tree.body[-1].end_lineno if tree.body else 1
    found = [Symbol(module, "module", rel, 1, last, is_test, module)]
    seen = {module}

    def add(sym: Symbol) -> None:
        if sym.qualified_name not in seen:
            seen.add(sym.qualified_name)
            found.append(sym)

    prefixes = router_prefixes(tree)
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            route = route_label(node, prefixes)
            kind = "route" if any(is_route_decorator(d) for d in node.decorator_list) else "function"
            add(Symbol(f"{module}.{node.name}", kind, rel, first_line(node), node.end_lineno, is_test, module, route))
        elif isinstance(node, ast.ClassDef):
            cls = f"{module}.{node.name}"
            add(Symbol(cls, "class", rel, first_line(node), node.end_lineno, is_test, module))
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    add(Symbol(f"{cls}.{item.name}", "method", rel, first_line(item), item.end_lineno, is_test, module))

    # variables last, so a function and a variable with the same name keep the function
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            for name in assigned_names(node):
                add(Symbol(f"{module}.{name}", "variable", rel, node.lineno, node.end_lineno, is_test, module))
    return found


# ---------------------------------------------------------------- scanner

class Scanner:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.result = ScanResult()
        self._trees: dict[str, ast.Module] = {}
        self._imports: dict[str, dict[str, str]] = {}   # module -> {local name: qualified}

    def scan(self) -> ScanResult:
        files = sorted(
            p for p in self.root.rglob("*.py")
            if not any(part in SKIP_DIRS for part in p.relative_to(self.root).parts)
        )
        for path in files:                              # pass 1
            self._collect_symbols(path)
        for module, tree in self._trees.items():        # pass 2
            self._collect_edges(module, tree)
        return self.result

    # ---- pass 1

    def _collect_symbols(self, path: Path) -> None:
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (SyntaxError, UnicodeDecodeError) as exc:
            print(f"skipping {path}: {exc}")
            return

        module = module_name_for(path, self.root)
        rel = path.relative_to(self.root).as_posix()
        self._trees[module] = tree
        for symbol in symbols_from_tree(tree, module, rel):
            self.result.symbols.setdefault(symbol.qualified_name, symbol)
        self._imports[module] = self._read_imports(module, path.name == "__init__.py", tree)

    def _read_imports(self, module: str, is_package: bool, tree: ast.Module) -> dict[str, str]:
        table: dict[str, str] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    # `import a.b` binds `a`; `import a.b as c` binds `c`
                    if alias.asname:
                        table[alias.asname] = alias.name
                    else:
                        head = alias.name.split(".")[0]
                        table[head] = head
            elif isinstance(node, ast.ImportFrom):
                source = (
                    resolve_relative(module, is_package, node.level, node.module)
                    if node.level else node.module or ""
                )
                for alias in node.names:
                    if alias.name != "*":
                        table[alias.asname or alias.name] = f"{source}.{alias.name}"
        return table

    # ---- pass 2

    def _collect_edges(self, module: str, tree: ast.Module) -> None:
        imports = self._imports.get(module, {})

        # module -> module import edges
        for target in set(imports.values()):
            resolved = self._known(target)
            if resolved and resolved != module:
                self._edge(module, self._module_of(resolved), "imports", 1)

        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._scan_body(f"{module}.{node.name}", node, module, imports, cls=None)
            elif isinstance(node, ast.ClassDef):
                cls = f"{module}.{node.name}"
                for base in node.bases:
                    name = dotted_name(base)
                    target = name and self._resolve(name, module, imports, cls=None)
                    if target:
                        self._edge(cls, target, "inherits", node.lineno)
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        self._scan_body(f"{cls}.{item.name}", item, module, imports, cls=cls)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                # `settings = Settings()`: the variable depends on what builds it
                for name in assigned_names(node):
                    var = f"{module}.{name}"
                    if self.result.symbols.get(var, None) and self.result.symbols[var].kind == "variable":
                        self._scan_body(var, node.value, module, imports, cls=None)

    def _scan_body(self, caller: str, body: ast.AST, module: str, imports: dict, cls: str | None) -> None:
        locals_ = local_names(body)
        called_nodes = set()

        for node in ast.walk(body):
            if isinstance(node, ast.Call):
                called_nodes.add(id(node.func))
                name = dotted_name(node.func)
                if not name or self._skip(name, locals_, imports):
                    continue
                target = self._resolve(name, module, imports, cls)
                candidate = self._candidate(name, module, imports, cls)
                if target and target != caller:
                    self._edge(caller, target, "calls", node.lineno)
                elif not target:
                    self.result.unresolved_calls.append(UnresolvedCall(caller, candidate, node.lineno))

        # plain references that are not calls, e.g. Depends(get_current_user_id) or settings.jwt_secret
        for node in ast.walk(body):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and id(node) not in called_nodes:
                if self._skip(node.id, locals_, imports):
                    continue
                target = self._resolve(node.id, module, imports, cls)
                sym = target and self.result.symbols.get(target)
                if sym and (sym.kind in CALLABLE_KINDS or sym.kind == "variable") and target != caller:
                    self._edge(caller, target, "references", node.lineno)

    def _skip(self, name: str, locals_: set[str], imports: dict) -> bool:
        head = name.split(".")[0]
        if head in ("self", "cls"):
            return False
        if head in BUILTIN_NAMES and head not in imports:
            return True
        return head in locals_ and head not in imports

    def _candidate(self, name: str, module: str, imports: dict, cls: str | None) -> str:
        """The full name a name *would* have, whether or not it exists."""
        head, _, rest = name.partition(".")
        if head in ("self", "cls") and cls and rest:
            return f"{cls}.{rest.split('.')[0]}"
        if head in imports:
            return imports[head] + (f".{rest}" if rest else "")
        return f"{module}.{name}"      # defined in the same module

    def _resolve(self, name: str, module: str, imports: dict, cls: str | None) -> str | None:
        """Maps a name as written in code to a known symbol, or None."""
        candidate = self._candidate(name, module, imports, cls)
        if name.split(".")[0] in ("self", "cls"):
            # self.save() must be a real method of this class, no guessing
            return candidate if candidate in self.result.symbols else None
        return self._known(candidate)

    def _known(self, candidate: str) -> str | None:
        """Longest known prefix: app.models.user.User.find_one -> app.models.user.User

        The prefix may be a class or a variable (their attributes come from
        libraries we did not scan), but never a module: `utils.save()` where
        utils has no `save` is a broken call, not a call to the module.
        """
        parts = candidate.split(".")
        while parts:
            name = ".".join(parts)
            sym = self.result.symbols.get(name)
            if sym:
                if sym.kind == "module" and name != candidate:
                    return None
                return name
            parts.pop()
        return None

    def _module_of(self, qualified: str) -> str:
        sym = self.result.symbols.get(qualified)
        return sym.module if sym else qualified

    def _edge(self, source: str, target: str, kind: str, line: int) -> None:
        self.result.edges.append(Edge(source, target, kind, line))
