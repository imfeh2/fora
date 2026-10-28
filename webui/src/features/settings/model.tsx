import {
  CircleHelp,
  Eye,
  EyeOff,
  Pencil,
  Save,
  Search,
  Settings,
} from "lucide-react";
import {
  type CSSProperties,
  type FormEventHandler,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useRouter } from "@/app/router";
import {
  ColumnResizeHandle,
  useColumnWidth,
} from "@/components/layout/column-resize";
import { LoadError } from "@/components/ui/access-error";
import { Choices } from "@/components/ui/choices";
import { Combobox } from "@/components/ui/combobox";
import { ConfirmDialog, DialogActions, Modal } from "@/components/ui/dialog";
import {
  Button,
  Chip,
  EmptyState,
  Field,
  FieldSkeleton,
  IconButton,
  Input,
  LoadingSkeleton,
  SearchField,
  Select,
  Spinner,
  Textarea,
  toast,
} from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { parseRequestBody } from "@/features/settings/request-body";
import {
  reportLoadFailure,
  useReportSettingsSave,
} from "@/features/settings/saver";
import {
  type AgentModelConfig,
  BackendError,
  backend,
  type ModelCatalog,
  type ProviderConfig,
  type RegisteredModel,
  type Thinking,
} from "@/lib/backend";

const PROVIDERS = [
  { value: "openai-chat", label: "OpenAI Chat" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
];

const THINKING_OPTIONS: Thinking[] = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function supportsTokenBudget(apiType: string): boolean {
  return apiType === "anthropic" || apiType === "google";
}

function thinkingLabel(option: Thinking, budget?: number | null): string {
  const value =
    typeof budget === "number" ? budget.toLocaleString("en-US") : budget;
  return option === "budget" ? `budget (${value} tokens)` : option;
}

export function modelTestDescription(latency: number, reply: string): string {
  return `${latency.toLocaleString("en-US")} ms, ${reply.trim().replace(/\s+/g, " ").slice(0, 80)}`;
}

export function ModelSelection({
  catalog,
  value,
  onChange,
  inherit = true,
}: {
  catalog: ModelCatalog;
  value: AgentModelConfig;
  onChange: (value: AgentModelConfig) => void;
  inherit?: boolean;
}) {
  const id = useId();
  const selected = catalog.models.find(
    (model) =>
      model.id ===
      (value.model_id ?? (inherit ? catalog.default_model_id : null)),
  );
  const options = selected?.thinking_options ?? THINKING_OPTIONS;
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Model"
        action={
          value.model_id === null && inherit && selected ? (
            <span className="rounded-full border border-line px-1.5 text-[10px] font-medium text-fg-muted">
              <span className="sr-only">Effective model </span>
              {selected.name}
            </span>
          ) : undefined
        }
        htmlFor={`${id}-model`}
      >
        <Select
          id={`${id}-model`}
          value={value.model_id ?? ""}
          onChange={(event) =>
            onChange({ ...value, model_id: event.target.value || null })
          }
        >
          <option value="">
            {inherit ? "Use global default" : "Not configured"}
          </option>
          {catalog.providers.map((provider) => (
            <optgroup
              key={provider.id}
              label={provider.name}
              disabled={!provider.enabled}
            >
              {catalog.models
                .filter((model) => model.provider_id === provider.id)
                .map((model) => (
                  <option
                    key={model.id}
                    value={model.id}
                    disabled={!model.enabled}
                  >
                    {model.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <Field label="Thinking effort" htmlFor={`${id}-thinking`}>
        <Select
          id={`${id}-thinking`}
          value={value.thinking ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              thinking: (event.target.value || null) as Thinking | null,
            })
          }
        >
          {inherit ? (
            <option value="">
              Use global default ({catalog.default_thinking})
            </option>
          ) : null}
          {value.thinking && !options.includes(value.thinking) ? (
            <option value={value.thinking} disabled>
              {value.thinking} (unavailable for this model)
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option} value={option}>
              {thinkingLabel(option, selected?.thinking_budget_tokens)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function AgentCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const id = useId();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState<AgentModelConfig>({
    model_id: null,
    thinking: null,
  });
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await backend.modelCatalog();
      if (current !== generation.current) return;
      setCatalog(result);
      setLoadError(null);
    } catch (error) {
      if (current === generation.current)
        setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => {
    void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.restored") void load();
    });
    return () => {
      generation.current += 1;
      off();
    };
  }, [load]);
  const create = async () => {
    if (!catalog || !name.trim() || busy) return;
    setBusy(true);
    let created = false;
    try {
      await backend.createAgent(name.trim(), value);
      created = true;
    } catch (error) {
      if (error instanceof BackendError && error.transport)
        backend.reportFailure(error);
      else
        toast({
          tone: "danger",
          title: "Could not create Agent",
          description: error instanceof Error ? error.message : String(error),
        });
    } finally {
      setBusy(false);
    }
    if (!created) return;
    onClose();
    try {
      await onCreated();
    } catch (error) {
      backend.reportFailure(error);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="New Agent"
      variant="form"
      footer={
        <DialogActions
          cancel={
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          }
        >
          <Button
            variant="primary"
            disabled={!catalog || !name.trim() || busy}
            onClick={() => void create()}
          >
            {busy ? <Spinner label="Creating Agent" /> : null}
            Create Agent
          </Button>
        </DialogActions>
      }
    >
      {loadError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-danger"
        >
          <span>{loadError}</span>
          <Button disabled={busy} onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}
      <fieldset
        className="flex flex-col gap-4 border-0 p-0"
        disabled={busy || !catalog}
      >
        <Field label="Name" htmlFor={id}>
          <Input
            id={id}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {catalog ? (
          <ModelSelection catalog={catalog} value={value} onChange={setValue} />
        ) : !loadError ? (
          <LoadingSkeleton label="Loading models">
            <FieldSkeleton />
            <FieldSkeleton />
          </LoadingSkeleton>
        ) : null}
      </fieldset>
    </Modal>
  );
}

type SaveModel = (
  action: string,
  id: string | number | null,
  values?: Record<string, unknown>,
  onBodyError?: (message: string) => void,
) => Promise<boolean>;

export function ModelPanel({
  view = "models",
}: {
  view?: "providers" | "models";
}) {
  const { registerNavigationBlocker } = useRouter();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editProvider, setEditProvider] = useState(false);
  const column = useColumnWidth({
    storageKey: "fora.providers-width",
    initial: 248,
    min: 200,
    max: 480,
  });
  const [deleteProvider, setDeleteProvider] = useState<ProviderConfig | null>(
    null,
  );
  const [session, setSession] = useState<{
    provider: ProviderConfig;
    models: RegisteredModel[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(true);
  const online = useRef(true);
  const [loadError, setLoadError] = useState<BackendError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const defaultDirty = useRef(false);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const reading = useRef<number | null>(null);
  const saving = useRef(false);
  const mounted = useRef(true);
  const connectionGeneration = useRef(0);
  const refreshPending = useRef(false);
  const drafts = useRef(new Map<string, boolean>());
  const [hasDrafts, setHasDrafts] = useState(false);
  const reportDefaults = useCallback((dirty: boolean) => {
    defaultDirty.current = dirty;
    setHasDrafts(dirty || Array.from(drafts.current.values()).some(Boolean));
  }, []);
  const editor = useRef<HTMLFieldSetElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [connectionDirty, setConnectionDirty] = useState(false);
  useReportSettingsSave("model", busy);
  const load = useCallback(async (): Promise<void> => {
    if (!online.current || saving.current || reading.current !== null) {
      refreshPending.current = true;
      return;
    }
    const request = ++generation.current;
    reading.current = request;
    setLoadError(null);
    try {
      const loaded = await backend.modelCatalog();
      if (request !== generation.current) return;
      setCatalog(loaded);
      setError(null);
      setReviewed(true);
    } catch (failure) {
      if (request === generation.current) {
        setLoadError(reportLoadFailure(failure));
      }
    } finally {
      if (request === generation.current && reading.current === request) {
        reading.current = null;
        if (refreshPending.current && !saving.current) {
          refreshPending.current = false;
          void load();
        }
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const off = backend.onEvent((event) => {
      if (
        event.type === "connection.closed" ||
        event.type === "connection.reconnecting" ||
        event.type === "connection.restored"
      ) {
        online.current = event.type === "connection.restored";
        setConnected(online.current);
        connectionGeneration.current += 1;
        setReviewed(false);
        if (saving.current) setUncertain(true);
        generation.current += 1;
        reading.current = null;
        refreshPending.current = false;
        if (online.current) void load();
      }
      if (event.type === "settings.updated" && event.section === "model")
        void load();
    });
    return () => {
      mounted.current = false;
      connectionGeneration.current += 1;
      generation.current += 1;
      reading.current = null;
      refreshPending.current = false;
      off();
    };
  }, [load]);
  useEffect(() => {
    if (!catalog || !selected || selected === "new") return;
    setSession((previous) => {
      const provider = catalog.providers.find((item) => item.id === selected);
      const retained = previous?.provider.id === selected ? previous : null;
      const target = provider ?? retained?.provider;
      if (!target) return null;
      const current = catalog.models.filter(
        (item) => item.provider_id === selected,
      );
      return {
        provider: target,
        models: [
          ...current,
          ...(retained?.models.filter(
            (item) => !current.some((model) => model.id === item.id),
          ) ?? []),
        ],
      };
    });
  }, [catalog, selected]);
  useEffect(
    () =>
      registerNavigationBlocker((_next, proceed) => {
        if (saving.current) return true;
        if (
          defaultDirty.current ||
          Array.from(drafts.current.values()).some(Boolean)
        ) {
          setDiscard(() => proceed);
          return true;
        }
        return false;
      }),
    [registerNavigationBlocker],
  );
  useEffect(() => {
    if (!busy && !hasDrafts) return;
    const guard = (event: BeforeUnloadEvent) => {
      if (
        saving.current ||
        defaultDirty.current ||
        Array.from(drafts.current.values()).some(Boolean)
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [busy, hasDrafts]);
  useEffect(() => {
    if (selected)
      editor.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [selected]);
  const providerDraft = useCallback((dirty: boolean, connection: boolean) => {
    drafts.current.set("provider", dirty);
    setHasDrafts(
      defaultDirty.current || Array.from(drafts.current.values()).some(Boolean),
    );
    setConnectionDirty(connection);
  }, []);
  const modelDraft = useCallback((id: string, dirty: boolean) => {
    drafts.current.set(id, dirty);
    setHasDrafts(
      defaultDirty.current || Array.from(drafts.current.values()).some(Boolean),
    );
  }, []);
  const resetEditor = () => {
    drafts.current.clear();
    setHasDrafts(defaultDirty.current);
    setConnectionDirty(false);
    setRevision((value) => value + 1);
  };
  const choose = (id: string | null, edit = false) => {
    if (saving.current) return;
    if (id === selected) {
      setEditProvider(edit);
      return;
    }
    const proceed = () => {
      resetEditor();
      const provider = catalog?.providers.find((item) => item.id === id);
      setSession(
        provider
          ? {
              provider,
              models:
                catalog?.models.filter(
                  (item) => item.provider_id === provider.id,
                ) ?? [],
            }
          : null,
      );
      setSelected(id);
      setEditProvider(edit || id === "new");
      setError(null);
      if (id === null)
        requestAnimationFrame(() => {
          const target =
            opener.current?.isConnected === true
              ? opener.current
              : (document.querySelector<HTMLElement>("[data-provider-add]") ??
                document.querySelector<HTMLElement>("[data-nav]"));
          target?.focus();
        });
    };
    if (Array.from(drafts.current.values()).some(Boolean))
      setDiscard(() => proceed);
    else proceed();
  };
  const save: SaveModel = async (action, id, values = {}, onBodyError) => {
    if (!online.current || saving.current || uncertain) return false;
    if (
      (action === "save_provider" && id === null && selected !== "new") ||
      ((action === "save_provider" || action === "delete_provider") &&
        id !== null &&
        !catalog?.providers.some((item) => item.id === id)) ||
      ((action === "save_model" || action === "delete_model") &&
        id !== null &&
        !catalog?.models.some((item) => item.id === id)) ||
      (action === "save_model" &&
        id === null &&
        !catalog?.providers.some((item) => item.id === values.provider_id))
    ) {
      return false;
    }
    saving.current = true;
    const connection = connectionGeneration.current;
    generation.current += 1;
    reading.current = null;
    setBusy(true);
    setError(null);
    const focus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    try {
      const updated = await backend.configureModel(action, id, values);
      if (!mounted.current || connection !== connectionGeneration.current)
        return false;
      generation.current += 1;
      setCatalog(updated);
      setLoadError(null);
      if (action === "save_provider" && id === null) {
        const created = updated.providers.filter(
          (item) => !catalog?.providers.some((old) => old.id === item.id),
        );
        drafts.current.delete("provider");
        setSelected(created.length === 1 ? created[0].id : null);
      }
      if (action === "delete_model" && typeof id === "string") {
        drafts.current.delete(id);
        setSession((previous) =>
          previous
            ? {
                ...previous,
                models: previous.models.filter((item) => item.id !== id),
              }
            : null,
        );
      }
      return true;
    } catch (failure) {
      if (!mounted.current || connection !== connectionGeneration.current)
        return false;
      setError(failure instanceof Error ? failure.message : String(failure));
      if (
        onBodyError &&
        failure instanceof BackendError &&
        ["invalid_request_body", "unsupported_request_body"].includes(
          failure.code,
        )
      ) {
        onBodyError(failure.message);
        setError(null);
      }
      if (failure instanceof BackendError && failure.transport) {
        setUncertain(true);
        setReviewed(false);
        backend.reportFailure(failure);
        void load();
      }
      return false;
    } finally {
      saving.current = false;
      if (mounted.current) {
        setBusy(false);
        if (refreshPending.current) {
          refreshPending.current = false;
          void load();
        }
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) focus?.focus();
        });
      }
    }
  };
  const savedProvider = catalog?.providers.find((item) => item.id === selected);
  const retained = session?.provider.id === selected ? session : null;
  const provider = savedProvider ?? retained?.provider;
  const providerMissing = Boolean(provider && !savedProvider);
  const currentModels =
    catalog?.models.filter((item) => item.provider_id === selected) ?? [];
  const models = [
    ...currentModels,
    ...(retained?.models.filter(
      (item) => !currentModels.some((model) => model.id === item.id),
    ) ?? []),
  ];
  const visibleProviders = [
    ...(catalog?.providers ?? []),
    ...(providerMissing && provider ? [provider] : []),
  ];
  const providerGroups = [true, false]
    .map((enabled) => ({
      enabled,
      items: visibleProviders.filter(
        (item) =>
          item.enabled === enabled &&
          `${item.name} ${item.api_type}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    }))
    .filter((group) => group.items.length > 0);
  const closeMissingModel = (id: string) => {
    const proceed = () => {
      modelDraft(id, false);
      setSession((previous) =>
        previous
          ? {
              ...previous,
              models: previous.models.filter((item) => item.id !== id),
            }
          : null,
      );
    };
    if (drafts.current.get(id)) setDiscard(() => proceed);
    else proceed();
  };
  const open = selected !== null;
  const recovery = uncertain ? (
    <section
      role="alert"
      className="flex flex-col gap-3 rounded border border-danger p-4"
    >
      <p>
        The save result is unknown. Read the saved configuration before
        continuing.
      </p>
      <Button onClick={() => void load()}>Read saved configuration</Button>
      {reviewed && catalog && !busy && connected ? (
        <>
          <p>
            Saved providers:{" "}
            {catalog.providers.map((item) => item.name).join(", ") || "None"}.
            Saved models:{" "}
            {catalog.models.map((item) => item.name).join(", ") || "None"}.
          </p>
          <p>
            Use the saved configuration to close the current drafts and continue
            editing.
          </p>
          <Button
            onClick={() => {
              resetEditor();
              setCatalogEpoch((value) => value + 1);
              defaultDirty.current = false;
              setHasDrafts(false);
              setEditProvider(false);
              setSelected(null);
              setUncertain(false);
              setError(null);
            }}
          >
            Use saved configuration
          </Button>
        </>
      ) : null}
    </section>
  ) : null;
  const content = (
    <fieldset
      ref={editor}
      aria-label="Provider configuration"
      className="m-0 flex min-w-0 max-w-[720px] flex-col gap-6 border-0 p-0"
      key={`${selected}-${revision}`}
    >
      {error ? (
        <p
          role="alert"
          className="rounded border border-danger p-3 text-sm text-danger"
        >
          {error}
        </p>
      ) : null}
      {providerMissing ? (
        <p role="alert" className="text-sm text-danger">
          This provider no longer exists. Your draft is retained. Close this
          editor to continue.
        </p>
      ) : null}
      <fieldset
        disabled={busy || uncertain || !connected}
        className="m-0 min-w-0 border-0 p-0"
      >
        <ProviderForm
          provider={provider}
          save={save}
          busy={busy || uncertain || !connected}
          saving={busy}
          recovery={recovery}
          saveError={error}
          unavailable={providerMissing}
          onDeleted={() => {
            resetEditor();
            setSelected(null);
          }}
          onDraft={providerDraft}
          onCancel={() => choose(null)}
          modelCount={models.length}
          models={currentModels}
          editOpen={editProvider}
          onEdit={setEditProvider}
          onDiscard={(proceed) => {
            if (drafts.current.get("provider")) setDiscard(() => proceed);
            else proceed();
          }}
        />
      </fieldset>
      {provider ? (
        <section aria-label="Models" className="flex min-w-0 flex-col gap-3">
          <ProviderModelEditor
            provider={provider}
            save={save}
            busy={busy || uncertain || !connected}
            saving={busy}
            connectionDirty={connectionDirty}
            onDraft={modelDraft}
            recovery={recovery}
            saveError={error}
            unavailable={providerMissing}
            directory={(addAction) => (
              <ModelDirectory
                addAction={addAction}
                modelCount={models.length}
                provider={provider}
                models={currentModels}
                save={save}
                disabled={
                  busy ||
                  uncertain ||
                  !connected ||
                  providerMissing ||
                  connectionDirty
                }
                recovery={recovery}
                saveError={error}
              />
            )}
            onDiscard={(proceed) => {
              if (drafts.current.get("new-model")) setDiscard(() => proceed);
              else proceed();
            }}
          />
          {models.map((model) => (
            <ProviderModelEditor
              key={model.id}
              provider={provider}
              model={model}
              save={save}
              busy={busy || uncertain || !connected}
              saving={busy}
              connectionDirty={connectionDirty}
              onDraft={modelDraft}
              recovery={recovery}
              saveError={error}
              onDiscard={(proceed) => {
                if (drafts.current.get(model.id)) setDiscard(() => proceed);
                else proceed();
              }}
              unavailable={
                providerMissing ||
                !catalog?.models.some((item) => item.id === model.id)
              }
              onClose={
                !catalog?.models.some((item) => item.id === model.id)
                  ? () => closeMissingModel(model.id)
                  : undefined
              }
            />
          ))}
        </section>
      ) : null}
    </fieldset>
  );
  const activate = (id: string, target: HTMLElement) => {
    opener.current = target;
    choose(id);
  };
  const navigateList = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget
        .closest("[data-provider-list]")
        ?.querySelectorAll<HTMLButtonElement>("[data-provider-target]") ?? [],
    );
    const index = buttons.indexOf(event.currentTarget);
    buttons[
      (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
        buttons.length
    ]?.focus();
  };
  return (
    <fieldset
      aria-label="Model settings"
      className="model-settings m-0 flex min-w-0 flex-1 flex-col gap-6 border-0 p-0 min-h-0"
    >
      {loadError && !(loadError.transport && backend.disconnected) ? (
        <LoadError error={loadError} retry={() => void load()} />
      ) : null}
      {!catalog ? (
        !loadError && connected ? (
          <LoadingSkeleton label="Loading model settings">
            <div className="flex max-w-[560px] flex-col gap-4">
              <FieldSkeleton />
              <FieldSkeleton />
            </div>
            <div className="flex min-h-0 min-w-0 flex-1">
              <div className="flex min-w-0 flex-col gap-3 p-3 md:w-[280px] md:shrink-0 md:border-r md:border-line">
                <FieldSkeleton />
                <FieldSkeleton />
                <FieldSkeleton />
              </div>
              <div className="hidden min-w-0 flex-1 flex-col gap-6 p-6 md:flex">
                <FieldSkeleton />
                <FieldSkeleton />
                <FieldSkeleton />
              </div>
            </div>
          </LoadingSkeleton>
        ) : null
      ) : (
        <>
          {view === "models" ? (
            <fieldset
              disabled={busy || uncertain || !connected}
              className="m-0 min-w-0 border-0 p-0"
            >
              <DefaultModelForm
                key={catalogEpoch}
                catalog={catalog}
                save={save}
                busy={busy}
                onDraft={reportDefaults}
              />
            </fieldset>
          ) : null}
          {recovery}
          {error && !open ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {view === "providers" ? (
            <>
              {catalog.providers.length === 0 && !open ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center">
                  <EmptyState
                    title="No providers found"
                    action={
                      <Button
                        data-provider-add
                        className="px-4"
                        disabled={busy || uncertain || !connected}
                        variant="primary"
                        onClick={(event) => {
                          opener.current = event.currentTarget;
                          choose("new");
                        }}
                      >
                        Add
                      </Button>
                    }
                  />
                </div>
              ) : (
                <div
                  className="relative flex min-h-0 min-w-0 flex-1"
                  style={
                    { "--column-width": `${column.width}px` } as CSSProperties
                  }
                >
                  <div
                    id="provider-list"
                    data-provider-list
                    className={`min-w-0 flex-col gap-3 border-line px-2 pt-2 pb-3 border-r md:w-[var(--column-width)] md:shrink-0 ${open ? "hidden md:flex" : "flex w-full"}`}
                  >
                    <div className="shrink-0">
                      <SearchField
                        icon={<Search size={16} />}
                        aria-label="Search providers"
                        placeholder="Search providers"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </div>
                    <div className="flex-1">
                      {providerGroups.map((group) => (
                        <section
                          key={String(group.enabled)}
                          aria-label={
                            group.enabled
                              ? "Enabled providers"
                              : "Disabled providers"
                          }
                        >
                          {group.enabled ? null : (
                            <h3 className="py-2 text-xs text-fg-muted">
                              Disabled
                            </h3>
                          )}
                          {group.items.map((item) => {
                            const modelCount = catalog.models.filter(
                              (model) => model.provider_id === item.id,
                            ).length;
                            return (
                              <div
                                key={item.id}
                                className={`flex min-h-11 min-w-0 items-center gap-2 rounded px-2 hover:bg-surface-hover ${selected === item.id ? "bg-surface-hover" : ""}`}
                              >
                                <button
                                  type="button"
                                  data-provider-target
                                  className="min-w-0 flex-1 py-2 text-left text-sm wrap-anywhere"
                                  aria-current={
                                    selected === item.id ? "true" : undefined
                                  }
                                  disabled={busy || uncertain || !connected}
                                  onKeyDown={navigateList}
                                  onClick={(event) =>
                                    activate(item.id, event.currentTarget)
                                  }
                                >
                                  <span className="block font-medium">
                                    {item.name}
                                  </span>
                                  <span className="text-xs text-fg-muted">
                                    {item.api_type}, {modelCount}{" "}
                                    {modelCount === 1 ? "model" : "models"},{" "}
                                    {item.api_key_set ? "key set" : "no key"}
                                  </span>
                                </button>
                                <Input
                                  type="checkbox"
                                  aria-label={`Enable ${item.name}`}
                                  checked={item.enabled}
                                  disabled={busy || uncertain || !connected}
                                  onChange={(event) =>
                                    void save("save_provider", item.id, {
                                      enabled: event.target.checked,
                                    })
                                  }
                                />
                                <OverflowMenu
                                  label={`Actions for ${item.name}`}
                                  actions={[
                                    {
                                      id: "edit",
                                      label: "Edit",
                                      disabled: busy || uncertain || !connected,
                                      onSelect: () => choose(item.id, true),
                                    },
                                    {
                                      id: "delete",
                                      label: "Delete",
                                      tone: "danger",
                                      disabled:
                                        busy ||
                                        uncertain ||
                                        !connected ||
                                        catalog.models.some(
                                          (model) =>
                                            model.provider_id === item.id,
                                        ) ||
                                        !catalog.providers.some(
                                          (provider) => provider.id === item.id,
                                        ),
                                      onSelect: () => setDeleteProvider(item),
                                    },
                                  ]}
                                />
                              </div>
                            );
                          })}
                        </section>
                      ))}
                      {!visibleProviders.some((item) =>
                        `${item.name} ${item.api_type}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      ) ? (
                        <p className="text-sm text-fg-muted">
                          No providers found
                        </p>
                      ) : null}
                    </div>
                    <Button
                      data-provider-add
                      disabled={busy || uncertain || !connected}
                      variant="primary"
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        choose("new");
                      }}
                    >
                      Add
                    </Button>
                  </div>
                  <ColumnResizeHandle
                    label="Resize provider list"
                    controls="provider-list"
                    min={200}
                    max={480}
                    width={column.width}
                    resizing={column.resizing}
                    className="sidebar-resize column-resize max-[900px]:hidden"
                    onPointerDown={column.startResize}
                    onKeyDown={column.resizeWithKeys}
                    onDoubleClick={column.reset}
                  />
                  <div
                    className={`min-w-0 flex-1 p-6 ${open ? "block" : "hidden md:block"}`}
                  >
                    {open ? (
                      <>
                        <div className="mb-4 md:hidden">
                          <Button onClick={() => choose(null)}>
                            Back to Providers
                          </Button>
                        </div>
                        {content}
                      </>
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <EmptyState title="Select a provider" />
                      </div>
                    )}
                  </div>
                </div>
              )}
              <ConfirmDialog
                open={deleteProvider !== null}
                onOpenChange={(next) => {
                  if (!next) setDeleteProvider(null);
                }}
                title={`Delete ${deleteProvider?.name}?`}
                description="The provider is removed from the settings for every Member. This cannot be undone."
                confirmLabel="Delete provider"
                onConfirm={async () => {
                  if (
                    deleteProvider &&
                    (await save("delete_provider", deleteProvider.id))
                  ) {
                    if (selected === deleteProvider.id) {
                      resetEditor();
                      setSelected(null);
                    }
                    setDeleteProvider(null);
                  }
                }}
              />
            </>
          ) : null}
        </>
      )}
      <Modal
        open={discard !== null}
        onOpenChange={(next) => {
          if (!next) setDiscard(null);
        }}
        title="Discard unsaved changes?"
        variant="confirm"
        description="Your changes have not been saved."
        initialFocus={() => keepEditing.current}
        footer={
          <DialogActions
            cancel={
              <Button ref={keepEditing} onClick={() => setDiscard(null)}>
                Keep Editing
              </Button>
            }
          >
            <Button
              variant="danger"
              onClick={() => {
                const proceed = discard;
                setDiscard(null);
                proceed?.();
              }}
            >
              Discard
            </Button>
          </DialogActions>
        }
      />
    </fieldset>
  );
}

function ProviderModelEditor({
  provider,
  model,
  save,
  busy,
  saving,
  connectionDirty,
  onDraft,
  unavailable = false,
  onClose,
  onDiscard,
  recovery,
  saveError,
  directory,
}: {
  directory?: (addAction: ReactNode) => ReactNode;
  recovery: ReactNode;
  saveError: string | null;
  unavailable?: boolean;
  onClose?: () => void;
  onDiscard: (proceed: () => void) => void;
  provider: ProviderConfig;
  model?: RegisteredModel;
  save: SaveModel;
  busy: boolean;
  saving: boolean;
  connectionDirty: boolean;
  onDraft: (id: string, dirty: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const id = model?.id ?? "new-model";
  const report = useCallback(
    (dirty: boolean) => onDraft(id, dirty),
    [id, onDraft],
  );
  useEffect(() => () => onDraft(id, false), [id, onDraft]);
  const close = () => {
    if (busy) return;
    onDiscard(() => {
      setExpanded(false);
      report(false);
      onClose?.();
    });
  };
  const addAction = (
    <Button disabled={busy || unavailable} onClick={() => setExpanded(true)}>
      Add model
    </Button>
  );
  return (
    <section
      className={
        model
          ? "flex min-h-11 min-w-0 flex-wrap items-center justify-between gap-2 border-t border-line py-2"
          : "flex min-w-0 flex-col gap-3"
      }
    >
      {model ? (
        <>
          <div className="min-w-0 flex-1 wrap-anywhere text-sm">
            <p className="font-medium">{model.name}</p>
            <p className="text-xs text-fg-muted">{model.model}</p>
          </div>
          <label
            htmlFor={`${id}-enabled`}
            className="flex items-center gap-2 text-sm"
          >
            <Input
              id={`${id}-enabled`}
              type="checkbox"
              aria-label={`Enable model ${model.name}`}
              checked={model.enabled}
              disabled={busy || unavailable}
              onChange={(event) =>
                void save("save_model", model.id, {
                  enabled: event.target.checked,
                })
              }
            />
            Enabled
          </label>
          <Button size="sm" disabled={busy} onClick={() => setExpanded(true)}>
            Edit
          </Button>
          <Button
            size="sm"
            disabled={busy || unavailable}
            onClick={() => setDeleting(true)}
          >
            Delete
          </Button>
        </>
      ) : (
        directory?.(addAction)
      )}
      {expanded ? (
        <ModelForm
          open
          title={model ? "Edit model" : "Add model"}
          onOpenChange={(next) => {
            if (!next) close();
          }}
          recovery={recovery}
          saveError={saveError}
          provider={provider}
          model={model}
          save={save}
          busy={busy}
          saving={saving}
          onDraft={report}
          connectionDirty={connectionDirty}
          unavailable={unavailable}
          onClose={close}
        />
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${model?.name}?`}
        description="The model is removed from the settings. This cannot be undone."
        confirmLabel="Delete model"
        onConfirm={async () => {
          if (model && !unavailable) await save("delete_model", model.id);
        }}
      />
    </section>
  );
}

function DefaultModelForm({
  catalog,
  save,
  busy,
  onDraft,
}: {
  catalog: ModelCatalog;
  save: SaveModel;
  busy: boolean;
  onDraft?: (dirty: boolean) => void;
}) {
  const [value, setValue] = useState<AgentModelConfig>({
    model_id: catalog.default_model_id,
    thinking: catalog.default_thinking,
  });
  const dirty = useRef(false);
  const draftDirty =
    value.model_id !== catalog.default_model_id ||
    value.thinking !== catalog.default_thinking;
  useEffect(() => {
    onDraft?.(draftDirty);
  }, [onDraft, draftDirty]);
  useEffect(() => {
    if (!dirty.current) {
      setValue({
        model_id: catalog.default_model_id,
        thinking: catalog.default_thinking,
      });
    }
  }, [catalog.default_model_id, catalog.default_thinking]);
  return (
    <form
      className="default-model-card flex flex-col gap-4"
      onChangeCapture={() => {
        dirty.current = true;
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !draftDirty) return;
        if (await save("set_defaults", null, value)) dirty.current = false;
      }}
    >
      <h2 className="text-base font-medium">Global defaults</h2>
      <ModelSelection
        catalog={catalog}
        value={value}
        onChange={setValue}
        inherit={false}
      />
      <Button type="submit" variant="primary" disabled={busy || !draftDirty}>
        {busy ? <Spinner label="Saving model defaults" /> : <Save size={16} />}
        Save defaults
      </Button>
    </form>
  );
}

function ProviderForm({
  provider,
  save,
  busy,
  saving,
  onDeleted,
  onDraft,
  onCancel,
  unavailable = false,
  modelCount = 0,
  recovery,
  saveError,
  models,
  editOpen,
  onEdit,
  onDiscard,
}: {
  models: RegisteredModel[];
  recovery: ReactNode;
  saveError: string | null;
  editOpen: boolean;
  onEdit: (open: boolean) => void;
  onDiscard: (proceed: () => void) => void;
  provider?: ProviderConfig;
  unavailable?: boolean;
  save: SaveModel;
  busy: boolean;
  saving: boolean;
  onDeleted: () => void;
  onDraft?: (dirty: boolean, connectionDirty: boolean) => void;
  onCancel?: () => void;
  modelCount?: number;
}) {
  const id = useId();
  const [name, setName] = useState(provider?.name ?? "");
  const [apiType, setApiType] = useState(provider?.api_type ?? "openai-chat");
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [clearKey, setClearKey] = useState(false);
  const [extraBody, setExtraBody] = useState(
    JSON.stringify(provider?.extra_body ?? {}),
  );
  const [bodyError, setBodyError] = useState<string | null>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const restoreBodyFocus = useRef(false);
  const [nameError, setNameError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const dirty = useRef(false);
  const body = parseRequestBody(extraBody, apiType);
  const error = body.error ?? bodyError;
  const connectionDirty =
    apiType !== (provider?.api_type ?? "openai-chat") ||
    baseUrl !== (provider?.base_url ?? "") ||
    apiKey !== "" ||
    clearKey ||
    body.error !== null ||
    JSON.stringify(body.value) !== JSON.stringify(provider?.extra_body ?? {});
  const draftDirty =
    connectionDirty ||
    name !== (provider?.name ?? "") ||
    enabled !== (provider?.enabled ?? true);
  useEffect(() => {
    if (!busy && restoreBodyFocus.current) {
      restoreBodyFocus.current = false;
      bodyInput.current?.focus();
    }
  }, [busy]);
  useEffect(() => {
    onDraft?.(draftDirty, connectionDirty);
  }, [onDraft, draftDirty, connectionDirty]);
  useEffect(() => {
    setEnabled(provider?.enabled ?? true);
  }, [provider?.enabled]);
  useEffect(() => {
    if (!dirty.current) {
      setName(provider?.name ?? "");
      setApiType(provider?.api_type ?? "openai-chat");
      setBaseUrl(provider?.base_url ?? "");
      setEnabled(provider?.enabled ?? true);
      setExtraBody(JSON.stringify(provider?.extra_body ?? {}));
      setBodyError(null);
    }
  }, [provider]);
  const cancel = () => {
    if (busy) return;
    onDiscard(() => {
      dirty.current = false;
      setName(provider?.name ?? "");
      setApiType(provider?.api_type ?? "openai-chat");
      setBaseUrl(provider?.base_url ?? "");
      setApiKey("");
      setClearKey(false);
      setExtraBody(JSON.stringify(provider?.extra_body ?? {}));
      setBodyError(null);
      onDraft?.(false, false);
      onEdit(false);
      if (!provider) onCancel?.();
    });
  };
  const submit: FormEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();
    if (busy || unavailable || !draftDirty) return;
    if (body.error !== null) {
      setAdvanced(true);
      requestAnimationFrame(() => bodyInput.current?.focus());
      return;
    }
    setBodyError(null);
    if (!name.trim()) {
      setNameError(true);
      event.currentTarget.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    setNameError(false);
    if (
      await save(
        "save_provider",
        provider?.id ?? null,
        {
          name: name.trim(),
          api_type: apiType,
          base_url: baseUrl.trim(),
          api_key: apiKey.trim(),
          enabled,
          extra_body: body.value,
          ...(provider ? { clear_key: clearKey } : {}),
        },
        (message) => {
          setBodyError(message);
          setAdvanced(true);
          restoreBodyFocus.current = true;
        },
      )
    ) {
      dirty.current = false;
      setName(name.trim());
      setBaseUrl(baseUrl.trim());
      setApiKey("");
      setClearKey(false);
      onEdit(false);
    }
  };
  const actions = (
    <DialogActions
      cancel={
        <Button disabled={busy} onClick={editOpen ? cancel : onCancel}>
          Cancel
        </Button>
      }
    >
      {provider ? (
        <span className="inline-flex items-center gap-1">
          <Button
            disabled={busy || unavailable || modelCount > 0}
            onClick={() => setConfirmDelete(true)}
          >
            {onDraft ? "Delete" : "Delete provider"}
          </Button>
          {modelCount > 0 ? (
            <Tooltip label="Remove this provider's models first.">
              <button
                type="button"
                disabled={busy}
                aria-label="About deleting this provider"
                className="inline-flex cursor-help p-1.5 -m-1.5"
              >
                <CircleHelp size={14} />
              </button>
            </Tooltip>
          ) : null}
        </span>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        disabled={busy || unavailable || !draftDirty}
      >
        {saving ? <Spinner label="Saving provider" /> : null}
        {onDraft ? "Save" : provider ? "Save provider" : "Create provider"}
      </Button>
    </DialogActions>
  );
  const alerts =
    editOpen && (saveError || unavailable) ? (
      <>
        {saveError ? (
          <p role="alert" className="text-sm text-danger">
            {saveError}
          </p>
        ) : null}
        {unavailable ? (
          <p role="alert" className="text-sm text-danger">
            This provider no longer exists. Your draft is retained.
          </p>
        ) : null}
      </>
    ) : null;
  const content = (
    <>
      {editOpen ? recovery : null}
      <fieldset
        disabled={busy}
        className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
        onChangeCapture={() => {
          dirty.current = true;
        }}
      >
        {editOpen || !provider ? (
          <>
            <Field
              label="Provider name"
              htmlFor={`${id}-name`}
              error={nameError ? "Enter a provider name." : undefined}
              errorId={`${id}-name-error`}
            >
              <Input
                id={`${id}-name`}
                value={name}
                required
                aria-invalid={nameError}
                aria-describedby={nameError ? `${id}-name-error` : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(false);
                }}
              />
            </Field>
            <Field label="Protocol">
              <div className="min-w-0 overflow-x-auto">
                <Choices
                  label="Protocol"
                  value={apiType}
                  options={PROVIDERS}
                  onChange={(value) => {
                    dirty.current = true;
                    setApiType(value);
                    setBodyError(null);
                  }}
                />
              </div>
            </Field>
          </>
        ) : null}
        <Field
          label="API key"
          htmlFor={`${id}-key`}
          hint={
            provider?.api_key_set
              ? "Leave blank to keep the stored key."
              : undefined
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-40">
              <Input
                id={`${id}-key`}
                type={showKey ? "text" : "password"}
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
            <IconButton
              label={showKey ? "Hide API key" : "Show API key"}
              size="sm"
              onClick={() => setShowKey((value) => !value)}
            >
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </IconButton>
            {provider?.api_key_set ? (
              <Chip tone="success">Key stored</Chip>
            ) : null}
            {provider ? (
              <ProviderTest
                provider={provider}
                models={models}
                disabled={busy || unavailable || connectionDirty}
                hint={
                  connectionDirty
                    ? "Save provider connection before reading its model list or testing."
                    : undefined
                }
              />
            ) : null}
          </div>
        </Field>
        <Field label="API address" htmlFor={`${id}-url`}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-40">
              <Input
                id={`${id}-url`}
                value={baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
            <IconButton
              label="Advanced settings"
              size="sm"
              onClick={() => setAdvanced((value) => !value)}
            >
              <Settings size={16} />
            </IconButton>
          </div>
        </Field>
        {advanced || editOpen ? (
          <Field
            label={
              <span className="inline-flex items-center gap-1">
                <label htmlFor={`${id}-body`}>Custom request body</label>
                <Tooltip
                  label={`JSON merged into every model request sent through this provider, up to 16 KiB of UTF-8 JSON.
Use at most 16 container levels.
Omit a key to remove it; null is sent as a real JSON null.
Nested objects are replaced as a whole, never merged key by key.
Clear the field to remove all custom content.
Applies from the next Turn for OpenAI Chat, OpenAI Responses and Anthropic.`}
                >
                  <button
                    type="button"
                    aria-label="About custom request body"
                    className="inline-flex cursor-help p-1.5 -m-1.5"
                  >
                    <CircleHelp size={14} />
                  </button>
                </Tooltip>
              </span>
            }
          >
            <Textarea
              id={`${id}-body`}
              ref={bodyInput}
              rows={6}
              spellCheck={false}
              value={extraBody}
              aria-invalid={error !== null}
              aria-describedby={`${id}-body-hint${error ? ` ${id}-body-error` : ""}`}
              onChange={(event) => {
                setExtraBody(event.target.value);
                setBodyError(null);
              }}
            />
            {apiType === "google" ? (
              <p id={`${id}-body-hint`} className="text-xs text-fg-muted">
                This API does not support a custom request body. Clear it before
                saving.
              </p>
            ) : null}
            {error ? (
              <p
                id={`${id}-body-error`}
                role="alert"
                className="text-xs text-danger"
              >
                {error}
              </p>
            ) : null}
          </Field>
        ) : null}
        {provider?.api_key_set ? (
          <label
            htmlFor={`${id}-clear-key`}
            className="flex items-center gap-2 text-sm"
          >
            <Input
              id={`${id}-clear-key`}
              type="checkbox"
              checked={clearKey}
              onChange={(event) => setClearKey(event.target.checked)}
            />
            Clear stored key
          </label>
        ) : null}
      </fieldset>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${provider?.name}?`}
        description="The provider is removed from the settings for every Member. This cannot be undone."
        confirmLabel="Delete provider"
        onConfirm={async () => {
          if (
            !unavailable &&
            provider &&
            (await save("delete_provider", provider.id))
          )
            onDeleted();
        }}
      />
    </>
  );
  const fields = (
    <form className="provider-form flex flex-col gap-4" onSubmit={submit}>
      {alerts}
      {content}
      {actions}
    </form>
  );
  return (
    <>
      {provider ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="wrap-anywhere text-base font-medium">
              {provider.name}
            </h2>
            <Chip>{provider.api_type}</Chip>
            <IconButton
              label="Edit provider"
              size="sm"
              disabled={busy}
              onClick={() => onEdit(true)}
            >
              <Pencil size={16} />
            </IconButton>
          </div>
          <label
            htmlFor={`${id}-enabled`}
            className="flex items-center gap-2 text-sm"
          >
            <Input
              id={`${id}-enabled`}
              type="checkbox"
              aria-label={`Enable ${provider.name}`}
              checked={provider.enabled}
              disabled={busy || unavailable}
              onChange={(event) =>
                void save("save_provider", provider.id, {
                  enabled: event.target.checked,
                })
              }
            />
            Enabled
          </label>
        </div>
      ) : null}
      {editOpen ? (
        <Modal
          open
          variant="form"
          onSubmit={submit}
          footer={actions}
          alert={alerts}
          title={provider ? "Edit provider" : "Add provider"}
          onOpenChange={(open) => {
            if (!open) cancel();
          }}
        >
          {content}
        </Modal>
      ) : (
        fields
      )}
    </>
  );
}

function useModelProbe(identity: string, disabled: boolean) {
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<number | null>(null);
  useEffect(() => {
    generation.current += 1;
    inFlight.current = null;
    setTesting(false);
    setFeedback(null);
    const off = backend.onEvent((event) => {
      if (
        event.type === "connection.restored" ||
        event.type === "connection.closed" ||
        event.type === "connection.reconnecting"
      ) {
        generation.current += 1;
        inFlight.current = null;
        setTesting(false);
        setFeedback(null);
      }
    });
    return () => {
      generation.current += 1;
      off();
    };
  }, [identity, disabled]);
  const run = async (values: Record<string, unknown>) => {
    if (disabled || inFlight.current !== null) return;
    const request = ++generation.current;
    inFlight.current = request;
    setTesting(true);
    setFeedback(null);
    try {
      const result = await backend.call<{ latency_ms: number; reply: string }>(
        "settings.test_model",
        values,
      );
      if (request !== generation.current) return;
      setFeedback(modelTestDescription(result.latency_ms, result.reply));
    } catch (failure) {
      if (request !== generation.current) return;
      setFeedback(failure instanceof Error ? failure.message : String(failure));
      if (failure instanceof BackendError && failure.transport)
        backend.reportFailure(failure);
    } finally {
      if (request === generation.current) {
        inFlight.current = null;
        setTesting(false);
      }
    }
  };
  return { testing, feedback, run };
}

function ProviderTest({
  provider,
  models,
  disabled,
  hint,
}: {
  provider: ProviderConfig;
  models: RegisteredModel[];
  disabled: boolean;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [thinking, setThinking] = useState<Thinking>("default");
  const model = models.find((item) => item.id === selected);
  const unavailable = disabled || !open || !model;
  const test = useModelProbe(
    JSON.stringify([provider, model, thinking]),
    unavailable,
  );
  return (
    <>
      <span className="inline-flex items-center gap-1">
        <Button disabled={disabled} onClick={() => setOpen(true)}>
          Test
        </Button>
        {hint ? (
          <Tooltip label={hint}>
            <button
              type="button"
              aria-label="About testing this provider"
              className="inline-flex cursor-help p-1.5 -m-1.5"
            >
              <CircleHelp size={14} />
            </button>
          </Tooltip>
        ) : null}
      </span>
      <Modal
        open={open}
        variant="form"
        description="Testing sends one request to the provider and changes nothing."
        footer={
          models.length > 0 ? (
            <DialogActions>
              <Button
                disabled={unavailable || test.testing}
                onClick={() => {
                  if (model) void test.run({ model_id: model.id, thinking });
                }}
              >
                {test.testing ? <Spinner label="Testing" /> : null}Test
              </Button>
            </DialogActions>
          ) : undefined
        }
        title="Test provider model"
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSelected("");
        }}
      >
        {models.length === 0 ? (
          <p>Add a model before testing this provider.</p>
        ) : (
          <>
            <Field label="Saved model">
              <Select
                aria-label="Saved model"
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setThinking("default");
                }}
              >
                <option value="">Select a model</option>
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Test thinking effort">
              <Select
                aria-label="Test thinking effort"
                value={thinking}
                onChange={(event) =>
                  setThinking(event.target.value as Thinking)
                }
              >
                {(model?.thinking_options ?? THINKING_OPTIONS).map((option) => (
                  <option key={option} value={option}>
                    {thinkingLabel(option, model?.thinking_budget_tokens)}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-sm text-fg-muted">
              Uses the saved provider and model configuration for one request.
            </p>
          </>
        )}
        {test.feedback ? <p role="status">{test.feedback}</p> : null}
      </Modal>
    </>
  );
}

function ModelDirectory({
  provider,
  models,
  save,
  disabled,
  recovery,
  addAction,
  modelCount,
  saveError,
}: {
  provider: ProviderConfig;
  models: RegisteredModel[];
  save: SaveModel;
  disabled: boolean;
  recovery: ReactNode;
  saveError: string | null;
  addAction: ReactNode;
  modelCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const reading = useRef<number | null>(null);
  const inFlight = useRef(false);
  const signature = JSON.stringify(provider);
  useEffect(() => {
    generation.current += 1;
    reading.current = null;
    setLoading(false);
    const off = backend.onEvent((event) => {
      if (
        event.type === "connection.restored" ||
        event.type === "connection.closed" ||
        event.type === "connection.reconnecting"
      ) {
        generation.current += 1;
        reading.current = null;
        setLoadedFor(null);
        setLoading(false);
      }
    });
    return () => {
      generation.current += 1;
      reading.current = null;
      off();
    };
  }, [signature, disabled, open]);
  const load = useCallback(async () => {
    if (disabled || reading.current !== null) return;
    const request = ++generation.current;
    reading.current = request;
    setLoading(true);
    setError(null);
    try {
      const result = await backend.call<{ models: string[] }>(
        "settings.list_models",
        { provider_id: provider.id },
      );
      if (request === generation.current) {
        setOptions(result.models);
        setLoadedFor(signature);
      }
    } catch (failure) {
      if (request !== generation.current) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      if (failure instanceof BackendError && failure.transport)
        backend.reportFailure(failure);
    } finally {
      if (request === generation.current) {
        reading.current = null;
        setLoading(false);
      }
    }
  }, [disabled, provider.id, signature]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={disabled} onClick={() => setOpen(true)}>
        Get model list
      </Button>
      {addAction}
    </div>
  );
  const filtered = options.filter((item) =>
    item.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-medium">
          Models <span className="text-fg-muted">{modelCount}</span>
        </h3>
        {modelCount > 0 ? actions : null}
      </div>
      {modelCount === 0 ? (
        <EmptyState title="No models configured" action={actions} />
      ) : null}
      <Modal
        open={open}
        variant="form"
        title="Model list"
        onOpenChange={setOpen}
        footer={
          <DialogActions>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </DialogActions>
        }
      >
        {recovery}
        <SearchField
          icon={<Search size={16} />}
          aria-label="Search models"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {loading ? <Spinner label="Loading model list" /> : null}
        {error ? <p role="alert">{error}</p> : null}
        {saveError ? <p role="alert">{saveError}</p> : null}
        <Button disabled={disabled || loading} onClick={() => void load()}>
          Retry
        </Button>
        {!loading &&
        !error &&
        loadedFor === signature &&
        options.length === 0 ? (
          <EmptyState title="No models returned" />
        ) : null}
        {options.length > 0 && filtered.length === 0 ? (
          <p className="text-sm text-fg-muted">No matching models</p>
        ) : null}
        {filtered.map((remote) => {
          const added = models.some((model) => model.model === remote);
          return (
            <div
              key={remote}
              className="flex min-w-0 items-center justify-between gap-3"
            >
              <span className="wrap-anywhere text-sm">{remote}</span>
              <Button
                disabled={disabled || added || loadedFor !== signature}
                onClick={async () => {
                  if (inFlight.current) return;
                  inFlight.current = true;
                  try {
                    await save("save_model", null, {
                      provider_id: provider.id,
                      model: remote,
                      name: remote,
                      enabled: true,
                      thinking_budget_tokens: null,
                    });
                  } finally {
                    inFlight.current = false;
                  }
                }}
              >
                {added ? "Added" : "Add"}
              </Button>
            </div>
          );
        })}
      </Modal>
    </>
  );
}

function ModelForm({
  open,
  title,
  onOpenChange,
  recovery,
  saveError,
  provider,
  model,
  save,
  busy,
  saving,
  onDraft,
  connectionDirty = false,
  unavailable = false,
  onClose,
}: {
  open: boolean;
  title: string;
  onOpenChange: (open: boolean) => void;
  recovery?: ReactNode;
  saveError?: string | null;
  onClose?: () => void;
  provider: ProviderConfig;
  unavailable?: boolean;
  model?: RegisteredModel;
  save: SaveModel;
  busy: boolean;
  saving: boolean;
  onDraft?: (dirty: boolean) => void;
  connectionDirty?: boolean;
}) {
  const id = useId();
  const [name, setName] = useState(model?.name ?? "");
  const [remote, setRemote] = useState(model?.model ?? "");
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const [budgetTokens, setBudgetTokens] = useState(
    model?.thinking_budget_tokens?.toString() ?? "",
  );
  const [options, setOptions] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [thinking, setThinking] = useState<Thinking>("default");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState(false);

  const draftDirty =
    name !== (model?.name ?? "") ||
    remote !== (model?.model ?? "") ||
    enabled !== (model?.enabled ?? true) ||
    budgetTokens !== (model?.thinking_budget_tokens?.toString() ?? "");
  useEffect(() => {
    onDraft?.(draftDirty);
  }, [onDraft, draftDirty]);
  const budgetSupported = supportsTokenBudget(provider.api_type);
  const parsedBudget = budgetTokens.trim() ? Number(budgetTokens) : null;
  const validBudget =
    parsedBudget === null ||
    (Number.isSafeInteger(parsedBudget) && parsedBudget > 0);
  const budgetChanged =
    model !== undefined && parsedBudget !== model.thinking_budget_tokens;
  const validTestSelection =
    validBudget &&
    (thinking !== "budget" || (budgetSupported && parsedBudget !== null));
  const testThinkingOptions: Thinking[] =
    budgetSupported && parsedBudget !== null && validBudget
      ? [...THINKING_OPTIONS, "budget"]
      : THINKING_OPTIONS;
  const dirty = useRef(false);
  const listRequest = useRef(0);
  useEffect(() => {
    if (!dirty.current) {
      setName(model?.name ?? "");
      setRemote(model?.model ?? "");
      setEnabled(model?.enabled ?? true);
      setBudgetTokens(model?.thinking_budget_tokens?.toString() ?? "");
    }
  }, [model]);
  useEffect(() => {
    setEnabled(model?.enabled ?? true);
  }, [model?.enabled]);
  useEffect(() => {
    listRequest.current += 1;
    setOptions([]);
    setListing(false);
    const off = backend.onEvent((event) => {
      if (
        event.type === "connection.restored" ||
        event.type === "connection.closed" ||
        event.type === "connection.reconnecting"
      ) {
        listRequest.current += 1;
        setOptions([]);
        setListing(false);
      }
    });
    return () => {
      listRequest.current += 1;
      off();
    };
  }, [provider, unavailable, connectionDirty, busy]);
  const listModels = async () => {
    if (unavailable || connectionDirty || busy || listing) return;
    const request = ++listRequest.current;
    setListing(true);
    try {
      const result = await backend.call<{ models: string[] }>(
        "settings.list_models",
        { provider_id: provider.id },
      );
      if (request === listRequest.current) setOptions(result.models);
    } catch (error) {
      if (request === listRequest.current) {
        setFeedback(error instanceof Error ? error.message : String(error));
        if (error instanceof BackendError && error.transport)
          backend.reportFailure(error);
        else
          toast({
            tone: "danger",
            title: "Could not load models",
            description: error instanceof Error ? error.message : String(error),
          });
      }
    } finally {
      if (request === listRequest.current) setListing(false);
    }
  };
  const test = useModelProbe(
    JSON.stringify([provider, model, remote, budgetTokens, thinking]),
    busy ||
      unavailable ||
      connectionDirty ||
      !validTestSelection ||
      !remote.trim() ||
      budgetChanged ||
      Boolean(model && remote !== model.model),
  );
  const testModel = () =>
    test.run(
      model
        ? { model_id: model.id, thinking }
        : {
            provider_id: provider.id,
            model: remote.trim(),
            thinking,
            thinking_budget_tokens: budgetSupported ? parsedBudget : null,
          },
    );
  const submit: FormEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();
    if (busy || unavailable || !draftDirty) return;
    if (!remote.trim()) {
      event.currentTarget
        .querySelector<HTMLInputElement>('[role="combobox"]')
        ?.focus();
      setRemoteError(true);
      return;
    }
    setRemoteError(false);
    if (budgetSupported && !validBudget) {
      event.currentTarget
        .querySelector<HTMLInputElement>('[type="number"]')
        ?.focus();
      return;
    }
    if (
      await save("save_model", model?.id ?? null, {
        name: name.trim() || remote.trim(),
        model: remote.trim(),
        provider_id: provider.id,
        enabled,
        thinking_budget_tokens: budgetSupported ? parsedBudget : null,
      })
    ) {
      dirty.current = false;
      if (model) {
        setName(name.trim() || remote.trim());
        setRemote(remote.trim());
        setBudgetTokens(
          budgetSupported ? (parsedBudget?.toString() ?? "") : "",
        );
      }
      if (!model) {
        setName("");
        setEnabled(true);
        setRemote("");
        setBudgetTokens("");
        setThinking("default");
      }
      onDraft?.(false);
      onOpenChange(false);
    }
  };
  const actions = (
    <DialogActions
      cancel={
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <Button
        disabled={
          busy ||
          unavailable ||
          test.testing ||
          connectionDirty ||
          !provider.api_key_set ||
          !remote.trim() ||
          !validTestSelection ||
          budgetChanged ||
          Boolean(model && remote !== model.model)
        }
        onClick={() => void testModel()}
      >
        {test.testing ? <Spinner label="Testing" /> : null}Test
      </Button>
      {model ? (
        <Button
          disabled={unavailable || busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete model
        </Button>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        disabled={busy || unavailable || !draftDirty}
      >
        {saving ? <Spinner label="Saving model" /> : null}
        Save
      </Button>
    </DialogActions>
  );
  return (
    <Modal
      open={open}
      variant="form"
      onSubmit={submit}
      footer={actions}
      title={title}
      onOpenChange={onOpenChange}
      alert={
        saveError || unavailable ? (
          <p role="alert" className="text-sm text-danger">
            {unavailable
              ? "This model or provider no longer exists. Your draft is retained."
              : saveError}
          </p>
        ) : null
      }
    >
      {recovery}
      <fieldset
        disabled={busy}
        className="m-0 min-w-0 border-0 p-0"
        onChangeCapture={() => {
          dirty.current = true;
        }}
      >
        <Field label="Display name" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Model ID"
          htmlFor={`${id}-remote`}
          error={remoteError ? "Enter a remote model ID." : undefined}
          errorId={`${id}-remote-error`}
        >
          <Combobox
            id={`${id}-remote`}
            label="Model ID"
            value={remote}
            onChange={(value) => {
              dirty.current = true;
              setRemote(value);
              setRemoteError(false);
            }}
            options={options}
            chooseLabel="Choose model"
            loadLabel="Load models"
            onLoad={() => void listModels()}
            loading={listing}
            invalid={remoteError}
            describedBy={remoteError ? `${id}-remote-error` : undefined}
          />
        </Field>
        {budgetSupported ? (
          <Field
            label="Thinking token budget"
            htmlFor={`${id}-budget`}
            hint={
              validBudget ? "Used only when budget is selected." : undefined
            }
            error={validBudget ? undefined : "Enter a positive whole number."}
            errorId={`${id}-budget-error`}
          >
            <Input
              id={`${id}-budget`}
              type="number"
              min="1"
              step="1"
              aria-invalid={!validBudget}
              aria-describedby={validBudget ? undefined : `${id}-budget-error`}
              value={budgetTokens}
              onChange={(event) => setBudgetTokens(event.target.value)}
            />
          </Field>
        ) : null}
        <label
          htmlFor={`${id}-enabled`}
          className="flex items-center gap-2 text-sm"
        >
          <Input
            id={`${id}-enabled`}
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
        <Field label="Test thinking effort" htmlFor={`${id}-thinking`}>
          <Select
            id={`${id}-thinking`}
            value={thinking}
            onChange={(event) => setThinking(event.target.value as Thinking)}
          >
            {testThinkingOptions.map((option) => (
              <option key={option} value={option}>
                {thinkingLabel(option, parsedBudget)}
              </option>
            ))}
          </Select>
        </Field>
        {connectionDirty ? (
          <p className="text-sm text-fg-muted">
            Save provider connection first.
          </p>
        ) : model && (budgetChanged || remote !== model.model) ? (
          <p className="text-sm text-fg-muted">Save model changes first.</p>
        ) : null}
        {feedback || test.feedback ? (
          <p role="status" className="text-sm">
            {test.feedback ?? feedback}
          </p>
        ) : null}
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${model?.name}?`}
          description="The model is removed from the settings. This cannot be undone."
          confirmLabel="Delete model"
          onConfirm={async () => {
            if (!unavailable && model) await save("delete_model", model.id);
          }}
        />
      </fieldset>
    </Modal>
  );
}
