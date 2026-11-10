import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LoadError } from "@/components/ui/access-error";
import {
  Button,
  Chip,
  Field,
  FieldSkeleton,
  Input,
  LoadingSkeleton,
  Spinner,
  toast,
} from "@/components/ui/index";
import {
  reportLoadFailure,
  useReportSettingsSave,
} from "@/features/settings/saver";
import { BackendError, backend } from "@/lib/backend";

export type ExecutionSettings = {
  write_directories: string[];
  read_directories: string[];
  restricts_reads: boolean;
  unusable_write_directories: { path: string; reason: string }[];
  unusable_read_directories: { path: string; reason: string }[];
  error: string | null;
};

type DirectoryRow = { id: number; path: string };
type DirectoryDraft = {
  rows: DirectoryRow[];
  editing: { id: number; value: string } | null;
  adding: string | null;
};
type FocusTarget = { id: number } | "add" | "new";

function draftDirectories(draft: DirectoryDraft): string[] {
  const paths = draft.rows.map((row) =>
    row.id === draft.editing?.id ? draft.editing.value : row.path,
  );
  if (draft.adding !== null && draft.adding !== "") paths.push(draft.adding);
  return paths;
}

function sameDirectories(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

export function cleanDirectories(directories: string[]): string[] {
  return [...new Set(directories.map((path) => path.trim()).filter(Boolean))];
}

export function executionUpdate(writes: string[], reads: string[]) {
  return {
    write_directories: cleanDirectories(writes),
    read_directories: cleanDirectories(reads),
  };
}

function completedRows(rows: DirectoryRow[]): DirectoryRow[] {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const path = row.path.trim();
    if (!path || seen.has(path)) return [];
    seen.add(path);
    return [{ ...row, path }];
  });
}

function DirectoryList({
  label,
  draft,
  onChange,
  saving,
  nextId,
  reasons = [],
  focusAfterSave,
}: {
  label: string;
  draft: DirectoryDraft;
  onChange: (draft: DirectoryDraft) => void;
  saving: RefObject<boolean>;
  nextId: RefObject<number>;
  reasons?: { path: string; reason: string }[];
  focusAfterSave?: RefObject<(() => void) | null>;
}) {
  const id = useId();
  const editInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<number, HTMLButtonElement>());
  const focusTarget = useRef<FocusTarget | null>(null);
  useLayoutEffect(() => {
    const target = focusTarget.current;
    if (target === null || saving.current) return;
    focusTarget.current = null;
    if (target === "new") addInput.current?.focus();
    else if (target === "add") (addInput.current ?? addButton.current)?.focus();
    else if (draft.editing?.id === target.id) editInput.current?.focus();
    else
      (
        editButtons.current.get(target.id) ??
        addInput.current ??
        addButton.current
      )?.focus();
  });
  if (focusAfterSave)
    focusAfterSave.current = () =>
      (editInput.current ?? addInput.current ?? addButton.current)?.focus();
  const completeEdit = () => {
    if (!draft.editing || saving.current) return;
    const editing = draft.editing;
    const rows = completedRows(
      draft.rows.map((row) =>
        row.id === editing.id ? { ...row, path: editing.value } : row,
      ),
    );
    const target = rows.find((row) => row.path === editing.value.trim());
    focusTarget.current = target ? { id: target.id } : "add";
    onChange({ ...draft, rows, editing: null });
  };
  const cancelEdit = () => {
    if (!draft.editing || saving.current) return;
    focusTarget.current = { id: draft.editing.id };
    onChange({ ...draft, editing: null });
  };
  const completeAdd = () => {
    if (saving.current) return;
    const path = (draft.adding ?? "").trim();
    const rows = [...draft.rows];
    if (
      path &&
      !cleanDirectories(
        rows
          .filter((row) => row.id !== draft.editing?.id)
          .map((row) => row.path),
      ).includes(path)
    )
      rows.push({ id: nextId.current++, path });
    focusTarget.current = "add";
    onChange({ ...draft, rows, adding: null });
  };
  const cancelAdd = () => {
    if (saving.current) return;
    focusTarget.current = "add";
    onChange({ ...draft, adding: null });
  };
  const inputKey = (
    event: KeyboardEvent<HTMLInputElement>,
    complete: () => void,
    cancel: () => void,
  ) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      complete();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  return (
    <Field label={<span id={id}>{label}</span>}>
      <ul
        aria-labelledby={id}
        className="m-0 flex min-w-0 list-none flex-col gap-2 p-0"
      >
        {draft.rows.map((row) => {
          const editing = draft.editing?.id === row.id;
          const path = editing ? draft.editing?.value : row.path;
          const reason = reasons.find((item) => item.path === path)?.reason;
          return (
            <li
              key={row.id}
              className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface p-3"
            >
              {editing ? (
                <>
                  <Input
                    ref={editInput}
                    aria-label="Edit directory path"
                    value={draft.editing?.value ?? ""}
                    onChange={(event) => {
                      if (saving.current) return;
                      onChange({
                        ...draft,
                        editing: { id: row.id, value: event.target.value },
                      });
                    }}
                    onKeyDown={(event) =>
                      inputKey(event, completeEdit, cancelEdit)
                    }
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" onClick={cancelEdit}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={completeEdit}>
                      Done
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                  <span className="min-w-0 flex-1 basis-40 whitespace-pre-wrap font-mono text-sm wrap-anywhere">
                    {row.path}
                  </span>
                  <div className="flex min-w-0 max-w-full flex-wrap gap-1">
                    <Button
                      ref={(button) => {
                        if (button) editButtons.current.set(row.id, button);
                        else editButtons.current.delete(row.id);
                      }}
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${row.path}`}
                      onClick={() => {
                        if (saving.current) return;
                        const rows = draft.rows.map((item) =>
                          item.id === draft.editing?.id
                            ? { ...item, path: draft.editing.value }
                            : item,
                        );
                        focusTarget.current = { id: row.id };
                        onChange({
                          ...draft,
                          rows,
                          editing: { id: row.id, value: row.path },
                        });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${row.path}`}
                      onClick={() => {
                        if (saving.current) return;
                        const index = draft.rows.findIndex(
                          (item) => item.id === row.id,
                        );
                        const rows = draft.rows.filter(
                          (item) => item.id !== row.id,
                        );
                        const target = rows[Math.min(index, rows.length - 1)];
                        focusTarget.current = target
                          ? { id: target.id }
                          : "add";
                        onChange({ ...draft, rows });
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              )}
              {reason ? (
                <div className="flex min-w-0 flex-wrap gap-2 [&>span]:h-auto [&>span]:min-h-5 [&>span]:min-w-0 [&>span]:max-w-full [&>span]:whitespace-normal [&>span]:wrap-anywhere [&>span]:leading-body">
                  <Chip tone="warning">{reason}</Chip>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {draft.adding !== null ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface p-3">
          <Input
            ref={addInput}
            aria-label="New directory path"
            value={draft.adding}
            onChange={(event) => {
              if (saving.current) return;
              onChange({ ...draft, adding: event.target.value });
            }}
            onKeyDown={(event) => inputKey(event, completeAdd, cancelAdd)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={cancelAdd}>
              Cancel
            </Button>
            <Button size="sm" onClick={completeAdd}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
      <div>
        <Button
          ref={addButton}
          size="sm"
          disabled={draft.adding !== null}
          onClick={() => {
            if (saving.current) return;
            focusTarget.current = "new";
            onChange({ ...draft, adding: "" });
          }}
        >
          Add directory
        </Button>
      </div>
    </Field>
  );
}

export function ExecutionForm({
  initial,
  onSave,
}: {
  initial: ExecutionSettings;
  onSave: (
    values: ReturnType<typeof executionUpdate>,
  ) => Promise<ExecutionSettings>;
}) {
  const nextId = useRef(0);
  const createDraft = useCallback((paths: string[]): DirectoryDraft => {
    return {
      rows: paths.map((path) => ({ id: nextId.current++, path })),
      editing: null,
      adding: null,
    };
  }, []);
  const saving = useRef(false);
  const writeFocus = useRef<(() => void) | null>(null);
  const [info, setInfo] = useState(initial);
  const [writes, setWrites] = useState(() =>
    createDraft(initial.write_directories),
  );
  const [reads, setReads] = useState(() =>
    createDraft(initial.read_directories),
  );
  const [busy, setBusy] = useState(false);
  useReportSettingsSave("execution", busy);
  const previous = useRef(initial);
  useEffect(() => {
    const old = previous.current;
    if (initial === old) return;
    previous.current = initial;
    if (saving.current) return;
    setWrites((current) =>
      sameDirectories(draftDirectories(current), old.write_directories)
        ? createDraft(initial.write_directories)
        : current,
    );
    setReads((current) =>
      sameDirectories(draftDirectories(current), old.read_directories)
        ? createDraft(initial.read_directories)
        : current,
    );
    setInfo(initial);
  }, [initial, createDraft]);
  const values = executionUpdate(
    draftDirectories(writes),
    draftDirectories(reads),
  );
  const changed =
    !sameDirectories(values.write_directories, info.write_directories) ||
    !sameDirectories(values.read_directories, info.read_directories) ||
    info.error !== null;
  const save = async () => {
    if (saving.current || !changed) return;
    saving.current = true;
    setBusy(true);
    try {
      const result = await onSave(values);
      previous.current = result;
      setInfo(result);
      setWrites(createDraft(result.write_directories));
      setReads(createDraft(result.read_directories));
    } catch (failure) {
      if (failure instanceof BackendError && failure.transport)
        backend.reportFailure(failure);
      else
        toast({
          tone: "danger",
          title: "Could not save",
          description:
            failure instanceof Error ? failure.message : String(failure),
        });
    } finally {
      saving.current = false;
      setBusy(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) writeFocus.current?.();
      });
    }
  };
  return (
    <form
      className="m-0 flex w-full max-w-[720px] min-w-0 flex-col gap-4 border-0 p-0 [&_button]:h-auto [&_button]:min-h-[26px] [&_button]:max-w-full [&_button]:flex-wrap [&_button]:whitespace-normal [&_button]:wrap-anywhere"
      aria-label="Execution settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {info.error ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 [&>span]:h-auto [&>span]:min-h-5 [&>span]:min-w-0 [&>span]:max-w-full [&>span]:whitespace-normal [&>span]:wrap-anywhere [&>span]:leading-body">
          <Chip tone="danger">Unavailable</Chip>
          <span className="min-w-0 flex-1 text-sm text-fg-muted wrap-anywhere">
            {info.error}
          </span>
        </div>
      ) : null}
      <fieldset
        className="m-0 flex w-full max-w-[720px] min-w-0 flex-col gap-4 border-0 p-0"
        disabled={busy}
      >
        <DirectoryList
          label="Writable directories"
          draft={writes}
          onChange={setWrites}
          saving={saving}
          nextId={nextId}
          reasons={info.unusable_write_directories}
          focusAfterSave={writeFocus}
        />
        {info.restricts_reads ? (
          <DirectoryList
            label="Readable directories"
            draft={reads}
            onChange={setReads}
            saving={saving}
            nextId={nextId}
            reasons={info.unusable_read_directories}
          />
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-3 pt-1 [&>button]:min-h-8">
          <Button
            variant="primary"
            type="submit"
            aria-label="Save"
            disabled={!changed || busy}
          >
            {busy ? <Spinner label="Saving execution settings" /> : null}
            Save
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function ExecutionPanel() {
  const [info, setInfo] = useState<ExecutionSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadError, setLoadError] = useState<BackendError | null>(null);
  const generation = useRef(0);
  const saving = useRef(false);
  const load = useCallback(async () => {
    if (saving.current) return;
    const current = ++generation.current;
    setFailed(false);
    setLoadError(null);
    try {
      const result = (await backend.settings("execution")) as ExecutionSettings;
      if (current === generation.current) {
        setInfo(result);
        setFailed(false);
      }
    } catch (failure) {
      if (current === generation.current) {
        setFailed(true);
        setLoadError(reportLoadFailure(failure));
      }
    }
  }, []);
  useEffect(() => {
    void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.restored") void load();
    });
    return () => {
      generation.current++;
      off();
    };
  }, [load]);
  const recovery =
    loadError && !(loadError.transport && backend.disconnected) ? (
      <LoadError error={loadError} retry={() => void load()} />
    ) : null;
  if (!info)
    return failed ? (
      recovery
    ) : (
      <LoadingSkeleton label="Loading execution settings">
        {["target", "directory", "permissions"].map((field) => (
          <FieldSkeleton key={field} />
        ))}
      </LoadingSkeleton>
    );
  return (
    <>
      {recovery}
      <ExecutionForm
        initial={info}
        onSave={async (values) => {
          generation.current++;
          saving.current = true;
          try {
            const result = (await backend.updateSettings(
              "execution",
              info.restricts_reads &&
                !sameDirectories(values.read_directories, info.read_directories)
                ? values
                : { write_directories: values.write_directories },
            )) as ExecutionSettings;
            setInfo(result);
            return result;
          } finally {
            generation.current++;
            saving.current = false;
          }
        }}
      />
    </>
  );
}
