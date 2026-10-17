import { clsx } from "clsx";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useMemo } from "react";
import { type MenuAction, OverflowMenu } from "@/components/ui/menu";
import type { LibraryEntry } from "@/lib/backend";
import { documentFolder, documentName } from "@/lib/format";

export type FolderNode = {
  path: string;
  name: string;
  children: FolderNode[];
};

export function folderTree(entries: LibraryEntry[]): FolderNode[] {
  const folders = new Map<string, FolderNode>();
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    folders.set(entry.path, {
      path: entry.path,
      name: documentName(entry.path),
      children: [],
    });
  }
  const roots: FolderNode[] = [];
  for (const folder of folders.values()) {
    const parent = folders.get(documentFolder(folder.path) ?? "");
    if (parent) parent.children.push(folder);
    else roots.push(folder);
  }
  const sort = (nodes: FolderNode[]) => {
    nodes.sort((a, b) =>
      a.name.localeCompare(b.name, "en-US", { sensitivity: "base" }),
    );
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

export function FolderTree({
  entries,
  expanded,
  selected,
  onToggle,
  onSelect,
  rowActions,
}: {
  entries: LibraryEntry[];
  expanded: ReadonlySet<string>;
  selected: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  rowActions?: (path: string) => MenuAction[];
}) {
  const roots = useMemo(() => folderTree(entries), [entries]);

  const render = (nodes: FolderNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const open = expanded.has(node.path);
      const active = selected === node.path;
      const actions = rowActions?.(node.path) ?? [];
      return (
        <li key={node.path}>
          <div
            className={clsx(
              "group flex h-[34px] items-center rounded-xs pr-1 transition-[background-color] duration-(--duration-fast) ease-linear",
              active ? "bg-surface-raised" : "hover:bg-surface-raised/60",
            )}
          >
            <button
              type="button"
              className="flex h-full flex-none items-center justify-center w-6 border-0 bg-transparent text-fg-muted cursor-pointer"
              aria-label={
                open ? `Collapse ${node.name}` : `Expand ${node.name}`
              }
              onClick={() => onToggle(node.path)}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <button
              type="button"
              data-folder={node.path}
              aria-current={active ? "true" : undefined}
              className={clsx(
                "flex flex-1 min-w-0 items-center gap-2 h-full pl-0 pr-2 border-0 bg-transparent text-sm text-left cursor-pointer",
                active ? "text-fg" : "text-fg-muted group-hover:text-fg",
              )}
              style={{ paddingLeft: depth * 14 }}
              onClick={() => onSelect(node.path)}
            >
              <Folder size={16} className="flex-none" />
              <span className="min-w-0 truncate">{node.name}</span>
            </button>
            {actions.length > 0 ? (
              <span className="flex-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                <OverflowMenu
                  label={`Folder actions for ${node.path}`}
                  actions={actions}
                />
              </span>
            ) : null}
          </div>
          {open && node.children.length > 0 ? (
            <ul className="flex flex-col">
              {render(node.children, depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });

  return (
    <ul className="flex flex-col gap-px" aria-label="Library folders">
      <li>
        <div
          className={clsx(
            "flex h-[34px] items-center rounded-xs pr-1",
            selected === ""
              ? "bg-surface-raised"
              : "hover:bg-surface-raised/60",
          )}
        >
          <button
            type="button"
            data-folder=""
            aria-current={selected === "" ? "true" : undefined}
            className={clsx(
              "flex flex-1 min-w-0 items-center gap-2 h-full pl-6 pr-2 border-0 bg-transparent text-sm text-left cursor-pointer",
              selected === "" ? "text-fg" : "text-fg-muted",
            )}
            onClick={() => onSelect("")}
          >
            <Folder size={16} className="flex-none" />
            <span className="min-w-0 truncate">Library</span>
          </button>
        </div>
      </li>
      {render(roots, 1)}
    </ul>
  );
}
