/**
 * Reads unified diff text (what `git diff` prints) into files and numbered
 * lines for showing. Pure, so it is tested on its own.
 */

export type DiffLine = {
  kind: "context" | "add" | "del" | "gap";
  oldNo: number | null;
  newNo: number | null;
  text: string;
};

export type DiffFile = {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function cleanPath(raw: string): string | null {
  const path = raw.split("\t")[0].trim().replace(/^"|"$/g, "");
  if (path === "/dev/null") return null;
  return path.replace(/^[ab]\//, "");
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let oldPath: string | null = null;

  const all = text.split("\n");
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    // a new file's header; without "diff --git" lines (plain `diff -u`) it can follow a hunk directly
    if (inHunk && line.startsWith("--- ") && all[i + 1]?.startsWith("+++ ")) inHunk = false;
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      oldPath = null;
      continue;
    }
    if (line.startsWith("--- ") && !inHunk) {
      oldPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ") && !inHunk) {
      file = { path: cleanPath(line.slice(4)) ?? oldPath ?? "?", added: 0, removed: 0, lines: [] };
      files.push(file);
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk && file) {
      if (file.lines.length) file.lines.push({ kind: "gap", oldNo: null, newNo: null, text: "" });
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!file || !inHunk) continue;
    if (line.startsWith("+")) {
      file.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
      file.added++;
    } else if (line.startsWith("-")) {
      file.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
      file.removed++;
    } else if (line.startsWith(" ")) {
      file.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file": not part of the code
    } else if (line === "") {
      // a blank context line some tools print without its leading space
      if (oldNo || newNo) file.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: "" });
    } else {
      inHunk = false;
    }
  }
  // a trailing empty line from the final newline is not code
  for (const f of files) {
    while (f.lines.length && f.lines[f.lines.length - 1].kind === "context" && f.lines[f.lines.length - 1].text === "") {
      f.lines.pop();
    }
  }
  return files;
}

export function diffTotals(files: DiffFile[]): { added: number; removed: number } {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });
}
