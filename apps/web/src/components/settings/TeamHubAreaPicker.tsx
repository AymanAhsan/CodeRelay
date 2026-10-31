import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { ChevronRightIcon, FileIcon, FolderIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { useDirectoryEntries } from "../files/useDirectoryEntries";
import { areaRowState, setAreaSelected } from "./teamHubAreas";

function parentOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stripFolderGlob(area: string): string {
  return area.endsWith("/**") ? area.slice(0, -3) : area;
}

function isPattern(area: string): boolean {
  return /[*?[\]{}]/.test(stripFolderGlob(area));
}

/**
 * File tree for choosing "Your areas". Pressing a row toggles it and dragging across rows
 * applies the same choice to each one; a selected folder owns everything inside it.
 */
export function TeamHubAreaPicker({
  environmentId,
  cwd,
  areas,
  disabled,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly areas: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onChange: (areas: Set<string>) => void;
}) {
  const { entries, load, ready, error } = useDirectoryEntries(environmentId, cwd);
  // Open the folders that lead to the saved areas so they show as selected.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const open = new Set<string>();
    for (const area of areas) {
      if (isPattern(area)) continue;
      for (let parent = parentOf(stripFolderGlob(area)); parent !== ""; parent = parentOf(parent)) {
        open.add(parent);
      }
    }
    return open;
  });
  const openedAtStart = useRef(expanded);
  useEffect(() => {
    for (const path of openedAtStart.current) void load(path);
  }, [load]);
  // While the pointer is held, rows it passes over take this value.
  const paint = useRef<boolean | null>(null);
  // Drag events can arrive before the parent re-renders, so apply each change to the latest set.
  const latestAreas = useRef(areas);
  useLayoutEffect(() => {
    latestAreas.current = areas;
  }, [areas]);

  useEffect(() => {
    const stop = () => {
      paint.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const rows = useMemo(
    () =>
      entries.filter((entry) => {
        if (entry.ignored) return false;
        for (let parent = parentOf(entry.path); parent !== ""; parent = parentOf(parent)) {
          if (!expanded.has(parent)) return false;
        }
        return true;
      }),
    [entries, expanded],
  );

  // Areas the tree cannot show as one row, such as `apps/*/src/**`.
  const otherAreas = [...areas].filter(isPattern);

  const toggleExpanded = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      void load(path);
    }
    setExpanded(next);
  };

  const apply = (entry: ProjectEntry, selected: boolean) => {
    const state = areaRowState(latestAreas.current, entry.path, entry.kind);
    if (state === "inherited" || (state === "selected") === selected) return;
    const next = setAreaSelected(latestAreas.current, entry.path, entry.kind, selected);
    latestAreas.current = next;
    onChange(next);
  };

  const onRowKeyDown = (event: KeyboardEvent, entry: ProjectEntry) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      apply(entry, areaRowState(areas, entry.path, entry.kind) !== "selected");
    } else if (entry.kind === "directory" && event.key === "ArrowRight") {
      if (!expanded.has(entry.path)) toggleExpanded(entry.path);
    } else if (entry.kind === "directory" && event.key === "ArrowLeft") {
      if (expanded.has(entry.path)) toggleExpanded(entry.path);
    }
  };

  return (
    <div className="space-y-2">
      <div
        role="tree"
        aria-label="Repository files"
        aria-multiselectable
        className={cn(
          "max-h-80 overflow-y-auto rounded-lg border border-border/60 py-1 select-none",
          disabled && "pointer-events-none opacity-64",
        )}
      >
        {!ready ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{error ?? "Loading files…"}</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">This project has no files.</p>
        ) : (
          rows.map((entry) => {
            const state = areaRowState(areas, entry.path, entry.kind);
            const isOpen = expanded.has(entry.path);
            const depth = entry.path.split("/").length - 1;
            const Icon = entry.kind === "directory" ? FolderIcon : FileIcon;
            return (
              <div
                key={entry.path}
                role="treeitem"
                tabIndex={0}
                aria-selected={state === "selected" || state === "inherited"}
                aria-expanded={entry.kind === "directory" ? isOpen : undefined}
                aria-level={depth + 1}
                className={cn(
                  "flex h-7 cursor-default items-center gap-1.5 pr-3 text-sm outline-none focus-visible:bg-accent",
                  (state === "selected" || state === "inherited") && "bg-primary/8",
                )}
                style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
                onKeyDown={(event) => onRowKeyDown(event, entry)}
                onPointerDown={(event) => {
                  if (event.button !== 0 || state === "inherited") return;
                  // Touch captures the pointer to the first row; release it so dragging reaches
                  // the rows below.
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  paint.current = state !== "selected";
                  apply(entry, paint.current);
                }}
                onPointerEnter={() => {
                  if (paint.current !== null) apply(entry, paint.current);
                }}
              >
                {entry.kind === "directory" ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={isOpen ? "Collapse folder" : "Expand folder"}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => toggleExpanded(entry.path)}
                  >
                    <ChevronRightIcon className={cn("size-3.5", isOpen && "rotate-90")} />
                  </button>
                ) : (
                  <span className="size-5 shrink-0" />
                )}
                <Checkbox
                  tabIndex={-1}
                  aria-hidden
                  className="pointer-events-none"
                  checked={state === "selected" || state === "inherited"}
                  indeterminate={state === "partial"}
                  disabled={state === "inherited"}
                />
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{nameOf(entry.path)}</span>
              </div>
            );
          })
        )}
      </div>
      {otherAreas.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {otherAreas.map((area) => (
            <span
              key={area}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 py-0.5 pr-0.5 pl-2 font-mono text-xs"
            >
              {area}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${area}`}
                disabled={disabled}
                onClick={() => {
                  const next = new Set(areas);
                  next.delete(area);
                  onChange(next);
                }}
              >
                <XIcon />
              </Button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
