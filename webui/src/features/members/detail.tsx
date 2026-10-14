import { clsx } from "clsx";
import {
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Gauge,
  Maximize2,
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
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
import { useWindowState } from "@/features/members/window-cache";
import { AgentModelDialog } from "@/features/settings/model";
import {
  type AgentDetail,
  type AgentHistoryRead,
  type AgentHistoryRun,
  type AgentRun,
  BackendError,
  backend,
  type HistoryBinary,
  type HistoryMessages,
  type HistoryText,
  type HistoryValue,
  type LibraryDocument,
  type LibraryEntry,
  type LivePage,
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
        ((event.type.startsWith("turn.") ||
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

function mergeHistoryRequests(
  current: AgentHistoryRead["requests"],
  incoming: AgentHistoryRead["requests"],
) {
  const requests = new Map(
    current.map((request) => [request.ordinal, request]),
  );
  for (const request of incoming) requests.set(request.ordinal, request);
  return [...requests.values()].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
}

function historyFailure(failure: unknown): BackendError {
  return failure instanceof BackendError
    ? failure
    : new BackendError(
        "request_failed",
        failure instanceof Error ? failure.message : String(failure),
      );
}

function isHistoryConnectionFailure(error: BackendError): boolean {
  return error.transport && error.code !== "timeout";
}

function mergeHistoryMessages(
  current: HistoryMessages,
  incoming: HistoryMessages,
): HistoryMessages {
  if (current.offset !== incoming.offset) return incoming;
  const messages = [...current.messages];
  for (const [index, message] of incoming.messages.entries())
    messages[index] = message;
  const end = current.offset + messages.length;
  return {
    ...incoming,
    messages,
    has_more: end < incoming.total,
    next_offset: end < incoming.total ? end : undefined,
  };
}

function mergeHistoryWindows(
  current: AgentHistoryRead["windows"],
  incoming: AgentHistoryRead["windows"],
) {
  const windows = new Map(current.map((event) => [event.number, event]));
  for (const event of incoming) windows.set(event.number, event);
  return [...windows.values()].sort(
    (left, right) => left.number - right.number,
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

export function TurnHistoryModal({
  agentId,
  sequence,
  open,
  onOpenChange,
  inline = false,
  latestOrdinal,
  initialOrdinal,
}: {
  agentId: number;
  sequence: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inline?: boolean;
  latestOrdinal?: number;
  initialOrdinal?: number;
}) {
  const following = useRef(inline && initialOrdinal === undefined);
  const newestOrdinal = useRef(latestOrdinal);
  newestOrdinal.current = latestOrdinal;
  const [read, setRead] = useState<AgentHistoryRead | null>(null);
  const [ordinal, setOrdinal] = useState<number | undefined>(
    inline && initialOrdinal === undefined ? latestOrdinal : initialOrdinal,
  );
  const [error, setError] = useState<BackendError | null>(null);
  const loadGeneration = useRef(0);
  const pendingRefresh = useRef<Promise<void> | null>(null);
  const refreshDirty = useRef(false);

  const load = useCallback(
    async (
      nextOrdinal: number | undefined,
      options: {
        target?:
          | "run"
          | "input"
          | "response"
          | "related"
          | "requests"
          | "windows";
        offset?: number;
        requestAfter?: number;
        windowsAfter?: number;
      } = {},
    ) => {
      const generation = ++loadGeneration.current;
      const target = options.target;
      const offset = options.offset ?? 0;
      try {
        const result = await backend.agentHistoryRead(
          agentId,
          sequence,
          nextOrdinal,
          target === "run" ? offset : 0,
          target === "input" ? offset : 0,
          target === "response" ? offset : 0,
          target === "related" ? offset : 0,
          {
            requestAfter: options.requestAfter,
            windowsAfter: options.windowsAfter,
          },
        );
        if (generation !== loadGeneration.current) return;
        if (!target && nextOrdinal === undefined && result.request) {
          setOrdinal(result.request.summary.ordinal);
        }
        setRead((current) => {
          if (!current) return result;
          const requests = mergeHistoryRequests(
            current.requests,
            result.requests,
          );
          const windows = mergeHistoryWindows(current.windows, result.windows);
          const requestsHasMore = requests.length < result.run.request_count;
          const windowsHasMore =
            target === "windows" ||
            result.windows.length >= current.windows.length
              ? result.windows_has_more
              : current.windows_has_more;
          const request = result.request;
          const previous = current.request;
          const merged = {
            ...result,
            messages: mergeHistoryMessages(current.messages, result.messages),
            request:
              request &&
              previous &&
              request.summary.ordinal === previous.summary.ordinal
                ? {
                    ...request,
                    input: mergeHistoryMessages(previous.input, request.input),
                    related: mergeHistoryMessages(
                      previous.related,
                      request.related,
                    ),
                    response:
                      previous.response && request.response
                        ? mergeHistoryMessages(
                            previous.response,
                            request.response,
                          )
                        : request.response,
                  }
                : request,
            requests,
            requests_has_more: requestsHasMore,
            requests_next_after: requestsHasMore
              ? (requests[requests.length - 1]?.ordinal ?? null)
              : null,
            windows,
            windows_has_more: windowsHasMore,
            windows_next_after: windowsHasMore
              ? (windows[windows.length - 1]?.number ?? null)
              : null,
          };
          if (!target) return merged;
          if (target === "requests" || target === "windows") {
            return {
              ...merged,
              request: current.request ?? result.request,
            };
          }
          if (target === "run") {
            return {
              ...merged,
              messages: {
                ...result.messages,
                offset: current.messages.offset,
                messages: [
                  ...current.messages.messages,
                  ...result.messages.messages,
                ],
              },
            };
          }
          if (!current.request || !result.request || !merged.request)
            return merged;
          return {
            ...merged,
            request: {
              ...merged.request,
              input:
                target === "input"
                  ? {
                      ...result.request.input,
                      offset: current.request.input.offset,
                      messages: [
                        ...current.request.input.messages,
                        ...result.request.input.messages,
                      ],
                    }
                  : merged.request.input,
              response:
                target === "response" &&
                current.request.response &&
                result.request.response
                  ? {
                      ...result.request.response,
                      offset: current.request.response.offset,
                      messages: [
                        ...current.request.response.messages,
                        ...result.request.response.messages,
                      ],
                    }
                  : merged.request.response,
              related:
                target === "related"
                  ? {
                      ...result.request.related,
                      offset: current.request.related.offset,
                      messages: [
                        ...current.request.related.messages,
                        ...result.request.related.messages,
                      ],
                    }
                  : merged.request.related,
            },
          };
        });
        setError(null);
      } catch (failure) {
        if (generation !== loadGeneration.current) return;
        const problem = historyFailure(failure);
        if (!isHistoryConnectionFailure(problem)) setError(problem);
      }
    },
    [agentId, sequence],
  );

  const refreshOrdinal = useRef<number | undefined>(undefined);
  const refreshHistory = useCallback(
    (nextOrdinal: number | undefined): Promise<void> => {
      refreshOrdinal.current = nextOrdinal;
      if (pendingRefresh.current) {
        refreshDirty.current = true;
        return pendingRefresh.current;
      }
      const requestedGeneration = loadGeneration.current;
      const operation = Promise.resolve().then(async () => {
        if (loadGeneration.current !== requestedGeneration) return;
        try {
          do {
            refreshDirty.current = false;
            const previous = loadGeneration.current;
            await load(refreshOrdinal.current);
            if (loadGeneration.current !== previous + 1) return;
          } while (refreshDirty.current);
        } finally {
          if (pendingRefresh.current === operation)
            pendingRefresh.current = null;
        }
      });
      pendingRefresh.current = operation;
      return operation;
    },
    [load],
  );

  useEffect(() => {
    if (!open) return;
    setRead(null);
    following.current = inline && initialOrdinal === undefined;
    const initial = following.current ? newestOrdinal.current : initialOrdinal;
    setOrdinal(initial);
    void refreshHistory(initial);
    return () => {
      loadGeneration.current += 1;
      pendingRefresh.current = null;
      refreshDirty.current = false;
    };
  }, [initialOrdinal, inline, refreshHistory, open, sequence]);

  useEffect(() => {
    if (!open) return;
    return backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        loadGeneration.current += 1;
        pendingRefresh.current = null;
        refreshDirty.current = false;
        setError((current) =>
          current && isHistoryConnectionFailure(current) ? null : current,
        );
        return;
      }
      if (
        event.type === "connection.restored" ||
        (event.type.startsWith("turn.") &&
          event.agent_id === agentId &&
          event.sequence === sequence)
      )
        void refreshHistory(
          following.current ? newestOrdinal.current : ordinal,
        );
    });
  }, [agentId, refreshHistory, open, ordinal, sequence]);

  useEffect(() => {
    if (
      !open ||
      !following.current ||
      latestOrdinal === undefined ||
      latestOrdinal === ordinal
    )
      return;
    setOrdinal(latestOrdinal);
    void refreshHistory(latestOrdinal);
  }, [latestOrdinal, refreshHistory, open, ordinal]);

  const selectRequest = (nextOrdinal: number) => {
    following.current = false;
    pendingRefresh.current = null;
    refreshDirty.current = false;
    setOrdinal(nextOrdinal);
    void load(nextOrdinal);
  };

  const content = (
    <div className="min-w-0 min-h-0 flex flex-col gap-4">
      {error ? (
        <div className="flex items-center justify-between gap-3 py-2 px-3 border border-red-300/40 rounded-xs bg-red-500/15 text-red-100 text-xs">
          <span className="flex items-center gap-2 min-w-0 wrap-anywhere">
            <CircleAlert size={14} aria-hidden="true" />
            {error.message}
          </span>
          <Button size="sm" onClick={() => void load(ordinal)}>
            <RefreshCw size={13} />
            Retry
          </Button>
        </div>
      ) : null}
      {read ? (
        <HistoryReadPanel
          read={read}
          compact={inline}
          ordinal={ordinal}
          onSelectRequest={selectRequest}
          onLoadMoreRun={() =>
            void load(ordinal, {
              target: "run",
              offset:
                read.messages.next_offset ??
                read.messages.offset + read.messages.messages.length,
            })
          }
          onLoadMoreRequests={() =>
            read.requests_next_after === null
              ? undefined
              : void load(ordinal, {
                  target: "requests",
                  requestAfter: read.requests_next_after,
                })
          }
          onLoadMoreWindows={() =>
            read.windows_next_after === null
              ? undefined
              : void load(ordinal, {
                  target: "windows",
                  windowsAfter: read.windows_next_after,
                })
          }
          onLoadMoreInput={() =>
            read.request
              ? void load(ordinal, {
                  target: "input",
                  offset:
                    read.request.input.offset +
                    read.request.input.messages.length,
                })
              : undefined
          }
          onLoadMoreResponse={() =>
            read.request?.response
              ? void load(ordinal, {
                  target: "response",
                  offset:
                    read.request.response.offset +
                    read.request.response.messages.length,
                })
              : undefined
          }
          onLoadMoreRelated={() =>
            read.request
              ? void load(ordinal, {
                  target: "related",
                  offset:
                    read.request.related.offset +
                    read.request.related.messages.length,
                })
              : undefined
          }
        />
      ) : error ? null : (
        <StatePanel
          compact
          icons={[Terminal, Gauge, FileText]}
          title="Loading activity history"
        />
      )}
    </div>
  );
  return inline ? (
    content
  ) : (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Activity #${sequence}`}
      variant="history"
      wide
      footer={<Button onClick={() => onOpenChange(false)}>Close</Button>}
    >
      {content}
    </Modal>
  );
}

function HistoryReadPanel({
  read,
  compact = false,
  ordinal,
  onSelectRequest,
  onLoadMoreRun,
  onLoadMoreRequests,
  onLoadMoreWindows,
  onLoadMoreInput,
  onLoadMoreResponse,
  onLoadMoreRelated,
}: {
  read: AgentHistoryRead;
  compact?: boolean;
  ordinal: number | undefined;
  onSelectRequest: (ordinal: number) => void;
  onLoadMoreRun: () => void;
  onLoadMoreRequests: () => void;
  onLoadMoreWindows: () => void;
  onLoadMoreInput: () => void;
  onLoadMoreResponse: () => void;
  onLoadMoreRelated: () => void;
}) {
  return (
    <>
      {read.run.error ? (
        <p className="text-danger wrap-anywhere">{read.run.error}</p>
      ) : null}
      {!read.request && read.messages.messages.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {read.run.status === "running"
            ? "No saved progress yet"
            : "No saved content"}
        </p>
      ) : null}
      {!compact ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          <span>{read.run.status}</span>
          <span>{formatTime(read.run.started_at)}</span>
          {read.run.last_saved_at ? (
            <span>Saved {formatTime(read.run.last_saved_at)}</span>
          ) : null}
          {read.run.window_number ? (
            <span>
              Window {read.run.window_number}
              {read.run.window_reason ? ` · ${read.run.window_reason}` : ""}
            </span>
          ) : null}
          {read.run.window_reset_at ? (
            <span>Reset {formatTime(read.run.window_reset_at)}</span>
          ) : null}
          {read.run.run_id ? (
            <span className="font-mono">{read.run.run_id}</span>
          ) : null}
        </div>
      ) : null}
      {read.missing.length > 0 ? (
        <p className="py-2 px-3 border border-yellow-200/40 rounded-xs bg-yellow-500/10 text-warning text-xs">
          Missing historical data: {read.missing.join(", ")}
        </p>
      ) : null}
      {!compact && read.windows.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold tracking-title">
            Context windows
          </h3>
          <ul className="flex flex-col gap-1 text-xs text-fg-muted">
            {read.windows.map((event) => (
              <li key={event.number} className="flex flex-wrap gap-x-3 gap-y-1">
                <span>Window {event.number}</span>
                <span>From #{event.since_sequence}</span>
                {event.reason ? <span>{event.reason}</span> : null}
                {event.reset_at ? (
                  <span>{formatTime(event.reset_at)}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {read.windows_has_more ? (
            <Button size="sm" onClick={onLoadMoreWindows}>
              Load more windows
            </Button>
          ) : null}
        </section>
      ) : null}
      {read.requests.length > 0 ? (
        <div
          className="flex min-w-0 flex-wrap gap-1 border-b border-line pb-3"
          role="tablist"
          aria-label="Model requests"
        >
          {read.requests.map((request) => (
            <button
              key={request.ordinal}
              type="button"
              role="tab"
              aria-selected={ordinal === request.ordinal}
              className={clsx(
                "inline-flex min-w-0 max-w-full flex-wrap items-center gap-2 px-3 py-1 border rounded-sm text-xs wrap-anywhere cursor-pointer",
                ordinal === request.ordinal
                  ? "border-blue-300/60 bg-blue-500/18 text-blue-50"
                  : "border-line bg-transparent text-fg-muted hover:bg-surface-hover",
              )}
              onClick={() => onSelectRequest(request.ordinal)}
            >
              Request {request.ordinal}
              <span className="capitalize">{request.status}</span>
            </button>
          ))}
        </div>
      ) : null}
      {read.requests_has_more ? (
        <Button size="sm" onClick={onLoadMoreRequests}>
          Load more requests
        </Button>
      ) : null}
      {read.request ? (
        <RequestHistoryContent
          key={`${read.run.sequence}-${read.request.summary.ordinal}`}
          agentId={read.agent_id}
          sequence={read.run.sequence}
          request={read.request}
          compact={compact}
          onLoadMoreInput={onLoadMoreInput}
          onLoadMoreResponse={onLoadMoreResponse}
          onLoadMoreRelated={onLoadMoreRelated}
        />
      ) : null}
      {(!compact || !read.request) && read.messages.messages.length > 0 ? (
        <HistoryMessagesPanel
          agentId={read.agent_id}
          sequence={read.run.sequence}
          title="Saved Turn messages"
          content={read.messages}
          compact={compact}
          onLoadMore={read.messages.has_more ? onLoadMoreRun : undefined}
        />
      ) : null}
    </>
  );
}

function RequestHistoryContent({
  agentId,
  sequence,
  request,
  compact = false,
  onLoadMoreInput,
  onLoadMoreResponse,
  onLoadMoreRelated,
}: {
  agentId: number;
  sequence: number;
  request: NonNullable<AgentHistoryRead["request"]>;
  compact?: boolean;
  onLoadMoreInput: () => void;
  onLoadMoreResponse: () => void;
  onLoadMoreRelated: () => void;
}) {
  const results = compact ? historyParts(request.related) : [];
  const calls = new Set(
    compact && request.response
      ? historyParts(request.response)
          .filter(
            (part) =>
              part.part_kind === "tool-call" &&
              typeof part.tool_call_id === "string",
          )
          .map((part) => part.tool_call_id)
      : [],
  );
  const related = compact
    ? {
        ...request.related,
        messages: request.related.messages.flatMap((message) => {
          if (!isRecord(message) || !Array.isArray(message.parts))
            return [message];
          const parts = message.parts.filter(
            (part) =>
              !isRecord(part) ||
              part.part_kind !== "tool-return" ||
              !calls.has(part.tool_call_id),
          );
          return parts.length > 0 ? [{ ...message, parts }] : [];
        }),
      }
    : request.related;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span>Request {request.summary.ordinal}</span>
        <span>
          {request.summary.streaming ? "Streaming" : "Single response"}
        </span>
        <span>{formatTime(request.summary.started_at)}</span>
        {request.summary.error ? (
          <span className="text-danger">{request.summary.error}</span>
        ) : null}
      </div>
      <LiveTools
        agentId={agentId}
        sequence={sequence}
        ordinal={request.summary.ordinal}
      />
      {!compact ? (
        <>
          <HistoryMessagesPanel
            agentId={agentId}
            sequence={sequence}
            title="Model input"
            content={request.input}
            onLoadMore={request.input.has_more ? onLoadMoreInput : undefined}
          />
          <HistoryValuePanel
            key={`${sequence}-${request.summary.ordinal}-parameters`}
            agentId={agentId}
            sequence={sequence}
            title="Model request parameters"
            value={request.parameters}
          />
          <HistoryValuePanel
            key={`${sequence}-${request.summary.ordinal}-settings`}
            agentId={agentId}
            sequence={sequence}
            title="Model settings"
            value={request.settings}
          />
          <HistoryValuePanel
            key={`${sequence}-${request.summary.ordinal}-model`}
            agentId={agentId}
            sequence={sequence}
            title="Model"
            value={request.model}
          />
        </>
      ) : null}

      {request.response ? (
        <HistoryMessagesPanel
          agentId={agentId}
          sequence={sequence}
          title="Model response"
          content={request.response}
          compact={compact}
          toolResults={results}
          onLoadMore={
            request.response.has_more ? onLoadMoreResponse : undefined
          }
        />
      ) : (
        <p className="text-warning text-sm">
          The model response is waiting for a saved result.
        </p>
      )}
      {related.messages.length > 0 || related.has_more ? (
        <HistoryMessagesPanel
          agentId={agentId}
          sequence={sequence}
          title="Associated tool results"
          content={related}
          compact={compact}
          onLoadMore={request.related.has_more ? onLoadMoreRelated : undefined}
        />
      ) : null}
    </div>
  );
}

export function LiveTools({
  agentId,
  sequence,
  ordinal,
}: {
  agentId: number;
  sequence: number;
  ordinal: number;
}) {
  const [page, setPage] = useState<LivePage | null>(null);
  const [error, setError] = useState<BackendError | null>(null);
  const retryRead = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    let active = true;
    let connected = true;
    let generation = 0;
    let pending = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let confirmedEpoch: string | null = null;
    let confirmedRevision = 0;
    const load = async () => {
      if (!active || !connected) return;
      if (pending) {
        dirty = true;
        return;
      }
      pending = true;
      const current = generation;
      try {
        do {
          dirty = false;
          let after: number | undefined;
          do {
            const cursor = after;
            const result = await backend.agentLive(
              agentId,
              sequence,
              ordinal,
              cursor,
            );
            if (!active || current !== generation) return;
            if (
              result.turn &&
              result.runtime_epoch === confirmedEpoch &&
              result.turn.live_revision < confirmedRevision
            ) {
              dirty = true;
              break;
            }
            setPage((previous) => {
              if (
                cursor === undefined ||
                !previous?.turn ||
                !result.turn ||
                previous.runtime_epoch !== result.runtime_epoch
              )
                return result;
              const first = previous.turn.requests[0];
              const next = result.turn.requests[0];
              if (!first || !next || first.request_id !== next.request_id)
                return result;
              const tools = new Map(
                first.tools.map((tool) => [tool.part_index, tool]),
              );
              for (const tool of next.tools) tools.set(tool.part_index, tool);
              return {
                ...result,
                turn: {
                  ...result.turn,
                  requests: [
                    {
                      ...next,
                      tools: [...tools.values()].sort(
                        (a, b) => a.part_index - b.part_index,
                      ),
                    },
                  ],
                },
              };
            });
            setError(null);
            const next = result.turn?.requests[0];
            after = next?.tools_has_more
              ? (next.tools_next_after ?? undefined)
              : undefined;
          } while (after !== undefined);
        } while (dirty);
      } catch (failure) {
        if (active && current === generation) setError(historyFailure(failure));
      } finally {
        if (active && current === generation) pending = false;
      }
    };
    const schedule = (immediate = false) => {
      if (!active || !connected) return;
      if (pending) {
        dirty = true;
        return;
      }
      if (immediate) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        void load();
      } else if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          void load();
        }, 150);
      }
    };
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        confirmedEpoch = null;
        confirmedRevision = 0;
        connected = false;
        generation += 1;
        pending = false;
        dirty = false;
      }
      if (event.type === "connection.restored") {
        connected = true;
        generation += 1;
        pending = false;
        dirty = false;
        void load();
      }
      if (
        (event.type === "tool.updated" ||
          event.type === "usage.updated" ||
          event.type === "turn.finished") &&
        event.agent_id === agentId &&
        event.sequence === sequence &&
        (event.ordinal === undefined || event.ordinal === ordinal)
      ) {
        if (
          event.saved === true &&
          typeof event.runtime_epoch === "string" &&
          typeof event.live_revision === "number"
        ) {
          if (confirmedEpoch !== event.runtime_epoch) confirmedRevision = 0;
          confirmedEpoch = event.runtime_epoch;
          confirmedRevision = Math.max(confirmedRevision, event.live_revision);
        }
        schedule(event.type === "turn.finished");
      }
    });
    retryRead.current = load;
    void load();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      off();
      retryRead.current = null;
    };
  }, [agentId, sequence, ordinal]);
  const failure =
    error && !(error.transport && backend.disconnected) ? (
      <LoadError
        error={error}
        retry={() => {
          if (!retryRead.current) throw new Error("Live read is inactive");
          void retryRead.current();
        }}
      />
    ) : null;
  const request = page?.turn?.requests[0];
  if (
    !page ||
    !request ||
    (request.tools.length === 0 && !request.has_response)
  )
    return failure;
  return (
    <section className="flex flex-col gap-2">
      {failure}
      {request.has_response && !request.response_saved ? (
        <>
          <p className="text-danger text-xs">Not saved</p>
          <LiveContent
            key={`${page.runtime_epoch}:${request.request_id}:${request.response_version}`}
            agentId={agentId}
            sequence={sequence}
            ordinal={ordinal}
            partIndex={0}
            contentSource="response"
            epoch={page.runtime_epoch}
            contentVersion={request.response_version}
          />
        </>
      ) : null}
      {request.tools.length > 0 ? (
        <h3 className="m-0 text-sm font-semibold tracking-title">Tools</h3>
      ) : null}
      {request.tools.map((tool) => (
        <div
          key={`${page.runtime_epoch}:${request.request_id}:${tool.part_index}`}
          className="flex flex-col gap-2"
        >
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span>{tool.tool_name}</span>
            <span>{tool.status}</span>
            {!tool.saved ? (
              <span className="text-danger">Not saved</span>
            ) : null}
            {tool.started_at ? (
              <span>Started {formatTime(tool.started_at)}</span>
            ) : null}
            {tool.completed_at ? (
              <span>Finished {formatTime(tool.completed_at)}</span>
            ) : null}
          </div>
          {tool.has_result && !tool.saved ? (
            <LiveContent
              key={tool.content_version}
              agentId={agentId}
              sequence={sequence}
              ordinal={ordinal}
              partIndex={tool.part_index}
              contentSource="tool"
              epoch={page.runtime_epoch}
              contentVersion={tool.content_version}
            />
          ) : null}
        </div>
      ))}
    </section>
  );
}

function LiveContent({
  agentId,
  sequence,
  ordinal,
  partIndex,
  contentSource,
  epoch,
  contentVersion,
}: {
  agentId: number;
  sequence: number;
  ordinal: number;
  partIndex: number;
  contentSource: "tool" | "response";
  epoch: string;
  contentVersion?: string | null;
}) {
  const [content, setContent] = useState<HistoryMessages | null>(null);
  const [error, setError] = useState<BackendError | null>(null);
  const retryRead = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const result = await backend.agentLiveRead(
          agentId,
          sequence,
          ordinal,
          partIndex,
          epoch,
          contentSource,
          contentVersion,
        );
        if (!active || current !== generation) return;
        setContent(result);
        setError(null);
      } catch (failure) {
        if (
          active &&
          current === generation &&
          !(failure instanceof BackendError && failure.code === "live_changed")
        )
          setError(historyFailure(failure));
      }
    };
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        generation += 1;
        setContent(null);
        setError(null);
      }
      if (event.type === "connection.restored") void load();
    });
    retryRead.current = load;
    void load();
    return () => {
      active = false;
      off();
      retryRead.current = null;
    };
  }, [
    agentId,
    sequence,
    ordinal,
    partIndex,
    contentSource,
    epoch,
    contentVersion,
  ]);
  return (
    <>
      {error && !(error.transport && backend.disconnected) ? (
        <LoadError
          error={error}
          retry={() => {
            if (!retryRead.current)
              throw new Error("Live content read is inactive");
            void retryRead.current();
          }}
        />
      ) : null}
      {content ? (
        <HistoryMessagesPanel
          agentId={agentId}
          sequence={sequence}
          title={contentSource === "response" ? "Response" : "Tool result"}
          content={content}
        />
      ) : null}
    </>
  );
}

function HistoryMessagesPanel({
  agentId,
  sequence,
  title,
  content,
  onLoadMore,
  compact = false,
  toolResults = [],
}: {
  agentId: number;
  sequence: number;
  title: string;
  content: HistoryMessages;
  onLoadMore?: () => void;
  compact?: boolean;
  toolResults?: { [key: string]: HistoryValue }[];
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-semibold tracking-title">{title}</h3>
      <div className="flex flex-col gap-2">
        {content.messages.map((message, index) =>
          compact ? (
            <ModelMessageContent
              key={`${content.offset + index}`}
              value={message}
              agentId={agentId}
              sequence={sequence}
              toolResults={toolResults}
            />
          ) : (
            <HistoryValueView
              key={`${content.offset + index}`}
              value={message}
              label={`Message ${content.offset + index + 1}`}
              agentId={agentId}
              sequence={sequence}
            />
          ),
        )}
      </div>
      {onLoadMore ? (
        <Button size="sm" onClick={onLoadMore}>
          Load more messages
        </Button>
      ) : null}
    </section>
  );
}

function SavedMarkdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 max-w-full text-sm leading-body wrap-anywhere [&_p]:my-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_pre]:min-w-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:bg-surface-raised [&_pre]:p-3 [&_code]:font-mono [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_img]:max-w-full [&_td]:p-2 [&_th]:p-2">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}

function historyParts(content: HistoryMessages) {
  return content.messages.flatMap((message) =>
    isRecord(message) && Array.isArray(message.parts)
      ? message.parts.filter(isRecord)
      : [],
  );
}

function ModelMessageContent({
  value,
  agentId,
  sequence,
  toolResults = [],
}: {
  value: HistoryValue;
  agentId: number;
  sequence: number;
  toolResults?: { [key: string]: HistoryValue }[];
}) {
  if (isRecord(value) && Array.isArray(value.parts)) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {value.parts.map((part, index) => (
          <ModelMessageContent
            key={index}
            value={part}
            agentId={agentId}
            sequence={sequence}
            toolResults={toolResults}
          />
        ))}
      </div>
    );
  }
  if (
    isRecord(value) &&
    (value.part_kind === "text" || value.part_kind === "thinking")
  ) {
    const reference = textValue(value.content);
    const body =
      typeof value.content === "string" ? (
        <SavedMarkdown>{value.content}</SavedMarkdown>
      ) : reference ? (
        <HistoryTextPreview
          agentId={agentId}
          sequence={sequence}
          reference={reference}
          label={value.part_kind === "thinking" ? "Thinking" : "Response"}
          markdown
        />
      ) : (
        <HistoryValueView
          value={value.content}
          label="Content"
          agentId={agentId}
          sequence={sequence}
        />
      );
    return value.part_kind === "thinking" ? (
      <details className="min-w-0 max-w-full rounded-md border border-line p-3 text-fg-muted">
        <summary className="cursor-pointer text-sm wrap-anywhere">
          Thinking
        </summary>
        {body}
      </details>
    ) : (
      body
    );
  }
  if (
    isRecord(value) &&
    (value.part_kind === "tool-call" || value.part_kind === "tool-return")
  ) {
    const call = value.part_kind === "tool-call";
    const results = call
      ? toolResults.filter(
          (part) =>
            part.part_kind === "tool-return" &&
            typeof value.tool_call_id === "string" &&
            part.tool_call_id === value.tool_call_id,
        )
      : [];
    return (
      <details className="min-w-0 rounded-md border border-line bg-surface p-3">
        <summary className="cursor-pointer text-sm wrap-anywhere">
          {typeof value.tool_name === "string" ? value.tool_name : "Tool"} ·{" "}
          {call ? "Call" : "Result"}
        </summary>
        <HistoryValueView
          value={call ? value.args : value.content}
          label={call ? "Arguments" : "Result"}
          agentId={agentId}
          sequence={sequence}
        />
        {results.map((result, index) => (
          <HistoryValueView
            key={index}
            value={result.content}
            label="Result"
            agentId={agentId}
            sequence={sequence}
          />
        ))}
      </details>
    );
  }
  return (
    <HistoryValueView
      value={value}
      label="Saved content"
      agentId={agentId}
      sequence={sequence}
    />
  );
}

function HistoryValuePanel({
  agentId,
  sequence,
  title,
  value,
}: {
  agentId?: number;
  sequence?: number;
  title: string;
  value: HistoryValue;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-semibold tracking-title">{title}</h3>
      <HistoryValueView
        agentId={agentId}
        sequence={sequence}
        value={value}
        label={title}
      />
    </section>
  );
}

function isRecord(
  value: HistoryValue,
): value is { [key: string]: HistoryValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function binaryValue(value: HistoryValue): HistoryBinary | null {
  if (!isRecord(value) || value.kind !== "binary") return null;
  if (
    typeof value.source !== "string" ||
    typeof value.message_index !== "number" ||
    !Array.isArray(value.path) ||
    typeof value.media_type !== "string" ||
    typeof value.size !== "number"
  )
    return null;
  return value as unknown as HistoryBinary;
}

function textValue(value: HistoryValue): HistoryText | null {
  if (!isRecord(value) || value.kind !== "text") return null;
  if (
    typeof value.source !== "string" ||
    typeof value.message_index !== "number" ||
    !Array.isArray(value.path) ||
    typeof value.offset !== "number" ||
    typeof value.next_offset !== "number" ||
    typeof value.total_bytes !== "number" ||
    typeof value.value !== "string" ||
    typeof value.has_more !== "boolean"
  )
    return null;
  return value as unknown as HistoryText;
}

function HistoryValueView({
  value,
  label,
  agentId,
  sequence,
}: {
  value: HistoryValue;
  label: string;
  agentId?: number;
  sequence?: number;
}) {
  const binary = binaryValue(value);
  const text = textValue(value);
  if (text && agentId !== undefined && sequence !== undefined) {
    return (
      <HistoryTextPreview
        key={`${agentId}:${sequence}:${text.source}:${text.request_ordinal}:${text.message_index}:${JSON.stringify(text.path)}`}
        agentId={agentId}
        sequence={sequence}
        reference={text}
        label={label}
      />
    );
  }
  if (binary && agentId !== undefined && sequence !== undefined) {
    return (
      <HistoryImagePreview
        key={`${agentId}:${sequence}:${binary.source}:${binary.request_ordinal}:${binary.message_index}:${JSON.stringify(binary.path)}`}
        agentId={agentId}
        sequence={sequence}
        reference={binary}
      />
    );
  }
  if (Array.isArray(value)) {
    return (
      <details
        open
        className="min-w-0 max-w-full border border-line rounded-sm bg-surface"
      >
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold wrap-anywhere">
          {label}
        </summary>
        <div className="flex flex-col gap-2 p-3 border-t border-line">
          {value.map((child, index) => (
            <HistoryValueView
              key={`${label}-${index}`}
              value={child}
              label={`${label} ${index + 1}`}
              agentId={agentId}
              sequence={sequence}
            />
          ))}
        </div>
      </details>
    );
  }
  if (isRecord(value)) {
    return (
      <details
        open
        className="min-w-0 max-w-full border border-line rounded-sm bg-surface"
      >
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold wrap-anywhere">
          {label}
        </summary>
        <div className="flex flex-col gap-2 p-3 border-t border-line">
          {Object.entries(value).map(([key, child]) => (
            <HistoryValueView
              key={`${label}-${key}`}
              value={child}
              label={key}
              agentId={agentId}
              sequence={sequence}
            />
          ))}
        </div>
      </details>
    );
  }
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1 py-2 px-3 border border-line rounded-sm bg-surface">
      <span className="text-xs text-fg-muted">{label}</span>
      <pre className="m-0 whitespace-pre-wrap wrap-anywhere text-xs leading-body font-mono tracking-[0]">
        {value === null ? "null" : String(value)}
      </pre>
    </div>
  );
}

function historyContentIdentity(
  agentId: number,
  sequence: number,
  reference: HistoryText | HistoryBinary,
): string {
  return JSON.stringify([
    agentId,
    sequence,
    reference.source,
    reference.request_ordinal,
    reference.message_index,
    reference.path,
    reference.runtime_epoch,
    reference.part_index,
    reference.content_source,
    reference.content_version,
  ]);
}

function HistoryTextPreview({
  agentId,
  sequence,
  reference,
  label,
  markdown = false,
  active = true,
}: {
  agentId: number;
  sequence: number;
  reference: HistoryText;
  label: string;
  markdown?: boolean;
  active?: boolean;
}) {
  const textKey = `text:${agentId}:${sequence}:${reference.source}:${reference.request_ordinal}:${reference.message_index}:${JSON.stringify(reference.path)}`;
  const identity = historyContentIdentity(agentId, sequence, reference);
  const [savedIdentity, setSavedIdentity] = useWindowState(
    `${textKey}:identity`,
    identity,
  );
  const [text, setText] = useWindowState(textKey, reference.value);
  const [nextOffset, setNextOffset] = useWindowState(
    `${textKey}:offset`,
    reference.next_offset,
  );
  const [hasMore, setHasMore] = useWindowState(
    `${textKey}:more`,
    reference.has_more,
  );
  const [error, setError] = useState<BackendError | null>(null);
  const [loading, setLoading] = useState(false);
  const loadGeneration = useRef(0);
  const interruptedOffset = useRef<number | null>(null);
  const textRequest = useRef(false);
  const content = useRef({
    value: text,
    nextOffset,
    total: reference.total_bytes,
  });
  const currentIdentity = useRef(identity);
  const matching = savedIdentity === identity;

  useLayoutEffect(() => {
    const current = content.current;
    const compatible = current.value.startsWith(reference.value);
    if (
      currentIdentity.current !== identity ||
      !matching ||
      !compatible ||
      reference.total_bytes < current.nextOffset
    ) {
      currentIdentity.current = identity;
      setSavedIdentity(identity);
      loadGeneration.current += 1;
      textRequest.current = false;
      interruptedOffset.current = null;
      setLoading(false);
      setError(null);
      content.current = {
        value: reference.value,
        nextOffset: reference.next_offset,
        total: reference.total_bytes,
      };
      setText(reference.value);
      setNextOffset(reference.next_offset);
      setHasMore(reference.has_more);
      return;
    }
    current.total = reference.total_bytes;
    setHasMore(current.nextOffset < current.total);
  }, [
    identity,
    matching,
    setSavedIdentity,
    reference.value,
    reference.next_offset,
    reference.total_bytes,
    reference.has_more,
  ]);

  const loadMore = useCallback(
    async (offset: number) => {
      if (textRequest.current || !active) return;
      textRequest.current = true;
      const generation = ++loadGeneration.current;
      interruptedOffset.current = offset;
      setLoading(true);
      try {
        const result = await backend.agentHistoryText(agentId, sequence, {
          ...reference,
          offset,
        });
        if (
          generation !== loadGeneration.current ||
          identity !== currentIdentity.current
        )
          return;
        if (result.offset !== offset || result.next_offset <= offset)
          throw new Error("Saved text did not advance");
        interruptedOffset.current = null;
        content.current = {
          value: content.current.value + result.value,
          nextOffset: result.next_offset,
          total: Math.max(content.current.total, result.total_bytes),
        };
        setText(content.current.value);
        setNextOffset(content.current.nextOffset);
        setHasMore(content.current.nextOffset < content.current.total);
        setError(null);
      } catch (failure) {
        if (
          generation !== loadGeneration.current ||
          identity !== currentIdentity.current
        )
          return;
        const problem = historyFailure(failure);
        if (!isHistoryConnectionFailure(problem)) {
          interruptedOffset.current = null;
          setError(problem);
        }
      } finally {
        if (
          generation === loadGeneration.current &&
          identity === currentIdentity.current
        ) {
          textRequest.current = false;
          setLoading(false);
        }
      }
    },
    [active, agentId, identity, sequence],
  );

  useEffect(() => {
    if (!active) {
      loadGeneration.current += 1;
      textRequest.current = false;
      setLoading(false);
    }
    const stop = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        loadGeneration.current += 1;
        textRequest.current = false;
        setLoading(false);
      }
      if (
        active &&
        event.type === "connection.restored" &&
        interruptedOffset.current !== null
      )
        void loadMore(interruptedOffset.current);
    });
    return () => {
      loadGeneration.current += 1;
      textRequest.current = false;
      stop();
    };
  }, [active, loadMore]);

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2 py-2 px-3 border border-line rounded-sm bg-surface">
      <span className="text-xs text-fg-muted">
        {label} · {formatBytes(reference.total_bytes)}
      </span>
      {markdown ? (
        <SavedMarkdown>{matching ? text : reference.value}</SavedMarkdown>
      ) : (
        <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere text-xs leading-body font-mono tracking-[0]">
          {matching ? text : reference.value}
        </pre>
      )}
      {error ? (
        <p className="m-0 text-danger text-xs">{error.message}</p>
      ) : null}
      {(matching ? hasMore : reference.has_more) ? (
        <Button
          size="sm"
          disabled={loading}
          onClick={() =>
            void loadMore(matching ? nextOffset : reference.next_offset)
          }
        >
          {loading
            ? "Loading text..."
            : error
              ? "Retry text"
              : "Load more text"}
        </Button>
      ) : null}
    </div>
  );
}

function HistoryImagePreview({
  agentId,
  sequence,
  reference,
  active = true,
}: {
  agentId: number;
  sequence: number;
  reference: HistoryBinary;
  active?: boolean;
}) {
  const identity = historyContentIdentity(agentId, sequence, reference);
  const [image, setImage] = useState<{
    identity: string;
    url: string;
  } | null>(null);
  const [error, setError] = useState<BackendError | null>(null);
  const [zoom, setZoom] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadGeneration = useRef(0);
  const currentIdentity = useRef(identity);
  const visibleImage = image?.identity === identity ? image.url : null;

  useLayoutEffect(() => {
    currentIdentity.current = identity;
    loadGeneration.current += 1;
    setImage(null);
    setError(null);
    setZoom(false);
    setLoading(false);
  }, [identity]);

  const load = useCallback(async () => {
    if (!active) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const result = await backend.agentHistoryImage(
        agentId,
        sequence,
        reference,
      );
      if (
        generation !== loadGeneration.current ||
        identity !== currentIdentity.current
      )
        return;
      setImage({
        identity,
        url: `data:${result.media_type};base64,${result.data}`,
      });
      setError(null);
    } catch (failure) {
      if (
        generation !== loadGeneration.current ||
        identity !== currentIdentity.current
      )
        return;
      const problem = historyFailure(failure);
      if (!isHistoryConnectionFailure(problem)) setError(problem);
    } finally {
      if (
        generation === loadGeneration.current &&
        identity === currentIdentity.current
      )
        setLoading(false);
    }
  }, [active, agentId, identity, sequence]);

  useEffect(() => {
    if (active) void load();
    const stop = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        loadGeneration.current += 1;
        setLoading(false);
      }
      if (event.type === "connection.restored") void load();
    });
    return () => {
      loadGeneration.current += 1;
      stop();
    };
  }, [load]);

  if (error) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-danger text-xs">
          Could not load image: {error.message}
        </p>
        <Button size="sm" disabled={loading} onClick={() => void load()}>
          Retry image
        </Button>
      </div>
    );
  }
  if (!visibleImage) {
    return (
      <span className="text-fg-muted text-xs">
        Loading image ({formatBytes(reference.size)})
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="relative self-start max-w-full overflow-hidden border border-line rounded-sm bg-surface cursor-zoom-in"
        aria-label="Open history image"
        onClick={() => setZoom(true)}
      >
        <img
          src={visibleImage}
          alt="Saved model content"
          className="block max-h-[200px] max-w-full object-contain"
          onError={() =>
            setError(
              new BackendError(
                "image_failed",
                "The saved image could not be displayed",
              ),
            )
          }
        />
        <span className="absolute right-2 bottom-2 inline-flex items-center justify-center p-1 rounded-xs bg-gray-1100/70 text-white">
          <Maximize2 size={14} aria-hidden="true" />
        </span>
      </button>
      <Modal
        open={zoom}
        onOpenChange={setZoom}
        title="History image"
        variant="history"
        wide
        footer={<Button onClick={() => setZoom(false)}>Close</Button>}
      >
        <img
          src={visibleImage}
          alt="Saved model content"
          className="max-h-[70vh] max-w-full self-center object-contain"
        />
      </Modal>
    </>
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
    <li className="border border-line rounded-sm bg-gray-800/50 overflow-hidden transition-[border-color] duration-(--duration-fast) ease-linear hover:border-line-interactive">
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
