import Decimal from "decimal.js";
import { useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useResource } from "@/app/organization";
import {
  type Column,
  Page,
  PageBody,
  PageHeader,
  Table,
} from "@/components/layout/shell";
import { LoadError } from "@/components/ui/access-error";
import { Modal } from "@/components/ui/dialog";
import {
  Button,
  Chip,
  Field,
  Input,
  LoadingSkeleton,
  Meter,
  Select,
  Skeleton,
  toast,
} from "@/components/ui/index";
import { TurnHistoryModal } from "@/features/members/turn-history";
import {
  BackendError,
  backend,
  type UsageDetail,
  type UsageFilters,
  type UsageMetrics,
  type UsageQuery,
  type UsageRecord,
  type UsageResult,
} from "@/lib/backend";

import { formatInteger } from "@/lib/format";

export { formatInteger } from "@/lib/format";

type RangeName = "7" | "30" | "90" | "all" | "custom";
type Range = { name: RangeName; filters: UsageFilters };
type Group =
  | { dimension: "model_key"; key: string; name: string }
  | { dimension: "agent_id"; key: number; name: string };

const numeric = "whitespace-nowrap font-mono tabular-nums";
const rangeChoices: { name: RangeName; label: string }[] = [
  { name: "7", label: "Last 7 days" },
  { name: "30", label: "Last 30 days" },
  { name: "90", label: "Last 90 days" },
  { name: "all", label: "All time" },
  { name: "custom", label: "Custom range" },
];
const groupColumns: Column[] = [
  { key: "name", label: "Name" },
  { key: "requests", label: "Requests", align: "end" },
  { key: "input", label: "Input tokens", align: "end" },
  { key: "output", label: "Output tokens", align: "end" },
  { key: "total", label: "Total tokens", align: "end" },
  { key: "share", label: "Share", align: "end" },
  { key: "cost", label: "Estimated cost", align: "end" },
];
const recordColumns: Column[] = [
  { key: "time", label: "Time" },
  { key: "agent", label: "Agent" },
  { key: "model", label: "Model" },
  { key: "input", label: "Input", align: "end" },
  { key: "output", label: "Output", align: "end" },
  { key: "total", label: "Total", align: "end" },
  { key: "cost", label: "Cost", align: "end" },
];

export function formatCost(value: string | null, currency = "USD"): string {
  if (value === null) return "Unavailable";
  const cost = new Decimal(value);
  if (!cost.isFinite()) throw new Error("Saved cost must be finite");
  const formatted = cost.toFixed(4, Decimal.ROUND_HALF_UP);
  const amount =
    !cost.isZero() && new Decimal(formatted).isZero() ? "<0.0001" : formatted;
  return `${currency} ${amount}`;
}

function modelName(model: UsageRecord["model"]): string {
  if (model.display_name) return String(model.display_name);
  const parts = [
    model.api_type,
    model.provider,
    model.model_name ?? model.model,
  ];
  return (
    parts
      .filter((part) => part !== null && part !== undefined && part !== "")
      .join(" / ") || "Unknown model"
  );
}

function preset(name: RangeName): Range {
  if (name === "all" || name === "custom") return { name, filters: {} };
  const now = Date.now();
  return {
    name,
    filters: {
      start_at: new Date(now - Number(name) * 86400000).toISOString(),
      end_at: new Date(now).toISOString(),
    },
  };
}

function inputTime(value?: string | null): string {
  return value ? new Date(value).toISOString().slice(0, 16) : "";
}

export function validateUtcInput(input: HTMLInputElement): {
  value: string | null;
  error: string | null;
} {
  const validity = input.validity;
  if (validity.rangeOverflow || validity.rangeUnderflow)
    return { value: null, error: "Enter a UTC year from 0001 to 9999." };
  if (
    !validity.valid ||
    (input.value !== "" && !Number.isFinite(input.valueAsNumber))
  )
    return {
      value: null,
      error: "Enter a complete, valid UTC date and time in minutes.",
    };
  if (input.value === "") return { value: null, error: null };
  return { value: new Date(input.valueAsNumber).toISOString(), error: null };
}

function RangeControls({
  range,
  onChange,
}: {
  range: Range;
  onChange: (next: Range) => void;
}) {
  const from = useRef<HTMLInputElement>(null);
  const until = useRef<HTMLInputElement>(null);
  const id = useId();
  const [errors, setErrors] = useState<(string | null)[]>([null, null]);
  const check = (apply: boolean) => {
    if (!from.current || !until.current) return;
    const start = validateUtcInput(from.current);
    const end = validateUtcInput(until.current);
    if (
      !start.error &&
      !end.error &&
      start.value &&
      end.value &&
      start.value >= end.value
    )
      end.error = "Until must be later than From.";
    setErrors([start.error, end.error]);
    if (apply && !start.error && !end.error)
      onChange({
        name: "custom",
        filters: { start_at: start.value, end_at: end.value },
      });
  };
  const choose = (name: RangeName) => {
    setErrors([null, null]);
    const next = name === "custom" ? { ...range, name } : preset(name);
    if (from.current) from.current.value = inputTime(next.filters.start_at);
    if (until.current) until.current.value = inputTime(next.filters.end_at);
    onChange(next);
  };
  return (
    <section aria-label="Time range" className="flex flex-col gap-3">
      <fieldset className="flex flex-wrap gap-2" aria-label="Usage time range">
        {rangeChoices.map((choice) => (
          <Button
            key={choice.name}
            variant="ghost"
            aria-pressed={range.name === choice.name}
            onClick={() => choose(choice.name)}
          >
            <Chip tone={range.name === choice.name ? "blue" : "neutral"}>
              {choice.label}
            </Chip>
          </Button>
        ))}
      </fieldset>
      {range.name === "custom" ? (
        <div className="grid grid-cols-2 narrow:grid-cols-1 gap-3 max-w-xl">
          {[
            { label: "From (UTC)", ref: from, value: range.filters.start_at },
            { label: "Until (UTC)", ref: until, value: range.filters.end_at },
          ].map((field, index) => (
            <Field
              key={field.label}
              label={field.label}
              htmlFor={`${id}-${index}`}
            >
              <Input
                ref={field.ref}
                id={`${id}-${index}`}
                type="datetime-local"
                min="0001-01-01T00:00"
                max="9999-12-31T23:59"
                step={60}
                defaultValue={inputTime(field.value)}
                aria-invalid={!!errors[index]}
                aria-describedby={
                  errors[index] ? `${id}-${index}-error` : undefined
                }
                onChange={() => check(true)}
                onBlur={() => check(false)}
              />
              {errors[index] ? (
                <p id={`${id}-${index}-error`} className="text-xs text-danger">
                  {errors[index]}
                </p>
              ) : null}
            </Field>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function useSavedRead<T>(
  read: (current: () => boolean) => Promise<T>,
  stopOnError = false,
) {
  const failure = useRef<{ error: unknown } | null>(null);
  const epoch = useRef(0);
  const guardedRead = useCallback(async () => {
    if (stopOnError && failure.current) throw failure.current.error;
    const generation = epoch.current;
    try {
      return await read(() => generation === epoch.current);
    } catch (error) {
      if (generation === epoch.current) failure.current = { error };
      throw error;
    }
  }, [read, stopOnError]);
  const {
    resource,
    refresh: readResource,
    invalidate: invalidateResource,
  } = useResource(guardedRead);
  const invalidate = useCallback(
    (enabled: boolean, error?: BackendError) => {
      epoch.current += 1;
      failure.current = null;
      invalidateResource(enabled, error);
    },
    [invalidateResource],
  );
  const refresh = useCallback(
    (changed = false) => {
      failure.current = null;
      return readResource(changed);
    },
    [readResource],
  );
  const automaticRefresh = useCallback(() => {
    if (!stopOnError || !failure.current) void readResource(true);
  }, [readResource, stopOnError]);
  useEffect(() => {
    invalidate(!backend.disconnected);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = undefined;
        invalidate(
          false,
          event.error instanceof BackendError
            ? event.error
            : new BackendError("disconnected", "Connection lost"),
        );
      } else if (event.type === "connection.restored") {
        invalidate(true);
        void refresh(true);
      } else if (
        event.type.startsWith("agent.") ||
        event.type.startsWith("member.") ||
        event.type.startsWith("turn.") ||
        event.type.startsWith("usage.") ||
        event.type === "tool.updated" ||
        event.type === "organization.changed"
      ) {
        if (event.type === "turn.finished") {
          if (debounce !== undefined) clearTimeout(debounce);
          debounce = undefined;
          automaticRefresh();
        } else if (debounce === undefined)
          debounce = setTimeout(() => {
            debounce = undefined;
            automaticRefresh();
          }, 150);
      }
    });
    void refresh();
    const poll = setInterval(automaticRefresh, 5000);
    return () => {
      invalidate(false);
      off();
      clearInterval(poll);
      if (debounce !== undefined) clearTimeout(debounce);
    };
  }, [invalidate, refresh, automaticRefresh]);
  const retry = () => {
    if (backend.disconnected)
      void backend.reconnect().catch((error: unknown) =>
        toast({
          tone: "danger",
          title: "Could not reconnect",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    else void refresh(true);
  };
  return { resource, refresh, invalidate, retry };
}

function Summary({ metrics }: { metrics: UsageMetrics }) {
  return (
    <section
      aria-label="Usage totals"
      className="grid grid-cols-4 narrow:grid-cols-2 gap-4"
    >
      {[
        { label: "Total tokens", value: metrics.total_tokens },
        { label: "Input tokens", value: metrics.input_tokens },
        { label: "Output tokens", value: metrics.output_tokens },
        { label: "Requests", value: metrics.requests },
      ].map((metric) => (
        <div
          key={metric.label}
          className="min-w-0 rounded-md border border-line bg-surface p-4 min-h-24"
        >
          <p className="text-xs text-fg-muted">{metric.label}</p>
          <p className="text-2xl font-bold font-mono tabular-nums break-words mt-2">
            {formatInteger(metric.value)}
          </p>
        </div>
      ))}
    </section>
  );
}

type ChartPoint = {
  timestamp: number;
  total: number | null;
  day: UsageResult["daily"][number] | null;
};

export function trendPoints(daily: UsageResult["daily"]): {
  points: ChartPoint[];
  scale: number;
} {
  const scale = daily.reduce(
    (largest, day) => Math.max(largest, (day.total_tokens?.length ?? 1) - 6),
    0,
  );
  const points: ChartPoint[] = [];
  for (const day of daily) {
    const timestamp = Date.parse(`${day.date}T00:00:00Z`);
    const previous = points[points.length - 1];
    if (previous && timestamp - previous.timestamp > 86400000)
      points.push({
        timestamp: previous.timestamp + 86400000,
        total: null,
        day: null,
      });
    const value = day.total_tokens;
    const digits = value?.slice(0, 15);
    const total =
      value === null || digits === undefined
        ? null
        : Number(digits) * 10 ** (value.length - digits.length - scale);
    points.push({ timestamp, total, day });
  }
  return { points, scale };
}

function Trend({ result }: { result: UsageResult }) {
  const daySelectId = useId();
  const { points, scale } = trendPoints(result.daily);
  const reduced = useReducedMotion();
  const [focused, setFocused] = useState<string | null>(null);
  const selected = result.daily.find((day) => day.date === focused);
  const bounds = [result.filters.start_at, result.filters.end_at].map(
    (value, index) =>
      value
        ? Date.parse(value)
        : points[index === 0 ? 0 : points.length - 1]?.timestamp,
  );
  const label = scale === 0 ? "Tokens" : `Tokens (×10^${scale})`;
  return (
    <section
      aria-label="Daily token trend"
      className="rounded-md border border-line bg-surface p-4 min-w-0"
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold">Daily usage</h2>
        <span className="text-xs text-fg-muted">{label} · UTC</span>
      </div>
      {points.length === 0 ? (
        <p className="text-sm text-fg-muted py-12 text-center">
          No saved usage in this time range.
        </p>
      ) : (
        <>
          <div className="h-[200px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart
                data={points}
                accessibilityLayer
                margin={{ left: 0, right: 16, top: 8, bottom: 8 }}
              >
                <CartesianGrid stroke="var(--color-line)" vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={[bounds[0] ?? "dataMin", bounds[1] ?? "dataMax"]}
                  tickFormatter={(value: number) =>
                    new Date(value).toISOString().slice(0, 10)
                  }
                  tick={{ fill: "var(--color-fg-muted)", fontSize: 12 }}
                  minTickGap={32}
                />
                <YAxis
                  tick={{ fill: "var(--color-fg-muted)", fontSize: 12 }}
                  width={56}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    const day = payload?.[0]?.payload?.day as
                      | UsageResult["daily"][number]
                      | null
                      | undefined;
                    return active && day ? (
                      <div className="rounded-sm border border-line bg-surface-raised p-3 text-xs font-mono tabular-nums">
                        <p>{day.date} UTC</p>
                        <p>{formatInteger(day.total_tokens)} tokens</p>
                        <p>{formatInteger(day.requests)} requests</p>
                      </div>
                    ) : null;
                  }}
                />
                <Line
                  dataKey="total"
                  name={label}
                  type="linear"
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  connectNulls={false}
                  dot={{ r: 2 }}
                  isAnimationActive={!reduced}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="sr-only focus-within:not-sr-only focus-within:mt-3">
            <label htmlFor={daySelectId}>
              Read daily usage{" "}
              <Select
                id={daySelectId}
                value={focused ?? ""}
                onChange={(event) => setFocused(event.target.value)}
              >
                <option value="">Choose a UTC day</option>
                {result.daily.map((day) => (
                  <option key={day.date} value={day.date}>
                    {day.date}
                  </option>
                ))}
              </Select>
            </label>
            <output aria-live="polite">
              {selected
                ? `${selected.date} UTC: ${formatInteger(selected.total_tokens)} tokens, ${formatInteger(selected.requests)} requests`
                : "Use the day selector to read exact saved values."}
            </output>
          </div>
        </>
      )}
    </section>
  );
}

export function shareOf(
  value: string | null,
  total: string | null,
): number | null {
  if (value === null || total === null) return null;
  const denominator = BigInt(total);
  if (denominator === 0n) return 0;
  const basisPoints = (BigInt(value) * 10000n) / denominator;
  return Number(basisPoints > 10000n ? 10000n : basisPoints) / 100;
}

function GroupTable({
  result,
  dimension,
  onDimension,
  onSelect,
}: {
  result: UsageResult;
  dimension: Group["dimension"];
  onDimension: (dimension: Group["dimension"]) => void;
  onSelect: (group: Group) => void;
}) {
  const groups =
    dimension === "model_key"
      ? result.groups.model_key.map((metrics) => ({
          metrics,
          group: {
            dimension: "model_key",
            key: metrics.model_key,
            name: modelName(
              result.models.find((model) => model.key === metrics.model_key)
                ?.model ?? {},
            ),
          } as Group,
          deleted: false,
        }))
      : result.groups.agent_id.map((metrics) => {
          const agent = result.agents.find(
            (item) => item.id === metrics.agent_id,
          );
          return {
            metrics,
            group: {
              dimension: "agent_id",
              key: metrics.agent_id,
              name: agent?.name ?? `Agent ${metrics.agent_id}`,
            } as Group,
            deleted: !!agent?.deleted,
          };
        });
  return (
    <section
      aria-label="Usage by group"
      className="rounded-md border border-line bg-surface overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 p-3">
        <h2 className="text-sm font-semibold">
          Usage by {dimension === "model_key" ? "model" : "Agent"}
        </h2>
        <fieldset aria-label="Group usage by" className="flex gap-2">
          <Button
            size="sm"
            aria-pressed={dimension === "model_key"}
            onClick={() => onDimension("model_key")}
          >
            Model
          </Button>
          <Button
            size="sm"
            aria-pressed={dimension === "agent_id"}
            onClick={() => onDimension("agent_id")}
          >
            Agent
          </Button>
        </fieldset>
      </div>
      <Table label="Usage groups" columns={groupColumns}>
        {groups.map(({ metrics, group, deleted }) => {
          const share = shareOf(
            metrics.total_tokens,
            result.summary.total_tokens,
          );
          return (
            <tr
              key={`${group.dimension}:${group.key}`}
              onClick={() => onSelect(group)}
              className="cursor-pointer"
            >
              <td>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(group);
                  }}
                >
                  {group.name}
                </Button>
                {deleted ? <Chip>Deleted</Chip> : null}
              </td>
              {[
                metrics.requests,
                metrics.input_tokens,
                metrics.output_tokens,
                metrics.total_tokens,
              ].map((value, index) => (
                <td
                  key={groupColumns[index + 1].key}
                  data-align="end"
                  className={numeric}
                >
                  {formatInteger(value)}
                </td>
              ))}
              <td data-align="end">
                <div className="flex items-center justify-end gap-2">
                  <span className={numeric}>
                    {share === null ? "Unavailable" : `${share.toFixed(2)}%`}
                  </span>
                  {share !== null ? (
                    <div className="w-20">
                      <Meter
                        value={share}
                        max={100}
                        label={`Share for ${group.name}`}
                      />
                    </div>
                  ) : null}
                </div>
              </td>
              <td data-align="end" className={numeric}>
                {formatCost(metrics.estimated_cost)}
              </td>
            </tr>
          );
        })}
      </Table>
      {groups.length === 0 ? (
        <p className="p-4 text-sm text-fg-muted">
          No saved usage in this time range.
        </p>
      ) : null}
    </section>
  );
}

function Records({
  result,
  group,
  busy,
  onPage,
  onSelect,
}: {
  result: UsageResult;
  group: Group;
  busy: boolean;
  onPage: (cursor: string) => void;
  onSelect: (record: UsageRecord) => void;
}) {
  const columns = recordColumns.filter(
    (column) => group.dimension !== "agent_id" || column.key !== "agent",
  );
  return (
    <section
      aria-label="Group request records"
      className="rounded-md border border-line bg-surface overflow-hidden"
      aria-busy={busy}
    >
      <Table label="Request records" columns={columns}>
        {result.records.map((record) => (
          <tr
            key={record.record_id}
            className="cursor-pointer"
            onClick={() => onSelect(record)}
          >
            <td className="whitespace-nowrap">
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(record);
                }}
              >
                {new Date(record.started_at)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 19)}{" "}
                UTC
              </Button>
              {record.saved === false ? (
                <Chip tone="danger">Not saved</Chip>
              ) : null}
            </td>
            {group.dimension !== "agent_id" ? (
              <td>
                {record.agent_name}
                {record.agent_deleted ? <Chip>Deleted</Chip> : null}
              </td>
            ) : null}
            <td className="min-w-40">{modelName(record.model)}</td>
            {[
              record.input_tokens,
              record.output_tokens,
              record.total_tokens,
            ].map((value, index) => (
              <td
                key={recordColumns[index + 3].key}
                data-align="end"
                className={numeric}
              >
                {formatInteger(value)}
              </td>
            ))}
            <td data-align="end" className={numeric}>
              {formatCost(record.cost, record.currency)}
            </td>
          </tr>
        ))}
      </Table>
      {result.records.length === 0 ? (
        <p className="p-4 text-sm text-fg-muted">
          No saved requests in this time range.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-3">
        <Button
          aria-disabled={busy || !result.previous_cursor}
          onClick={() => {
            if (!busy && result.previous_cursor) onPage(result.previous_cursor);
          }}
        >
          Previous
        </Button>
        <span className="text-xs text-fg-muted" role="status">
          {busy
            ? "Loading records…"
            : `${result.records.length} of ${result.summary.records} records · 20 per page`}
        </span>
        <Button
          aria-disabled={busy || !result.has_more || !result.next_cursor}
          onClick={() => {
            if (!busy && result.has_more && result.next_cursor)
              onPage(result.next_cursor);
          }}
        >
          Next
        </Button>
      </div>
    </section>
  );
}

function QueryView({
  filters,
  group,
  dimension,
  onDimension,
  onGroup,
  onRecord,
  onRevision,
  refreshSignal,
}: {
  filters: UsageFilters;
  group: Group | null;
  dimension: Group["dimension"];
  onDimension: (dimension: Group["dimension"]) => void;
  onGroup: (group: Group) => void;
  onRecord: (record: UsageRecord) => void;
  onRevision: (revision: number) => void;
  refreshSignal: number;
}) {
  const query = useRef<UsageQuery>({
    ...filters,
    contributions_only: true,
    limit: 20,
  });
  const advanceVersion = useRef<{
    version: number;
    current: () => boolean;
  } | null>(null);
  const readIdentity = useRef<() => boolean>(() => false);
  const read = useCallback(async (current: () => boolean) => {
    const target = query.current;
    const advancing = advanceVersion.current;
    advanceVersion.current = null;
    readIdentity.current = current;
    if (advancing?.current()) {
      await backend.usageAdvance(advancing.version);
      if (!current())
        throw new BackendError("connection_changed", "Connection changed");
    }
    try {
      return { result: await backend.usageQuery(target), target };
    } catch (error) {
      if (
        !current() ||
        !(error instanceof BackendError) ||
        error.code !== "usage_changed"
      )
        throw error;
      const next = {
        ...target,
        cursor: null,
        dataset_revision: undefined,
        runtime_epoch: undefined,
        live_versions: undefined,
        initialization_version: undefined,
        anchor:
          target.initialization_version === undefined
            ? target.anchor
            : undefined,
      };
      return { result: await backend.usageQuery(next), target: next };
    }
  }, []);
  const { resource, refresh, invalidate, retry } = useSavedRead(read, true);
  const response = resource.data;
  const data = response?.result;
  const lastResponse = useRef<typeof response>(null);
  const lastSignal = useRef(refreshSignal);
  useEffect(() => {
    if (lastSignal.current !== refreshSignal) {
      lastSignal.current = refreshSignal;
      void refresh(true);
    }
  }, [refreshSignal, refresh]);
  useEffect(() => {
    if (!data || !response) return;
    if (data.status === "initializing") {
      query.current = {
        ...filters,
        contributions_only: true,
        limit: 20,
        initialization_version: data.index.version,
      };
      if (!resource.error && !resource.refreshing && !backend.disconnected) {
        const current = readIdentity.current;
        const timer = setTimeout(() => {
          if (!current() || backend.disconnected) return;
          advanceVersion.current = { version: data.index.version, current };
          void refresh(true);
        }, 100);
        return () => clearTimeout(timer);
      }
    } else if (!resource.error && lastResponse.current !== response) {
      lastResponse.current = response;
      advanceVersion.current = null;
      query.current = {
        ...response.target,
        initialization_version: undefined,
        dataset_revision: data.dataset_revision,
        runtime_epoch: data.runtime_epoch,
        live_versions: data.live_versions,
        anchor: data.records[0]?.record_id,
      };
      onRevision(data.dataset_revision);
    }
  }, [
    data,
    response,
    resource.error,
    resource.refreshing,
    filters,
    onRevision,
    refresh,
  ]);
  const page = (cursor: string) => {
    if (!data || data.status !== "ready" || resource.refreshing) return;
    query.current = {
      ...filters,
      contributions_only: true,
      limit: 20,
      cursor,
      dataset_revision: data.dataset_revision,
      ...(data.runtime_epoch !== undefined
        ? {
            runtime_epoch: data.runtime_epoch,
            live_versions: data.live_versions,
          }
        : {}),
      anchor: data.records[0]?.record_id,
    };
    invalidate(!backend.disconnected);
    void refresh();
  };
  return (
    <div className="flex flex-col gap-6 min-w-0">
      {resource.error ? (
        <LoadError error={resource.error} retry={retry} />
      ) : null}
      {data?.status === "initializing" || !data ? (
        <>
          {data?.status === "initializing" ? (
            <p
              role="status"
              aria-label="Usage initialization progress"
              className="text-sm text-fg-muted font-mono tabular-nums"
            >
              Initializing saved usage ·{" "}
              {formatInteger(String(data.index.processed_requests))} requests
              processed · {formatInteger(String(data.index.processed_turns))}{" "}
              activities processed
            </p>
          ) : null}
          {!resource.error ? (
            <LoadingSkeleton
              label={data ? "Initializing saved usage" : "Loading usage"}
            >
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-[200px] w-full" />
              <Skeleton className="h-48 w-full" />
            </LoadingSkeleton>
          ) : null}
        </>
      ) : group ? (
        <Records
          result={data}
          group={group}
          busy={resource.refreshing}
          onPage={page}
          onSelect={onRecord}
        />
      ) : (
        <>
          <Summary metrics={data.summary} />
          <Trend result={data} />
          <GroupTable
            result={data}
            dimension={dimension}
            onDimension={onDimension}
            onSelect={onGroup}
          />
        </>
      )}
    </div>
  );
}

function DetailContent({
  recordId,
  revision,
  onContext,
}: {
  recordId: string;
  revision: number | null;
  onContext: (detail: UsageDetail) => void;
}) {
  const read = useCallback(() => backend.usageRead(recordId), [recordId]);
  const { resource, refresh, retry } = useSavedRead(read);
  useEffect(() => {
    if (revision !== null) void refresh(true);
  }, [revision, refresh]);
  const detail = resource.data;
  const copy = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.usage_json);
      toast({ tone: "success", title: "Copied usage JSON" });
    } catch (error) {
      toast({
        tone: "danger",
        title: "Could not copy JSON",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <>
      {resource.error ? (
        <LoadError error={resource.error} retry={retry} />
      ) : null}
      {detail ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                void copy();
              }}
            >
              Copy JSON
            </Button>
            <Button onClick={() => onContext(detail)}>View Turn context</Button>
            {detail.saved === false ? (
              <Chip tone="danger">Not saved</Chip>
            ) : null}
          </div>
          <dl className="grid grid-cols-[minmax(100px,1fr)_minmax(0,2fr)] gap-3 text-xs">
            {Object.entries(detail)
              .filter(
                ([key]) =>
                  !["usage_json", "usage", "turn_summary_json"].includes(key),
              )
              .map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-fg-muted break-words">{key}</dt>
                  <dd className="font-mono tabular-nums whitespace-pre-wrap break-words">
                    {value === null
                      ? "Unavailable"
                      : typeof value === "object"
                        ? JSON.stringify(value, null, 2)
                        : String(value)}
                  </dd>
                </div>
              ))}
          </dl>
          <h3 className="text-sm font-semibold">Complete usage JSON</h3>
          <pre className="text-xs font-mono whitespace-pre-wrap break-words rounded-sm bg-app p-3">
            {detail.usage_json}
          </pre>
          {detail.turn_summary_json !== null ? (
            <>
              <h3 className="text-sm font-semibold">Saved Turn summary</h3>
              <pre className="text-xs font-mono whitespace-pre-wrap break-words rounded-sm bg-app p-3">
                {detail.turn_summary_json}
              </pre>
            </>
          ) : null}
        </>
      ) : resource.status !== "failed" ? (
        <LoadingSkeleton label="Loading request details">
          <Skeleton className="h-48 w-full" />
        </LoadingSkeleton>
      ) : null}
    </>
  );
}

export function UsagePage({ entrySignal = 0 }: { entrySignal?: number }) {
  const [range, setRange] = useState<Range>(() => preset("7"));
  const [dimension, setDimension] = useState<Group["dimension"]>("model_key");
  const [group, setGroup] = useState<Group | null>(null);
  const [record, setRecord] = useState<UsageRecord | null>(null);
  const [context, setContext] = useState<UsageDetail | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  useEffect(() => {
    setGroup(null);
    setRecord(null);
    setContext(null);
    setRevision(null);
  }, [entrySignal]);
  const filters = {
    ...range.filters,
    ...(group ? { [group.dimension]: group.key } : {}),
  };
  return (
    <Page>
      <PageHeader
        title={group ? group.name : "Usage"}
        actions={
          <>
            {group ? (
              <Button onClick={() => setGroup(null)}>Back to usage</Button>
            ) : null}
            <Button onClick={() => setRefreshSignal((value) => value + 1)}>
              Refresh
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="flex flex-col gap-6 min-w-0">
          <RangeControls range={range} onChange={setRange} />
          <QueryView
            key={JSON.stringify(filters)}
            filters={filters}
            group={group}
            dimension={dimension}
            onDimension={setDimension}
            onGroup={setGroup}
            onRecord={setRecord}
            onRevision={setRevision}
            refreshSignal={refreshSignal}
          />
        </div>
      </PageBody>
      <Modal
        open={record !== null}
        onOpenChange={(open) => {
          if (!open) setRecord(null);
        }}
        title="Request details"
        variant="history"
        wide
      >
        {record ? (
          <DetailContent
            key={record.record_id}
            recordId={record.record_id}
            revision={revision}
            onContext={(detail) => {
              setContext(detail);
              setRecord(null);
            }}
          />
        ) : null}
      </Modal>
      {context ? (
        <TurnHistoryModal
          key={`${context.agent_id}:${context.sequence}:${context.ordinal}`}
          agentId={context.agent_id}
          sequence={context.sequence}
          initialOrdinal={context.ordinal ?? undefined}
          open
          onOpenChange={(open) => {
            if (!open) setContext(null);
          }}
        />
      ) : null}
    </Page>
  );
}
