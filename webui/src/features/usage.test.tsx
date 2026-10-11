import { StrictMode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  AgentHistoryRead,
  BackendEvent,
  UsageDetail,
  UsageMetrics,
  UsageQuery,
  UsageRecord,
  UsageResult,
} from "@/lib/backend";

let testing: typeof import("@testing-library/react");
let usage: typeof import("@/features/usage");
let App: typeof import("@/App")["default"];
let backendModule: typeof import("@/lib/backend");
let TooltipProvider: typeof import("@/components/ui/tooltip")["TooltipProvider"];
let closeDom: () => void;
let listeners: Set<(event: BackendEvent) => void>;
let queryMock: ReturnType<typeof vi.spyOn>;
let readMock: ReturnType<typeof vi.spyOn>;

const metrics: UsageMetrics = {
  records: 21,
  input_tokens: "9007199254740993",
  output_tokens: "7",
  total_tokens: "9007199254741000",
  requests: "21",
  input_known: 21,
  output_known: 21,
  total_known: 21,
  requests_known: 21,
  cache_read_tokens: "0",
  cache_write_tokens: "0",
  cache_read_known: 21,
  cache_write_known: 21,
  estimated_cost: "0.0000001234567890123456789",
  cost_known: 21,
  last_active: "2026-10-10T00:00:00Z",
  model_count: 1,
};
const record: UsageRecord = {
  record_id: "request:2:4:1",
  source_kind: "request",
  agent_id: 2,
  agent_name: "Researcher",
  agent_name_source: "retained_member",
  agent_deleted: true,
  sequence: 4,
  ordinal: 1,
  request_id: "saved-request",
  started_at: "2026-10-10T00:00:00Z",
  completed_at: "2026-10-10T00:01:00Z",
  status: "completed",
  coverage: "recorded",
  model_key: "saved-model",
  model: { display_name: "Saved model" },
  model_identity_source: "configuration",
  field_source: "sdk_serialized",
  input_tokens: "9007199254740993",
  output_tokens: "7",
  total_tokens: "9007199254741000",
  requests: "1",
  cost: "0.0000001234567890123456789",
  cost_source: "genai-prices",
  currency: "USD",
  partial_history: false,
};

function result(params: UsageQuery = {}, revision = 1): UsageResult {
  return {
    filters: { ...params },
    dataset_revision: revision,
    index: { ready: 1, revision },
    summary: { ...metrics },
    coverage: { recorded: 21 },
    groups: {
      agent_id: [{ ...metrics, agent_id: 2 }],
      model_key: [{ ...metrics, model_key: "saved-model" }],
    },
    daily: [{ date: "2026-10-10", ...metrics }],
    records: [{ ...record }],
    has_more: true,
    next_cursor: "opaque-next",
    previous_cursor: params.cursor ? "opaque-previous" : null,
    agents: [{ id: 2, name: "Researcher", deleted: 1 }],
    models: [{ key: "saved-model", model: record.model }],
  };
}

function detail(revision = 1): UsageDetail {
  return {
    ...record,
    dataset_revision: revision,
    usage_json: JSON.stringify(
      {
        input_tokens: 123,
        output_tokens: 7,
        details: { reasoning_tokens: 4 },
        extra_saved_field: "preserved",
      },
      null,
      2,
    ),
    turn_summary: { requests: 1 },
    turn_summary_json: '{"requests":1}',
    summary_mismatch: false,
    traceable_requests: 1,
    provider_field_presence: "unknown",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  closeDom = () => dom.window.close();
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "SVGElement",
    "Element",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
  ] as const)
    vi.stubGlobal(name, dom.window[name]);
  vi.stubGlobal(
    "getComputedStyle",
    dom.window.getComputedStyle.bind(dom.window),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const matchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  dom.window.matchMedia = matchMedia as typeof dom.window.matchMedia;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 1),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: { width: 600, height: 200 },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(
    dom.window.HTMLElement.prototype,
    "getBoundingClientRect",
    {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 600,
        bottom: 200,
        width: 600,
        height: 200,
        toJSON() {},
      }),
    },
  );
  testing = await import("@testing-library/react");
  backendModule = await import("@/lib/backend");
  usage = await import("@/features/usage");
  ({ default: App } = await import("@/App"));
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
}, 30000);

beforeEach(() => {
  listeners = new Set();
  vi.spyOn(backendModule.backend, "disconnected", "get").mockReturnValue(false);
  vi.spyOn(backendModule.backend, "onEvent").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  queryMock = vi
    .spyOn(backendModule.backend, "usageQuery")
    .mockImplementation(async (params) => result(params));
  readMock = vi
    .spyOn(backendModule.backend, "usageRead")
    .mockImplementation(async () => detail());
});

afterEach(async () => {
  testing.cleanup();
  vi.useRealTimers();
  await testing.act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

async function mount() {
  await testing.act(async () => {
    testing.render(
      <StrictMode>
        <TooltipProvider>
          <usage.UsagePage />
        </TooltipProvider>
      </StrictMode>,
    );
  });
}

async function click(name: string) {
  await testing.act(async () => {
    testing.fireEvent.click(testing.screen.getByRole("button", { name }));
  });
}

async function emit(type: string) {
  await testing.act(async () => {
    for (const listener of listeners) listener({ type });
  });
}

function lastQuery(): UsageQuery {
  return queryMock.mock.calls.at(-1)?.[0] as UsageQuery;
}

function summaryText() {
  return testing.screen.getByRole("region", { name: "Usage totals" })
    .textContent;
}

describe("Usage dashboard", () => {
  it("provides a primary Usage entry alongside Members and opens the independent page", async () => {
    vi.spyOn(backendModule.backend, "connect").mockResolvedValue(undefined);
    vi.spyOn(backendModule.backend, "organization").mockResolvedValue({
      id: 1,
      uuid: "usage-test-organization",
      human_id: 1,
      token_limit: null,
      members: [{ id: 1, type: "human", name: "Reviewer", state: "idle" }],
    });
    vi.spyOn(backendModule.backend, "discussions").mockResolvedValue([]);
    await testing.act(async () => {
      testing.render(<App />);
    });
    const entry = testing.screen.getByRole("button", { name: "Usage" });
    const members = testing.screen.getByRole("button", { name: "Members" });
    expect(entry.closest("li")?.parentElement).toBe(
      members.closest("li")?.parentElement,
    );
    expect(testing.screen.queryByText("Token Usage")).toBeNull();
    await click("Usage");
    expect(entry.getAttribute("aria-current")).toBe("page");
    expect(testing.screen.getByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(summaryText()).toContain("9,007,199,254,741,000");
  });
  it("shows four totals, a real responsive chart and one group table with exact saved numbers", async () => {
    await mount();
    expect(lastQuery()).toMatchObject({ contributions_only: true, limit: 20 });
    expect(
      Date.parse(lastQuery().end_at as string) -
        Date.parse(lastQuery().start_at as string),
    ).toBe(7 * 86400000);
    expect(summaryText()).toContain("9,007,199,254,741,000");
    expect(
      testing.screen
        .getByRole("table", { name: "Usage groups" })
        .querySelectorAll("th"),
    ).toHaveLength(7);
    expect(
      testing.screen.queryByRole("table", { name: "Request records" }),
    ).toBeNull();
    expect(
      testing.screen
        .getByRole("region", { name: "Daily token trend" })
        .querySelector("svg"),
    ).toBeTruthy();
    expect(
      testing.screen.getByRole("combobox", { name: "Read daily usage" }),
    ).toBeTruthy();
    expect(testing.screen.queryByRole("tablist")).toBeNull();
    const calls = queryMock.mock.calls.length;
    await click("Agent");
    expect(queryMock.mock.calls).toHaveLength(calls);
    expect(
      testing.screen.getByRole("button", { name: "Researcher" }),
    ).toBeTruthy();
    expect(testing.screen.getByText("Deleted")).toBeTruthy();
  });

  it("uses backend group keys, fixed page size and restores the selected range and grouping", async () => {
    await mount();
    await click("Last 30 days");
    const range = {
      start_at: lastQuery().start_at,
      end_at: lastQuery().end_at,
    };
    await click("Agent");
    await click("Researcher");
    expect(lastQuery()).toMatchObject({ ...range, agent_id: 2, limit: 20 });
    expect(
      testing.screen
        .getByRole("table", { name: "Request records" })
        .querySelectorAll("th"),
    ).toHaveLength(6);
    await click("Next");
    expect(lastQuery()).toMatchObject({
      ...range,
      agent_id: 2,
      limit: 20,
      cursor: "opaque-next",
      dataset_revision: 1,
    });
    await click("Previous");
    expect(lastQuery().cursor).toBe("opaque-previous");
    await click("Back to usage");
    expect(lastQuery()).toMatchObject(range);
    expect(lastQuery().agent_id).toBeUndefined();
    expect(
      testing.screen
        .getByRole("button", { name: "Agent" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      testing.screen
        .getByRole("button", { name: "Last 30 days" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("queries an unknown historical model by its exact key", async () => {
    queryMock.mockImplementation(async (params: UsageQuery) => {
      const value = result(params);
      value.groups.model_key[0].model_key = "unknown";
      value.models = [{ key: "unknown", model: {} }];
      return value;
    });
    await mount();
    await click("Unknown model");
    expect(lastQuery().model_key).toBe("unknown");
    expect(lastQuery().limit).toBe(20);
  });

  it("keeps selected range, records, controls and focus while a page fails and retries", async () => {
    await mount();
    await click("Saved model");
    const next = testing.screen.getByRole("button", { name: "Next" });
    next.focus();
    const pending = deferred<UsageResult>();
    queryMock.mockImplementationOnce(() => pending.promise);
    await click("Next");
    expect(document.activeElement).toBe(next);
    expect(testing.screen.getByRole("button", { name: "Next" })).toBe(next);
    expect(
      testing.screen.getByRole("table", { name: "Request records" })
        .textContent,
    ).toContain("9,007,199,254,741,000");
    await testing.act(async () =>
      pending.reject(new backendModule.BackendError("timeout", "Timed out")),
    );
    expect(testing.screen.getByRole("alert").textContent).toContain(
      "Timed out",
    );
    const failed = { ...lastQuery() };
    await click("Retry");
    expect(lastQuery()).toMatchObject(failed);
    expect(testing.screen.queryByRole("alert")).toBeNull();
    expect(testing.screen.getByRole("button", { name: "Next" })).toBe(next);
  });

  it("drops old range successes and failures without affecting the current request", async () => {
    const old = deferred<UsageResult>();
    queryMock.mockImplementationOnce(() => old.promise);
    await mount();
    await click("Last 90 days");
    await testing.act(async () =>
      old.resolve({
        ...result(),
        summary: { ...metrics, total_tokens: "999" },
      }),
    );
    expect(summaryText()).not.toContain("999");
    const another = deferred<UsageResult>();
    queryMock.mockImplementationOnce(() => another.promise);
    await click("Last 30 days");
    await click("All time");
    await testing.act(async () =>
      another.reject(new backendModule.BackendError("timeout", "Old failure")),
    );
    expect(testing.screen.queryByText("Old failure")).toBeNull();
    expect(lastQuery().start_at).toBeUndefined();
    expect(summaryText()).toContain("9,007,199,254,741,000");
  });

  it("publishes a slow success during repeated refresh hints and then performs one supplementary read", async () => {
    vi.useFakeTimers();
    const slow = deferred<UsageResult>();
    const next = deferred<UsageResult>();
    queryMock
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => next.promise);
    await mount();
    await testing.act(async () => {
      await vi.advanceTimersByTimeAsync(11000);
    });
    expect(queryMock.mock.calls).toHaveLength(1);
    await testing.act(async () => slow.resolve(result()));
    expect(summaryText()).toContain("9,007,199,254,741,000");
    expect(queryMock.mock.calls).toHaveLength(2);
    await testing.act(async () =>
      next.resolve({
        ...result({}, 2),
        summary: { ...metrics, total_tokens: "123" },
      }),
    );
    expect(summaryText()).toContain("123");
  });

  it("recovers a changed revision with the current filters and reading anchor", async () => {
    await mount();
    await click("Saved model");
    queryMock.mockRejectedValueOnce(
      new backendModule.BackendError("usage_changed", "Usage changed"),
    );
    await click("Next");
    const recovered = lastQuery();
    expect(recovered).toMatchObject({
      model_key: "saved-model",
      limit: 20,
      contributions_only: true,
      cursor: null,
      anchor: record.record_id,
    });
    expect(recovered.dataset_revision).toBeUndefined();
    expect(testing.screen.queryByRole("alert")).toBeNull();
  });

  it("keeps complete record JSON and identity while query revisions update, and recovers detail failures", async () => {
    await mount();
    await click("Saved model");
    await click("2026-10-10 00:00:00 UTC");
    const modal = testing.screen.getByRole("dialog", {
      name: "Request details",
    });
    expect(modal.textContent).toContain("extra_saved_field");
    expect(modal.textContent).toContain("reasoning_tokens");
    expect(modal.textContent).toContain("0.0000001234567890123456789");
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    await click("Copy JSON");
    expect(copy).toHaveBeenCalledWith(detail().usage_json);
    readMock.mockRejectedValue(
      new backendModule.BackendError("timeout", "Detail timeout"),
    );
    queryMock.mockImplementation(async (params: UsageQuery) =>
      result(params, 2),
    );
    await emit("turn.finished");
    await testing.act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 160));
    });
    expect(
      testing.screen.getByRole("dialog", { name: "Request details" }),
    ).toBe(modal);
    expect(modal.textContent).toContain("Detail timeout");
    readMock.mockResolvedValue(detail(2));
    await click("Retry");
    expect(readMock.mock.calls.at(-1)?.[0]).toBe(record.record_id);
    expect(testing.screen.queryByText("Detail timeout")).toBeNull();
  });

  it("separates incomplete UTC editing from adopted filters and permits one empty boundary", async () => {
    await mount();
    const adopted = { ...lastQuery() };
    await click("Custom range");
    const from = testing.screen.getByLabelText(
      "From (UTC)",
    ) as HTMLInputElement;
    const until = testing.screen.getByLabelText(
      "Until (UTC)",
    ) as HTMLInputElement;
    expect(from.min).toBe("0001-01-01T00:00");
    expect(from.max).toBe("9999-12-31T23:59");
    expect(from.step).toBe("60");
    Object.defineProperty(from, "validity", {
      configurable: true,
      value: { valid: false, badInput: true },
    });
    await testing.act(async () => {
      testing.fireEvent.change(from, { target: { value: "" } });
    });
    expect(from.getAttribute("aria-invalid")).toBe("true");
    await click("Refresh");
    expect(lastQuery().start_at).toBe(adopted.start_at);
    delete (from as unknown as { validity?: unknown }).validity;
    await testing.act(async () => {
      testing.fireEvent.change(until, {
        target: { value: "2026-10-11T12:00" },
      });
    });
    expect(lastQuery().start_at).toBeNull();
    expect(lastQuery().end_at).toBe("2026-10-11T12:00:00.000Z");
    await testing.act(async () => {
      testing.fireEvent.change(from, { target: { value: "2026-10-12T00:00" } });
    });
    expect(
      testing.screen.getByText("Until must be later than From."),
    ).toBeTruthy();
    expect(lastQuery().start_at).toBeNull();
    await click("Last 7 days");
    expect(testing.screen.queryByLabelText("From (UTC)")).toBeNull();
    await click("Custom range");
    expect(
      testing.screen.getByLabelText("From (UTC)").getAttribute("aria-invalid"),
    ).toBe("false");
  });

  it("invalidates disconnected reads and old finally callbacks while the new connection is pending", async () => {
    const stale = deferred<UsageResult>();
    const current = deferred<UsageResult>();
    queryMock
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise);
    await mount();
    await emit("connection.closed");
    await emit("connection.restored");
    await testing.act(async () => stale.resolve(result({}, 9)));
    expect(
      testing.screen.queryByRole("region", { name: "Usage totals" }),
    ).toBeNull();
    await click("Refresh");
    expect(queryMock.mock.calls).toHaveLength(2);
    await testing.act(async () => current.resolve(result({}, 2)));
    expect(summaryText()).toContain("9,007,199,254,741,000");
    expect(queryMock.mock.calls).toHaveLength(3);
  });

  it("shows zero and unknown values faithfully and continues index initialization before showing totals", async () => {
    vi.useFakeTimers();
    queryMock.mockResolvedValueOnce({
      ...result(),
      index: { ready: 0, revision: 1 },
    });
    queryMock.mockResolvedValue({
      ...result(),
      summary: {
        ...metrics,
        records: 0,
        input_tokens: "0",
        output_tokens: "0",
        total_tokens: "0",
        requests: "0",
      },
      daily: [],
      groups: { model_key: [], agent_id: [] },
    });
    await mount();
    expect(
      testing.screen.queryByRole("region", { name: "Usage totals" }),
    ).toBeNull();
    await testing.act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(summaryText()).toBe(
      "Total tokens0Input tokens0Output tokens0Requests0",
    );
    expect(usage.formatInteger(null)).toBe("Unavailable");
    expect(usage.shareOf("0", "0")).toBe(0);
    expect(usage.shareOf(null, "1")).toBeNull();
    expect(usage.shareOf("9007199254740993", "18014398509481986")).toBe(50);
  });

  it("combines event hints and releases subscriptions and polling on unmount", async () => {
    vi.useFakeTimers();
    await mount();
    const pending = deferred<UsageResult>();
    queryMock.mockImplementationOnce(() => pending.promise);
    await emit("turn.started");
    await emit("member.updated");
    await emit("organization.changed");
    await testing.act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(queryMock.mock.calls).toHaveLength(2);
    expect(listeners.size).toBe(1);
    testing.cleanup();
    expect(listeners.size).toBe(0);
    await testing.act(async () => pending.resolve(result({}, 2)));
    await testing.act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(queryMock.mock.calls).toHaveLength(2);
    expect(testing.screen.queryByRole("heading")).toBeNull();
  });

  it("shows a slow detail success during repeated revision changes before supplementary data", async () => {
    vi.useFakeTimers();
    await mount();
    await click("Saved model");
    const slow = deferred<UsageDetail>();
    const next = deferred<UsageDetail>();
    readMock
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => next.promise);
    let revision = 1;
    queryMock.mockImplementation(async (params: UsageQuery) =>
      result(params, ++revision),
    );
    await click("2026-10-10 00:00:00 UTC");
    await testing.act(async () => {
      await vi.advanceTimersByTimeAsync(11000);
    });
    expect(readMock.mock.calls).toHaveLength(1);
    await testing.act(async () => slow.resolve(detail(1)));
    const modal = testing.screen.getByRole("dialog", {
      name: "Request details",
    });
    expect(modal.textContent).toContain("extra_saved_field");
    expect(readMock.mock.calls).toHaveLength(2);
    await testing.act(async () => next.resolve(detail(revision)));
    expect(testing.screen.getByRole("dialog")).toBe(modal);
    await click("Close");
    const count = readMock.mock.calls.length;
    await testing.act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(readMock.mock.calls).toHaveLength(count);
  });

  it("opens saved Turn context with the exact deleted member, sequence and request ordinal", async () => {
    const pending = deferred<AgentHistoryRead>();
    const history = vi
      .spyOn(backendModule.backend, "agentHistoryRead")
      .mockReturnValue(pending.promise);
    await mount();
    await click("Saved model");
    await click("2026-10-10 00:00:00 UTC");
    await click("View Turn context");
    expect(
      history.mock.calls[history.mock.calls.length - 1]?.slice(0, 3),
    ).toEqual([2, 4, 1]);
    expect(
      testing.screen.getByRole("dialog", { name: "Turn #4" }),
    ).toBeTruthy();
    expect(
      testing.screen.queryByRole("dialog", { name: "Request details" }),
    ).toBeNull();
  });

  it("uses finite chart coordinates, sparse date gaps and exact original strings", () => {
    const daily = [
      { ...metrics, date: "0001-01-01", total_tokens: "9".repeat(400) },
      { ...metrics, date: "9999-12-31", total_tokens: "0" },
    ];
    const trend = usage.trendPoints(daily);
    expect(trend.points).toHaveLength(3);
    expect(Number.isFinite(trend.points[0].total)).toBe(true);
    expect(trend.points[0].day).toBe(daily[0]);
    expect(trend.points[1].total).toBeNull();
    expect(trend.points[1].day).toBeNull();
    expect(trend.points[2].total).toBe(0);
  });
});
