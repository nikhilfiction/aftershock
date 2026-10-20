/** The sections of each report layout, for the sidebar and the phone's bottom tabs. */
import type { IconName } from "../components/Icon";
import type { Report } from "../api/types";
import { brokenDeletions } from "./report";

export type Section = { id: string; label: string; short: string; icon: IconName };

export function changeSections(r: Report): Section[] {
  return [
    { id: "radar-h", label: "Dependency radar", short: "Radar", icon: "graph" },
    ...(brokenDeletions(r).length
      ? [{ id: "broken-h", label: "Breaking changes", short: "Breaks", icon: "warning" } as Section]
      : []),
    { id: "routes-h", label: "API routes", short: "Routes", icon: "hash" },
    { id: "tests-h", label: "Tests to run", short: "Tests", icon: "prompt" },
    { id: "diff-h", label: "Code diff", short: "Code", icon: "braces" },
  ];
}

export function functionSections(r: Report): Section[] {
  const allHidden = r.affected.length > 0 && r.hidden_dependencies.length === r.affected.length;
  return [
    { id: "radar-h", label: "Dependency radar", short: "Radar", icon: "graph" },
    { id: "hidden-h", label: allHidden ? "Hidden callers" : "Who calls it", short: "Callers", icon: "eye" },
    { id: "tests-h", label: "Tests to run", short: "Tests", icon: "prompt" },
    { id: "sig-h", label: "Changed function", short: "Code", icon: "code" },
    { id: "graph-h", label: "Call graph", short: "Graph", icon: "tree" },
  ];
}

export const INTRO_SECTIONS: Section[] = [
  { id: "intro-h", label: "Start here", short: "Start", icon: "radar" },
  { id: "graph-h", label: "How the files fit", short: "Files", icon: "tree" },
];

