/** Area glob for a file tree row: a folder owns everything below it, a file owns itself. */
export function areaForPath(path: string, kind: "file" | "directory"): string {
  return kind === "directory" ? `${path}/**` : path;
}

function folderOfArea(area: string): string | null {
  return area.endsWith("/**") ? area.slice(0, -3) : null;
}

function isInside(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

export type AreaRowState = "selected" | "inherited" | "partial" | "none";

/**
 * How a tree row shows in the area picker. `inherited` rows sit inside a selected folder and
 * change only through that folder; `partial` folders contain selected paths.
 */
export function areaRowState(
  areas: ReadonlySet<string>,
  path: string,
  kind: "file" | "directory",
): AreaRowState {
  if (areas.has(areaForPath(path, kind))) return "selected";
  let partial = false;
  for (const area of areas) {
    const folder = folderOfArea(area);
    if (folder !== null && isInside(path, folder)) return "inherited";
    if (kind === "directory" && isInside(folder ?? area, path)) partial = true;
  }
  return partial ? "partial" : "none";
}

/**
 * Selects or clears one row. Selecting a folder drops the areas it now covers, so the saved
 * list stays as short as the selection allows.
 */
export function setAreaSelected(
  areas: ReadonlySet<string>,
  path: string,
  kind: "file" | "directory",
  selected: boolean,
): Set<string> {
  const area = areaForPath(path, kind);
  const next = new Set(areas);
  if (!selected) {
    next.delete(area);
    return next;
  }
  if (kind === "directory") {
    for (const existing of areas) {
      if (isInside(folderOfArea(existing) ?? existing, path)) next.delete(existing);
    }
  }
  next.add(area);
  return next;
}
