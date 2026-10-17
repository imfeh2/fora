import { Save } from "lucide-react";
import {
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { LoadError } from "@/components/ui/access-error";
import {
  Button,
  Field,
  FieldSkeleton,
  Input,
  LoadingSkeleton,
  Select,
  Spinner,
} from "@/components/ui/index";
import {
  reportLoadFailure,
  useReportSettingsSave,
  useSaver,
} from "@/features/settings/saver";
import {
  type AgentModelConfig,
  type BackendError,
  backend,
  type Member,
  type ModelCatalog,
  type Thinking,
} from "@/lib/backend";

const FIELDS = [
  { key: "context_window_tokens", label: "Context window (tokens)" },
  { key: "memory_index_bytes", label: "MEMORY.md in context (bytes)" },
  { key: "exchange_nudge_after", label: "Nudge after (messages)" },
  { key: "idle_streak_after", label: "Idle after (Turns)" },
  { key: "no_tool_turns_before_pause", label: "Pause after tool-free Turns" },
  { key: "max_concurrent_turns", label: "Concurrent Turns" },
  { key: "token_limit", label: "Tokens per Agent" },
  { key: "request_limit", label: "Model requests per Turn" },
];

const GROUPS = [
  { title: "Context", fields: FIELDS.slice(0, 2) },
  { title: "Run limits", fields: FIELDS.slice(5) },
  { title: "Reminders and pausing", fields: FIELDS.slice(2, 5) },
];

function agentInteger(key: string, draft: string): number | null {
  const value = draft.trim();
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) &&
    number >= (key === "token_limit" || key === "request_limit" ? 0 : 1)
    ? number
    : null;
}

export function agentUpdate(
  drafts: Record<string, string>,
): Record<string, number> | null {
  if (Object.keys(drafts).length !== FIELDS.length) return null;
  const update: Record<string, number> = {};
  for (const { key } of FIELDS) {
    const value = agentInteger(key, drafts[key] ?? "");
    if (value === null) return null;
    update[key] = value;
  }
  return update;
}

export function AgentForm({
  drafts,
  disabled = false,
  saving = false,
  first,
  onChange,
  onSave,
}: {
  drafts: Record<string, string>;
  disabled?: boolean;
  saving?: boolean;
  first?: Ref<HTMLInputElement>;
  onChange: (drafts: Record<string, string>) => void;
  onSave: (values: Record<string, number>) => void;
}) {
  const id = useId();
  const update = agentUpdate(drafts);
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (update && !disabled) onSave(update);
      }}
    >
      <fieldset
        className="agent-form m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
        aria-label="Agent settings"
        disabled={disabled}
      >
        <div className="agent-groups">
          {GROUPS.map((group) => (
            <section className="agent-group" key={group.title}>
              <h3>{group.title}</h3>
              <div className="agent-fields">
                {group.fields.map(({ key, label }) => (
                  <Field
                    key={key}
                    label={label}
                    htmlFor={`${id}-${key}`}
                    hint={
                      key in drafts && agentInteger(key, drafts[key]) === null
                        ? "Enter a valid whole number before saving."
                        : key === "request_limit"
                          ? "0 means unlimited. Changes apply to new Turns."
                          : key === "token_limit"
                            ? "0 means no ceiling."
                            : undefined
                    }
                  >
                    <Input
                      ref={key === FIELDS[0].key ? first : undefined}
                      id={`${id}-${key}`}
                      type="number"
                      inputMode="numeric"
                      min={
                        key === "token_limit" || key === "request_limit" ? 0 : 1
                      }
                      step={1}
                      max={Number.MAX_SAFE_INTEGER}
                      required
                      aria-invalid={
                        key in drafts && agentInteger(key, drafts[key]) === null
                      }
                      value={drafts[key] ?? ""}
                      onChange={(event) =>
                        onChange({ ...drafts, [key]: event.target.value })
                      }
                    />
                  </Field>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="primary"
            type="submit"
            disabled={disabled || !update}
          >
            {saving ? (
              <Spinner label="Saving agent settings" />
            ) : (
              <Save size={16} />
            )}
            Save
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function AgentModelsPanel() {
  const [agents, setAgents] = useState<Member[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<BackendError | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [organization, model] = await Promise.all([
        backend.organization(),
        backend.modelCatalog(),
      ]);
      setAgents(
        organization.members.filter((member) => member.type === "agent"),
      );
      setCatalog(model);
      setError(null);
    } catch (failure) {
      setError(reportLoadFailure(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !catalog) {
    return (
      <LoadingSkeleton label="Loading Agent models">
        <div className="agent-groups">
          <section className="agent-group">
            <h3>Agent models</h3>
            <div className="agent-fields">
              <FieldSkeleton />
              <FieldSkeleton />
            </div>
          </section>
        </div>
      </LoadingSkeleton>
    );
  }

  if (error && !(error.transport && backend.disconnected)) {
    return <LoadError error={error} retry={() => void load()} />;
  }

  if (!catalog) return null;

  const models = catalog.models.filter((model) => model.enabled);

  const save = async (agentId: number, values: AgentModelConfig) => {
    setSaving(agentId);
    setRowErrors((current) => {
      if (!(agentId in current)) return current;
      const next = { ...current };
      delete next[agentId];
      return next;
    });
    try {
      await backend.configureModel("set_agent", agentId, values);
      await load();
    } catch (failure) {
      setRowErrors((current) => ({
        ...current,
        [agentId]:
          failure instanceof Error
            ? failure.message
            : "Could not save the selection",
      }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="agent-group">
      <h3>Agent models</h3>
      <div className="flex flex-col gap-2">
        {agents.map((agent) => {
          const saved = catalog.agent_configs[String(agent.id)] ?? {
            model_id: null,
            thinking: null,
          };
          const effective = saved.model_id ?? catalog.default_model_id;
          const model = models.find((item) => item.id === effective);
          const options = model?.thinking_options ?? [];
          return (
            <div
              key={agent.id}
              className="flex min-w-0 flex-wrap items-center gap-3 px-2 py-1"
            >
              <span className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">
                {agent.name}
              </span>
              <Select
                aria-label={`Model for ${agent.name}`}
                value={saved.model_id ?? ""}
                disabled={saving === agent.id}
                onChange={(event) => {
                  const modelId = event.target.value || null;
                  if (modelId === null) {
                    void save(agent.id, { model_id: null, thinking: null });
                    return;
                  }
                  const next = models.find((item) => item.id === modelId);
                  const keep =
                    saved.thinking !== null &&
                    (next?.thinking_options ?? []).includes(saved.thinking);
                  void save(agent.id, {
                    model_id: modelId,
                    thinking: keep ? saved.thinking : null,
                  });
                }}
              >
                <option value="">Default</option>
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={`Thinking for ${agent.name}`}
                value={saved.thinking ?? ""}
                disabled={saving === agent.id || options.length === 0}
                onChange={(event) =>
                  void save(agent.id, {
                    model_id: saved.model_id,
                    thinking: (event.target.value || null) as Thinking | null,
                  })
                }
              >
                <option value="">Default</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
              {rowErrors[agent.id] ? (
                <p className="w-full text-xs text-danger">
                  {rowErrors[agent.id]}
                </p>
              ) : null}
            </div>
          );
        })}
        {agents.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No Agents in this organization.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function AgentPanel() {
  const first = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadError, setLoadError] = useState<BackendError | null>(null);

  const editing = useRef(drafts);
  editing.current = drafts;
  const saved = useRef(drafts);

  const load = useCallback(async (preserve = false) => {
    setLoading(true);
    setLoadFailed(false);
    setLoadError(null);
    try {
      const values = await backend.settings("agent");
      if (!preserve || editing.current === saved.current) {
        const next = Object.fromEntries(
          FIELDS.map(({ key }) => [key, String(values[key] ?? "")]),
        );
        saved.current = next;
        setDrafts(next);
      }
      setLoadFailed(false);
    } catch (error) {
      setLoadFailed(true);
      setLoadError(reportLoadFailure(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return backend.onEvent((event) => {
      if (event.type === "connection.restored") void load(true);
    });
  }, [load]);

  const { saving, save } = useSaver(load, first);
  useReportSettingsSave("agent", saving);
  const recovery =
    loadError && !(loadError.transport && backend.disconnected) ? (
      <LoadError error={loadError} retry={() => void load(true)} />
    ) : null;
  if (Object.keys(drafts).length === 0)
    return loadFailed ? (
      recovery
    ) : (
      <LoadingSkeleton label="Loading Agent settings">
        <div className="agent-groups">
          {GROUPS.map((group) => (
            <section className="agent-group" key={group.title}>
              <h3>{group.title}</h3>
              <div className="agent-fields">
                {group.fields.map(({ key }) => (
                  <FieldSkeleton key={key} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </LoadingSkeleton>
    );
  return (
    <>
      {recovery}
      <AgentForm
        drafts={drafts}
        disabled={loading || saving || loadFailed}
        saving={saving}
        first={first}
        onChange={setDrafts}
        onSave={(values) => void save("agent", values)}
      />
      <AgentModelsPanel />
    </>
  );
}
