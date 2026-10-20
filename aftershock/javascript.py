"""Runs the JavaScript / TypeScript scanner (js/scanner.cjs) with Node.

The scanner needs the TypeScript compiler. It is installed once into a cache
folder (~/.cache/aftershock) the first time it is needed, or taken from
AFTERSHOCK_TYPESCRIPT if that points at an installed `typescript` package.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

from aftershock.scanner import SKIP_DIRS, Edge, ScanResult, Symbol, UnresolvedCall

JS_DIR = Path(__file__).resolve().parent / "js"
SCANNER = JS_DIR / "scanner.cjs"
RUNTIME = JS_DIR / "runtime.cjs"
TYPESCRIPT_VERSION = "6.0.3"          # the last TypeScript written in JavaScript, with the compiler API
JS_EXTENSIONS = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"}
JS_SKIP_DIRS = SKIP_DIRS | {"coverage", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".cache", "out",
                            "vendor", "bower_components"}
NODE_TIMEOUT = 900


class JsError(Exception):
    pass


def is_js_path(path: str) -> bool:
    return Path(path).suffix in JS_EXTENSIONS and not path.endswith((".d.ts", ".d.mts", ".d.cts", ".min.js"))


def js_module_name(rel_path: str) -> str:
    """src/services/orders.ts -> src.services.orders (same rule as the Node scanner)."""
    stem = rel_path[: -len(Path(rel_path).suffix)]
    return ".".join(part.replace(".", "_") for part in stem.split("/"))


def iter_js_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in JS_SKIP_DIRS]
        for name in filenames:
            if is_js_path(name):
                yield Path(dirpath) / name


def has_js_files(root: Path) -> bool:
    return next(iter_js_files(root), None) is not None


def count_js_files(root: Path) -> int:
    return sum(1 for _ in iter_js_files(root))


# ---------------------------------------------------------------- Node and TypeScript

def node_binary() -> str:
    node = shutil.which("node")
    if not node:
        raise JsError("This code is JavaScript/TypeScript; scanning it needs Node.js 18 or newer on PATH")
    return node


def cache_dir() -> Path:
    home = os.getenv("AFTERSHOCK_HOME")
    base = Path(home) if home else Path(os.getenv("XDG_CACHE_HOME") or Path.home() / ".cache") / "aftershock"
    return base / f"typescript-{TYPESCRIPT_VERSION}"


def typescript_path(install: bool = True) -> Path:
    """Where the `typescript` package is. Installs it into the cache folder if needed."""
    given = os.getenv("AFTERSHOCK_TYPESCRIPT")
    if given:
        return Path(given)
    target = cache_dir() / "node_modules" / "typescript"
    if (target / "package.json").is_file():
        return target
    if not install:
        raise JsError("The TypeScript compiler is not installed; run `aftershock setup-js`")
    npm = shutil.which("npm")
    if not npm:
        raise JsError("Installing the TypeScript compiler needs npm on PATH (or set AFTERSHOCK_TYPESCRIPT)")
    cache_dir().mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [npm, "install", "--prefix", str(cache_dir()), f"typescript@{TYPESCRIPT_VERSION}",
         "--no-audit", "--no-fund", "--silent", "--no-save"],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0 or not (target / "package.json").is_file():
        raise JsError(f"Could not install the TypeScript compiler: {(proc.stderr or proc.stdout).strip()[-500:]}")
    return target


def run_node(args: list[str], stdin: str | None = None, timeout: int = NODE_TIMEOUT) -> str:
    env = {**os.environ, "AFTERSHOCK_TYPESCRIPT": str(typescript_path())}
    try:
        proc = subprocess.run([node_binary(), str(SCANNER), *args], input=stdin, capture_output=True, text=True,
                              env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise JsError(f"The JavaScript scanner took longer than {timeout}s")
    if proc.returncode != 0:
        raise JsError(f"The JavaScript scanner failed: {proc.stderr.strip()[-1500:]}")
    return proc.stdout


# ---------------------------------------------------------------- scanning

def scan_js(root: str | Path) -> ScanResult:
    data = json.loads(run_node(["scan", str(Path(root).resolve())]))
    result = ScanResult()
    for s in data["symbols"]:
        result.symbols.setdefault(s["qualified_name"], Symbol(**s))
    result.edges = [Edge(e["source"], e["target"], e["kind"], e["line"]) for e in data["edges"]]
    result.unresolved_calls = [UnresolvedCall(u["caller"], u["candidate"], u["line"]) for u in data["unresolved"]]
    result.meta = data.get("meta", {})
    return result


def js_symbols_of(files: dict[str, str]) -> dict[str, list[Symbol]]:
    """Symbols of old versions of files, keyed by path. Used to find deleted functions."""
    if not files:
        return {}
    data = json.loads(run_node(["symbols"], stdin=json.dumps({"files": files})))
    return {rel: [Symbol(**s) for s in symbols] for rel, symbols in data.items()}


def instrument(root: str | Path) -> int:
    """Rewrites the code in `root` for runtime tracing. Only ever run this on a copy."""
    return json.loads(run_node(["instrument", str(Path(root).resolve())]))["files"]
