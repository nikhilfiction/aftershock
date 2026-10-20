"""Turns a git diff into the list of symbols it changed or deleted.

A diff only gives file names and line numbers. To know *which functions*
changed, we look up each changed line in the scanned symbols and pick the
smallest symbol whose lines contain it (a method beats its class, a class
beats its module). This works the same for Python and JavaScript/TypeScript.
"""

import ast
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from aftershock.javascript import is_js_path, js_module_name, js_symbols_of
from aftershock.scanner import ScanResult, Symbol, module_name_for_rel, symbols_from_tree

HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
DEF_LINE = re.compile(r"^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)")
# function x(, class X, const x = (...) =>, const x = function  (top-level JS/TS definitions)
JS_DEF_LINE = re.compile(
    r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)"
    r"|^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)"
    r"|^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)"
)
# the files a diff is read for: every language a scanner understands
SOURCE_GLOBS = ["*.py", "*.js", "*.jsx", "*.ts", "*.tsx", "*.mjs", "*.cjs", "*.mts", "*.cts"]


def is_source_path(path: str) -> bool:
    return path.endswith(".py") or is_js_path(path)


def module_for(rel: str) -> str:
    return js_module_name(rel) if is_js_path(rel) else module_name_for_rel(rel)


def definition_on(line: str, path: str) -> str | None:
    """The name a line defines, if it starts a function or class."""
    if is_js_path(path):
        m = JS_DEF_LINE.match(line)
    else:
        m = DEF_LINE.match(line)
    return next((g for g in m.groups() if g), None) if m else None


class DiffError(Exception):
    pass


@dataclass
class FileChange:
    path: str                                        # e.g. app/routers/users.py
    old_path: str | None = None                      # differs from path when a file was renamed
    changed_lines: set[int] = field(default_factory=set)   # line numbers in the NEW file
    removed_defs: set[str] = field(default_factory=set)    # def/class names on removed lines
    added_defs: set[str] = field(default_factory=set)      # def/class names on added lines
    is_new: bool = False
    is_deleted: bool = False


@dataclass
class DeletedSymbol:
    qualified_name: str
    file_path: str


@dataclass
class ChangeSet:
    changed: list[str]                               # qualified names of changed symbols
    deleted: list[DeletedSymbol]
    files: list[str]                                 # every source file the diff touched


# ---------------------------------------------------------------- reading a diff

def _clean_path(raw: str) -> str | None:
    path = raw.split("\t")[0].strip().strip('"')
    if path == "/dev/null":
        return None
    if path.startswith(("a/", "b/")):
        path = path[2:]
    return path


def parse_diff(text: str) -> dict[str, FileChange]:
    """Reads unified diff text (what `git diff` prints) into one FileChange per file."""
    files: dict[str, FileChange] = {}
    current: FileChange | None = None
    old_path: str | None = None
    old_left = new_left = 0          # lines still to read in the current hunk
    new_line = 0                     # line number in the new file we are on

    # A run of removed lines with nothing added in its place is a pure deletion.
    # It gets marked on the line just above where the removed lines used to be.
    minus_run = False
    minus_mark = 0
    minus_has_def = False

    def end_minus_run(replaced: bool) -> None:
        nonlocal minus_run, minus_has_def
        if minus_run and not replaced and not minus_has_def and current is not None:
            current.changed_lines.add(minus_mark)
        minus_run = False
        minus_has_def = False

    for line in text.splitlines():
        in_hunk = old_left > 0 or new_left > 0

        if not in_hunk:
            end_minus_run(replaced=False)
            if line.startswith("--- "):
                old_path = _clean_path(line[4:])
            elif line.startswith("+++ "):
                new_path = _clean_path(line[4:])
                path = new_path or old_path
                if path is None:
                    continue
                current = files.setdefault(path, FileChange(path, old_path=old_path))
                current.is_new = old_path is None
                current.is_deleted = new_path is None
            elif (match := HUNK_HEADER.match(line)) and current is not None:
                old_left = int(match.group(2) or 1)
                new_left = int(match.group(4) or 1)
                new_line = int(match.group(3))
                if new_left == 0:
                    new_line += 1    # "+9,0" means "after line 9"
            continue

        if line.startswith("\\"):    # "\ No newline at end of file"
            continue

        if line.startswith("+"):
            end_minus_run(replaced=True)
            current.changed_lines.add(new_line)
            if name := definition_on(line[1:], current.path):
                current.added_defs.add(name)
            new_line += 1
            new_left -= 1
        elif line.startswith("-"):
            if not minus_run:
                minus_run, minus_mark = True, max(new_line - 1, 1)
            if name := definition_on(line[1:], current.path):
                current.removed_defs.add(name)
                minus_has_def = True
            old_left -= 1
        else:                        # context line (only with --unified above 0)
            end_minus_run(replaced=False)
            new_line += 1
            old_left -= 1
            new_left -= 1

    end_minus_run(replaced=False)
    return files


# ---------------------------------------------------------------- talking to git

def _git(repo: Path, *args: str) -> str:
    try:
        out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True)
    except FileNotFoundError:
        raise DiffError("git is not installed or not on PATH")
    except subprocess.CalledProcessError as exc:
        raise DiffError(exc.stderr.strip() or f"git {' '.join(args)} failed")
    return out.stdout


def git_root(repo: Path) -> Path:
    return Path(_git(repo, "rev-parse", "--show-toplevel").strip()).resolve()


def git_diff(repo: Path, base: str = "HEAD") -> str:
    """Changes between `base` and the files on disk (committed or not).

    base = "HEAD"          -> your uncommitted changes
    base = "main"          -> everything that differs from main
    base = "main...HEAD"   -> what this branch added since it left main
    """
    return _git(repo, "diff", "--unified=0", "--no-color", "--no-ext-diff", base, "--", *SOURCE_GLOBS)


def old_ref_for(repo: Path, base: str) -> str:
    """Which commit holds the 'before' version of the files."""
    if "..." in base:
        left, right = base.split("...", 1)
        return _git(repo, "merge-base", left or "HEAD", right or "HEAD").strip()
    if ".." in base:
        return base.split("..", 1)[0] or "HEAD"
    return base


def old_source(repo: Path, ref: str, git_path: str) -> str | None:
    try:
        return _git(repo, "show", f"{ref}:{git_path}")
    except DiffError:
        return None


# ---------------------------------------------------------------- mapping lines to symbols

def _index_by_file(result: ScanResult) -> dict[str, list[Symbol]]:
    index: dict[str, list[Symbol]] = {}
    for sym in result.symbols.values():
        index.setdefault(sym.file_path, []).append(sym)
    return index


def symbol_at(symbols: list[Symbol], line: int) -> Symbol | None:
    """The smallest symbol whose lines contain `line`; the module if none does."""
    inside = [s for s in symbols if s.kind != "module" and s.start_line <= line <= s.end_line]
    if inside:
        return min(inside, key=lambda s: (s.end_line - s.start_line, s.kind == "class"))
    return next((s for s in symbols if s.kind == "module"), None)


def map_changes(
    changes: dict[str, FileChange],
    result: ScanResult,
    prefix: str = "",
    old_text_for=None,
) -> ChangeSet:
    """Converts per-file line changes into changed and deleted symbols.

    prefix:        where the scanned folder sits inside the git repo, e.g. "backend/"
    old_text_for:  function(git_path) -> old file text, or None. When given, deleted
                   symbols are found exactly by comparing old and new definitions.
    """
    index = _index_by_file(result)
    changed: list[str] = []
    deleted: list[DeletedSymbol] = []
    files: list[str] = []
    old_js: dict[str, str] = {}                      # old JS/TS texts, read in one go at the end
    pending: list[tuple[str, str, FileChange]] = []

    for git_path, change in changes.items():
        if not is_source_path(git_path) or not git_path.startswith(prefix):
            continue
        rel = git_path[len(prefix):]
        files.append(rel)
        current = index.get(rel, [])

        for line in sorted(change.changed_lines):
            sym = symbol_at(current, line)
            if sym and sym.qualified_name not in changed:
                changed.append(sym.qualified_name)

        # deleted symbols: defined before the change, missing after it
        old_git_path = change.old_path or git_path
        old_rel = old_git_path[len(prefix):] if old_git_path.startswith(prefix) else old_git_path
        old_text = old_text_for(old_git_path) if old_text_for and not change.is_new else None
        if old_text is None:
            gone = _gone_by_name(change, rel, result)
        elif is_js_path(old_rel):
            old_js[old_rel] = old_text
            pending.append((rel, old_rel, change))
            continue
        else:
            try:
                old_tree = ast.parse(old_text)
            except SyntaxError:
                old_tree = ast.parse("")
            gone = _gone(symbols_from_tree(old_tree, module_name_for_rel(old_rel), old_rel), result)
        deleted.extend(DeletedSymbol(q, old_rel if change.old_path else rel) for q in gone)

    if pending:
        old_symbols = js_symbols_of(old_js)
        for rel, old_rel, change in pending:
            gone = _gone(old_symbols.get(old_rel, []), result)
            deleted.extend(DeletedSymbol(q, old_rel if change.old_path else rel) for q in gone)

    return ChangeSet(changed=changed, deleted=deleted, files=files)


def _gone(old_symbols: list[Symbol], result: ScanResult) -> list[str]:
    """Symbols the old file defined that no longer exist anywhere. A JS test case
    whose title changed is not reported: nothing can call a test."""
    gone = sorted({s.qualified_name for s in old_symbols if not s.test_name} - set(result.symbols))
    # a deleted class or file is reported once, not once per method inside it
    return [q for q in gone if not any(q.startswith(g + ".") for g in gone)]


def _gone_by_name(change: FileChange, rel: str, result: ScanResult) -> list[str]:
    """Without the old file (a pasted diff), go by the def/function lines the diff removed."""
    module = module_for(rel)
    return sorted(f"{module}.{n}" for n in change.removed_defs - change.added_defs
                  if f"{module}.{n}" not in result.symbols)


def changes_from_git(repo: str | Path, result: ScanResult, base: str = "HEAD") -> ChangeSet:
    """The full pipeline: run git diff, read it, and map it onto the scanned code."""
    scan_root = Path(repo).resolve()
    top = git_root(scan_root)
    rel_root = scan_root.relative_to(top).as_posix()
    prefix = "" if rel_root == "." else rel_root + "/"

    text = git_diff(top, base)
    ref = old_ref_for(top, base)
    return map_changes(parse_diff(text), result, prefix, lambda p: old_source(top, ref, p))


def changes_from_text(text: str, result: ScanResult, prefix: str = "") -> ChangeSet:
    """For a diff saved to a file or piped in, e.g. inside CI."""
    return map_changes(parse_diff(text), result, prefix)


def changes_between(git_dir: str | Path, base: str, head: str, result: ScanResult, prefix: str = "") -> ChangeSet:
    """Changes from `base` to `head` inside a git repo that may have no files on disk
    (the API keeps bare mirror clones). Compares head against the point where it
    left base, which is what a pull request shows.
    """
    git_dir = Path(git_dir)
    old_ref = _git(git_dir, "merge-base", base, head).strip()
    text = _git(git_dir, "diff", "--unified=0", "--no-color", "--no-ext-diff", old_ref, head, "--", *SOURCE_GLOBS)
    return map_changes(parse_diff(text), result, prefix, lambda p: old_source(git_dir, old_ref, p))


def diff_text_between(git_dir: str | Path, base: str, head: str, subdir: str = "") -> str:
    """The code changes from where `head` left `base`, with 3 lines of context:
    what a pull request page shows. Paths are relative to `subdir` when given."""
    git_dir = Path(git_dir)
    old_ref = _git(git_dir, "merge-base", base, head).strip()
    args = ["diff", "--unified=3", "--no-color", "--no-ext-diff"]
    if subdir:
        args.append(f"--relative={subdir.strip('/')}")
    return _git(git_dir, *args, old_ref, head, "--", *SOURCE_GLOBS)
