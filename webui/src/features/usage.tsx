import { BarChart3, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@/app/router";
import {
  type Column,
  Page,
  PageBody,
  PageHeader,
  Section,
  Table,
} from "@/components/layout/shell";
import { Modal } from "@/components/ui/dialog";
import {
  Button,
  Chip,
  Input,
  StateDot,
  StatusText,
} from "@/components/ui/index";
import { StatePanel } from "@/components/ui/state-panel";
import { TurnHistoryModal } from "@/features/members/detail";
import {
  BackendError,
  backend,
  type UsageDetail,
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

function Failure({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-sm border border-danger p-4 text-sm"
    >
      <span className="text-danger wrap-anywhere">{error}</span>
      <Button size="sm" onClick={retry}>
        Retry
      </Button>
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

export function UsagePage({ agentId }: { agentId?: number }) {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<UsageFilters>({ agent_id: agentId });
  const [limit, setLimit] = useState(20);
  const [timeRange, setTimeRange] = useState("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [result, setResult] = useState<UsageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [context, setContext] = useState<UsageRecord | null>(null);
  const generation = useRef(0);
  const current = useRef<UsageResult | null>(null);
  const choices = useRef<Pick<UsageResult, "agents" | "models">>({
    agents: [],
    models: [],
  });
  const anchor = useRef<string | undefined>(undefined);
  const recordsElement = useRef<HTMLDivElement>(null);
  const revealRecords = useRef(false);

  const changeFilters = (next: UsageFilters) => {
    generation.current += 1;
    if (next.start_at !== filters.start_at || next.end_at !== filters.end_at) {
      setTimeRange(next.start_at || next.end_at ? "custom" : "all");
    }
    current.current = null;
    anchor.current = undefined;
    setFilters(next);
    setCursor(null);
    setResult(null);
  };

  const load = useCallback(
    async (refresh = false) => {
      const request = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        let data: UsageResult;
        try {
          data = await backend.usageQuery({
            ...filters,
            limit,
            cursor: refresh ? null : cursor,
            anchor: refresh ? anchor.current : undefined,
            dataset_revision:
              !refresh && cursor
                ? current.current?.dataset_revision
                : undefined,
          });
        } catch (failure) {
          if (
            !(failure instanceof BackendError) ||
            failure.code !== "usage_changed"
          )
            throw failure;
          data = await backend.usageQuery({
            ...filters,
            limit,
            anchor: anchor.current,
          });
        }
        if (request !== generation.current) return;
        if (
          !refresh ||
          data.dataset_revision !== current.current?.dataset_revision
        ) {
          current.current = data;
          choices.current = data;
          anchor.current = data.records[0]?.record_id;
          setResult(data);
        }
        setLoading(false);
      } catch (failure) {
        if (request !== generation.current) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      }
    },
    [filters, limit, cursor],
  );

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = backend.onEvent((event) => {
      if (
        event.type === "connection.restored" ||
        event.type.startsWith("agent.") ||
        event.type.startsWith("turn.") ||
        event.type.startsWith("organization.")
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(true), 150);
      }
    });
    const polling = setInterval(() => void load(true), 5000);
    return () => {
      generation.current += 1;
      clearTimeout(timer);
      clearInterval(polling);
      stop();
    };
  }, [load]);

  useEffect(() => {
    if (result && revealRecords.current) {
      revealRecords.current = false;
      recordsElement.current?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    }
    if (!result || result.index.ready) return;
    const timer = setTimeout(() => void load(true), 100);
    return () => clearTimeout(timer);
  }, [result, load]);

  return (
    <Page>
      <PageHeader
        title="Token Usage"
        crumb={{
          label: "Members",
          onSelect: () => navigate({ name: "members" }),
        }}
        actions={
          <Button onClick={() => void load(true)} disabled={loading}>
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
                changeFilters({
                  ...filters,
                  start_at: hours
                    ? new Date(Date.now() - hours * 3600000).toISOString()
                    : null,
                  end_at: null,
                });
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
                aria-label={key === "start_at" ? "From UTC" : "Until UTC"}
                value={filters[key]?.slice(0, 16) ?? ""}
                onChange={(event) =>
                  changeFilters({
                    ...filters,
                    [key]: event.target.value
                      ? `${event.target.value}:00+00:00`
                      : null,
                  })
                }
              />
            </label>
          ))}
          <Button onClick={() => changeFilters({})}>Clear Filters</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(filters)
            .filter(([, value]) => value != null && value !== "")
            .map(([key, value]) => (
              <Button
                key={key}
                size="sm"
                onClick={() => changeFilters({ ...filters, [key]: null })}
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
        {error ? <Failure error={error} retry={() => void load()} /> : null}
        {!result ? (
          loading ? (
            <div
              role="status"
              aria-label="Loading usage"
              aria-busy={loading}
              className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
            >
              {METRICS.map(([key]) => (
                <div
                  key={key}
                  className="h-28 rounded-sm border border-line bg-surface-raised animate-pulse"
                />
              ))}
            </div>
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
            <div ref={recordsElement}>
              <Section title="Request records">
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
                  <span>
                    {result.records.length.toLocaleString()} shown ·{" "}
                    {result.summary.records.toLocaleString()} records ·{" "}
                    {usageNumber(result.summary.requests)} requests
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Page size"
                      className={SELECT_CLASS}
                      value={limit}
                      onChange={(event) => {
                        setLimit(Number(event.target.value));
                        setCursor(null);
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
                      disabled={!result.previous_cursor || loading}
                      onClick={() => setCursor(result.previous_cursor)}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      disabled={!result.has_more || loading}
                      onClick={() => setCursor(result.next_cursor)}
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
          revision={result?.dataset_revision}
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
  onClose,
  onContext,
}: {
  recordId: string;
  revision?: number;
  onClose: () => void;
  onContext: (record: UsageRecord) => void;
}) {
  const [detail, setDetail] = useState<UsageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setError(null);
    try {
      const data = await backend.usageRead(recordId);
      if (request === generation.current) setDetail(data);
    } catch (failure) {
      if (request === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [recordId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load, revision]);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Usage record"
      wide
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error ? <Failure error={error} retry={() => void load()} /> : null}
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
        <div
          role="status"
          className="h-40 animate-pulse rounded-sm bg-surface-raised"
        >
          Loading record…
        </div>
      ) : null}
    </Modal>
  );
}
