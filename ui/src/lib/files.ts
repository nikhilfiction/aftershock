/** Turns a list of file paths into the rows of an indented file tree. */

export type TreeRow = {
  key: string;
  name: string;      // "routes/" for a folder, "orders.py" for a file
  depth: number;
  dir: boolean;
  path: string;      // the full path; for a folder, the folder's path
};

export function treeRows(paths: string[]): TreeRow[] {
  const rows: TreeRow[] = [];
  const seenDirs = new Set<string>();
  // folders before the files next to them, like an editor's sidebar
  const sorted = [...new Set(paths)].sort((a, b) => {
    const pa = a.split("/");
    const pb = b.split("/");
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) continue;
      const aDir = i < pa.length - 1;
      const bDir = i < pb.length - 1;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return pa[i].localeCompare(pb[i]);
    }
    return pa.length - pb.length;
  });
  for (const path of sorted) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join("/");
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        rows.push({ key: `d:${dir}`, name: `${parts[i]}/`, depth: i, dir: true, path: dir });
      }
    }
    rows.push({ key: `f:${path}`, name: parts[parts.length - 1], depth: parts.length - 1, dir: false, path });
  }
  return rows;
}
