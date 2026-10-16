import { clsx } from "clsx";
import {
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Gauge,
  Pause,
  PencilLine,
  Play,
  RefreshCw,
  Send,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useOrganization, useResource } from "@/app/organization";
import { useNavigate } from "@/app/router";
import { Page, PageBody, PageHeader, Section } from "@/components/layout/shell";
import { LoadError } from "@/components/ui/access-error";
import { ConfirmDialog, Modal, PromptDialog } from "@/components/ui/dialog";
import {
  Avatar,
  Button,
  Chip,
  Dot,
  LoadingSkeleton,
  Meter,
  Skeleton,
  StateDot,
  StatusText,
} from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { StatePanel } from "@/components/ui/state-panel";
import { Tooltip } from "@/components/ui/tooltip";
import { TreeView } from "@/features/library/tree-view";
import { ConversationSkeleton } from "@/features/members/activity-skeleton";
import { ConversationHistory } from "@/features/members/conversation-history";
import { historyRun, mergeHistoryRuns } from "@/features/members/history-state";
import { agentStateLabel, canResume } from "@/features/members/state";
import { TurnHistoryModal } from "@/features/members/turn-history";
import { AgentModelDialog } from "@/features/settings/model";
import {
  type AgentDetail,
  type AgentHistoryRun,
  type AgentRun,
  BackendError,
  backend,
  type LibraryDocument,
  type LibraryEntry,
  type Member,
} from "@/lib/backend";
import {
  formatBytes,
  formatInteger,
  formatTime,
  plural,
  relativeTime,
} from "@/lib/format";

const TOOL_ICONS: Record<string, ReactNode> = {
  send: <Send size={13} />,
  run: <Terminal size={13} />,
  edit: <PencilLine size={13} />,
  ack: <Check size={13} />,
};

function toolIcon(tool: string): ReactNode {
  if (TOOL_ICONS[tool]) return TOOL_ICONS[tool];
  if (tool.startsWith("library")) return <FileText size={13} />;
  return <Gauge size={13} />;
}

function runTone(status: string): "green" | "red" | "blue" | "yellow" | "grey" {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "running") return "blue";
  if (status === "interrupted") return "yellow";
  return "grey";
}

export function MemberPage({ id }: { id: number }) {
  const { members, refresh, organizationError, connectionError } =
    useOrganization();
  const pending = !organizationError && !connectionError;
  const navigate = useNavigate();
  const member = members?.find((item) => item.id === id);
  const agent = member?.type === "agent" ? member : null;

  useEffect(() => {
    if (members !== null && !agent) navigate({ name: "members" });
  }, [agent, members, navigate]);

  if (members === null)
    return (
      <Page>
        <PageHeader
          crumb={{
            label: "Members",
            onSelect: () => navigate({ name: "members" }),
          }}
          title={
            pending ? <Skeleton className="h-6 w-44 max-w-full" /> : "Member"
          }
          leading={
            pending ? (
              <Skeleton className="size-10 shrink-0 rounded-md" />
            ) : undefined
          }
        />
        <PageBody>{pending ? <MemberSkeleton /> : null}</PageBody>
      </Page>
    );
  if (!agent) return null;
  return <AgentPage key={agent.id} member={agent} refresh={refresh} />;
}

function MemberSkeleton() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-3 py-4">
      <ConversationSkeleton label="Loading Member" window />
    </div>
  );
}

function AgentPage({
  member,
  refresh,
}: {
  member: Member;
  refresh: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const read = useCallback(() => backend.agentDetail(member.id), [member.id]);
  const { resource, refresh: refreshDetail, invalidate } = useResource(read);
  const detail = resource.data;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRead = useRef<Promise<void> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const load = useCallback(
    (changed = false) => {
      clearTimer();
      const operation = refreshDetail(changed);
      pendingRead.current = operation;
      void operation.finally(() => {
        if (pendingRead.current === operation) pendingRead.current = null;
      });
      return operation;
    },
    [clearTimer, refreshDetail],
  );
  const [doomed, setDoomed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [panel, setPanel] = useState<"model" | "workspace" | "context" | null>(
    null,
  );
  const paused = canResume(member);
  const [changingState, setChangingState] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const stateRequest = useRef(false);
  const toggle = async () => {
    if (stateRequest.current) return;
    stateRequest.current = true;
    setChangingState(true);
    try {
      await (paused
        ? backend.resumeAgent(member.id)
        : backend.pauseAgent(member.id));
      await refresh();
      setActionError(null);
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      stateRequest.current = false;
      setChangingState(false);
    }
  };

  useEffect(() => {
    let connected = true;
    const schedule = (immediate = false) => {
      if (!connected) return;
      if (pendingRead.current || immediate) void load(true);
      else if (timer.current === null)
        timer.current = setTimeout(() => {
          timer.current = null;
          void load(true);
        }, 150);
    };
    invalidate(true);
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        connected = false;
        clearTimer();
        pendingRead.current = null;
        invalidate(
          false,
          event.error instanceof BackendError ? event.error : undefined,
        );
        return;
      }
      if (event.type === "connection.restored") {
        connected = true;
        invalidate(true);
        void load();
        return;
      }
      if (
        (((event.type.startsWith("turn.") &&
          event.type !== "turn.generation") ||
          event.type === "usage.updated" ||
          event.type === "workspace.changed") &&
          event.agent_id === member.id) ||
        event.type === "organization.changed" ||
        event.type === "usage.index_updated" ||
        event.type === "settings.updated"
      )
        schedule(event.type === "turn.finished");
    });
    void load();
    return () => {
      connected = false;
      clearTimer();
      pendingRead.current = null;
      off();
      invalidate(false);
    };
  }, [clearTimer, load, invalidate, member.id]);

  return (
    <Page>
      <PageHeader
        wrap
        title={member.name}
        status={
          <>
            <AgentState member={member} />
            {member.pause_requested && member.state === "running" ? (
              <span className="text-sm text-warning wrap-anywhere">
                Pause requested · Current activity will finish
              </span>
            ) : null}
          </>
        }
        crumb={{
          label: "Members",
          onSelect: () => navigate({ name: "members" }),
        }}
        leading={<Avatar memberId={member.id} size="lg" />}
        actions={
          <>
            <Button
              variant={paused ? "primary" : "default"}
              disabled={changingState}
              onClick={() => void toggle()}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <OverflowMenu
              label={`Actions for ${member.name}`}
              actions={[
                {
                  id: "rename",
                  label: "Rename",
                  icon: <PencilLine size={15} />,
                  onSelect: () => setRenaming(true),
                },
                {
                  id: "delete",
                  label: "Delete",
                  icon: <Trash2 size={15} />,
                  tone: "danger",
                  disabled: member.state === "running",
                  onSelect: () => setDoomed(true),
                },
              ]}
            />
          </>
        }
      />
      <PageBody>
        {actionError ? (
          <p role="alert" className="text-danger wrap-anywhere">
            {actionError}
          </p>
        ) : null}
        <div className="flex min-w-0 flex-wrap gap-2 narrow:flex-col narrow:items-stretch">
          <Button onClick={() => setPanel("model")}>Model settings</Button>
          <Button onClick={() => setPanel("workspace")}>Workspace</Button>
          <Button onClick={() => setPanel("context")}>Inspect context</Button>
        </div>
        {resource.error &&
        !(resource.error.transport && backend.disconnected) ? (
          <LoadError
            error={resource.error}
            retry={() =>
              void (backend.disconnected
                ? backend.reconnect().catch(backend.reportFailure)
                : load())
            }
          />
        ) : null}
        {detail ? (
          <>
            {member.state === "blocked" || member.state === "error" ? (
              <div className="flex flex-col gap-2" role="status">
                {detail.reasons?.map((reason) => (
                  <p key={reason.code} className="text-warning wrap-anywhere">
                    {reason.message}. {reason.recovery}
                  </p>
                ))}
              </div>
            ) : null}
            <HistorySection
              key={member.id}
              agentId={member.id}
              initialRuns={detail.runs}
              reading
            />
          </>
        ) : resource.error ? null : (
          <MemberSkeleton />
        )}
      </PageBody>
      {panel === "model" ? (
        <AgentModelDialog agentId={member.id} onClose={() => setPanel(null)} />
      ) : null}
      <Modal
        open={panel === "workspace" || panel === "context"}
        onOpenChange={(open) => !open && setPanel(null)}
        title={panel === "workspace" ? "Workspace" : "Full context"}
        wide
        footer={<Button onClick={() => setPanel(null)}>Close</Button>}
      >
        {resource.error &&
        !(resource.error.transport && backend.disconnected) ? (
          <LoadError error={resource.error} retry={() => void load()} />
        ) : null}
        {detail ? (
          panel === "workspace" ? (
            <WorkspaceSection agentId={member.id} entries={detail.workspace} />
          ) : (
            <AgentContextSummary member={member} detail={detail} />
          )
        ) : resource.error ? null : (
          <LoadingSkeleton label="Loading Agent">
            {panel === "workspace" ? (
              [1, 2, 3, 4, 5].map((row) => (
                <Skeleton key={row} className="h-7 w-44 max-w-full" />
              ))
            ) : (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-px rounded-md border border-line bg-line">
                {[1, 2].map((card) => (
                  <div
                    key={card}
                    className="flex flex-col gap-3 bg-surface p-4"
                  >
                    <Skeleton className="w-24" />
                    <Skeleton className="h-6 w-32" />
                  </div>
                ))}
              </div>
            )}
          </LoadingSkeleton>
        )}
      </Modal>
      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename Member"
        protectUnsaved
        label="Name"
        initial={member.name}
        submitLabel="Rename"
        onSubmit={async (name) => {
          await backend.renameMember(member.id, name);
          await refresh();
        }}
      />

      <ConfirmDialog
        open={doomed}
        onOpenChange={setDoomed}
        title={`Delete ${member.name}?`}
        description="It leaves every Discussion and stops running."
        confirmLabel="Delete Agent"
        onConfirm={async () => {
          await backend.deleteAgent(member.id);
          await refresh();
        }}
      />
    </Page>
  );
}

function AgentContextSummary({
  member,
  detail,
}: {
  member: Member;
  detail: AgentDetail;
}) {
  return (
    <>
      {detail.statistics_unavailable ? (
        <p className="text-warning">
          Statistics unavailable: {detail.statistics_unavailable}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-px overflow-hidden rounded-md border border-line bg-line flex-none">
          <Stat
            label="Token spend"
            value={formatInteger(
              detail.usage_metrics
                ? detail.usage_metrics.total_tokens
                : detail.usage.total_tokens,
            )}
            detail={
              detail.token_limit === null ? (
                <span className="text-fg-muted">Token ceiling unavailable</span>
              ) : detail.token_limit > 0 ? (
                <>
                  {detail.usage_metrics?.total_tokens !== null ? (
                    <Meter
                      value={Math.min(
                        Number(
                          detail.usage_metrics
                            ? detail.usage_metrics.total_tokens
                            : detail.usage.total_tokens,
                        ),
                        detail.token_limit,
                      )}
                      max={detail.token_limit}
                      label={`Token spend for ${member.name}`}
                    />
                  ) : null}
                  <span className="text-fg-muted">
                    of {detail.token_limit.toLocaleString("en-US")}
                  </span>
                </>
              ) : (
                <span className="text-fg-muted">No ceiling</span>
              )
            }
          />
          <Stat
            label="Model requests"
            value={formatInteger(
              detail.usage_metrics
                ? detail.usage_metrics.requests
                : detail.usage.requests,
            )}
            detail={
              <span className="text-fg-muted">
                {formatInteger(
                  detail.usage_metrics
                    ? detail.usage_metrics.input_tokens
                    : detail.usage.input_tokens,
                )}{" "}
                in ·{" "}
                {formatInteger(
                  detail.usage_metrics
                    ? detail.usage_metrics.output_tokens
                    : detail.usage.output_tokens,
                )}{" "}
                out
              </span>
            }
          />
        </div>
      )}
      {detail.usage_version && !detail.usage_version.index.ready ? (
        <p className="text-fg-muted text-xs">Indexing saved usage</p>
      ) : null}
      {detail.usage_metrics &&
      detail.usage_metrics.total_known < detail.usage_metrics.records ? (
        <p className="text-fg-muted text-xs">Partial usage</p>
      ) : null}
      <AgentDetailStatus detail={detail} />
      <HistorySection agentId={member.id} initialRuns={detail.runs} />
    </>
  );
}

export function AgentDetailStatus({ detail }: { detail: AgentDetail }) {
  return (
    <>
      {detail.over_token_limit ? (
        <Chip tone="danger">
          <CircleAlert size={12} />
          Token ceiling
        </Chip>
      ) : null}
      {detail.pause_requested && detail.state === "running" ? (
        <Chip tone="warning">
          Pause requested · Current activity will finish
        </Chip>
      ) : null}
      {detail.idle ? (
        <Chip tone="warning">
          Idle · {detail.idle_streak.toLocaleString("en-US")}
        </Chip>
      ) : null}
      {detail.window.number > 1 ? (
        <Tooltip
          focusable
          label={[
            detail.window.reason,
            detail.window.reset_at ? formatTime(detail.window.reset_at) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <Chip>Window {detail.window.number.toLocaleString("en-US")}</Chip>
        </Tooltip>
      ) : null}
    </>
  );
}

export function WorkspaceContent({ file }: { file: LibraryDocument }) {
  return (
    <>
      <Chip>{formatBytes(new TextEncoder().encode(file.content).length)}</Chip>
      <pre className="max-h-[50vh] overflow-auto p-3 rounded-sm border border-line bg-surface text-fg font-mono text-xs leading-body tracking-[0]">
        {file.content}
      </pre>
    </>
  );
}

export function WorkspaceSection({
  agentId,
  entries,
}: {
  agentId: number;
  entries: LibraryEntry[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [path, setPath] = useState<string | null>(null);
  const [file, setFile] = useState<LibraryDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const connected = useRef(true);
  const pending = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const load = useCallback((): Promise<void> => {
    if (path === null || !connected.current) return Promise.resolve();
    clearTimer();
    if (pending.current) {
      dirty.current = true;
      return pending.current;
    }
    const current = generation.current;
    dirty.current = false;
    setLoading(true);
    setError(null);
    const operation = Promise.resolve().then(async () => {
      if (current !== generation.current) return;
      try {
        for (;;) {
          try {
            const result = await backend.workspaceRead(agentId, path);
            if (current !== generation.current) return;
            setFile((previous) =>
              previous?.hash === result.hash ? previous : result,
            );
            setError(null);
          } catch (failure) {
            if (current !== generation.current) return;
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
          }
          if (!dirty.current || current !== generation.current) return;
          dirty.current = false;
        }
      } finally {
        if (current === generation.current && pending.current === operation) {
          pending.current = null;
          setLoading(false);
        }
      }
    });
    pending.current = operation;
    return operation;
  }, [agentId, clearTimer, path]);

  useEffect(() => {
    generation.current += 1;
    connected.current = true;
    setFile(null);
    setError(null);
    if (path === null) return;
    const schedule = (immediate = false) => {
      if (!connected.current) return;
      if (pending.current || immediate) void load();
      else if (timer.current === null)
        timer.current = setTimeout(() => {
          timer.current = null;
          void load();
        }, 150);
    };
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        clearTimer();
        generation.current += 1;
        connected.current = false;
        pending.current = null;
        dirty.current = false;
        setLoading(false);
      }
      if (event.type === "connection.restored") {
        generation.current += 1;
        connected.current = true;
        pending.current = null;
        dirty.current = false;
        void load();
      }
      if (
        event.agent_id === agentId &&
        ((event.type === "workspace.changed" &&
          (event.path === undefined || event.path === path)) ||
          event.type === "turn.finished")
      )
        schedule(event.type === "turn.finished");
    });
    void load();
    return () => {
      generation.current += 1;
      connected.current = false;
      pending.current = null;
      dirty.current = false;
      clearTimer();
      off();
    };
  }, [clearTimer, load, path]);

  return (
    <Section title="Workspace">
      {entries.length === 0 ? (
        <StatePanel
          compact
          icons={[PencilLine, FileText, Terminal]}
          title="No Workspace files"
          description="Files created by this Agent will appear here."
        />
      ) : (
        <TreeView
          entries={entries}
          expanded={expanded}
          onToggle={(folder) =>
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(folder)) next.delete(folder);
              else next.add(folder);
              return next;
            })
          }
          onOpen={(next) => {
            setFile(null);
            setPath(next);
          }}
          readOnly
        />
      )}
      <Modal
        open={path !== null}
        onOpenChange={(open) => !open && setPath(null)}
        title={path ?? ""}
        variant="history"
        footer={null}
      >
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 text-danger"
          >
            <span>{error}</span>
            <Button disabled={loading} onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : null}
        {file ? (
          <WorkspaceContent file={file} />
        ) : loading ? (
          <LoadingSkeleton label="Loading file">
            {["90%", "75%", "85%"].map((width) => (
              <Skeleton key={width} style={{ width }} />
            ))}
          </LoadingSkeleton>
        ) : null}
      </Modal>
    </Section>
  );
}

function AgentState({ member }: { member: Member }) {
  return (
    <StatusText
      dot={<StateDot state={member.state} ping={member.state === "running"} />}
    >
      {agentStateLabel(member)}
    </StatusText>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 p-4 bg-surface">
      <span className="text-xs font-bold tracking-caps uppercase text-fg-muted">
        {label}
      </span>
      <span className="text-md font-semibold tabular-nums tracking-title">
        {value}
      </span>
      {detail ? (
        <span className="flex flex-col gap-1 text-xs">{detail}</span>
      ) : null}
    </div>
  );
}

export function HistorySection({
  agentId,
  initialRuns,
  reading = false,
}: {
  agentId: number;
  initialRuns: AgentRun[];
  reading?: boolean;
}) {
  return reading ? (
    <ConversationHistory
      key={agentId}
      agentId={agentId}
      initialRuns={initialRuns}
    />
  ) : (
    <InspectionHistory agentId={agentId} initialRuns={initialRuns} />
  );
}

function InspectionHistory({
  agentId,
  initialRuns,
}: {
  agentId: number;
  initialRuns: AgentRun[];
}) {
  const [runs, setRuns] = useState(() => initialRuns.map(historyRun));
  const [hasOlder, setHasOlder] = useState(initialRuns.length >= 30);
  const [before, setBefore] = useState<number | undefined>(() => {
    const last = initialRuns[initialRuns.length - 1];
    return last?.sequence;
  });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const olderGeneration = useRef(0);

  useEffect(
    () => () => {
      olderGeneration.current += 1;
    },
    [],
  );

  useEffect(() => {
    setRuns((current) =>
      mergeHistoryRuns(current, initialRuns.map(historyRun)),
    );
    if (initialRuns.length < 30) setHasOlder(false);
  }, [initialRuns]);

  const loadOlder = async () => {
    if (loadingOlder || !hasOlder || before === undefined) return;
    const generation = ++olderGeneration.current;
    setLoadingOlder(true);
    try {
      const page = await backend.agentHistory(agentId, before, 30);
      if (generation !== olderGeneration.current) return;
      setRuns((current) => mergeHistoryRuns(current, page.runs));
      setHasOlder(page.has_before);
      setBefore(page.next_before ?? undefined);
      setOlderError(null);
    } catch (failure) {
      if (generation === olderGeneration.current)
        setOlderError(
          failure instanceof Error ? failure.message : String(failure),
        );
    } finally {
      if (generation === olderGeneration.current) setLoadingOlder(false);
    }
  };

  return (
    <Section title="History">
      {runs.length === 0 ? (
        <StatePanel
          compact
          icons={[Terminal, Play, Gauge]}
          title="No activity yet"
          description="This Agent's activity will appear here."
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {runs.map((run) => (
              <ActivityCard
                key={run.sequence}
                run={run}
                onOpen={() => setSelected(run.sequence)}
              />
            ))}
          </ul>
          {olderError ? (
            <p role="alert" className="text-danger">
              {olderError}
            </p>
          ) : null}
          {hasOlder ? (
            <Button disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? (
                <RefreshCw className="animate-spin" size={14} />
              ) : null}
              {olderError ? "Retry earlier history" : "Load earlier history"}
            </Button>
          ) : null}
        </>
      )}
      {selected !== null ? (
        <TurnHistoryModal
          agentId={agentId}
          sequence={selected}
          open
          onOpenChange={(open) => !open && setSelected(null)}
        />
      ) : null}
    </Section>
  );
}

function ActivityCard({
  run,
  onOpen,
}: {
  run: AgentRun | AgentHistoryRun;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(run.status === "failed");
  const effects = "effects" in run ? run.effects : [];
  const tools = [...new Set(effects.map((effect) => effect.tool))];
  const requestCount = run.request_count ?? 0;

  return (
    <li className="border border-line rounded-sm bg-surface-raised/50 overflow-hidden transition-[border-color] duration-(--duration-fast) ease-linear hover:border-line-interactive">
      <button
        type="button"
        className="flex items-center gap-3 w-full py-3 px-4 border-0 bg-transparent text-inherit text-left cursor-pointer"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown
          className={clsx(
            "flex-none text-fg-muted transition-[rotate] duration-(--duration-base) ease-transform",
            !open && "-rotate-90",
          )}
          size={14}
          aria-hidden="true"
        />
        <span className="flex-none text-fg-muted font-mono text-xs tracking-[0]">
          #{run.sequence}
        </span>
        <StatusText dot={<Dot tone={runTone(run.status)} />}>
          <span className="capitalize">{run.status}</span>
        </StatusText>
        <span className="flex-1 min-w-0 truncate text-xs text-fg-muted">
          {requestCount > 0 ? (
            `${plural(requestCount, "model request")} · ${effects.length} ${plural(effects.length, "effect")}`
          ) : effects.length === 0 ? (
            <span className="text-warning">
              {run.status === "running"
                ? "No saved progress yet"
                : "Saved messages only"}
            </span>
          ) : (
            `${plural(effects.length, "effect")} · ${tools.join(", ")}`
          )}
          {run.usage_metrics ? (
            <span>
              {" "}
              · {formatInteger(run.usage_metrics.total_tokens)} tokens
              {run.usage_metrics.total_known < run.usage_metrics.records
                ? " (partial)"
                : ""}
            </span>
          ) : null}
        </span>
        <Tooltip label={formatTime(run.started_at)}>
          <time
            className="flex-none text-xs text-fg-muted"
            dateTime={run.started_at}
          >
            {relativeTime(run.started_at)}
          </time>
        </Tooltip>
      </button>
      {open ? (
        <div className="flex flex-col gap-3 pt-0 pr-4 pb-4 pl-[46px] animate-rise-in [animation-duration:var(--duration-slow)]">
          {run.error ? (
            <p className="flex items-center gap-2 py-2 px-3 border border-red-300/40 rounded-xs bg-red-500/15 text-red-100 text-xs font-mono tracking-[0]">
              <CircleAlert size={14} aria-hidden="true" />
              {run.error}
            </p>
          ) : null}
          {effects.length === 0 ? (
            <StatePanel
              compact
              icons={[Terminal, Gauge, FileText]}
              title={
                run.status === "running"
                  ? "No saved progress yet"
                  : "No effects recorded"
              }
            />
          ) : (
            <ul className="flex flex-col gap-1 -ml-1 border-l border-line pl-4">
              {effects.map((effect) => (
                <li
                  className="flex items-baseline gap-3 min-w-0"
                  key={`${run.sequence}-${effect.ordinal}`}
                >
                  <span className="inline-flex items-center gap-[5px] flex-none min-w-29 text-blue-100 font-mono text-xs tracking-[0]">
                    {toolIcon(effect.tool)}
                    {effect.tool}
                  </span>
                  <span className="flex-1 min-w-0 text-xs truncate text-fg-muted">
                    {effect.summary}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {run.last_saved_at ? (
            <p className="text-fg-muted text-xs">
              Saved {formatTime(run.last_saved_at)}
            </p>
          ) : null}
          {run.completed_at ? (
            <p className="text-fg-muted text-xs">
              Finished {formatTime(run.completed_at)}
            </p>
          ) : null}
          {onOpen ? (
            <Button size="sm" onClick={onOpen}>
              <FileText size={13} />
              View full context
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
