import { Eye, Save, SquarePen, Trash2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Route, useNavigate, useRouter } from "@/app/router";
import {
  type Crumb,
  Page,
  PageBody,
  PageHeader,
} from "@/components/layout/shell";
import { LoadError } from "@/components/ui/access-error";
import { ConfirmDialog, Modal, PromptDialog } from "@/components/ui/dialog";
import { ImageViewer } from "@/components/ui/image-viewer";
import {
  Button,
  Chip,
  dismissToast,
  EmptyState,
  IconButton,
  LoadingSkeleton,
  Skeleton,
  Spinner,
  Textarea,
  toast,
} from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { type MediaKind, mediaKind } from "@/features/library/media";
import { MarkdownContent } from "@/features/markdown";
import { reportLoadFailure } from "@/features/settings/saver";
import { BackendError, backend } from "@/lib/backend";
import { documentName, formatBytes } from "@/lib/format";

type Loaded = { content: string; hash: string };

function conflictToastId(path: string): string {
  return `document-conflict:${path}`;
}

const conflictDescription =
  "Your unsaved changes are preserved. Reopen replaces them with the current document.";

export function documentCrumbs(
  path: string,
  navigate: (route: Route) => void,
  size?: string,
): Crumb[] {
  const parts = path.split("/");
  return [
    { label: "Library", onSelect: () => navigate({ name: "library" }) },
    ...parts.map((label, index) => ({
      label,
      hint: index === parts.length - 1 ? size : undefined,
      onSelect: () =>
        navigate({
          name: "library",
          path:
            (index === parts.length - 1
              ? parts.slice(0, index).join("/")
              : parts.slice(0, index + 1).join("/")) || undefined,
        }),
    })),
  ];
}

function DocumentFrame({
  path,
  actions,
  status,
  size,
  menuDisabled = false,
  children,
  embedded = false,
}: {
  path: string;
  actions?: ReactNode;
  status?: ReactNode;
  size?: string;
  menuDisabled?: boolean;
  children: ReactNode;
  embedded?: boolean;
}) {
  const navigate = useNavigate();
  const crumb = documentCrumbs(path, navigate, size);
  const [renaming, setRenaming] = useState(false);
  const [doomed, setDoomed] = useState(false);
  if (embedded)
    return <div className="flex flex-1 min-h-0 flex-col">{children}</div>;
  return (
    <Page>
      <PageHeader
        title={<span className="text-2xl font-semibold">{path}</span>}
        crumb={crumb}
        actions={
          <>
            {status}
            {actions}
            <OverflowMenu
              label={`Actions for ${path}`}
              actions={[
                {
                  id: "rename",
                  label: "Rename",
                  disabled: menuDisabled,
                  icon: <SquarePen size={15} />,
                  onSelect: () => setRenaming(true),
                },
                {
                  id: "delete",
                  label: "Delete",
                  disabled: menuDisabled,
                  icon: <Trash2 size={15} />,
                  tone: "danger",
                  onSelect: () => setDoomed(true),
                },
              ]}
            />
          </>
        }
      />
      <PageBody variant="flush">{children}</PageBody>
      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename document"
        protectUnsaved
        label="New path"
        initial={path}
        submitLabel="Rename"
        onSubmit={async (destination) => {
          const moved = await backend.moveLibrary(path, destination);
          setRenaming(false);
          navigate({ name: "library", path: moved.path });
        }}
      />
      <ConfirmDialog
        open={doomed}
        onOpenChange={setDoomed}
        title={`Delete ${path}?`}
        description="The document is removed for every Member. This cannot be undone."
        confirmLabel="Delete document"
        onConfirm={async () => {
          await backend.deleteLibrary(path);
          setDoomed(false);
          navigate({
            name: "library",
            path: path.includes("/")
              ? path.slice(0, path.lastIndexOf("/"))
              : undefined,
          });
        }}
      />
    </Page>
  );
}

export function DocumentUnavailable({
  code,
}: {
  code: "not_found" | "not_readable";
}) {
  return (
    <EmptyState
      title={
        code === "not_readable"
          ? "Cannot read this file as UTF-8 text"
          : "Document not found"
      }
    />
  );
}

export function DocumentBody({ path }: { path: string }) {
  const kind = mediaKind(path);
  return kind === null ? (
    <TextDocument path={path} embedded />
  ) : (
    <MediaDocument path={path} kind={kind} embedded />
  );
}

function TextDocument({
  path,
  embedded,
}: {
  path: string;
  embedded?: boolean;
}) {
  const navigate = useNavigate();
  const { registerNavigationBlocker } = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState("");
  const [unavailable, setUnavailable] = useState<
    "not_found" | "not_readable" | null
  >(null);
  const [failed, setFailed] = useState(false);
  const [loadError, setLoadError] = useState<BackendError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(true);

  const editing = useRef({ loaded, draft });
  editing.current = { loaded, draft };
  const loadRevision = useRef(0);
  const refreshing = useRef<Promise<void> | null>(null);
  const refreshDirty = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = useRef(true);
  const clearTimer = useCallback(() => {
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
  }, []);

  const load = useCallback(
    (preserve = false): Promise<void> => {
      if (!connected.current) return Promise.resolve();
      clearTimer();
      if (preserve && refreshing.current) {
        refreshDirty.current = true;
        return refreshing.current;
      }
      if (!preserve) loadRevision.current += 1;
      setLoadError(null);
      if (editing.current.loaded === null) {
        setFailed(false);
        setUnavailable(null);
      }
      const revision = loadRevision.current;
      const operation = Promise.resolve().then(async () => {
        if (revision !== loadRevision.current) return;
        let keepDraft = preserve;
        try {
          do {
            refreshDirty.current = false;
            try {
              const document = await backend.readLibrary(path);
              if (revision !== loadRevision.current) return;
              const current = editing.current;
              if (
                keepDraft &&
                current.loaded &&
                current.draft !== current.loaded.content
              ) {
                if (document.hash !== current.loaded.hash)
                  toast({
                    id: conflictToastId(path),
                    tone: "danger",
                    title: "Saved elsewhere",
                    description: conflictDescription,
                    duration: null,
                    action: { label: "Reopen", onClick: () => void load() },
                  });
              } else {
                const value = {
                  content: document.content,
                  hash: document.hash,
                };
                editing.current = { loaded: value, draft: document.content };
                setLoaded(value);
                setDraft(document.content);
                dismissToast(conflictToastId(path));
              }
              setUnavailable(null);
              setFailed(false);
              setLoadError(null);
            } catch (failure) {
              if (revision !== loadRevision.current) return;
              setFailed(true);
              if (
                failure instanceof BackendError &&
                (failure.code === "not_found" ||
                  failure.code === "not_readable")
              ) {
                setUnavailable(failure.code);
              } else {
                setLoadError(reportLoadFailure(failure));
              }
            }
            keepDraft = true;
          } while (refreshDirty.current && revision === loadRevision.current);
        } finally {
          if (refreshing.current === operation) refreshing.current = null;
        }
      });
      refreshing.current = operation;
      return operation;
    },
    [clearTimer, path],
  );

  useEffect(() => {
    connected.current = true;
    const schedule = () => {
      if (!connected.current) return;
      if (refreshing.current) {
        refreshDirty.current = true;
      } else if (refreshTimer.current === null) {
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          void load(true);
        }, 150);
      }
    };
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        connected.current = false;
        clearTimer();
        loadRevision.current += 1;
        refreshing.current = null;
        refreshDirty.current = false;
      }
      if (event.type === "connection.restored") {
        connected.current = true;
        void load(true);
      }
      if (event.type === "library.updated" && event.path === path) schedule();
      if (
        event.type === "turn.finished" &&
        (refreshTimer.current !== null || refreshing.current !== null)
      )
        void load(true);
    });
    void load();
    return () => {
      connected.current = false;
      clearTimer();
      loadRevision.current += 1;
      refreshing.current = null;
      refreshDirty.current = false;
      off();
    };
  }, [clearTimer, load, path]);

  useEffect(() => () => dismissToast(conflictToastId(path)), [path]);

  const dirty = loaded !== null && draft !== loaded.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [discardNavigation, setDiscardNavigation] = useState<
    (() => void) | null
  >(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  useEffect(
    () =>
      registerNavigationBlocker((_next, proceed) => {
        if (!dirtyRef.current) return false;
        setDiscardNavigation(() => proceed);
        return true;
      }),
    [registerNavigationBlocker],
  );
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const crumb = documentCrumbs(path, navigate);

  const save = async () => {
    if (!dirty || loaded === null) return;
    setBusy(true);
    setSaveError(null);
    try {
      const result = await backend.writeLibrary(path, draft, loaded.hash);
      if (result.conflict) {
        toast({
          id: conflictToastId(path),
          tone: "danger",
          title: "Saved elsewhere",
          description: conflictDescription,
          duration: null,
          action: { label: "Reopen", onClick: () => void load() },
        });
        return;
      }
      clearTimer();
      loadRevision.current += 1;
      refreshing.current = null;
      refreshDirty.current = false;
      const value = { content: draft, hash: result.hash };
      editing.current = { ...editing.current, loaded: value };
      setLoaded(value);
    } catch (failure) {
      if (failure instanceof BackendError && failure.transport)
        backend.reportFailure(failure);
      else
        setSaveError(
          failure instanceof Error ? failure.message : String(failure),
        );
    } finally {
      setBusy(false);
    }
  };

  if (unavailable && loaded === null) {
    return (
      <Page>
        <PageHeader title={path} crumb={crumb} />
        <PageBody>
          <DocumentUnavailable code={unavailable} />
        </PageBody>
      </Page>
    );
  }

  return (
    <DocumentFrame
      path={path}
      embedded={embedded}
      menuDisabled={loaded === null || failed}
      actions={
        <>
          <IconButton
            label={preview ? "Edit document" : "Preview document"}
            disabled={loaded === null}
            onClick={() => setPreview((value) => !value)}
          >
            {preview ? <SquarePen size={16} /> : <Eye size={16} />}
          </IconButton>
          <Button
            variant="primary"
            disabled={!dirty || busy || failed}
            onClick={save}
          >
            {busy ? <Spinner label="Saving document" /> : <Save size={16} />}
            Save
          </Button>
        </>
      }
      size={
        loaded === null
          ? undefined
          : formatBytes(new TextEncoder().encode(draft).length)
      }
      status={dirty ? <Chip tone="blue">Unsaved changes</Chip> : null}
    >
      <div className="flex flex-1 min-h-0 flex-col gap-4 px-8 pb-6">
        {saveError ? (
          <p role="alert" className="text-sm text-danger">
            {saveError}
          </p>
        ) : null}
        {unavailable ? <DocumentUnavailable code={unavailable} /> : null}
        {loadError && !(loadError.transport && backend.disconnected) ? (
          <LoadError error={loadError} retry={() => void load(true)} />
        ) : null}
        {loaded === null ? (
          failed ? null : (
            <LoadingSkeleton label="Loading document">
              {["90%", "75%", "85%", "50%"].map((width) => (
                <Skeleton key={width} style={{ width }} />
              ))}
            </LoadingSkeleton>
          )
        ) : preview ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-[72ch]">
              <MarkdownContent source={draft} identity={`library:${path}`} />
            </div>
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-[72ch] flex-1 min-h-0 grid-rows-[minmax(0,1fr)] items-stretch font-mono tracking-[0] leading-[1.6] [&_textarea]:leading-[1.6]">
            <Textarea
              aria-label="Document"
              readOnly={failed}
              value={draft}
              spellCheck={false}
              onChange={(event) => {
                editing.current.draft = event.target.value;
                setDraft(event.target.value);
              }}
            />
          </div>
        )}
      </div>
      <Modal
        open={discardNavigation !== null}
        onOpenChange={(next) => {
          if (!next) setDiscardNavigation(null);
        }}
        title="Discard unsaved changes?"
        variant="confirm"
        description="Your changes have not been saved."
        initialFocus={() => keepEditing.current}
        footer={
          <>
            <Button
              ref={keepEditing}
              onClick={() => setDiscardNavigation(null)}
            >
              Keep Editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const proceed = discardNavigation;
                setDiscardNavigation(null);
                proceed?.();
              }}
            >
              Discard
            </Button>
          </>
        }
      />
    </DocumentFrame>
  );
}

type MediaState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; url: string; size: number };

function MediaDocument({
  path,
  kind,
  embedded,
}: {
  path: string;
  kind: MediaKind;
  embedded?: boolean;
}) {
  const [state, setState] = useState<MediaState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState(false);
  const images = useMemo(
    () =>
      state.status === "ready"
        ? [{ src: state.url, name: documentName(path), alt: path }]
        : [],
    [state, path],
  );

  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    void backend.libraryFile(path, abort.signal).then(
      (blob) => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectUrl, size: blob.size });
      },
      (failure: unknown) => {
        if (abort.signal.aborted) return;
        setState({
          status: "error",
          message: failure instanceof Error ? failure.message : String(failure),
        });
      },
    );
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, attempt]);

  return (
    <DocumentFrame
      path={path}
      embedded={embedded}
      size={state.status === "ready" ? formatBytes(state.size) : undefined}
      menuDisabled={state.status === "loading"}
    >
      <div className="flex flex-1 min-h-0 items-center justify-center p-8">
        {state.status === "loading" ? (
          <Spinner label="Loading file" />
        ) : state.status === "error" ? (
          <div
            role="alert"
            className="flex max-w-[520px] flex-col items-center gap-3 text-sm"
          >
            <p className="text-center break-words text-danger">
              {state.message}
            </p>
            <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </Button>
          </div>
        ) : kind === "image" ? (
          <button
            type="button"
            aria-label={`View ${documentName(path)}`}
            className="flex size-full min-h-0 cursor-zoom-in items-center justify-center"
            onClick={() => setOpened(true)}
          >
            <img
              src={state.url}
              alt={path}
              className="max-h-full max-w-full object-contain"
              onError={() =>
                setState({
                  status: "error",
                  message: "Image could not be loaded.",
                })
              }
            />
          </button>
        ) : kind === "video" ? (
          <video src={state.url} controls className="max-h-full max-w-full" />
        ) : (
          <audio src={state.url} controls className="w-full max-w-[520px]" />
        )}
      </div>
      <ImageViewer
        open={opened}
        images={images}
        onClose={() => setOpened(false)}
      />
    </DocumentFrame>
  );
}
