/** Showing small pieces of code (Python, JavaScript, TypeScript): colouring, indentation and a function's header. */
import type { ReactNode } from "react";

export type Language = "python" | "js";

/** The language of a file, from its extension. */
export function languageOf(path: string): Language {
  return /\.[cm]?[jt]sx?$/.test(path) ? "js" : "python";
}

const PY_KEYWORDS = new Set(
  "def class return async await if elif else for while in not and or is import from as with lambda yield raise try except finally pass None True False".split(" "),
);
const JS_KEYWORDS = new Set(
  "function class return async await if else for while of in new const let var import from export default as try catch finally throw this super extends implements interface type null undefined true false typeof instanceof yield static private public protected readonly".split(" "),
);
const PY_TOKEN = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|\b\w+\b)/g;
const JS_TOKEN = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*$|\b[\w$]+\b)/g;

/** Light colouring for one line: keywords, strings, comments, the name after def/function/class. */
export function highlight(line: string, language: Language = "python"): ReactNode[] {
  const js = language === "js";
  const keywords = js ? JS_KEYWORDS : PY_KEYWORDS;
  const out: ReactNode[] = [];
  let last = 0;
  let afterDef = false;
  for (const m of line.matchAll(js ? JS_TOKEN : PY_TOKEN)) {
    const [tok] = m;
    const at = m.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    if (/^["'`]/.test(tok)) out.push(<span key={at} className="tk-str">{tok}</span>);
    else if (tok.startsWith(js ? "//" : "#")) out.push(<span key={at} className="tk-com">{tok}</span>);
    else if (afterDef) out.push(<span key={at} className="tk-name">{tok}</span>);
    else if (keywords.has(tok)) out.push(<span key={at} className="tk-kw">{tok}</span>);
    else out.push(tok);
    afterDef = tok === "def" || tok === "class" || tok === "function";
    last = at + tok.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** Removes the indentation the lines share, so a snippet starts at the left edge. */
export function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut));
}

/**
 * A function's header (decorators and the line that defines it, however many
 * lines that takes) plus its first body line. Python headers end at ":",
 * JavaScript and TypeScript ones at "{" or "=>".
 */
export function headerLines(lines: string[], language: Language = "python"): string[] {
  const out: string[] = [];
  const ends = language === "js" ? (l: string) => /(\{|=>)\s*$/.test(l.trimEnd()) : (l: string) => l.trimEnd().endsWith(":");
  const starts =
    language === "js"
      ? (l: string) => /\b(function|class)\b|=>|^\s*(async\s+)?[\w$#]+\s*\(|^\s*\w+\.\w+\(/.test(l)
      : (l: string) => /^\s*(async\s+def|def|class)\s/.test(l);
  let inHeader = false;
  for (let i = 0; i < lines.length && out.length < 8; i++) {
    out.push(lines[i]);
    if (starts(lines[i])) inHeader = true;
    if (inHeader && ends(lines[i])) {
      if (i + 1 < lines.length) out.push(lines[i + 1]);
      break;
    }
  }
  return out;
}
