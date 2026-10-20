/** The verdict as plain sentences, built from a report's numbers. */
import type { Report } from "../api/types";
import { shortLabel } from "./format";

const CALLABLE = new Set(["function", "method", "route"]);

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

/** Plain sentences built from the report's numbers. */
export function verdictSentences(r: Report): string[] {
  const changed = r.changed;
  const subject =
    changed.length === 1
      ? shortLabel(changed[0].name, changed[0].kind)
      : changed.length === 0
        ? "the change"
        : `these ${changed.length} changes`;

  const n = r.affected.length;
  const noun = r.affected.every((s) => CALLABLE.has(s.kind))
    ? plural(n, "function depends", "functions depend")
    : plural(n, "part of the code depends", "parts of the code depend");
  const routes = r.affected.filter((s) => s.kind === "route").length;
  const hidden = r.hidden_dependencies.length;
  const sentences: string[] = [];

  if (n === 0) {
    sentences.push(`Nothing else depends on ${subject}.`);
  } else {
    let first = `${n} ${noun} on ${subject}`;
    if (routes) first += `, including ${routes} ${plural(routes, "API route", "API routes")}`;
    sentences.push(first + ".");
  }
  if (changed.length === 1 && changed[0].kind === "route") sentences.push("It is an API route itself.");
  if (hidden) {
    sentences.push(
      hidden === n
        ? `${plural(n, "It was", "All of them were")} found only by running the tests.`
        : `${hidden} of them ${plural(hidden, "was", "were")} found only by running the tests.`,
    );
  }
  for (const d of r.deleted.filter((d) => d.still_called_by.length)) {
    const k = d.still_called_by.length;
    sentences.push(`${shortLabel(d.name, "function")} was deleted but ${k} ${plural(k, "place still calls", "places still call")} it.`);
  }
  const code = changed.filter((s) => s.kind !== "module" && s.kind !== "variable");
  const untested = code.filter((s) => !s.reached_by_tests).length;
  if (untested) {
    sentences.push(
      code.length === 1
        ? "No test reaches it."
        : untested === code.length
          ? "No test reaches any of the changed code."
          : `No test reaches ${untested} of the ${code.length} changed functions.`,
    );
  }
  return sentences;
}
