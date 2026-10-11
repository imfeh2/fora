import { CircleHelp, Save } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "@/app/router";
import { Table } from "@/components/layout/shell";
import { LoadError } from "@/components/ui/access-error";
import { Combobox } from "@/components/ui/combobox";
import { ConfirmDialog, Modal } from "@/components/ui/dialog";
import {
  Button,
  Chip,
  Field,
  FieldSkeleton,
  Input,
  LoadingSkeleton,
  Spinner,
  Textarea,
  toast,
} from "@/components/ui/index";
import { Segmented } from "@/components/ui/segmented";
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
  return option === "budget" ? `budget · ${budget} tokens` : option;
}

export function modelTestDescription(latency: number, reply: string): string {
  return `${latency.toLocaleString("en-US")} ms · ${reply.trim().replace(/\s+/g, " ").slice(0, 80)}`;
}

const selectClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg";

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
      <Field label="Model" htmlFor={`${id}-model`}>
        <select
          id={`${id}-model`}
          className={selectClass}
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
        </select>
      </Field>
      <Field label="Thinking effort" htmlFor={`${id}-thinking`}>
        <select
          id={`${id}-thinking`}
          className={selectClass}
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
              {value.thinking} · unavailable for this model
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option} value={option}>
              {thinkingLabel(option, selected?.thinking_budget_tokens)}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-sm text-fg-muted">
        {selected
          ? `Effective model: ${catalog.providers.find((provider) => provider.id === selected.provider_id)?.name} / ${selected.name}. Changes apply to the next Turn.`
          : "No model selected. Configure a provider and model before this Agent runs."}
      </p>
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
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!catalog || !name.trim() || busy}
            onClick={() => void create()}
          >
            {busy ? <Spinner label="Creating Agent" /> : null}
            Create Agent
          </Button>
        </>
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

export function AgentModelDialog({
  agentId,
  onClose,
}: {
  agentId: number;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState({ dirty: false, busy: false });
  const [discarding, setDiscarding] = useState(false);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const { registerNavigationBlocker } = useRouter();
  useEffect(
    () =>
      registerNavigationBlocker((_next, proceed) => {
        if (editing.busy) return true;
        if (!editing.dirty) return false;
        pendingNavigation.current ??= proceed;
        setDiscarding(true);
        return true;
      }),
    [editing, registerNavigationBlocker],
  );
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!editing.dirty && !editing.busy) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [editing]);
  const keepEditing = () => {
    pendingNavigation.current = null;
    setDiscarding(false);
  };
  const discard = () => {
    const proceed = pendingNavigation.current;
    pendingNavigation.current = null;
    onClose();
    proceed?.();
  };
  const close = () => {
    if (editing.busy) return;
    if (editing.dirty) setDiscarding(true);
    else onClose();
  };
  return (
    <>
      <Modal
        open
        onOpenChange={(open) => !open && close()}
        title="Model settings"
        footer={
          <Button disabled={editing.busy} onClick={close}>
            Close
          </Button>
        }
      >
        <AgentModelPanel
          key={agentId}
          agentId={agentId}
          onStateChange={setEditing}
        />
      </Modal>
      <Modal
        open={discarding}
        onOpenChange={(open) => !open && keepEditing()}
        title="Discard unsaved changes?"
        description="You have unsaved modifications."
        footer={
          <>
            <Button onClick={keepEditing}>Keep Editing</Button>
            <Button variant="danger" onClick={discard}>
              Discard
            </Button>
          </>
        }
      />
    </>
  );
}

export function AgentModelPanel({
  agentId,
  onStateChange,
}: {
  agentId: number;
  onStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [value, setValue] = useState<AgentModelConfig>({
    model_id: null,
    thinking: null,
  });
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    onStateChange?.({ dirty: dirty.current, busy });
  }, [busy, value, onStateChange]);
  useReportSettingsSave(`agent-model-${agentId}`, busy);
  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const loaded = await backend.modelCatalog();
      if (generation !== loadGeneration.current) return;
      setCatalog(loaded);
      setLoadError(null);
      if (!dirty.current) {
        setValue(
          loaded.agent_configs[String(agentId)] ?? {
            model_id: null,
            thinking: null,
          },
        );
      }
    } catch (error) {
      if (generation === loadGeneration.current) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [agentId]);
  useEffect(() => {
    void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.restored") void load();
    });
    return () => {
      loadGeneration.current += 1;
      off();
    };
  }, [load]);
  return (
    <form
      className="flex max-w-[560px] flex-col gap-4"
      onChangeCapture={() => {
        dirty.current = true;
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!catalog || busy) return;
        loadGeneration.current += 1;
        setBusy(true);
        try {
          const updated = await backend.configureModel(
            "set_agent",
            agentId,
            value,
          );
          loadGeneration.current += 1;
          setCatalog(updated);
          setValue(updated.agent_configs[String(agentId)] ?? value);
          dirty.current = false;
        } catch (error) {
          if (error instanceof BackendError && error.transport)
            backend.reportFailure(error);
          else
            toast({
              tone: "danger",
              title: "Could not save Agent model settings",
              description:
                error instanceof Error ? error.message : String(error),
            });
        } finally {
          setBusy(false);
        }
      }}
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
        disabled={!catalog || busy}
      >
        {catalog ? (
          <ModelSelection catalog={catalog} value={value} onChange={setValue} />
        ) : !loadError ? (
          <LoadingSkeleton label="Loading models">
            <FieldSkeleton />
            <FieldSkeleton />
          </LoadingSkeleton>
        ) : null}
        <Button type="submit" variant="primary">
          {busy ? <Spinner label="Saving Agent model settings" /> : null}
          Save model settings
        </Button>
      </fieldset>
    </form>
  );
}

type SaveModel = (
  action: string,
  id: string | number | null,
  values?: Record<string, unknown>,
  onBodyError?: (message: string) => void,
) => Promise<boolean>;

export type ProviderLayout = "cards" | "split" | "accordion";

export function ModelPanel() {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [expandedModels, setExpandedModels] = useState<string[]>([]);
  const selectionId = useId();
  useReportSettingsSave("model", busy);
  const [loadError, setLoadError] = useState<BackendError | null>(null);
  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setFailed(false);
    setLoadError(null);
    try {
      const loaded = await backend.modelCatalog();
      if (generation !== loadGeneration.current) return;
      setCatalog(loaded);
      setFailed(false);
    } catch (error) {
      if (generation === loadGeneration.current) {
        setFailed(true);
        setLoadError(reportLoadFailure(error));
      }
    }
  }, []);
  useEffect(() => {
    void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.restored") void load();
    });
    return () => {
      loadGeneration.current += 1;
      off();
    };
  }, [load]);
  const save: SaveModel = async (action, id, values = {}, onBodyError) => {
    loadGeneration.current += 1;
    setBusy(true);
    try {
      const updated = await backend.configureModel(action, id, values);
      loadGeneration.current += 1;
      setCatalog(updated);
      setFailed(false);
      setLoadError(null);
      if (action === "save_provider" && id === null) {
        const created = updated.providers[updated.providers.length - 1];
        if (!created) throw new Error("Saved provider is missing");
        setProviderId(created.id);
      }
      return true;
    } catch (error) {
      if (error instanceof BackendError && error.transport)
        backend.reportFailure(error);
      else if (
        onBodyError &&
        error instanceof BackendError &&
        ["invalid_request_body", "unsupported_request_body"].includes(
          error.code,
        )
      )
        onBodyError(error.message);
      else
        toast({
          tone: "danger",
          title: "Could not save model settings",
          description: error instanceof Error ? error.message : String(error),
        });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const provider = catalog?.providers.find((item) => item.id === providerId);
  const models =
    catalog?.models.filter((item) => item.provider_id === provider?.id) ?? [];
  const chooseProvider = (id: string | null) => {
    if (busy) return;
    setProviderId(id);
    setExpandedModels([]);
  };
  const toggleModel = (id: string) => {
    if (busy) return;
    setExpandedModels((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  };
  const fields = (
    <fieldset
      className="model-settings m-0 flex min-w-0 flex-col gap-6 border-0 p-0"
      aria-label="Model settings"
      disabled={!catalog || busy || failed}
    >
      {!catalog ? (
        failed ? null : (
          <LoadingSkeleton label="Loading model settings">
            <div className="flex max-w-[560px] flex-col gap-4">
              <FieldSkeleton />
              <FieldSkeleton />
            </div>
            <section className="provider-card">
              <FieldSkeleton />
              <FieldSkeleton />
              <FieldSkeleton />
              <FieldSkeleton />
            </section>
          </LoadingSkeleton>
        )
      ) : (
        <>
          <DefaultModelForm catalog={catalog} save={save} busy={busy} />
          <section className="provider-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-medium">Provider connection</h2>
              <Field label="Provider" htmlFor={`${selectionId}-provider`}>
                <select
                  id={`${selectionId}-provider`}
                  className={selectClass}
                  value={provider?.id ?? ""}
                  onChange={(event) =>
                    chooseProvider(event.target.value || null)
                  }
                >
                  <option value="">Add provider</option>
                  {catalog.providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.enabled ? "" : " · disabled"}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <ProviderForm
              key={provider?.id ?? "new"}
              provider={provider}
              save={save}
              busy={busy}
              onDeleted={() => chooseProvider(null)}
            />
          </section>
          {provider ? (
            <section className="models-section">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-base font-medium">Models</h2>
                <p className="text-sm text-fg-muted">{provider.name}</p>
              </div>
              {models.length === 0 ? (
                <p className="text-sm text-fg-muted">No models configured.</p>
              ) : null}
              {models.map((model) => {
                const expanded = expandedModels.includes(model.id);
                return (
                  <section className="model-item" key={model.id}>
                    <button
                      className="model-summary"
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={`${selectionId}-model-${model.id}`}
                      onClick={() => toggleModel(model.id)}
                    >
                      <span className="min-w-0 flex flex-col gap-1">
                        <span className="font-medium wrap-anywhere">
                          {model.name}
                        </span>
                        <span className="text-xs text-fg-muted wrap-anywhere">
                          {model.model}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 flex-none">
                        <Chip>{model.enabled ? "Enabled" : "Disabled"}</Chip>
                        <span>{expanded ? "Close" : "Edit"}</span>
                      </span>
                    </button>
                    <div
                      id={`${selectionId}-model-${model.id}`}
                      className="model-editor"
                      hidden={!expanded}
                      inert={!expanded}
                    >
                      <ModelForm
                        provider={provider}
                        model={model}
                        save={save}
                        busy={busy}
                      />
                    </div>
                  </section>
                );
              })}
              <section className="model-item">
                <button
                  className="model-add"
                  type="button"
                  aria-expanded={expandedModels.includes("new")}
                  aria-controls={`${selectionId}-model-new`}
                  onClick={() => toggleModel("new")}
                >
                  Add model
                </button>
                <div
                  id={`${selectionId}-model-new`}
                  className="model-editor"
                  hidden={!expandedModels.includes("new")}
                  inert={!expandedModels.includes("new")}
                >
                  <ModelForm
                    key={provider.id}
                    provider={provider}
                    save={save}
                    busy={busy}
                  />
                </div>
              </section>
            </section>
          ) : null}
        </>
      )}
    </fieldset>
  );
  return (
    <>
      {loadError && !(loadError.transport && backend.disconnected) ? (
        <LoadError error={loadError} retry={() => void load()} />
      ) : null}
      {fields}
    </>
  );
}

export function ProviderLayoutPanel({ layout }: { layout: ProviderLayout }) {
  const { registerNavigationBlocker } = useRouter();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [session, setSession] = useState<{
    provider: ProviderConfig;
    models: RegisteredModel[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const defaultDirty = useRef(false);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const generation = useRef(0);
  const reading = useRef<number | null>(null);
  const saving = useRef(false);
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
    if (saving.current || reading.current !== null) {
      refreshPending.current = true;
      return;
    }
    const request = ++generation.current;
    reading.current = request;
    try {
      const loaded = await backend.modelCatalog();
      if (request !== generation.current) return;
      setCatalog(loaded);
      setError(null);
      setReviewed(true);
    } catch (failure) {
      if (request === generation.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
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
    void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.restored") {
        generation.current += 1;
        reading.current = null;
        refreshPending.current = false;
        void load();
      }
      if (event.type === "settings.updated" && event.section === "model")
        void load();
    });
    return () => {
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
    if (selected && layout !== "cards")
      editor.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [selected, layout]);
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
  const choose = (id: string | null) => {
    if (saving.current) return;
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
      setError(null);
      if (id === null) requestAnimationFrame(() => opener.current?.focus());
    };
    if (Array.from(drafts.current.values()).some(Boolean))
      setDiscard(() => proceed);
    else proceed();
  };
  const save: SaveModel = async (action, id, values = {}) => {
    if (saving.current || uncertain) return false;
    if (
      (action === "save_provider" && id === null && selected !== "new") ||
      ((action === "save_provider" || action === "delete_provider") &&
        id !== null &&
        !catalog?.providers.some((item) => item.id === id)) ||
      ((action === "save_model" || action === "delete_model") &&
        id !== null &&
        !catalog?.models.some((item) => item.id === id)) ||
      (action === "save_model" &&
        !catalog?.providers.some((item) => item.id === values.provider_id))
    ) {
      return false;
    }
    saving.current = true;
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
      generation.current += 1;
      setCatalog(updated);
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
      if (
        layout === "cards" &&
        action === "save_provider" &&
        typeof values.name === "string" &&
        !Array.from(drafts.current.entries()).some(
          ([key, dirty]) => key !== "provider" && dirty,
        )
      ) {
        drafts.current.delete("provider");
        setHasDrafts(defaultDirty.current);
        setSelected(null);
        requestAnimationFrame(() => opener.current?.focus());
      }
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      if (failure instanceof BackendError && failure.transport) {
        setUncertain(true);
        setReviewed(false);
        backend.reportFailure(failure);
        void load();
      }
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
      if (refreshPending.current) {
        refreshPending.current = false;
        void load();
      }
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) focus?.focus();
      });
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
      {reviewed && catalog ? (
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
      className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0"
      key={`${selected}-${revision}`}
      onKeyDown={(event) => {
        if (
          layout !== "cards" &&
          event.key === "Escape" &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          choose(null);
        }
      }}
    >
      {error ? (
        <p
          role="alert"
          className="rounded border border-danger p-3 text-sm text-danger"
        >
          {error}
        </p>
      ) : null}
      {layout === "cards" ? recovery : null}
      {providerMissing ? (
        <p role="alert" className="text-sm text-danger">
          This provider no longer exists. Your draft is retained. Close this
          editor to continue.
        </p>
      ) : null}
      <fieldset
        disabled={busy || uncertain}
        className="m-0 min-w-0 border-0 p-0"
      >
        <ProviderForm
          provider={provider}
          save={save}
          busy={busy}
          unavailable={providerMissing}
          onDeleted={() => {
            resetEditor();
            setSelected(null);
          }}
          onDraft={providerDraft}
          onCancel={() => choose(null)}
          modelCount={models.length}
        />
      </fieldset>
      {provider ? (
        <section aria-label="Models" className="flex min-w-0 flex-col gap-3">
          <h3 className="text-base font-medium">
            Models <span className="text-fg-muted">{models.length}</span>
          </h3>
          {models.length === 0 ? (
            <p className="text-sm text-fg-muted">No models configured.</p>
          ) : null}
          {layout === "split" ? (
            <Table
              label="Provider models"
              columns={[
                { key: "model", label: "Model" },
                { key: "thinking", label: "Thinking", hideBelow: "sm" },
              ]}
            >
              {models.map((model) => (
                <ProviderModelEditor
                  key={model.id}
                  table
                  provider={provider}
                  model={model}
                  save={save}
                  busy={busy || uncertain}
                  connectionDirty={connectionDirty}
                  onDraft={modelDraft}
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
            </Table>
          ) : (
            models.map((model) => (
              <ProviderModelEditor
                key={model.id}
                provider={provider}
                model={model}
                save={save}
                busy={busy || uncertain}
                connectionDirty={connectionDirty}
                onDraft={modelDraft}
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
            ))
          )}
          <ProviderModelEditor
            provider={provider}
            save={save}
            busy={busy || uncertain}
            connectionDirty={connectionDirty}
            onDraft={modelDraft}
            unavailable={providerMissing}
          />
        </section>
      ) : null}
    </fieldset>
  );
  const summary = (item: ProviderConfig) => (
    <>
      <span className="min-w-0 flex-1 wrap-anywhere font-medium">
        {item.name}
      </span>
      <Chip>
        {PROVIDERS.find((option) => option.value === item.api_type)?.label ??
          item.api_type}
      </Chip>
      {item.api_key_set ? <Chip>Key stored</Chip> : null}
    </>
  );
  const enabled = (item: ProviderConfig) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        aria-label={`Enable ${item.name}`}
        checked={item.enabled}
        disabled={
          busy ||
          uncertain ||
          !catalog?.providers.some((provider) => provider.id === item.id)
        }
        onChange={(event) =>
          void save("save_provider", item.id, { enabled: event.target.checked })
        }
      />
      Enabled
    </label>
  );
  const activate = (id: string, target: HTMLElement) => {
    opener.current = target;
    choose(selected === id && layout === "accordion" ? null : id);
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
    <div
      className="model-settings flex min-w-0 flex-col gap-6"
      data-provider-layout={layout}
    >
      {!catalog ? (
        <div
          role="status"
          aria-label="Loading model settings"
          className="h-64 animate-pulse rounded bg-surface-hover"
        />
      ) : (
        <>
          <fieldset
            disabled={busy || uncertain}
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-medium">
              Providers{" "}
              <span className="text-fg-muted">{catalog.providers.length}</span>
            </h2>
            <Button
              disabled={busy || uncertain}
              variant="primary"
              onClick={(event) => {
                opener.current = event.currentTarget;
                choose("new");
              }}
            >
              Add
            </Button>
          </div>
          {layout !== "cards" || !open ? recovery : null}
          {error && (!open || layout === "cards") ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {catalog.providers.length === 0 && !open ? (
            <p className="text-sm text-fg-muted">
              Add a provider to configure its connection and models.
            </p>
          ) : null}
          {layout === "cards" ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {catalog.providers.map((item) => (
                <section
                  key={item.id}
                  className="flex min-w-0 flex-col gap-4 rounded-md border border-line bg-surface p-5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {summary(item)}
                  </div>
                  <p className="text-sm text-fg-muted">
                    {
                      catalog.models.filter(
                        (model) => model.provider_id === item.id,
                      ).length
                    }{" "}
                    models
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    {enabled(item)}
                    <Button
                      disabled={busy}
                      onClick={(event) =>
                        activate(item.id, event.currentTarget)
                      }
                    >
                      Edit
                    </Button>
                  </div>
                </section>
              ))}
            </div>
          ) : layout === "split" ? (
            <div className="flex min-h-[580px] min-w-0 rounded-md border border-line bg-surface">
              <div
                data-provider-list
                className={`min-w-0 flex-col border-line p-3 md:w-[280px] md:shrink-0 md:border-r ${open ? "hidden md:flex" : "flex w-full"}`}
              >
                {catalog.providers.map((item) => (
                  <div
                    key={item.id}
                    className={`flex min-h-11 min-w-0 items-center gap-2 rounded px-2 ${selected === item.id ? "bg-surface-hover" : ""}`}
                  >
                    <button
                      type="button"
                      data-provider-target
                      className="min-w-0 flex-1 py-2 text-left text-sm wrap-anywhere"
                      aria-current={selected === item.id ? "true" : undefined}
                      disabled={busy}
                      onKeyDown={navigateList}
                      onClick={(event) =>
                        activate(item.id, event.currentTarget)
                      }
                    >
                      {item.name}
                    </button>
                    {enabled(item)}
                  </div>
                ))}
              </div>
              <div
                className={`min-w-0 flex-1 p-5 ${open ? "block" : "hidden md:block"}`}
              >
                {open ? (
                  <>
                    <div className="mb-4 md:hidden">
                      <Button onClick={() => choose(null)}>
                        ‹ Back to Providers
                      </Button>
                    </div>
                    {content}
                  </>
                ) : (
                  <p className="text-sm text-fg-muted">
                    Select a provider to edit its connection and models.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div data-provider-list className="flex min-w-0 flex-col gap-3">
              {selected === "new" ? (
                <section className="rounded-md border border-line bg-surface p-5">
                  {content}
                </section>
              ) : null}
              {visibleProviders.map((item) => (
                <section
                  key={item.id}
                  className="min-w-0 rounded-md border border-line bg-surface"
                >
                  <div className="flex min-h-[52px] flex-wrap items-center gap-3 px-5 py-3">
                    <button
                      type="button"
                      data-provider-target
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
                      disabled={busy}
                      aria-expanded={selected === item.id}
                      onKeyDown={navigateList}
                      onClick={(event) =>
                        activate(item.id, event.currentTarget)
                      }
                    >
                      {summary(item)}
                    </button>
                    {enabled(item)}
                  </div>
                  {selected === item.id ? (
                    <div className="border-t border-line p-5">{content}</div>
                  ) : null}
                </section>
              ))}
            </div>
          )}
          {layout === "cards" ? (
            <Modal
              width="medium"
              open={open}
              onOpenChange={(next) => {
                if (!next) choose(null);
              }}
              title={provider?.name ?? "Add provider"}
              footer={null}
            >
              {content}
            </Modal>
          ) : null}
        </>
      )}
      {!catalog && error ? (
        <>
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Button onClick={() => void load()}>Retry</Button>
        </>
      ) : null}
      <Modal
        open={discard !== null}
        onOpenChange={(next) => {
          if (!next) setDiscard(null);
        }}
        title="Discard unsaved changes?"
        description="Your changes have not been saved."
        footer={
          <>
            <Button onClick={() => setDiscard(null)}>Keep Editing</Button>
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
          </>
        }
      />
    </div>
  );
}

function ProviderModelEditor({
  provider,
  model,
  save,
  busy,
  connectionDirty,
  onDraft,
  unavailable = false,
  onClose,
  table = false,
}: {
  table?: boolean;
  unavailable?: boolean;
  onClose?: () => void;
  provider: ProviderConfig;
  model?: RegisteredModel;
  save: SaveModel;
  busy: boolean;
  connectionDirty: boolean;
  onDraft: (id: string, dirty: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = model?.id ?? "new-model";
  const report = useCallback(
    (dirty: boolean) => onDraft(id, dirty),
    [id, onDraft],
  );
  useEffect(() => () => onDraft(id, false), [id, onDraft]);
  const recovery = onClose ? (
    <div className="flex flex-col gap-2 p-3">
      <p role="alert" className="text-sm text-danger">
        This model no longer exists. Your draft is retained.
      </p>
      <Button disabled={busy} onClick={onClose}>
        Close editor
      </Button>
    </div>
  ) : null;
  if (table && model)
    return (
      <>
        <tr>
          <td className="min-w-0">
            <button
              type="button"
              className="flex min-h-11 flex-col text-left text-sm wrap-anywhere"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <span className="font-medium">{model.name}</span>
              <span className="text-xs text-fg-muted">{model.model}</span>
            </button>
          </td>
          <td data-hide-below="sm" className="text-xs text-fg-muted">
            {model.thinking_budget_tokens
              ? `${model.thinking_budget_tokens} tokens`
              : model.thinking_options.join(", ")}
          </td>
        </tr>
        <tr hidden={!expanded} inert={!expanded}>
          <td colSpan={2}>
            {recovery}
            <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
              <ModelForm
                provider={provider}
                model={model}
                save={save}
                busy={busy}
                onDraft={report}
                connectionDirty={connectionDirty}
                unavailable={unavailable}
              />
            </fieldset>
          </td>
        </tr>
      </>
    );
  return (
    <section className="min-w-0 rounded border border-line">
      <button
        type="button"
        className="flex min-h-11 w-full min-w-0 flex-wrap items-center justify-between gap-2 p-3 text-left text-sm"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="min-w-0 wrap-anywhere font-medium">
          {model?.name ?? "Add model"}
        </span>
        {model ? (
          <span className="min-w-0 wrap-anywhere text-xs text-fg-muted">
            {model.model}
          </span>
        ) : null}
      </button>
      {recovery}
      <fieldset
        hidden={!expanded}
        inert={!expanded}
        disabled={busy}
        className="m-0 min-w-0 border-0 p-4"
      >
        <ModelForm
          provider={provider}
          model={model}
          save={save}
          busy={busy}
          onDraft={report}
          connectionDirty={connectionDirty}
          unavailable={unavailable}
        />
      </fieldset>
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
  useEffect(() => {
    onDraft?.(
      value.model_id !== catalog.default_model_id ||
        value.thinking !== catalog.default_thinking,
    );
  }, [onDraft, value, catalog.default_model_id, catalog.default_thinking]);
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
      <Button type="submit" variant="primary">
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
  onDeleted,
  onDraft,
  onCancel,
  unavailable = false,
  modelCount = 0,
}: {
  provider?: ProviderConfig;
  unavailable?: boolean;
  save: SaveModel;
  busy: boolean;
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
  return (
    <form
      className="provider-form flex flex-col gap-4"
      onChangeCapture={() => {
        dirty.current = true;
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (unavailable) return;
        if (body.error !== null) {
          bodyInput.current?.focus();
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
              restoreBodyFocus.current = true;
            },
          )
        ) {
          dirty.current = false;
          setName(name.trim());
          setBaseUrl(baseUrl.trim());
          setApiKey("");
          setClearKey(false);
        }
      }}
    >
      <Field
        label="Provider name"
        htmlFor={`${id}-name`}
        hint={nameError ? "Enter a provider name." : undefined}
      >
        <Input
          id={`${id}-name`}
          value={name}
          required
          aria-invalid={nameError}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="API type">
        <div className="min-w-0 overflow-x-auto">
          <Segmented
            label="API type"
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
      <Field
        label={
          <span className="inline-flex items-center gap-1">
            <label htmlFor={`${id}-body`}>Custom request body</label>
            <Tooltip label="Add a JSON object to every model request for this provider. Supports OpenAI Chat, OpenAI Responses and Anthropic. Maximum 16 KiB of UTF-8 JSON and 16 container levels. Explicit fields take priority over thinking settings; nested objects are replaced as a whole. Changes apply to the next Turn. Clear the field to remove all custom content. Omit a key to remove it; null is sent as a real JSON null.">
              <button
                type="button"
                aria-label="About custom request body"
                className="inline-flex cursor-help"
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
        <p id={`${id}-body-hint`} className="text-xs text-fg-muted">
          {apiType === "google"
            ? "This API does not support a custom request body. Clear it before saving."
            : "Optional JSON object · 16 KiB maximum · applies to the next Turn."}
        </p>
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
      <Field label="Base URL" htmlFor={`${id}-url`}>
        <Input
          id={`${id}-url`}
          value={baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </Field>
      <Field
        label="API key"
        htmlFor={`${id}-key`}
        hint={
          provider?.api_key_set
            ? "Leave blank to keep the stored key."
            : undefined
        }
      >
        <Input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Field>
      {provider?.api_key_set ? (
        <>
          <Chip tone="success">Key stored</Chip>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(event) => setClearKey(event.target.checked)}
            />
            Clear stored key
          </label>
        </>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enabled
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={unavailable}>
          {busy ? <Spinner label="Saving provider" /> : null}
          {onDraft ? "Save" : provider ? "Save provider" : "Create provider"}
        </Button>
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
        {provider ? (
          <Button
            disabled={unavailable || modelCount > 0}
            onClick={() => setConfirmDelete(true)}
          >
            {onDraft ? "Delete" : "Delete provider"}
          </Button>
        ) : null}
      </div>
      {modelCount > 0 ? (
        <p className="text-sm text-fg-muted">
          Remove this provider's models first.
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${provider?.name}?`}
        description="This provider will be removed."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (
            !unavailable &&
            provider &&
            (await save("delete_provider", provider.id))
          )
            onDeleted();
        }}
      />
    </form>
  );
}

function ModelForm({
  provider,
  model,
  save,
  busy,
  onDraft,
  connectionDirty = false,
  unavailable = false,
}: {
  provider: ProviderConfig;
  unavailable?: boolean;
  model?: RegisteredModel;
  save: SaveModel;
  busy: boolean;
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
  const [testing, setTesting] = useState(false);
  const [thinking, setThinking] = useState<Thinking>("default");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const testRequest = useRef(0);
  useEffect(() => {
    testRequest.current += 1;
    setTesting(false);
    setFeedback(null);
    return () => {
      testRequest.current += 1;
    };
  }, [provider, remote, budgetTokens, thinking, unavailable]);
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
    listRequest.current += 1;
    setOptions([]);
    setListing(false);
    return () => {
      listRequest.current += 1;
    };
  }, [provider, unavailable]);
  const listModels = async () => {
    if (unavailable) return;
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
  const testModel = async () => {
    if (unavailable || !validTestSelection || !remote.trim() || connectionDirty)
      return;
    const request = ++testRequest.current;
    setTesting(true);
    setFeedback(null);
    try {
      const result = await backend.call<{ latency_ms: number; reply: string }>(
        "settings.test_model",
        model
          ? { model_id: model.id, thinking }
          : {
              provider_id: provider.id,
              model: remote.trim(),
              thinking,
              thinking_budget_tokens: budgetSupported ? parsedBudget : null,
            },
      );
      if (request !== testRequest.current) return;
      setFeedback(modelTestDescription(result.latency_ms, result.reply));
      toast({
        tone: "success",
        title: "Model responded",
        description: modelTestDescription(result.latency_ms, result.reply),
      });
    } catch (error) {
      if (request !== testRequest.current) return;
      setFeedback(error instanceof Error ? error.message : String(error));
      if (error instanceof BackendError && error.transport)
        backend.reportFailure(error);
      else
        toast({
          tone: "danger",
          title: "Model test failed",
          description: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (request === testRequest.current) setTesting(false);
    }
  };
  return (
    <form
      className="model-form flex flex-col gap-4"
      onChangeCapture={() => {
        dirty.current = true;
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (unavailable) return;
        if (!remote.trim()) {
          event.currentTarget
            .querySelector<HTMLInputElement>('[role="combobox"]')
            ?.focus();
          setFeedback("Enter a remote model ID.");
          return;
        }
        if (budgetSupported && !validBudget) {
          event.currentTarget
            .querySelector<HTMLInputElement>('[type="number"]')
            ?.focus();
          toast({
            tone: "danger",
            title: "Invalid thinking budget",
            description: "Enter a positive whole number.",
          });
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
          }
          if (!model) {
            setName("");
            setEnabled(true);
            setRemote("");
            setBudgetTokens("");
            setThinking("default");
          }
        }
      }}
    >
      <Field label="Model name" htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Remote model ID" htmlFor={`${id}-remote`}>
        <Combobox
          id={`${id}-remote`}
          label="Remote model ID"
          value={remote}
          onChange={(value) => {
            dirty.current = true;
            setRemote(value);
          }}
          options={options}
          chooseLabel="Choose model"
          loadLabel="Load models"
          onLoad={() => void listModels()}
          loading={listing}
        />
      </Field>
      {budgetSupported ? (
        <Field
          label="Thinking token budget"
          htmlFor={`${id}-budget`}
          hint={
            validBudget
              ? "Used only when budget is selected."
              : "Enter a positive whole number."
          }
        >
          <Input
            id={`${id}-budget`}
            type="number"
            min="1"
            step="1"
            aria-invalid={!validBudget}
            value={budgetTokens}
            onChange={(event) => setBudgetTokens(event.target.value)}
          />
        </Field>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enabled
      </label>
      <Field label="Test thinking effort" htmlFor={`${id}-thinking`}>
        <select
          id={`${id}-thinking`}
          className={selectClass}
          value={thinking}
          onChange={(event) => setThinking(event.target.value as Thinking)}
        >
          {testThinkingOptions.map((option) => (
            <option key={option} value={option}>
              {thinkingLabel(option, parsedBudget)}
            </option>
          ))}
        </select>
      </Field>
      {connectionDirty ? (
        <p className="text-sm text-fg-muted">Save provider connection first.</p>
      ) : model && (budgetChanged || remote !== model.model) ? (
        <p className="text-sm text-fg-muted">Save model changes first.</p>
      ) : null}
      {feedback ? (
        <p role="status" className="text-sm">
          {feedback}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={unavailable}>
          {busy ? <Spinner label="Saving model" /> : null}
          {model ? "Save model" : "Add model"}
        </Button>
        <Button
          disabled={
            unavailable ||
            testing ||
            connectionDirty ||
            !provider.api_key_set ||
            !remote.trim() ||
            !validTestSelection ||
            budgetChanged ||
            Boolean(model && remote !== model.model)
          }
          onClick={() => void testModel()}
        >
          {testing ? <Spinner label="Testing" /> : null}Test
        </Button>
        {model ? (
          <Button disabled={unavailable} onClick={() => setConfirmDelete(true)}>
            Delete model
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${model?.name}?`}
        description="This model will be removed."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!unavailable && model) await save("delete_model", model.id);
        }}
      />
    </form>
  );
}
