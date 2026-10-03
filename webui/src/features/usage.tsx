import { BarChart3, Search } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type Resource, useResource } from "@/app/organization";
import { useNavigate } from "@/app/router";
import {
  type Column,
  Page,
  PageBody,
  PageHeader,
  Section,
  Table,
} from "@/components/layout/shell";
import { LoadError } from "@/components/ui/access-error";
import { Modal } from "@/components/ui/dialog";
import {
  Button,
  Chip,
  Input,
  LoadingSkeleton,
  Skeleton,
  StateDot,
  StatusText,
} from "@/components/ui/index";
import { StatePanel } from "@/components/ui/state-panel";
import { TurnHistoryModal } from "@/features/members/detail";
import {
  BackendError,
  backend,
  type UsageFilters,
  type UsageMetrics,
  type UsageRecord,
  type UsageResult,
} from "@/lib/backend";

export function usageNumber(value: string | null): string {
  return value === null ? "Unavailable" : BigInt(value).toLocaleString("en-US");
}

function modelName(model: UsageRecord["model"]): string {
  return String(
    model.display_name ?? model.model_name ?? model.model ?? "Unknown model",
  );
}

const COVERAGE: Record<string, string> = {
  recorded: "Recorded",
  in_progress: "In progress",
  no_response: "No response",
  missing_usage: "Usage missing",
  field_missing: "Field missing",
  legacy: "Turn summary only",
  missing_history: "History missing",
  partial_history: "Partial request history",
};

const METRICS = [
  ["total_tokens", "Total tokens", "total_known"],
  ["input_tokens", "Input tokens", "input_known"],
  ["output_tokens", "Output tokens", "output_known"],
  ["requests", "Requests", "requests_known"],
] as const;

const NUMERIC_COLUMNS: Column[] = [
  { key: "input", label: "Input", align: "end" },
  { key: "output", label: "Output", align: "end" },
  { key: "total", label: "Total tokens", align: "end" },
  { key: "requests", label: "Requests", align: "end" },
];

const SELECT_CLASS =
  "h-9 max-w-full rounded-sm border border-line bg-surface px-2 text-sm";

const KNOWN_COLUMNS = [
  "input_known",
  "output_known",
  "total_known",
  "requests_known",
] as const;

function TokenShare({
  value,
  total,
}: {
  value: string | null;
  total: string | null;
}) {
  if (value === null || total === null || BigInt(total) === 0n) {
    return <span className="text-fg-muted">Unavailable</span>;
  }
  const percent = Number((BigInt(value) * 10000n) / BigInt(total)) / 100;
  return (
    <div className="flex flex-col items-end gap-1 font-mono tabular-nums">
      <span>{percent.toFixed(2)}%</span>
      <div className="h-1 w-20 overflow-hidden rounded-full bg-surface-raised">
        <div className="h-full bg-fg-muted" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function NumericCells({
  metrics,
  coverage,
}: {
  metrics: Pick<
    UsageMetrics,
    "input_tokens" | "output_tokens" | "total_tokens" | "requests"
  >;
  coverage?: Pick<
    UsageMetrics,
    | "records"
    | "input_known"
    | "output_known"
    | "total_known"
    | "requests_known"
  >;
}) {
  return (
    <>
      {[
        metrics.input_tokens,
        metrics.output_tokens,
        metrics.total_tokens,
        metrics.requests,
      ].map((value, index) => (
        <td
          key={NUMERIC_COLUMNS[index].key}
          data-align="end"
          className="font-mono tabular-nums whitespace-nowrap"
        >
          {usageNumber(value)}
          {coverage && coverage[KNOWN_COLUMNS[index]] !== coverage.records ? (
            <div className="text-xs text-fg-muted">
              {coverage[KNOWN_COLUMNS[index]].toLocaleString()} of{" "}
              {coverage.records.toLocaleString()} records
            </div>
          ) : null}
        </td>
      ))}
    </>
  );
}

type UsageConnection = { available: boolean; error: BackendError | null };

type UsageQueryControl = {
  refresh: (changed?: boolean) => Promise<void>;
  retry: () => void;
};

function UsageQuery({
  filters,
  limit,
  cursor,
  current,
  anchor,
  controls,
  connection,
  onChange,
}: {
  filters: UsageFilters;
  limit: number;
  cursor: string | null;
  current: RefObject<UsageResult | null>;
  anchor: RefObject<string | undefined>;
  controls: RefObject<UsageQueryControl | null>;
  connection: RefObject<UsageConnection>;
  onChange: (
    resource: Resource<UsageResult>,
    connectionError: BackendError | null,
  ) => void;
}) {
  const first = useRef(true);
  const revision = useRef(current.current?.dataset_revision);
  const generation = useRef(0);
  const mounted = useRef(false);
  const [connectionError, setConnectionError] = useState(
    connection.current.error,
  );
  const read = useCallback(async () => {
    const request = generation.current;
    let data: UsageResult;
    try {
      data = await backend.usageQuery({
        ...filters,
        limit,
        cursor: first.current ? cursor : null,
        anchor: first.current ? undefined : anchor.current,
        dataset_revision:
          first.current && cursor ? revision.current : undefined,
      });
    } catch (failure) {
      if (
        !(failure instanceof BackendError) ||
        failure.code !== "usage_changed" ||
        request !== generation.current
      )
        throw failure;
      data = await backend.usageQuery({
        ...filters,
        limit,
        anchor: anchor.current,
      });
    }
    if (request === generation.current) {
      first.current = false;
      anchor.current = data.records[0]?.record_id;
    }
    return data;
  }, [filters, limit, cursor, anchor]);
  const { resource, refresh, invalidate } = useResource(read);
  const retry = useCallback(() => {
    if (connection.current.available && !backend.disconnected) void refresh();
    else
      void backend.reconnect().catch((failure) => {
        if (!(failure instanceof BackendError)) throw failure;
        if (mounted.current) setConnectionError(failure);
      });
  }, [refresh, connection]);
  useEffect(() => {
    mounted.current = true;
    controls.current = { refresh, retry };
    invalidate(
      connection.current.available,
      connection.current.error ?? undefined,
    );
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = backend.onEvent((event) => {
      if (event.type.startsWith("connection.")) {
        generation.current += 1;
        clearTimeout(timer);
        connection.current.available = event.type === "connection.restored";
        if (connection.current.available) {
          connection.current.error = null;
          setConnectionError(null);
          invalidate(true);
          void refresh();
        } else if (event.type === "connection.closed") {
          if (!(event.error instanceof BackendError))
            throw new Error("Connection error must be a BackendError");
          connection.current.error = event.error;
          setConnectionError(event.error);
          invalidate(false, event.error);
        } else invalidate(false);
        return;
      }
      if (
        event.type.startsWith("agent.") ||
        event.type.startsWith("turn.") ||
        event.type.startsWith("organization.")
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(true), 150);
      }
    });
    const polling = setInterval(() => void refresh(true), 5000);
    return () => {
      mounted.current = false;
      generation.current += 1;
      controls.current = null;
      invalidate(false);
      clearTimeout(timer);
      clearInterval(polling);
      stop();
    };
  }, [controls, refresh, retry, invalidate, connection]);
  useEffect(() => {
    onChange(resource, connectionError);
  }, [resource, connectionError, onChange]);
  useEffect(() => {
    if (!resource.data || resource.data.index.ready) return;
    const timer = setTimeout(() => void refresh(true), 100);
    return () => clearTimeout(timer);
  }, [resource.data, refresh]);
  return null;
}

export function UsagePage({ agentId }: { agentId?: number }) {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<UsageFilters>({ agent_id: agentId });
  const [limit, setLimit] = useState(20);
  const [timeRange, setTimeRange] = useState("all");
  const timeInputs = useRef<
    Record<"start_at" | "end_at", HTMLInputElement | null>
  >({ start_at: null, end_at: null });
  const [timeErrors, setTimeErrors] = useState<
    Partial<Record<"start_at" | "end_at", string>>
  >({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageTarget, setPageTarget] = useState<string | null>(null);
  const [result, setResult] = useState<UsageResult | null>(null);
  const [error, setError] = useState<BackendError | null>(null);
  const [loading, setLoading] = useState(true);
  const [datasetRevision, setDatasetRevision] = useState<number>();
  const controls = useRef<UsageQueryControl | null>(null);
  const connection = useRef<UsageConnection>({
    available: !backend.disconnected && !backend.reconnecting,
    error: null,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [context, setContext] = useState<UsageRecord | null>(null);
  const current = useRef<UsageResult | null>(null);
  const choices = useRef<Pick<UsageResult, "agents" | "models">>({
    agents: [],
    models: [],
  });
  const anchor = useRef<string | undefined>(undefined);
  const recordsElement = useRef<HTMLDivElement>(null);
  const revealRecords = useRef(false);
  const revealPage = useRef(false);
  const pageControl = useRef<HTMLElement | null>(null);

  const changeFilters = (next: UsageFilters, resetTimeInputs = false) => {
    if (resetTimeInputs) {
      for (const key of ["start_at", "end_at"] as const) {
        const input = timeInputs.current[key];
        if (input)
          input.value = next[key]
            ? new Date(next[key]).toISOString().slice(0, 16)
            : "";
      }
      setTimeErrors({});
    }
    if (JSON.stringify(next) === JSON.stringify(filters)) {
      void controls.current?.refresh(true);
      return;
    }
    if (next.start_at !== filters.start_at || next.end_at !== filters.end_at) {
      setTimeRange(next.start_at || next.end_at ? "custom" : "all");
    }
    revealPage.current = false;
    setPageTarget(null);
    current.current = null;
    anchor.current = undefined;
    setFilters(next);
    setCursor(null);
    setResult(null);
    setError(null);
    setLoading(true);
  };
  const changeTimes = (commit = true) => {
    const errors: Partial<Record<"start_at" | "end_at", string>> = {};
    const times: Record<"start_at" | "end_at", string | null> = {
      start_at: null,
      end_at: null,
    };
    for (const key of ["start_at", "end_at"] as const) {
      const input = timeInputs.current[key];
      if (!input) throw new Error("Usage time input is missing");
      if (input.validity.rangeUnderflow || input.validity.rangeOverflow)
        errors[key] = "Enter a UTC year from 0001 to 9999.";
      else if (
        !input.validity.valid ||
        (input.value && !Number.isFinite(input.valueAsNumber))
      )
        errors[key] = "Enter a complete, valid UTC date and time in minutes.";
      else if (input.value)
        times[key] = new Date(input.valueAsNumber)
          .toISOString()
          .replace(".000Z", "+00:00");
    }
    if (
      !errors.start_at &&
      !errors.end_at &&
      times.start_at &&
      times.end_at &&
      times.start_at >= times.end_at
    )
      errors.end_at = "Until must be later than From.";
    setTimeErrors(errors);
    if (!commit || Object.keys(errors).length > 0) return;
    if (
      times.start_at !== (filters.start_at ?? null) ||
      times.end_at !== (filters.end_at ?? null)
    )
      changeFilters({ ...filters, ...times });
  };
  const onQueryChange = useCallback(
    (resource: Resource<UsageResult>, connectionError: BackendError | null) => {
      setError(connectionError ?? resource.error);
      setLoading(resource.status === "pending" || resource.refreshing);
      if (resource.data) {
        setPageTarget(null);
        setResult(resource.data);
        current.current = resource.data;
        choices.current = resource.data;
        setDatasetRevision(resource.data.dataset_revision);
      }
    },
    [],
  );
  const changePage = (next: string | null, target: string) => {
    revealPage.current = true;
    setPageTarget(target);
    pageControl.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setCursor(next);
    setError(null);
    setLoading(true);
  };

  const retryQuery = () => {
    if (
      revealPage.current &&
      recordsElement.current?.contains(document.activeElement) &&
      document.activeElement?.closest('[role="alert"]') &&
      pageControl.current?.isConnected
    )
      pageControl.current.focus({ preventScroll: true });
    controls.current?.retry();
  };

  useLayoutEffect(() => {
    if (result && revealPage.current) {
      revealPage.current = false;
      if (recordsElement.current?.contains(document.activeElement))
        recordsElement.current.scrollIntoView({
          block: "start",
          behavior: "instant",
        });
    }
  }, [result]);

  useEffect(() => {
    if (result && revealRecords.current) {
      revealRecords.current = false;
      recordsElement.current?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    }
  }, [result]);

  return (
    <Page>
      <PageHeader
        title="Token Usage"
        crumb={{
          label: "Members",
          onSelect: () => navigate({ name: "members" }),
        }}
        actions={
          <Button
            onClick={() => void controls.current?.refresh(true)}
            disabled={loading}
          >
            Refresh
          </Button>
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-xs text-fg-muted">
            Time range
            <select
              aria-label="Time range"
              className={SELECT_CLASS}
              value={timeRange}
              onChange={(event) => {
                if (event.target.value === "custom") return;
                const hours = Number(event.target.value);
                changeFilters(
                  {
                    ...filters,
                    start_at: hours
                      ? new Date(Date.now() - hours * 3600000).toISOString()
                      : null,
                    end_at: null,
                  },
                  true,
                );
                setTimeRange(event.target.value);
              }}
            >
              <option value="all">All time</option>
              <option value="24">Last 24 hours</option>
              <option value="168">Last 7 days</option>
              <option value="720">Last 30 days</option>
              <option value="custom">Custom range</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-fg-muted">
            Agent
            <select
              aria-label="Agent"
              className={SELECT_CLASS}
              value={filters.agent_id ?? ""}
              onChange={(event) =>
                changeFilters({
                  ...filters,
                  agent_id: event.target.value
                    ? Number(event.target.value)
                    : null,
                })
              }
            >
              <option value="">All Agents</option>
              {choices.current.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.deleted ? " · Deleted" : ""}
                </option>
              ))}
              {agentId &&
              !choices.current.agents.some((agent) => agent.id === agentId) ? (
                <option value={agentId}>Agent {agentId}</option>
              ) : null}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-fg-muted">
            Model
            <select
              aria-label="Model"
              className={SELECT_CLASS}
              value={filters.model_key ?? ""}
              onChange={(event) =>
                changeFilters({
                  ...filters,
                  model_key: event.target.value || null,
                })
              }
            >
              <option value="">All models</option>
              {choices.current.models.map((item) => (
                <option key={item.key} value={item.key}>
                  {modelName(item.model)}
                </option>
              ))}
            </select>
          </label>
          {(["start_at", "end_at"] as const).map((key) => (
            <label
              key={key}
              htmlFor={`usage-${key}`}
              className="flex min-w-0 flex-col gap-1 text-xs text-fg-muted"
            >
              {key === "start_at"
                ? "From (UTC, inclusive)"
                : "Until (UTC, exclusive)"}
              <Input
                id={`usage-${key}`}
                type="datetime-local"
                ref={(input) => {
                  timeInputs.current[key] = input;
                }}
                min="0001-01-01T00:00"
                max="9999-12-31T23:59"
                step={60}
                aria-label={key === "start_at" ? "From UTC" : "Until UTC"}
                aria-invalid={!!timeErrors[key]}
                aria-describedby={
                  timeErrors[key] ? `usage-${key}-error` : undefined
                }
                onInput={() => changeTimes()}
                onChange={() => changeTimes()}
                onBlur={() => changeTimes(false)}
              />
              {timeErrors[key] ? (
                <span
                  id={`usage-${key}-error`}
                  role="alert"
                  className="text-danger"
                >
                  {timeErrors[key]}
                </span>
              ) : null}
            </label>
          ))}
          <Button onClick={() => changeFilters({}, true)}>Clear Filters</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(filters)
            .filter(([, value]) => value != null && value !== "")
            .map(([key, value]) => (
              <Button
                key={key}
                size="sm"
                onClick={() =>
                  changeFilters(
                    { ...filters, [key]: null },
                    key === "start_at" || key === "end_at",
                  )
                }
              >
                {key === "model_key"
                  ? modelName(
                      choices.current.models.find((item) => item.key === value)
                        ?.model ?? {},
                    )
                  : `${key}: ${COVERAGE[String(value)] ?? value}`}{" "}
                ×
              </Button>
            ))}
        </div>
        <UsageQuery
          key={JSON.stringify({ filters, limit, cursor })}
          filters={filters}
          limit={limit}
          cursor={cursor}
          current={current}
          anchor={anchor}
          controls={controls}
          connection={connection}
          onChange={onQueryChange}
        />
        {error && !result ? (
          <LoadError error={error} retry={retryQuery} />
        ) : null}
        {!result ? (
          loading ? (
            <LoadingSkeleton label="Loading usage">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                {METRICS.map(([key]) => (
                  <Skeleton
                    key={key}
                    className="h-28 rounded-sm border border-line"
                  />
                ))}
              </div>
              <Skeleton className="h-64 rounded-md border border-line" />
              <Skeleton className="h-64 rounded-md border border-line" />
              <Skeleton className="h-64 rounded-md border border-line" />
            </LoadingSkeleton>
          ) : null
        ) : (
          <>
            <div
              className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
              aria-busy={loading}
            >
              {METRICS.map(([key, label, known]) => (
                <div
                  key={key}
                  className="min-w-0 rounded-md border border-line bg-surface p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
                    {label}
                    {key === "requests" ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          recordsElement.current?.scrollIntoView({
                            block: "start",
                            behavior: "smooth",
                          })
                        }
                      >
                        View Requests
                      </Button>
                    ) : null}
                  </div>
                  <div className="my-2 overflow-x-auto font-mono text-2xl font-bold tabular-nums">
                    {usageNumber(result.summary[key])}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {result.summary[known].toLocaleString()} of{" "}
                    {result.summary.records.toLocaleString()} records
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <span>
                {result.index.ready
                  ? "All indexed records"
                  : "Indexing · recorded range so far"}
              </span>
              {Object.entries(result.coverage).map(([key, count]) => (
                <Button
                  key={key}
                  size="sm"
                  onClick={() => changeFilters({ ...filters, coverage: key })}
                >
                  {COVERAGE[key] ?? key}: {count.toLocaleString()}
                </Button>
              ))}
            </div>
            <p className="m-0 text-xs text-fg-muted">
              For each complete record, total = input + output. Metrics sum
              saved values within each field's recorded range. Cache and audio
              counts are included in their parent totals. Saved zero values may
              include SDK defaults. Open a record to inspect every saved field
              and its source.
            </p>
            {(["model_key", "agent_id"] as const).map((dimension) => (
              <Section
                key={dimension}
                title={dimension === "model_key" ? "By model" : "By Agent"}
              >
                <div className="overflow-x-auto rounded-md border border-line">
                  <Table
                    label={
                      dimension === "model_key"
                        ? "Usage by model"
                        : "Usage by Agent"
                    }
                    columns={[
                      {
                        key: "name",
                        label: dimension === "model_key" ? "Model" : "Agent",
                      },
                      ...NUMERIC_COLUMNS,
                      { key: "cache-read", label: "Cache read", align: "end" },
                      {
                        key: "cache-write",
                        label: "Cache write",
                        align: "end",
                      },
                      {
                        key: "cost",
                        label: "Estimated cost (USD)",
                        align: "end",
                      },
                      { key: "share", label: "Token share", align: "end" },
                      { key: "activity", label: "Last request (UTC)" },
                      { key: "action", label: "" },
                    ]}
                  >
                    {result.groups[dimension].map((group) => {
                      const key =
                        "model_key" in group ? group.model_key : group.agent_id;
                      const agent = result.agents.find(
                        (item) => item.id === key,
                      );
                      const label =
                        dimension === "model_key"
                          ? modelName(
                              result.models.find((item) => item.key === key)
                                ?.model ?? {},
                            )
                          : `${agent?.name ?? `Agent ${key}`}${agent?.deleted ? " · Deleted" : ""}`;
                      return (
                        <tr key={key}>
                          <td className="max-w-64 wrap-anywhere">
                            {label}
                            <div className="text-xs text-fg-muted">
                              {group.total_known} of {group.records} records
                              have complete token totals
                              {dimension === "agent_id"
                                ? ` · ${group.model_count} model groups`
                                : ""}
                            </div>
                          </td>
                          <NumericCells metrics={group} coverage={group} />
                          {(
                            [
                              ["cache_read_tokens", "cache_read_known"],
                              ["cache_write_tokens", "cache_write_known"],
                            ] as const
                          ).map(([field, known]) => (
                            <td
                              key={field}
                              data-align="end"
                              className="font-mono tabular-nums whitespace-nowrap"
                            >
                              {usageNumber(group[field])}
                              <div className="text-xs text-fg-muted">
                                {group[known]} of {group.records} records
                              </div>
                            </td>
                          ))}
                          <td data-align="end" className="font-mono text-xs">
                            {group.estimated_cost ?? "Unavailable"}
                            <div className="text-fg-muted">
                              {group.cost_known} of {group.records} records
                            </div>
                          </td>
                          <td data-align="end" className="text-xs">
                            <TokenShare
                              value={group.total_tokens}
                              total={result.summary.total_tokens}
                            />
                          </td>
                          <td className="text-xs whitespace-nowrap">
                            {group.last_active
                              ?.replace("T", " ")
                              .replace("+00:00", "") ?? "Unavailable"}
                          </td>
                          <td>
                            <Button
                              size="sm"
                              onClick={() => {
                                revealRecords.current = true;
                                changeFilters({ ...filters, [dimension]: key });
                              }}
                            >
                              View Requests
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </Table>
                </div>
              </Section>
            ))}
            <div ref={recordsElement} aria-busy={loading}>
              <Section title="Request records">
                {error ? <LoadError error={error} retry={retryQuery} /> : null}
                {result.records.length === 0 ? (
                  <StatePanel
                    icons={[BarChart3, Search, BarChart3]}
                    title={
                      Object.values(filters).some(Boolean)
                        ? "No matching records"
                        : "No usage records yet"
                    }
                    description="Saved model requests and historical Turn summaries appear here."
                  />
                ) : (
                  <div className="overflow-x-auto rounded-md border border-line">
                    <Table
                      label="Request records"
                      columns={[
                        { key: "time", label: "Started (UTC)" },
                        { key: "identity", label: "Record" },
                        { key: "agent", label: "Agent" },
                        { key: "model", label: "Model" },
                        { key: "state", label: "Coverage" },
                        ...NUMERIC_COLUMNS,
                        { key: "cost", label: "Cost (USD)", align: "end" },
                        { key: "inspect", label: "" },
                      ]}
                    >
                      {result.records.map((record) => (
                        <tr key={record.record_id}>
                          <td className="whitespace-nowrap text-xs">
                            {record.started_at
                              .replace("T", " ")
                              .replace("+00:00", "")}
                          </td>
                          <td className="text-xs whitespace-nowrap">
                            Turn {record.sequence}
                            <div>
                              {record.ordinal === null
                                ? "Turn summary"
                                : `Request ${record.ordinal}`}
                            </div>
                            <div className="text-fg-muted">
                              <StatusText
                                dot={
                                  <StateDot
                                    state={
                                      record.status === "pending" ||
                                      record.status === "running"
                                        ? "running"
                                        : record.status === "failed"
                                          ? "error"
                                          : record.status === "interrupted"
                                            ? "blocked"
                                            : "idle"
                                    }
                                  />
                                }
                              >
                                {record.status}
                              </StatusText>
                            </div>
                          </td>
                          <td>
                            {record.agent_name}
                            {record.agent_deleted ? <Chip>Deleted</Chip> : null}
                          </td>
                          <td className="max-w-52 wrap-anywhere">
                            {modelName(record.model)}
                          </td>
                          <td className="text-xs">
                            {COVERAGE[record.coverage]}
                            {record.partial_history ? (
                              <div>Partial request history</div>
                            ) : null}
                          </td>
                          <NumericCells metrics={record} />
                          <td data-align="end" className="font-mono text-xs">
                            {record.cost ?? "Unavailable"}
                            {record.cost !== null ? (
                              <div className="text-fg-muted">
                                {record.cost_source === "genai-prices"
                                  ? "Estimated cost"
                                  : "Saved cost"}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <Button
                              size="sm"
                              onClick={() => setSelected(record.record_id)}
                            >
                              Inspect
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </Table>
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs">
                  <span role="status" aria-live="polite">
                    {pageTarget
                      ? `${pageTarget}${loading ? " loading" : " unavailable"} · `
                      : loading
                        ? "Loading records · "
                        : ""}
                    {result.records.length.toLocaleString()} shown ·{" "}
                    {result.summary.records.toLocaleString()} records ·{" "}
                    {usageNumber(result.summary.requests)} requests
                  </span>
                  <div className="flex flex-wrap items-center gap-2 [&_button[aria-disabled=true]]:cursor-not-allowed [&_button[aria-disabled=true]]:opacity-50">
                    <select
                      aria-label="Page size"
                      className={SELECT_CLASS}
                      value={limit}
                      aria-disabled={loading || !!error}
                      onChange={(event) => {
                        if (loading || error) return;
                        setLimit(Number(event.target.value));
                        changePage(null, "Page size");
                        anchor.current = undefined;
                      }}
                    >
                      {[20, 50, 100].map((size) => (
                        <option key={size} value={size}>
                          {size} per page
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      aria-disabled={
                        !result.previous_cursor || loading || !!error
                      }
                      onClick={() => {
                        if (!loading && !error && result.previous_cursor)
                          changePage(result.previous_cursor, "Previous page");
                      }}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      aria-disabled={!result.has_more || loading || !!error}
                      onClick={() => {
                        if (!loading && !error && result.has_more)
                          changePage(result.next_cursor, "Next page");
                      }}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </Section>
            </div>
          </>
        )}
      </PageBody>
      {selected ? (
        <UsageModal
          key={selected}
          recordId={selected}
          revision={datasetRevision}
          connection={connection}
          onClose={() => setSelected(null)}
          onContext={(record) => {
            setSelected(null);
            setContext(record);
          }}
        />
      ) : null}
      {context ? (
        <TurnHistoryModal
          agentId={context.agent_id}
          sequence={context.sequence}
          initialOrdinal={context.ordinal ?? undefined}
          open
          onOpenChange={(open) => !open && setContext(null)}
        />
      ) : null}
    </Page>
  );
}

function UsageModal({
  recordId,
  revision,
  connection,
  onClose,
  onContext,
}: {
  recordId: string;
  revision?: number;
  connection: RefObject<UsageConnection>;
  onClose: () => void;
  onContext: (record: UsageRecord) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState(
    connection.current.error,
  );
  const mounted = useRef(false);
  const read = useCallback(() => backend.usageRead(recordId), [recordId]);
  const { resource, refresh, invalidate } = useResource(read);
  const detail = resource.data;
  const error = connectionError ?? resource.error;
  const retry = useCallback(() => {
    if (connection.current.available && !backend.disconnected) void refresh();
    else
      void backend.reconnect().catch((failure) => {
        if (!(failure instanceof BackendError)) throw failure;
        if (mounted.current) setConnectionError(failure);
      });
  }, [refresh, connection]);
  useEffect(() => {
    mounted.current = true;
    invalidate(
      connection.current.available,
      connection.current.error ?? undefined,
    );
    const stop = backend.onEvent((event) => {
      if (!event.type.startsWith("connection.")) return;
      connection.current.available = event.type === "connection.restored";
      if (connection.current.available) {
        connection.current.error = null;
        setConnectionError(null);
        invalidate(true);
        void refresh();
      } else if (event.type === "connection.closed") {
        if (!(event.error instanceof BackendError))
          throw new Error("Connection error must be a BackendError");
        connection.current.error = event.error;
        setConnectionError(event.error);
        invalidate(false, event.error);
      } else invalidate(false);
    });
    return () => {
      mounted.current = false;
      invalidate(false);
      stop();
    };
  }, [refresh, invalidate, connection]);
  useEffect(() => {
    void refresh(true);
  }, [refresh, revision]);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Usage record"
      wide
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error ? <LoadError error={error} retry={retry} /> : null}
      {detail ? (
        <div className="flex min-w-0 flex-col gap-4 text-sm">
          <div className="font-mono text-xs wrap-anywhere">
            {detail.record_id}
          </div>
          <div>
            {detail.agent_name}
            {detail.agent_deleted ? <Chip>Deleted</Chip> : null} ·{" "}
            {modelName(detail.model)} · {COVERAGE[detail.coverage]}
            <div className="text-xs text-fg-muted">
              Agent name source: {detail.agent_name_source.replace(/_/g, " ")}{" "}
              record.
            </div>
          </div>
          <div>
            {detail.source_kind === "turn_summary"
              ? "Turn summary"
              : "Independent request"}{" "}
            · Turn {detail.sequence}
            {detail.ordinal ? ` · Request ${detail.ordinal}` : ""}
          </div>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {METRICS.map(([field, label]) => (
              <div key={field}>
                <dt className="text-xs text-fg-muted">{label}</dt>
                <dd className="m-0 overflow-x-auto font-mono tabular-nums">
                  {usageNumber(detail[field])}
                </dd>
              </div>
            ))}
            <div>
              <dt className="text-xs text-fg-muted">Started (UTC)</dt>
              <dd className="m-0 text-xs wrap-anywhere">{detail.started_at}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Completed (UTC)</dt>
              <dd className="m-0 text-xs wrap-anywhere">
                {detail.completed_at ?? "Unavailable"}
              </dd>
            </div>
          </dl>
          <div className="text-xs text-fg-muted">
            Source: {detail.field_source}. Provider field presence:{" "}
            {detail.provider_field_presence}. Saved zero may be an SDK default.
            Input includes cache and input audio; output includes reasoning and
            output audio.
          </div>
          <div>
            {detail.cost_source === "genai-prices"
              ? "Estimated cost (request-time prices)"
              : "Saved cost"}
            :{" "}
            <span className="font-mono">
              {detail.cost === null
                ? "Unavailable"
                : `${detail.cost} ${detail.currency}`}
            </span>
            <div className="text-xs text-fg-muted">
              Source: {detail.cost_source}
            </div>
          </div>
          <pre className="m-0 max-h-80 overflow-auto rounded-sm border border-line bg-app p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {detail.usage_json}
          </pre>
          <Button
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(detail.usage_json);
                setCopied(true);
                setCopyError(null);
              } catch (failure) {
                setCopyError(
                  failure instanceof Error ? failure.message : String(failure),
                );
              }
            }}
          >
            {copied ? "Copied" : "Copy JSON"}
          </Button>
          {copyError ? (
            <p role="alert" className="text-danger text-xs">
              {copyError}
            </p>
          ) : null}
          <details>
            <summary>Model snapshot · {detail.model_identity_source}</summary>
            <pre className="overflow-auto font-mono text-xs whitespace-pre-wrap wrap-anywhere">
              {JSON.stringify(detail.model, null, 2)}
            </pre>
          </details>
          {detail.turn_summary ? (
            <details>
              <summary>
                Original Turn summary · {detail.traceable_requests} traceable
                requests
                {detail.partial_history ? " · Partial request history" : ""}
              </summary>
              <p className="text-xs text-fg-muted">
                Request records contribute once. This original summary is
                retained for coverage checks.
                {detail.summary_mismatch
                  ? " Saved summary and traceable request totals differ."
                  : ""}
              </p>
              <pre className="overflow-auto font-mono text-xs whitespace-pre-wrap wrap-anywhere">
                {detail.turn_summary_json}
              </pre>
            </details>
          ) : null}
          <Button onClick={() => onContext(detail)}>
            Open complete Turn / Request context
          </Button>
        </div>
      ) : !error ? (
        <LoadingSkeleton label="Loading record">
          <Skeleton className="h-40 rounded-sm" />
        </LoadingSkeleton>
      ) : null}
    </Modal>
  );
}
