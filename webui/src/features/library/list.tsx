import {
  ChevronRight,
  File,
  FileText,
  FolderPlus,
  FolderTree as FolderTreeIcon,
  Plus,
  Search,
  SquarePen,
  Trash2,
} from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useResource } from "@/app/organization";
import { useNavigate } from "@/app/router";
import {
  ColumnResizeHandle,
  useColumnWidth,
} from "@/components/layout/column-resize";
import { Page } from "@/components/layout/shell";
import { LoadError } from "@/components/ui/access-error";
import { ConfirmDialog, Modal, PromptDialog } from "@/components/ui/dialog";
import {
  Button,
  IconButton,
  LoadingSkeleton,
  SearchField,
  Skeleton,
} from "@/components/ui/index";
import { type MenuAction, OverflowMenu } from "@/components/ui/menu";
import { StatePanel } from "@/components/ui/state-panel";
import { Tooltip } from "@/components/ui/tooltip";
import { DocumentBody } from "@/features/library/document";
import { FolderTree } from "@/features/library/folder-tree";
import { expandedFolders } from "@/features/library/tree";
import { BackendError, backend, type LibraryEntry } from "@/lib/backend";
import {
  documentFolder,
  documentName,
  formatBytes,
  plural,
} from "@/lib/format";

type Creation = { kind: LibraryEntry["kind"]; parent: string };

export function creationNameError(name: string): string | undefined {
  if (!name.trim()) return "Enter a name.";
  if (name === "." || name === ".." || /[/\\]/.test(name))
    return "Enter a single name, not a path (no / or \\).";
  return undefined;
}

export function creationDestination(creation: Creation, name: string): string {
  const error = creationNameError(name);
  if (error) throw new Error(error);
  return creation.parent ? `${creation.parent}/${name}` : name;
}

export async function createLibraryEntry(
  creation: Creation,
  name: string,
  entries: LibraryEntry[],
): Promise<string> {
  const destination = creationDestination(creation, name);
  const existing = entries.find((entry) => entry.path === destination);
  if (existing)
    throw new Error(
      `A ${existing.kind === "directory" ? "folder" : "file"} with this name already exists.`,
    );
  if (creation.kind === "directory") {
    await backend.mkdirLibrary(destination);
  } else {
    try {
      await backend.writeLibrary(destination, "");
    } catch (failure) {
      if (
        failure instanceof BackendError &&
        failure.code === "expected_hash_required"
      )
        throw new Error("A file with this name already exists.");
      throw failure;
    }
  }
  return destination;
}

export function libraryActions(
  entry: LibraryEntry,
  handlers: {
    rename: (entry: LibraryEntry) => void;
    create: (creation: Creation) => void;
    remove: (entry: LibraryEntry) => void;
  },
): MenuAction[] {
  return [
    {
      id: "rename",
      label: "Rename",
      icon: <SquarePen size={15} />,
      onSelect: () => handlers.rename(entry),
    },
    ...(entry.kind === "directory"
      ? [
          {
            id: "document",
            label: "New document",
            icon: <Plus size={15} />,
            onSelect: () =>
              handlers.create({ kind: "file", parent: entry.path }),
          },
          {
            id: "folder",
            label: "New folder",
            icon: <FolderPlus size={15} />,
            onSelect: () =>
              handlers.create({ kind: "directory", parent: entry.path }),
          },
        ]
      : []),
    {
      id: "delete",
      label: "Delete",
      icon: <Trash2 size={15} />,
      tone: "danger",
      onSelect: () => handlers.remove(entry),
    },
  ];
}

export function searchResults(
  entries: LibraryEntry[],
  query: string,
): { entries: LibraryEntry[]; expanded: Set<string> } {
  const needle = query.trim().toLowerCase();
  const files = entries.filter(
    (entry) =>
      entry.kind === "file" && entry.path.toLowerCase().includes(needle),
  );
  const expanded = new Set<string>();
  for (const file of files)
    for (const parent of expandedFolders(
      documentFolder(file.path) ?? undefined,
    ))
      expanded.add(parent);
  return {
    entries: [
      ...entries.filter(
        (entry) => entry.kind === "directory" && expanded.has(entry.path),
      ),
      ...files,
    ],
    expanded,
  };
}

export function deleteConsequence(
  entry: LibraryEntry | null,
  entries: LibraryEntry[],
): string {
  if (entry?.kind !== "directory")
    return "The document is removed for every Member. This cannot be undone.";
  const count = entries.filter(
    (item) => item.kind === "file" && item.path.startsWith(`${entry.path}/`),
  ).length;
  return `Removes ${plural(count, "file")} for every Member. This cannot be undone.`;
}

export function LibraryPage({ path = "" }: { path?: string }) {
  const navigate = useNavigate();
  const read = useCallback(() => backend.library(), []);
  const { resource, refresh: load, invalidate } = useResource(read);
  const entries = resource.data;
  const failed = resource.error !== null;
  const [query, setQuery] = useState("");
  const column = useColumnWidth({
    storageKey: "fora.library-width",
    initial: 248,
    min: 200,
    max: 480,
  });
  const [expanded, setExpanded] = useState(() => expandedFolders(path));
  const browsing = useRef<Set<string> | null>(null);
  const [treeOpen, setTreeOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 900 && !path,
  );
  const [creating, setCreating] = useState<Creation | null>(null);
  const [renaming, setRenaming] = useState<LibraryEntry | null>(null);
  const [doomed, setDoomed] = useState<LibraryEntry | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLSpanElement | null>(null);

  useEffect(() => {
    invalidate(true);
    void load();
    return () => invalidate(false);
  }, [load, invalidate]);

  useEffect(() => {
    setExpanded((current) => {
      const next = expandedFolders(path);
      return new Set([...current, ...next]);
    });
  }, [path]);

  useEffect(
    () =>
      backend.onEvent((event) => {
        if (event.type === "library.updated") void load(true);
        if (event.type === "connection.closed")
          invalidate(
            false,
            event.error instanceof BackendError ? event.error : undefined,
          );
        if (event.type === "connection.restored") {
          invalidate(true);
          void load();
        }
      }),
    [load, invalidate],
  );

  const fileEntry = (entries ?? []).find(
    (entry) => entry.kind === "file" && entry.path === path,
  );
  const file = fileEntry?.path;
  const pickedEntry = (entries ?? []).find((entry) => entry.path === path);
  const folder = pickedEntry
    ? pickedEntry.kind === "directory"
      ? pickedEntry.path
      : (documentFolder(pickedEntry.path) ?? "")
    : "";
  const needle = query.trim().toLowerCase();
  const results = useMemo(
    () => searchResults(entries ?? [], needle),
    [entries, needle],
  );
  const shown = needle ? results.entries : entries;
  const parts = file ? file.split("/").slice(0, -1) : [];
  const disabled = entries === null || failed || backend.disconnected;

  useEffect(() => {
    if (!needle) {
      const restore = browsing.current;
      if (!restore) return;
      browsing.current = null;
      setExpanded(restore);
      return;
    }
    setExpanded((current) => {
      browsing.current ??= current;
      return results.expanded;
    });
  }, [needle, results]);

  const toggleFolder = (next: string) =>
    setExpanded((current) => {
      const changed = new Set(current);
      if (changed.has(next)) changed.delete(next);
      else changed.add(next);
      return changed;
    });

  const openFile = (next: string) => {
    setTreeOpen(false);
    setQuery("");
    navigate({ name: "library", path: next });
  };

  const changeQuery = (value: string) => setQuery(value);

  const actionsFor = (entry: LibraryEntry) =>
    libraryActions(entry, {
      rename: setRenaming,
      create: setCreating,
      remove: setDoomed,
    }).map((action) => ({ ...action, disabled: failed }));

  const tree =
    entries === null ? null : (
      <FolderTree
        entries={shown ?? []}
        expanded={expanded}
        selected={path}
        onToggle={toggleFolder}
        onOpen={openFile}
        rowActions={(path) => {
          const entry = entries.find((item) => item.path === path);
          return entry ? actionsFor(entry) : [];
        }}
      />
    );

  return (
    <Page>
      <div
        className="relative flex flex-1 min-h-0 min-w-0"
        style={{ "--column-width": `${column.width}px` } as CSSProperties}
      >
        <aside
          style={{ width: column.width }}
          className="flex flex-none flex-col min-h-0 border-r border-line max-[900px]:hidden"
        >
          <div className="flex flex-none items-center gap-2 p-2">
            <SearchField
              icon={<Search size={15} />}
              value={query}
              placeholder="Search documents"
              aria-label="Search documents"
              onChange={(event) => changeQuery(event.target.value)}
            />
            <OverflowMenu
              label="New"
              icon={<Plus size={16} />}
              actions={[
                {
                  id: "document",
                  label: "New document",
                  icon: <Plus size={15} />,
                  disabled,
                  onSelect: () => setCreating({ kind: "file", parent: folder }),
                },
                {
                  id: "folder",
                  label: "New folder",
                  icon: <FolderPlus size={15} />,
                  disabled,
                  onSelect: () =>
                    setCreating({ kind: "directory", parent: folder }),
                },
              ]}
            />
          </div>
          <div
            id="library-tree"
            className="flex-1 min-h-0 overflow-y-auto px-2 pb-6"
          >
            {needle && (shown ?? []).length === 0 ? (
              <p className="px-2 py-2 text-sm text-fg-muted">
                No documents match
              </p>
            ) : (
              tree
            )}
          </div>
        </aside>
        <ColumnResizeHandle
          label="Resize library column"
          controls="library-tree"
          min={200}
          max={480}
          width={column.width}
          resizing={column.resizing}
          className="sidebar-resize column-resize max-[900px]:hidden"
          onPointerDown={column.startResize}
          onKeyDown={column.resizeWithKeys}
          onDoubleClick={column.reset}
        />
        <div className="flex flex-1 min-w-0 min-h-0 flex-col">
          <header className="flex flex-none items-center gap-2 border-b border-line px-6 py-2">
            <span className="hidden max-[900px]:inline-flex">
              <IconButton label="Folders" onClick={() => setTreeOpen(true)}>
                <FolderTreeIcon size={16} />
              </IconButton>
            </span>
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1 text-sm"
            >
              <span className="min-w-0 truncate text-fg-muted">Library</span>
              {parts.map((part, index) => {
                const folderPath = parts.slice(0, index + 1).join("/");
                return (
                  <span
                    key={folderPath}
                    className="flex min-w-0 items-center gap-1"
                  >
                    <ChevronRight
                      size={14}
                      className="flex-none text-fg-muted"
                    />
                    <span className="min-w-0 truncate text-fg-muted">
                      {part}
                    </span>
                  </span>
                );
              })}
              {file ? (
                <span className="flex min-w-0 items-center gap-1">
                  <ChevronRight size={14} className="flex-none text-fg-muted" />
                  {fileEntry ? (
                    <Tooltip label={formatBytes(fileEntry.size)}>
                      <span className="min-w-0 truncate text-fg">
                        {documentName(file)}
                      </span>
                    </Tooltip>
                  ) : (
                    <span className="min-w-0 truncate text-fg">
                      {documentName(file)}
                    </span>
                  )}
                </span>
              ) : null}
            </nav>
            <span className="ml-auto flex flex-none items-center gap-2">
              {file ? (
                <>
                  <span
                    ref={setActionsSlot}
                    className="flex items-center gap-2"
                  />
                  <OverflowMenu
                    label={`Actions for ${file}`}
                    actions={[
                      {
                        id: "rename",
                        label: "Rename",
                        icon: <SquarePen size={15} />,
                        disabled: !fileEntry,
                        onSelect: () => {
                          if (fileEntry) setRenaming(fileEntry);
                        },
                      },
                      {
                        id: "delete",
                        label: "Delete",
                        icon: <Trash2 size={15} />,
                        tone: "danger",
                        disabled: !fileEntry,
                        onSelect: () => {
                          if (fileEntry) setDoomed(fileEntry);
                        },
                      },
                    ]}
                  />
                </>
              ) : (
                <>
                  <Button
                    variant="primary"
                    disabled={disabled}
                    onClick={() =>
                      setCreating({ kind: "file", parent: folder })
                    }
                  >
                    <Plus size={16} />
                    New document
                  </Button>
                  <IconButton
                    label="New folder"
                    disabled={disabled}
                    onClick={() =>
                      setCreating({ kind: "directory", parent: folder })
                    }
                  >
                    <FolderPlus size={16} />
                  </IconButton>
                </>
              )}
            </span>
          </header>
          {file ? (
            <DocumentBody path={file} actionsSlot={actionsSlot} />
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 flex flex-col">
              {resource.error &&
              !(resource.error.transport && backend.disconnected) ? (
                <div className="pb-4">
                  <LoadError
                    error={resource.error}
                    retry={() =>
                      void (backend.disconnected
                        ? backend.reconnect().catch(backend.reportFailure)
                        : load())
                    }
                  />
                </div>
              ) : null}
              {entries === null ? (
                failed ? null : (
                  <LoadingSkeleton label="Loading Library">
                    {[1, 2, 3, 4, 5].map((row) => (
                      <div key={row} className="flex h-11 items-center gap-2">
                        <Skeleton className="size-4 shrink-0" />
                        <Skeleton className="w-40 max-w-full" />
                      </div>
                    ))}
                  </LoadingSkeleton>
                )
              ) : (
                <StatePanel
                  icons={[File, FileText, FolderPlus]}
                  title="Pick a file on the left"
                  action={{
                    label: "New document",
                    icon: <Plus size={16} />,
                    onClick: () =>
                      setCreating({ kind: "file", parent: folder }),
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>
      <Modal
        open={treeOpen}
        onOpenChange={setTreeOpen}
        title="Folders"
        side="left"
      >
        <div className="flex-1 min-h-0 overflow-y-auto">{tree}</div>
      </Modal>
      <PromptDialog
        open={creating !== null}
        onOpenChange={(next) => !next && setCreating(null)}
        title={creating?.kind === "directory" ? "New folder" : "New document"}
        protectUnsaved
        label="Name"
        description={
          creating?.parent
            ? `Location: Library / ${creating.parent}`
            : "Location: Library"
        }
        trim={false}
        validate={creationNameError}
        submitLabel={
          creating?.kind === "directory" ? "Create folder" : "Create document"
        }
        onSubmit={async (name) => {
          if (!creating || !entries)
            throw new Error("Library creation is not ready.");
          const destination = await createLibraryEntry(creating, name, entries);
          if (creating.kind === "directory") {
            setExpanded(
              (current) =>
                new Set([...current, ...expandedFolders(destination)]),
            );
            await load();
          } else {
            await load();
            openFile(destination);
          }
        }}
      />
      <PromptDialog
        open={renaming !== null}
        onOpenChange={(next) => !next && setRenaming(null)}
        title={
          renaming?.kind === "directory" ? "Rename folder" : "Rename document"
        }
        protectUnsaved
        label="New path"
        initial={renaming?.path ?? ""}
        submitLabel="Rename"
        onSubmit={async (destination) => {
          if (renaming) {
            await backend.moveLibrary(renaming.path, destination);
            setExpanded(
              (current) =>
                new Set(
                  [...current].map((item) =>
                    item === renaming.path ||
                    item.startsWith(`${renaming.path}/`)
                      ? destination + item.slice(renaming.path.length)
                      : item,
                  ),
                ),
            );
            if (path === renaming.path)
              navigate({ name: "library", path: destination });
            else if (path.startsWith(`${renaming.path}/`))
              navigate({
                name: "library",
                path: destination + path.slice(renaming.path.length),
              });
          }
          await load();
        }}
      />
      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(next) => !next && setDoomed(null)}
        title={`Delete ${doomed?.path ?? ""}?`}
        description={deleteConsequence(doomed, entries ?? [])}
        confirmLabel={
          doomed?.kind === "directory" ? "Delete folder" : "Delete document"
        }
        onConfirm={async () => {
          if (doomed) await backend.deleteLibrary(doomed.path);
          if (
            doomed &&
            (path === doomed.path || path.startsWith(`${doomed.path}/`))
          )
            navigate({ name: "library" });
          await load();
        }}
      />
    </Page>
  );
}
