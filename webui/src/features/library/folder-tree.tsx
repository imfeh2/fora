import { clsx } from "clsx";
import {
  ChevronRight,
  File,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Music,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  Button as AriaButton,
  type Selection,
  Tree,
  TreeItem,
  TreeItemContent,
} from "react-aria-components";
import { type MenuAction, OverflowMenu } from "@/components/ui/menu";
import { mediaKind } from "@/features/library/media";
import type { LibraryEntry } from "@/lib/backend";
import { documentFolder, documentName } from "@/lib/format";

export type FolderNode = {
  path: string;
  name: string;
  kind: "directory" | "file";
  children: FolderNode[];
};

export function folderTree(entries: LibraryEntry[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  for (const entry of entries) {
    nodes.set(entry.path, {
      path: entry.path,
      name: documentName(entry.path),
      kind: entry.kind === "directory" ? "directory" : "file",
      children: [],
    });
  }
  const roots: FolderNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(documentFolder(node.path) ?? "");
    if (parent?.kind === "directory") parent.children.push(node);
    else roots.push(node);
  }
  const sort = (siblings: FolderNode[]) => {
    siblings.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, "en-US", { sensitivity: "base" });
    });
    for (const sibling of siblings) sort(sibling.children);
  };
  sort(roots);
  return roots;
}

function folderPaths(nodes: FolderNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    into.add(node.path);
    folderPaths(node.children, into);
  }
  return into;
}

function iconFor(node: FolderNode) {
  if (node.kind === "directory") return Folder;
  const kind = mediaKind(node.path);
  if (kind === "image") return ImageIcon;
  if (kind === "video") return Film;
  if (kind === "audio") return Music;
  const dot = node.name.lastIndexOf(".");
  return dot > 0 && dot < node.name.length - 1 ? FileText : File;
}

export function FolderTree({
  entries,
  expanded,
  selected,
  onToggle,
  onOpen,
  rowActions,
}: {
  entries: LibraryEntry[];
  expanded: ReadonlySet<string>;
  selected: string;
  onToggle: (path: string) => void;
  onOpen?: (path: string) => void;
  rowActions?: (path: string) => MenuAction[];
}) {
  const roots = useMemo(() => folderTree(entries), [entries]);
  const directories = useMemo(
    () => folderPaths(roots, new Set<string>()),
    [roots],
  );
  const expandedKeys = useMemo(
    () => new Set([...expanded].filter((path) => directories.has(path))),
    [directories, expanded],
  );
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => {
      const rows =
        container.current?.querySelectorAll<HTMLElement>("[data-key]");
      const row = [...(rows ?? [])].find(
        (item) => item.dataset.key === selected,
      );
      row?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, roots]);

  const changeExpanded = (keys: Selection) => {
    const next = new Set(Array.from(keys, (key) => String(key)));
    for (const path of next) if (!expandedKeys.has(path)) onToggle(path);
    for (const path of expandedKeys) if (!next.has(path)) onToggle(path);
  };

  const handleKey = (event: globalThis.KeyboardEvent) => {
    if (event.key !== " " && event.key !== "Enter") return;
    const row = event.target;
    if (!(row instanceof HTMLElement) || row.getAttribute("role") !== "row")
      return;
    const key = row.dataset.key;
    if (key === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (directories.has(key)) onToggle(key);
    else onOpen?.(key);
  };

  const handleClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest("button")) return;
    const key = target.closest<HTMLElement>('[role="row"]')?.dataset.key;
    if (key === undefined) return;
    event.stopPropagation();
    if (directories.has(key)) onToggle(key);
    else onOpen?.(key);
  };

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    node.addEventListener("keydown", handleKey);
    node.addEventListener("click", handleClick, true);
    return () => {
      node.removeEventListener("keydown", handleKey);
      node.removeEventListener("click", handleClick, true);
    };
  }, [handleKey, handleClick]);

  const renderNode = (node: FolderNode): ReactNode => {
    const directory = node.kind === "directory";
    const actions = rowActions?.(node.path) ?? [];
    const Icon = iconFor(node);
    const current = selected === node.path;
    return (
      <TreeItem
        key={node.path}
        id={node.path}
        textValue={node.name}
        ref={(element) => {
          if (!element) return;
          if (selected === node.path)
            element.setAttribute("aria-current", "true");
          else element.removeAttribute("aria-current");
        }}
        className={({ isFocusVisible }) =>
          clsx(
            "group relative flex items-center rounded-xs pr-1 transition-[background-color] duration-(--duration-fast) ease-linear",
            directory ? "h-[34px]" : "h-[30px]",
            current ? "bg-surface-raised" : "hover:bg-surface-raised/60",
            isFocusVisible && "outline-1 -outline-offset-1 outline-line-hover",
          )
        }
        style={({ level }) => ({ paddingLeft: level * 14 })}
      >
        <TreeItemContent>
          {({ isExpanded, hasChildItems }) => (
            <>
              {hasChildItems ? (
                <AriaButton
                  slot="chevron"
                  className="flex h-full w-6 flex-none cursor-pointer items-center justify-center border-0 bg-transparent text-fg-muted"
                >
                  <ChevronRight
                    size={14}
                    className={clsx(
                      "transition-transform duration-(--duration-fast) ease-linear",
                      isExpanded && "rotate-90",
                    )}
                  />
                </AriaButton>
              ) : (
                <span aria-hidden="true" className="h-full w-6 flex-none" />
              )}
              <Icon
                size={directory ? 16 : 14}
                className={clsx(
                  "flex-none",
                  directory
                    ? "text-fg-muted"
                    : current
                      ? "text-fg-muted"
                      : "text-fg-subtle",
                )}
              />
              <span
                title={node.name}
                className={clsx(
                  "ml-2 min-w-0 flex-1 truncate text-left",
                  directory
                    ? "text-sm leading-5"
                    : "text-[13px] leading-[18px]",
                  current ? "text-fg" : "text-fg-muted group-hover:text-fg",
                )}
              >
                {node.name}
              </span>
              {actions.length > 0 ? (
                <span className="flex-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  <OverflowMenu
                    label={`Actions for ${node.path}`}
                    actions={actions}
                    stopPropagation
                  />
                </span>
              ) : null}
            </>
          )}
        </TreeItemContent>
        {node.children.map(renderNode)}
      </TreeItem>
    );
  };

  return (
    <div ref={container} className="flex flex-col gap-px">
      <div className="flex h-[34px] items-center gap-2 pl-6 pr-2 text-sm text-fg-muted">
        <Folder size={16} className="flex-none" />
        <span className="min-w-0 truncate">Library</span>
      </div>
      <Tree
        aria-label="Library"
        className="flex flex-col gap-px"
        expandedKeys={expandedKeys}
        onExpandedChange={changeExpanded}
      >
        {roots.map(renderNode)}
      </Tree>
    </div>
  );
}
