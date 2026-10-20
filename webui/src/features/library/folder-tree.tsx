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
import { type ReactNode, useMemo } from "react";
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
  onSelect,
  onOpen,
  rowActions,
}: {
  entries: LibraryEntry[];
  expanded: ReadonlySet<string>;
  selected: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpen?: (path: string) => void;
  rowActions?: (path: string) => MenuAction[];
}) {
  const roots = useMemo(() => folderTree(entries), [entries]);
  const directories = useMemo(
    () => folderPaths(roots, new Set<string>()),
    [roots],
  );
  const known = useMemo(() => {
    const paths = new Set<string>([""]);
    const walk = (nodes: FolderNode[]) => {
      for (const node of nodes) {
        paths.add(node.path);
        walk(node.children);
      }
    };
    walk(roots);
    return paths;
  }, [roots]);
  const expandedKeys = useMemo(
    () => new Set([...expanded].filter((path) => directories.has(path))),
    [directories, expanded],
  );

  const changeExpanded = (keys: Selection) => {
    const next = new Set(Array.from(keys, (key) => String(key)));
    for (const path of next) if (!expandedKeys.has(path)) onToggle(path);
    for (const path of expandedKeys) if (!next.has(path)) onToggle(path);
  };

  const choose = (keys: Selection) => {
    const [key] = Array.from(keys);
    if (key === undefined) return;
    const path = String(key);
    if (directories.has(path)) onSelect(path);
    else onOpen?.(path);
  };

  const renderNode = (node: FolderNode): ReactNode => {
    const directory = node.kind === "directory";
    const actions = directory ? (rowActions?.(node.path) ?? []) : [];
    const Icon = iconFor(node);
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
        className={({ isSelected, isFocusVisible }) =>
          clsx(
            "group relative flex items-center rounded-xs pr-1 outline-none transition-[background-color] duration-(--duration-fast) ease-linear",
            directory ? "h-[34px]" : "h-[30px]",
            isSelected ? "bg-surface-raised" : "hover:bg-surface-raised/60",
            isFocusVisible && "outline-1 -outline-offset-1 outline-line-hover",
          )
        }
        style={({ level }) => ({ paddingLeft: level * 14 })}
      >
        <TreeItemContent>
          {({ isExpanded, hasChildItems, isSelected }) => (
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
                    : isSelected
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
                  isSelected ? "text-fg" : "text-fg-muted group-hover:text-fg",
                )}
              >
                {node.name}
              </span>
              {actions.length > 0 ? (
                <span className="flex-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  <OverflowMenu
                    label={`Folder actions for ${node.path}`}
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
    <div className="flex flex-col gap-px">
      <div
        className={clsx(
          "flex h-[34px] items-center rounded-xs pr-1",
          selected === "" ? "bg-surface-raised" : "hover:bg-surface-raised/60",
        )}
      >
        <button
          type="button"
          data-folder=""
          aria-current={selected === "" ? "true" : undefined}
          className={clsx(
            "flex h-full flex-1 min-w-0 items-center gap-2 border-0 bg-transparent pl-6 pr-2 text-left text-sm cursor-pointer",
            selected === "" ? "text-fg" : "text-fg-muted",
          )}
          onClick={() => onSelect("")}
        >
          <Folder size={16} className="flex-none" />
          <span className="min-w-0 truncate">Library</span>
        </button>
      </div>
      <Tree
        aria-label="Library"
        className="flex flex-col gap-px"
        selectionMode="single"
        selectionBehavior="replace"
        selectedKeys={known.has(selected) ? new Set([selected]) : undefined}
        onSelectionChange={choose}
        expandedKeys={expandedKeys}
        onExpandedChange={changeExpanded}
        disallowEmptySelection
      >
        {roots.map(renderNode)}
      </Tree>
    </div>
  );
}
