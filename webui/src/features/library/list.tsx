import {
  File,
  FileText,
  FolderPlus,
  FolderTree as FolderTreeIcon,
  Plus,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useResource } from "@/app/organization";
import { useNavigate } from "@/app/router";
import { Page, PageBody, PageHeader, Toolbar } from "@/components/layout/shell";
import { LoadError } from "@/components/ui/access-error";
import { ConfirmDialog, Modal, PromptDialog } from "@/components/ui/dialog";
import {
  Button,
  IconButton,
  LoadingSkeleton,
  SearchField,
  Skeleton,
} from "@/components/ui/index";
import type { MenuAction } from "@/components/ui/menu";
import { StatePanel } from "@/components/ui/state-panel";
import { FolderTree } from "@/features/library/folder-tree";
import { mediaKind } from "@/features/library/media";
import { MediaGrid } from "@/features/library/media-grid";
import { expandedFolders } from "@/features/library/tree";
import { FileList } from "@/features/library/tree-view";
import { BackendError, backend, type LibraryEntry } from "@/lib/backend";
import { documentFolder, plural } from "@/lib/format";

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
      `A ${existing.kind === "directory" ? "folder" : "file"} with this name already exists at this location. Choose another name.`,
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
        throw new Error(
          "A file with this name already exists at this location. Choose another name.",
        );
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
            label: "New document inside",
            icon: <Plus size={15} />,
            onSelect: () =>
              handlers.create({ kind: "file", parent: entry.path }),
          },
          {
            id: "folder",
            label: "New folder inside",
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

export function deleteConsequence(
  entry: LibraryEntry | null,
  entries: LibraryEntry[],
): string {
  if (entry?.kind !== "directory")
    return "The document is removed for every Member.";
  const count = entries.filter(
    (item) => item.kind === "file" && item.path.startsWith(`${entry.path}/`),
  ).length;
  return `Removes ${plural(count, "file")} for every Member.`;
}

function CreateActions({
  onCreate,
  disabled = false,
}: {
  onCreate: (creation: Creation) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Button
        variant="primary"
        disabled={disabled}
        onClick={() => onCreate({ kind: "file", parent: "" })}
      >
        <Plus size={16} />
        New document
      </Button>
      <IconButton
        label="New folder"
        disabled={disabled}
        onClick={() => onCreate({ kind: "directory", parent: "" })}
      >
        <FolderPlus size={16} />
      </IconButton>
    </>
  );
}

export function LibraryPage({ folder = "" }: { folder?: string }) {
  const navigate = useNavigate();
  const read = useCallback(() => backend.library(), []);
  const { resource, refresh: load, invalidate } = useResource(read);
  const entries = resource.data;
  const failed = resource.error !== null;
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(() => expandedFolders(folder));
  const [treeOpen, setTreeOpen] = useState(false);
  const [creating, setCreating] = useState<Creation | null>(null);
  const [renaming, setRenaming] = useState<LibraryEntry | null>(null);
  const [doomed, setDoomed] = useState<LibraryEntry | null>(null);

  useEffect(() => {
    invalidate(true);
    void load();
    return () => invalidate(false);
  }, [load, invalidate]);

  useEffect(() => {
    setExpanded((current) => new Set([...current, ...expandedFolders(folder)]));
  }, [folder]);

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

  const needle = query.trim().toLowerCase();
  const files = (entries ?? []).filter((entry) => entry.kind === "file");
  const visible = needle
    ? files.filter((entry) => entry.path.toLowerCase().includes(needle))
    : files.filter((entry) => (documentFolder(entry.path) ?? "") === folder);
  const media = needle
    ? []
    : visible.filter((entry) => mediaKind(entry.path) !== null);
  const documents = needle
    ? visible
    : visible.filter((entry) => mediaKind(entry.path) === null);
  const folderEntry = (entries ?? []).find(
    (entry) => entry.kind === "directory" && entry.path === folder,
  );

  const selectFolder = (path: string) => {
    setTreeOpen(false);
    setQuery("");
    navigate({ name: "library", folder: path || undefined });
  };

  const actionsFor = (entry: LibraryEntry) =>
    libraryActions(entry, {
      rename: setRenaming,
      create: setCreating,
      remove: setDoomed,
    }).map((action) => ({ ...action, disabled: failed }));

  const tree =
    entries === null ? null : (
      <FolderTree
        entries={entries}
        expanded={expanded}
        selected={folder}
        onToggle={(path) =>
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          })
        }
        onSelect={selectFolder}
        rowActions={(path) => {
          const entry = entries.find(
            (item) => item.kind === "directory" && item.path === path,
          );
          return entry ? actionsFor(entry) : [];
        }}
      />
    );

  const empty = entries !== null && entries.length === 0;
  const currentEmpty = documents.length === 0 && media.length === 0;

  return (
    <Page>
      <PageHeader
        title="Library"
        actions={
          <CreateActions
            onCreate={setCreating}
            disabled={entries === null || failed || backend.disconnected}
          />
        }
      />
      <Toolbar>
        <span className="hidden max-[900px]:inline-flex">
          <IconButton label="Folders" onClick={() => setTreeOpen(true)}>
            <FolderTreeIcon size={16} />
          </IconButton>
        </span>
        <SearchField
          icon={<Search size={15} />}
          value={query}
          placeholder="Search documents"
          aria-label="Search documents"
          onChange={(event) => setQuery(event.target.value)}
        />
      </Toolbar>
      <PageBody variant="flush">
        {resource.error &&
        !(resource.error.transport && backend.disconnected) ? (
          <div className="px-8 pb-4">
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
            <div className="px-8 pt-2">
              <LoadingSkeleton label="Loading Library">
                {[1, 2, 3, 4, 5].map((row) => (
                  <div key={row} className="flex h-11 items-center gap-2">
                    <Skeleton className="size-4 shrink-0" />
                    <Skeleton className="w-40 max-w-full" />
                  </div>
                ))}
              </LoadingSkeleton>
            </div>
          )
        ) : (
          <div className="flex flex-1 min-h-0">
            <aside className="flex-none w-[232px] min-h-0 overflow-y-auto px-2 pb-6 max-[900px]:hidden">
              {tree}
            </aside>
            <div className="flex-1 min-w-0 min-h-0 overflow-y-auto px-8 pb-8 max-[900px]:px-3">
              {!needle && folderEntry === undefined && folder !== "" ? (
                <StatePanel
                  icons={[FolderPlus, FileText, File]}
                  title="This folder no longer exists"
                  description="Go back to the Library root and pick another folder."
                  action={{
                    label: "Back to Library",
                    icon: <X size={16} />,
                    onClick: () => selectFolder(""),
                  }}
                />
              ) : empty || currentEmpty ? (
                <StatePanel
                  icons={
                    needle
                      ? [FileText, Search, File]
                      : [File, FileText, FolderPlus]
                  }
                  title={
                    needle
                      ? "No documents match"
                      : empty
                        ? "The Library is empty"
                        : "This folder has no documents"
                  }
                  description={
                    needle
                      ? "Try a different name or clear the search to see the Library."
                      : empty
                        ? "Create a document or folder to share information with Members."
                        : "Create a document here, or open a folder from the tree."
                  }
                  action={
                    needle
                      ? {
                          label: "Clear search",
                          icon: <X size={16} />,
                          onClick: () => setQuery(""),
                        }
                      : {
                          label: "New document",
                          icon: <Plus size={16} />,
                          onClick: () =>
                            setCreating({ kind: "file", parent: folder }),
                        }
                  }
                  secondaryAction={
                    needle
                      ? undefined
                      : {
                          label: "New folder",
                          icon: <FolderPlus size={16} />,
                          onClick: () =>
                            setCreating({ kind: "directory", parent: folder }),
                        }
                  }
                />
              ) : (
                <div className="flex flex-col gap-6">
                  {media.length > 0 ? (
                    <section className="flex flex-col gap-3">
                      <h2 className="text-xs font-medium text-fg-muted">
                        Media
                      </h2>
                      <MediaGrid
                        entries={media}
                        onOpen={(path) => navigate({ name: "document", path })}
                        rowActions={actionsFor}
                      />
                    </section>
                  ) : null}
                  {documents.length > 0 ? (
                    <FileList
                      entries={documents}
                      query={query}
                      onOpen={(path) => navigate({ name: "document", path })}
                      rowActions={actionsFor}
                      label={
                        needle
                          ? "Search results"
                          : folder
                            ? `Documents in ${folder}`
                            : "Library documents"
                      }
                    />
                  ) : null}
                </div>
              )}
            </div>
          </div>
        )}
      </PageBody>
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
          } else {
            navigate({ name: "document", path: destination });
          }
          await load();
        }}
      />
      <PromptDialog
        open={renaming !== null}
        onOpenChange={(next) => !next && setRenaming(null)}
        title={
          renaming?.kind === "directory" ? "Rename folder" : "Rename document"
        }
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
          await load();
        }}
      />
    </Page>
  );
}
