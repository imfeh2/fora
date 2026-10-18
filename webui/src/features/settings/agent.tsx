import { CircleHelp, Save } from "lucide-react";
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
  Spinner,
} from "@/components/ui/index";
import { Tooltip } from "@/components/ui/tooltip";
import {
  reportLoadFailure,
  useReportSettingsSave,
  useSaver,
} from "@/features/settings/saver";
import { type BackendError, backend } from "@/lib/backend";

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

const OPTIONAL_FIELDS = new Set(["context_window_tokens"]);

function agentField(
  key: string,
  draft: string,
): { valid: boolean; value: number | null } {
  const text = draft.trim();
  if (text === "") return { valid: OPTIONAL_FIELDS.has(key), value: null };
  if (!/^\d+$/.test(text)) return { valid: false, value: null };
  const number = Number(text);
  const minimum = key === "token_limit" || key === "request_limit" ? 0 : 1;
  return {
    valid: Number.isSafeInteger(number) && number >= minimum,
    value: number,
  };
}

export function agentUpdate(
  drafts: Record<string, string>,
): Record<string, number | null> | null {
  if (Object.keys(drafts).length !== FIELDS.length) return null;
  const update: Record<string, number | null> = {};
  for (const { key } of FIELDS) {
    const field = agentField(key, drafts[key] ?? "");
    if (!field.valid) return null;
    update[key] = field.value;
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
  onSave: (values: Record<string, number | null>) => void;
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
                    action={
                      key === "request_limit" || key === "token_limit" ? (
                        <Tooltip
                          label={
                            key === "request_limit"
                              ? "0 means unlimited."
                              : "0 means no ceiling."
                          }
                        >
                          <button
                            type="button"
                            aria-label={`About ${label}`}
                            className="inline-flex cursor-help p-1.5 -m-1.5"
                          >
                            <CircleHelp size={14} />
                          </button>
                        </Tooltip>
                      ) : undefined
                    }
                    htmlFor={`${id}-${key}`}
                    hint={
                      key in drafts && !agentField(key, drafts[key] ?? "").valid
                        ? "Enter a valid whole number before saving."
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
                      required={!OPTIONAL_FIELDS.has(key)}
                      aria-invalid={
                        key in drafts &&
                        !agentField(key, drafts[key] ?? "").valid
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
    </>
  );
}
