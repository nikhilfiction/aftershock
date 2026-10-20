"""Command line entry point.

    aftershock stats   <repo>
    aftershock symbols <repo> [--kind route]
    aftershock callers <repo> <function> [--depth 3] [--format text|markdown|json]
    aftershock diff    <repo> [--base main] [--diff-file changes.diff] [--fail-above 70]
    aftershock trace   <repo> [-- extra pytest args]     (runs the tests, records runtime calls)
    aftershock serve   [--port 8000]     the web app at /, the API under /api
    aftershock setup-js                  install the TypeScript compiler used to read JS/TS code

Python, JavaScript and TypeScript code are all read; a repo may mix them.

callers, diff and stats accept --trace FILE to include runtime calls.
"""

import argparse
import sys
from collections import Counter
from pathlib import Path

from aftershock.analysis import analyze
from aftershock.diff import DiffError, changes_from_git, changes_from_text
from aftershock.graph import build_graph, edge_confidence, find_symbol
from aftershock.javascript import JsError, typescript_path
from aftershock.project import scan_project, trace_project
from aftershock.render import RENDERERS, to_markdown
from aftershock.tracing import TRACE_FILE, load_trace, merge_trace


def cmd_stats(graph, result) -> None:
    kinds = Counter(data["kind"] for _, data in graph.nodes(data=True))
    edge_kinds = Counter(k for *_, data in graph.edges(data=True) for k in data["kinds"])
    print(f"Symbols: {graph.number_of_nodes()}  ({', '.join(f'{k}: {v}' for k, v in kinds.most_common())})")
    print(f"Edges:   {graph.number_of_edges()}  ({', '.join(f'{k}: {v}' for k, v in edge_kinds.most_common())})")
    languages = ", ".join(result.meta.get("languages", [])) or "none"
    print(f"Languages: {languages}")
    print(f"Unresolved calls (external libraries or dynamic code): {result.unresolved}")
    confidence = Counter(edge_confidence(d) for *_, d in graph.edges(data=True))
    if confidence["dynamic"] or confidence["both"]:
        print(f"Edge confidence: {confidence['both']} confirmed at runtime, "
              f"{confidence['dynamic']} seen only at runtime (hidden), {confidence['static']} only in the code")


def cmd_symbols(graph, kind: str | None) -> None:
    for name, data in sorted(graph.nodes(data=True)):
        if kind is None or data["kind"] == kind:
            print(f"{data['kind']:<9} {name}  ({data['file_path']}:{data['start_line']})")


def cmd_callers(graph, result, args) -> int:
    matches = find_symbol(graph, args.symbol)
    if not matches:
        print(f"No symbol matches '{args.symbol}'. Try the `symbols` command.")
        return 1
    if len(matches) > 1:
        print(f"'{args.symbol}' is ambiguous, pick one:")
        for m in matches:
            print(f"  {m}")
        return 1
    analysis = analyze(graph, matches, args.depth, result=result)
    print(RENDERERS[args.format](analysis))
    return 0


def cmd_diff(graph, result, args) -> int:
    try:
        if args.diff_file:
            text = sys.stdin.read() if args.diff_file == "-" else Path(args.diff_file).read_text()
            changes = changes_from_text(text, result, args.prefix)
        else:
            changes = changes_from_git(args.repo, result, args.base)
    except DiffError as exc:
        print(f"Could not read the diff: {exc}", file=sys.stderr)
        return 2

    analysis = analyze(graph, changes.changed, args.depth, changes.deleted, result)
    print(RENDERERS[args.format](analysis))

    if args.github:
        from aftershock.github import GitHubError, publish
        try:
            print(f"\nGitHub: {publish(to_markdown(analysis))}", file=sys.stderr)
        except GitHubError as exc:
            print(f"\nGitHub: {exc}", file=sys.stderr)    # a failed comment must not hide the report

    if args.fail_above is not None and analysis.risk.score > args.fail_above:
        print(f"\nRisk {analysis.risk.score} is above the limit of {args.fail_above}.", file=sys.stderr)
        return 1
    return 0


def cmd_trace(args) -> int:
    print("Running the tests with tracing on (this is slower than a normal test run)...")
    out = Path(args.out) if args.out else Path(args.repo) / TRACE_FILE
    outcome = trace_project(args.repo, out, pytest_args=args.pytest_args, install=not args.no_install)
    for line in outcome.summaries:
        print(line)
    for problem in outcome.problems:
        print(problem, file=sys.stderr)
    if outcome.trace is None:
        print("No trace was written.", file=sys.stderr)
        return 2
    trace = outcome.trace
    known = merge_trace(scan_project(args.repo), trace)
    print(f"Recorded {len(trace['edges'])} runtime calls ({known} between scanned symbols) -> {out}")
    if not trace["edges"]:
        print("No calls were recorded, which usually means the tests could not even start (for example an\n"
              "import error, or missing dependencies).", file=sys.stderr)
    print(f"Use it with: aftershock callers {args.repo} <name> --trace {out}")
    return 0


def carry_over_old_files() -> None:
    """The project used to be called Blast Radius. Its database and data folder
    get the new names, so earlier repositories and scans are still there."""
    import os
    moves = [("blast_radius.db", "aftershock.db", "DATABASE_URL"), (".blast-radius-data", ".aftershock-data", "DATA_DIR")]
    for old, new, setting in moves:
        if not os.getenv(setting) and Path(old).exists() and not Path(new).exists():
            Path(old).rename(new)
            print(f"Renamed {old} to {new} (the project is now called Aftershock)", file=sys.stderr)


def cmd_setup_js() -> int:
    try:
        path = typescript_path()
    except JsError as exc:
        print(exc, file=sys.stderr)
        return 2
    print(f"TypeScript compiler ready: {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aftershock")
    sub = parser.add_subparsers(dest="command", required=True)

    p_stats = sub.add_parser("stats", help="count symbols and edges")
    p_stats.add_argument("repo")

    p_sym = sub.add_parser("symbols", help="list symbols")
    p_sym.add_argument("repo")
    p_sym.add_argument("--kind", choices=["module", "class", "function", "method", "route", "variable"])

    p_call = sub.add_parser("callers", help="show everything that depends on one symbol")
    p_call.add_argument("repo")
    p_call.add_argument("symbol")

    p_diff = sub.add_parser("diff", help="show the blast radius of your git changes")
    p_diff.add_argument("repo", nargs="?", default=".")
    p_diff.add_argument("--base", default="HEAD",
                        help="compare against this git ref: HEAD (uncommitted work, default), main, main...HEAD")
    p_diff.add_argument("--diff-file", help="read a saved diff instead of running git ('-' = stdin)")
    p_diff.add_argument("--prefix", default="",
                        help="with --diff-file: the scanned folder's path inside the repo, e.g. backend/")
    p_diff.add_argument("--fail-above", type=int, help="exit with code 1 if the risk score is above this")
    p_diff.add_argument("--github", action="store_true",
                        help="inside GitHub Actions: comment the report on the pull request and the job summary")

    for p in (p_call, p_diff):
        p.add_argument("--depth", type=int, default=3)
        p.add_argument("--format", choices=list(RENDERERS), default="text")
    for p in (p_stats, p_call, p_diff):
        p.add_argument("--trace", help=f"include runtime calls from a trace file (made by `trace`, e.g. {TRACE_FILE})")

    p_trace = sub.add_parser("trace", help="run the repo's tests and record which functions really call which")
    p_trace.add_argument("repo", nargs="?", default=".")
    p_trace.add_argument("--out", help=f"where to write the trace (default: <repo>/{TRACE_FILE})")
    p_trace.add_argument("--no-install", action="store_true",
                         help="JS/TS: never run npm install; use the project's node_modules as it is")
    p_trace.add_argument("pytest_args", nargs="*", help="extra arguments for pytest, after --")

    sub.add_parser("setup-js", help="install the TypeScript compiler used to read JavaScript and TypeScript")

    p_serve = sub.add_parser("serve", help="run the web app and its API (API docs at /api/docs)")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8000)
    p_serve.add_argument("--reload", action="store_true", help="restart when code changes")

    args = parser.parse_args(argv)
    if args.command == "serve":
        import uvicorn

        carry_over_old_files()

        from aftershock.api.settings import Settings
        from aftershock.api.web import ui_is_built
        url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}"
        if ui_is_built(Settings().ui_dir):
            print(f"Aftershock: open {url}  (API docs: {url}/api/docs)", file=sys.stderr)
        else:
            print(f"Aftershock API: {url}/api/docs\n"
                  "The web app is not built yet. Build it once with:  cd ui && npm install && npm run build",
                  file=sys.stderr)
        uvicorn.run("aftershock.api.app:create_app", factory=True, host=args.host, port=args.port,
                    reload=args.reload)
        return 0

    if args.command == "trace":
        return cmd_trace(args)
    if args.command == "setup-js":
        return cmd_setup_js()

    try:
        result = scan_project(args.repo)
    except JsError as exc:
        print(exc, file=sys.stderr)
        return 2
    for warning in result.meta.get("warnings", []):
        print(f"Warning: {warning}", file=sys.stderr)
    if getattr(args, "trace", None):
        added = merge_trace(result, load_trace(args.trace))
        print(f"(including {added} runtime calls from {args.trace})\n", file=sys.stderr)
    graph = build_graph(result)

    if args.command == "stats":
        cmd_stats(graph, result)
        return 0
    if args.command == "symbols":
        cmd_symbols(graph, args.kind)
        return 0
    if args.command == "callers":
        return cmd_callers(graph, result, args)
    return cmd_diff(graph, result, args)


if __name__ == "__main__":
    sys.exit(main())
