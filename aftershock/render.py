"""Prints an Analysis as terminal text, Markdown (for pull request comments) or JSON."""

import json

from aftershock.analysis import Analysis, SymbolInfo

MAX_ROWS = 25        # longer lists get cut, with a "+N more" line


def _short(name: str) -> str:
    return name.split(".")[-1]


def _chain(s: SymbolInfo) -> str:
    return " -> ".join(_short(n) for n in s.via)


def _tag(s: SymbolInfo) -> str:
    tags = []
    if s.kind == "route":
        tags.append(s.route or "ROUTE")
    if s.confidence == "dynamic":
        tags.append("HIDDEN")
    return f" [{', '.join(tags)}]" if tags else ""


# ---------------------------------------------------------------- terminal

def to_text(a: Analysis) -> str:
    out = [f"Blast radius: {a.risk.score}/100 ({a.risk.level} risk)"]
    out += [f"  - {r}" for r in a.risk.reasons]
    out.append("")

    out.append(f"Changed ({len(a.changed)}):")
    for s in a.changed:
        mark = "" if s.reached_by_tests or s.kind in ("module", "variable") else "  (no test reaches it)"
        out.append(f"  {s.name}{_tag(s)}  {s.file_path}:{s.line}{mark}")
    if not a.changed:
        out.append("  nothing (only comments, tests or files outside the scan)")
    out.append("")

    if a.hidden_dependencies:
        out.append(f"Hidden dependencies, found only by running the tests ({len(a.hidden_dependencies)}):")
        out += [f"  {n}" for n in a.hidden_dependencies[:MAX_ROWS]]
        out.append("")

    for d in a.deleted:
        out.append(f"Deleted: {d.name}  ({d.file_path})")
        for c in d.still_called_by:
            out.append(f"  still called by {c}  <- this will break")
    if a.deleted:
        out.append("")

    if a.affected:
        for distance in sorted({s.distance for s in a.affected}):
            group = [s for s in a.affected if s.distance == distance]
            out.append("Direct dependents:" if distance == 1 else f"Distance {distance}:")
            for s in group[:MAX_ROWS]:
                out.append(f"  {s.name}{_tag(s)}")
                if distance > 1:
                    out.append(f"      via {_chain(s)}")
            if len(group) > MAX_ROWS:
                out.append(f"  ... and {len(group) - MAX_ROWS} more")
            out.append("")
    else:
        out.append("Nothing depends on the changed code.\n")

    if a.tests_to_run:
        out.append(f"Tests to run ({len(a.tests_to_run)}):")
        out += [f"  {t}" for t in a.tests_to_run[:MAX_ROWS]]
        if len(a.tests_to_run) > MAX_ROWS:
            out.append(f"  ... and {len(a.tests_to_run) - MAX_ROWS} more")
        if a.test_command:
            out.append("Run just these:")
            out += [f"  {line}" for line in a.test_command.splitlines()]
        out.append("")

    out.append(
        f"Summary: {len(a.changed)} changed, {len(a.affected)} affected, "
        f"{len(a.routes)} routes, {len(a.untested)} untested"
    )
    return "\n".join(out)


# ---------------------------------------------------------------- markdown

def to_markdown(a: Analysis) -> str:
    level_icon = {"low": "🟢", "medium": "🟠", "high": "🔴"}[a.risk.level]
    out = [f"### {level_icon} Blast radius: {a.risk.score}/100 ({a.risk.level} risk)", ""]
    out += [f"- {r}" for r in a.risk.reasons]
    out.append("")

    broken = [d for d in a.deleted if d.still_called_by]
    if broken:
        out.append("**Will break:**")
        for d in broken:
            callers = ", ".join(f"`{_short(c)}`" for c in d.still_called_by)
            out.append(f"- `{d.name}` was deleted but is still called by {callers}")
        out.append("")

    if a.hidden_dependencies:
        out.append("**Hidden dependencies** (found only by running the tests, invisible in the code):")
        out += [f"- `{n}`" for n in a.hidden_dependencies[:MAX_ROWS]]
        out.append("")

    if a.routes:
        out.append("**API routes affected:**")
        out += [f"- {f'**{s.route}** ' if s.route else ''}`{s.name}` ({s.file_path}:{s.line})"
                for s in a.routes[:MAX_ROWS]]
        out.append("")

    if a.changed:
        out += ["| Changed | Where | Reached by a test |", "| --- | --- | --- |"]
        for s in a.changed[:MAX_ROWS]:
            tested = "n/a" if s.kind in ("module", "variable") else ("yes" if s.reached_by_tests else "**no**")
            out.append(f"| `{_short(s.name)}` ({s.kind}) | {s.file_path}:{s.line} | {tested} |")
        out.append("")

    if a.affected:
        out += [f"<details><summary>{len(a.affected)} affected symbols</summary>", ""]
        for s in a.affected[:50]:
            via = f" — via {_chain(s)}" if s.distance > 1 else ""
            out.append(f"- `{s.name}`{_tag(s)} (distance {s.distance}){via}")
        if len(a.affected) > 50:
            out.append(f"- ... and {len(a.affected) - 50} more")
        out += ["", "</details>", ""]

    if a.tests_to_run:
        out += ["<details><summary>Tests to run</summary>", "", "```", *a.tests_to_run[:50], "```", ""]
        if a.test_command:
            out += ["Run just these:", "", "```bash", a.test_command, "```", ""]
        out.append("</details>")

    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------- json

def to_json(a: Analysis) -> str:
    return json.dumps(a.to_dict(), indent=2)


RENDERERS = {"text": to_text, "markdown": to_markdown, "json": to_json}
