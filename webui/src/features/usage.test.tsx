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
import { pageKeyOf, RouterProvider, useRouter } from "@/app/router";
import {
  Backend,
  BackendError,
  backend,
  type Frame,
  type Socket,
  type UsageDetail,
  type UsageResult,
} from "@/lib/backend";

let testing: typeof import("@testing-library/react");
let UsagePage: typeof import("./usage")["UsagePage"];
let usageNumber: typeof import("./usage")["usageNumber"];
let closeDom: () => void;
let TooltipProvider: typeof import("@/components/ui/tooltip")["TooltipProvider"];

function result(total = "1234"): UsageResult {
  const metrics = {
    records: 1,
    input_tokens: total,
    output_tokens: "0",
    total_tokens: total,
    requests: "1",
    input_known: 1,
    output_known: 1,
    total_known: 1,
    requests_known: 1,
    cache_read_tokens: "500",
    cache_write_tokens: "100",
    cache_read_known: 1,
    cache_write_known: 1,
    estimated_cost: "0.0000001234567890123456789",
    cost_known: 1,
    last_active: "2026-10-02T00:00:00+00:00",
    model_count: 1,
  };
  return {
    filters: {},
    dataset_revision: 3,
    index: { ready: 1, revision: 3 },
    summary: metrics,
    coverage: { recorded: 1 },
    groups: {
      agent_id: [{ ...metrics, agent_id: 2 }],
      model_key: [{ ...metrics, model_key: "model-key" }],
    },
    records: [
      {
        record_id: "request:2:1:1",
        source_kind: "request",
        agent_id: 2,
        agent_name: "Researcher",
        agent_name_source: "retained_member",
        agent_deleted: true,
        sequence: 1,
        ordinal: 1,
        request_id: "request-one",
        started_at: "2026-10-02T00:00:00+00:00",
        completed_at: null,
        status: "responded",
        coverage: "recorded",
        model_key: "model-key",
        model: { model_name: "Historical model" },
        model_identity_source: "remote",
        field_source: "saved_response",
        ...metrics,
        cost: null,
        cost_source: "historical_response",
        currency: "USD",
        partial_history: false,
      },
    ],
    has_more: false,
    next_cursor: null,
    previous_cursor: null,
    agents: [{ id: 2, name: "Researcher", deleted: 1 }],
    models: [{ key: "model-key", model: { model_name: "Historical model" } }],
  };
}

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  closeDom = () => dom.window.close();
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    value: vi.fn(),
  });
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "Event",
    "EventTarget",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "getComputedStyle",
  ] as const) {
    vi.stubGlobal(name, name === "window" ? dom.window : dom.window[name]);
  }
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testing = await import("@testing-library/react");
  ({ UsagePage, usageNumber } = await import("./usage"));
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
}, 30000);

beforeEach(() => {
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
  vi.spyOn(backend, "usageQuery").mockResolvedValue(result());
});

afterEach(async () => {
  await testing.act(async () => testing.cleanup());
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

function UsageNavigation() {
  const { route, navigate } = useRouter();
  return (
    <>
      <button
        type="button"
        onClick={() => navigate({ name: "usage", agentId: 2 })}
      >
        Agent 2 usage
      </button>
      <button
        type="button"
        onClick={() => navigate({ name: "usage", agentId: 3 })}
      >
        Agent 3 usage
      </button>
      <button type="button" onClick={() => navigate({ name: "usage" })}>
        All usage
      </button>
      {route.name === "usage" ? (
        <UsagePage key={pageKeyOf(route)} agentId={route.agentId} />
      ) : null}
    </>
  );
}

async function renderPage(agentId?: number) {
  await testing.act(async () =>
    testing.render(
      <RouterProvider>
        <TooltipProvider>
          <UsagePage agentId={agentId} />
        </TooltipProvider>
      </RouterProvider>,
    ),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function detail(total = "1234"): UsageDetail {
  return {
    ...result(total).records[0],
    dataset_revision: 3,
    usage_json: `{"input_tokens":${total},"cache_read_tokens":500}`,
    turn_summary: null,
    turn_summary_json: null,
    summary_mismatch: false,
    traceable_requests: 1,
    provider_field_presence: "unknown",
  };
}

function fakeClock() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
}

describe("usage records", () => {
  it("shows slow polling results and merges updates into one pending read", async () => {
    fakeClock();
    const reads: ReturnType<typeof deferred<UsageResult>>[] = [];
    vi.mocked(backend.usageQuery).mockImplementation(() => {
      const read = deferred<UsageResult>();
      reads.push(read);
      return read.promise;
    });
    await renderPage();
    await testing.act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(reads).toHaveLength(1);
    await testing.act(async () => reads[0].resolve(result()));
    expect(testing.screen.getAllByText("1,234").length).toBeGreaterThan(0);
    expect(reads).toHaveLength(2);
    const listener = vi.mocked(backend.onEvent).mock.calls[0][0];
    for (let index = 0; index < 5; index += 1) {
      await testing.act(async () => {
        listener({ type: "turn.progress", agent_id: 3 });
        await vi.advanceTimersByTimeAsync(200);
      });
    }
    expect(reads).toHaveLength(2);
    await testing.act(async () =>
      reads[1].resolve({ ...result("2345"), dataset_revision: 4 }),
    );
    expect(testing.screen.getAllByText("2,345").length).toBeGreaterThan(0);
    expect(reads).toHaveLength(3);
    await testing.act(async () =>
      reads[2].resolve({ ...result("3456"), dataset_revision: 5 }),
    );
    expect(testing.screen.getAllByText("3,456").length).toBeGreaterThan(0);
    expect(reads).toHaveLength(3);
  });

  it("retains failures and retries the reading target after queued updates", async () => {
    fakeClock();
    const read = deferred<UsageResult>();
    const queued = deferred<UsageResult>();
    vi.mocked(backend.usageQuery)
      .mockReturnValueOnce(read.promise)
      .mockReturnValueOnce(queued.promise);
    await renderPage(2);
    await testing.act(async () => vi.advanceTimersByTimeAsync(6000));
    await testing.act(async () =>
      read.reject(new BackendError("offline", "Read failed")),
    );
    expect(testing.screen.getByRole("alert").textContent).toContain(
      "Read failed",
    );
    expect(backend.usageQuery).toHaveBeenCalledTimes(2);
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Retry" }),
      ),
    );
    expect(backend.usageQuery).toHaveBeenCalledTimes(2);
    expect(backend.usageQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ agent_id: 2 }),
    );
    await testing.act(async () => queued.resolve(result()));
    expect(testing.screen.queryByRole("alert")).toBeNull();
  });

  it("keeps details visible while revisions change during a pending read", async () => {
    fakeClock();
    const reads: ReturnType<typeof deferred<UsageDetail>>[] = [];
    vi.spyOn(backend, "usageRead").mockImplementation(() => {
      const read = deferred<UsageDetail>();
      reads.push(read);
      return read.promise;
    });
    await renderPage();
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Inspect" }),
      ),
    );
    const listener = vi.mocked(backend.onEvent).mock.calls[0][0];
    for (let revision = 4; revision < 8; revision += 1) {
      vi.mocked(backend.usageQuery).mockResolvedValue({
        ...result(),
        dataset_revision: revision,
      });
      await testing.act(async () => {
        listener({ type: "turn.progress", agent_id: 3 });
        await vi.advanceTimersByTimeAsync(200);
      });
    }
    expect(reads).toHaveLength(1);
    await testing.act(async () => reads[0].resolve(detail()));
    const modal = testing.screen.getByRole("dialog");
    expect(modal.textContent).toContain("cache_read_tokens");
    expect(reads).toHaveLength(2);
    await testing.act(async () => reads[1].resolve(detail("2345")));
    expect(testing.within(modal).getAllByText("2,345").length).toBeGreaterThan(
      0,
    );
    expect(reads).toHaveLength(2);
  });

  it("invalidates page and detail reads across connection identities", async () => {
    fakeClock();
    const oldQuery = deferred<UsageResult>();
    const oldDetail = deferred<UsageDetail>();
    vi.spyOn(backend, "usageRead")
      .mockReturnValueOnce(oldDetail.promise)
      .mockResolvedValue(detail("2345"));
    await renderPage();
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Inspect" }),
      ),
    );
    vi.mocked(backend.usageQuery).mockReturnValueOnce(oldQuery.promise);
    await testing.act(async () => vi.advanceTimersByTimeAsync(5000));
    const listeners = vi
      .mocked(backend.onEvent)
      .mock.calls.map(([listener]) => listener);
    await testing.act(async () => {
      for (const listener of listeners)
        listener({ type: "connection.reconnecting" });
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(backend.usageQuery).toHaveBeenCalledTimes(2);
    vi.mocked(backend.usageQuery).mockResolvedValue({
      ...result("2345"),
      dataset_revision: 4,
    });
    await testing.act(async () => {
      for (const listener of listeners)
        listener({ type: "connection.restored" });
    });
    await testing.act(async () => {
      oldQuery.resolve({ ...result("999999"), dataset_revision: 9 });
      oldDetail.resolve(detail("999999"));
    });
    expect(testing.screen.queryByText("999,999")).toBeNull();
    expect(testing.screen.getAllByText("2,345").length).toBeGreaterThan(0);
    expect(testing.screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("cleans pending reads and subscriptions in StrictMode and on unmount", async () => {
    fakeClock();
    const stop = vi.fn();
    vi.mocked(backend.onEvent).mockReturnValue(stop);
    const reads: ReturnType<typeof deferred<UsageResult>>[] = [];
    vi.mocked(backend.usageQuery).mockImplementation(() => {
      const read = deferred<UsageResult>();
      reads.push(read);
      return read.promise;
    });
    const mounted = await testing.act(async () =>
      testing.render(
        <StrictMode>
          <RouterProvider>
            <TooltipProvider>
              <UsagePage />
            </TooltipProvider>
          </RouterProvider>
        </StrictMode>,
      ),
    );
    expect(reads).toHaveLength(1);
    const listeners = vi.mocked(backend.onEvent).mock.calls;
    const listener = listeners[listeners.length - 1][0];
    expect(listener).toBeDefined();
    await testing.act(async () => listener?.({ type: "connection.restored" }));
    expect(reads).toHaveLength(2);
    await testing.act(async () => reads[0].resolve(result("999999")));
    expect(testing.screen.queryByText("999,999")).toBeNull();
    await testing.act(async () => vi.advanceTimersByTimeAsync(6000));
    await testing.act(async () => mounted.unmount());
    await testing.act(async () => reads[1].resolve(result()));
    await testing.act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads).toHaveLength(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("discards a closed record's response and pending revision refresh", async () => {
    fakeClock();
    const oldDetail = deferred<UsageDetail>();
    vi.spyOn(backend, "usageRead")
      .mockReturnValueOnce(oldDetail.promise)
      .mockResolvedValue(detail("2345"));
    await renderPage();
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Inspect" }),
      ),
    );
    vi.mocked(backend.usageQuery).mockResolvedValue({
      ...result(),
      dataset_revision: 4,
    });
    await testing.act(async () => vi.advanceTimersByTimeAsync(5000));
    await testing.act(async () =>
      testing.fireEvent.click(
        testing
          .within(testing.screen.getByRole("dialog"))
          .getAllByRole("button", { name: "Close" })[0],
      ),
    );
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Inspect" }),
      ),
    );
    await testing.act(async () => oldDetail.resolve(detail("999999")));
    const modal = testing.screen.getByRole("dialog");
    expect(testing.within(modal).queryByText("999,999")).toBeNull();
    expect(testing.within(modal).getAllByText("2,345").length).toBeGreaterThan(
      0,
    );
    expect(backend.usageRead).toHaveBeenCalledTimes(2);
  });

  it("keeps filters mounted and announces shared loading until an empty result succeeds", async () => {
    const read = deferred<UsageResult>();
    vi.mocked(backend.usageQuery).mockReturnValueOnce(read.promise);
    await renderPage();
    const region = testing.screen.getByRole("region", {
      name: "Loading usage",
    });
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(testing.within(region).getAllByRole("status")).toHaveLength(1);
    expect(testing.within(region).queryByRole("button")).toBeNull();
    expect(testing.screen.queryByText("No usage records yet")).toBeNull();
    const field = testing.screen.getByLabelText("From UTC");
    field.focus();
    const next = deferred<UsageResult>();
    vi.mocked(backend.usageQuery).mockReturnValueOnce(next.promise);
    await testing.act(async () =>
      testing.fireEvent.change(field, {
        target: { value: "2026-10-01T00:00" },
      }),
    );
    expect(testing.screen.getByLabelText("From UTC")).toBe(field);
    expect(document.activeElement).toBe(field);
    await testing.act(async () => read.resolve(result("999999")));
    expect(testing.screen.queryByText("999,999")).toBeNull();
    const empty = result("0");
    empty.records = [];
    empty.summary = {
      ...empty.summary,
      records: 0,
      requests: "0",
      input_known: 0,
      output_known: 0,
      total_known: 0,
      requests_known: 0,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cache_read_known: 0,
      cache_write_known: 0,
      estimated_cost: null,
      cost_known: 0,
      last_active: null,
      model_count: 0,
    };
    empty.coverage = {};
    empty.groups = { agent_id: [], model_key: [] };
    await testing.act(async () => next.resolve(empty));
    expect(testing.screen.getByText("No matching records")).toBeTruthy();
    expect(
      testing.screen.queryByRole("region", { name: "Loading usage" }),
    ).toBeNull();
  });

  it("preserves a selected detail when the query resource changes identity", async () => {
    vi.spyOn(backend, "usageRead").mockResolvedValue(detail());
    await renderPage();
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Inspect" }),
      ),
    );
    const modal = testing.screen.getByRole("dialog");
    const read = deferred<UsageResult>();
    vi.mocked(backend.usageQuery).mockReturnValueOnce(read.promise);
    await testing.act(async () =>
      testing.fireEvent.change(testing.screen.getByLabelText("From UTC"), {
        target: { value: "2026-10-01T00:00" },
      }),
    );
    expect(testing.screen.getByRole("dialog")).toBe(modal);
    expect(modal.textContent).toContain("cache_read_tokens");
    expect(backend.usageRead).toHaveBeenCalledTimes(1);
    await testing.act(async () => read.resolve(result()));
    expect(testing.screen.getByRole("dialog")).toBe(modal);
    expect(backend.usageRead).toHaveBeenCalledTimes(1);
  });

  it("preserves pagination focus and the request region while loading and refreshing", async () => {
    fakeClock();
    vi.mocked(backend.usageQuery).mockResolvedValueOnce({
      ...result(),
      has_more: true,
      next_cursor: "page-two",
    });
    await renderPage();
    const read = deferred<UsageResult>();
    vi.mocked(backend.usageQuery).mockReturnValueOnce(read.promise);
    const next = testing.screen.getByRole("button", { name: "Next" });
    const table = testing.screen.getByRole("table", {
      name: "Request records",
    });
    next.focus();
    await testing.act(async () => testing.fireEvent.click(next));
    expect(testing.screen.getByRole("button", { name: "Next" })).toBe(next);
    expect(testing.screen.getByRole("table", { name: "Request records" })).toBe(
      table,
    );
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(testing.screen.getByRole("status").textContent).toContain(
      "Next page loading",
    );
    await testing.act(async () => testing.fireEvent.click(next));
    expect(backend.usageQuery).toHaveBeenCalledTimes(2);
    expect(backend.usageQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "page-two", dataset_revision: 3 }),
    );
    const page = result("2345");
    page.records[0].record_id = "request:2:1:2";
    page.previous_cursor = "page-one";
    const records = table.closest("section")?.parentElement;
    if (!records) throw new Error("Request region is missing");
    const scroll = vi.spyOn(records, "scrollIntoView").mockClear();
    await testing.act(async () => read.resolve(page));
    expect(document.activeElement).toBe(next);
    expect(scroll).toHaveBeenCalledWith({
      block: "start",
      behavior: "instant",
    });
    expect(next.getAttribute("aria-disabled")).toBe("true");
    const previous = testing.screen.getByRole("button", { name: "Previous" });
    previous.focus();
    vi.mocked(backend.usageQuery).mockResolvedValueOnce({
      ...result(),
      has_more: true,
      next_cursor: "page-two",
    });
    await testing.act(async () => testing.fireEvent.click(previous));
    expect(document.activeElement).toBe(previous);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(testing.screen.getByRole("table", { name: "Request records" })).toBe(
      table,
    );
    next.focus();
    vi.mocked(backend.usageQuery).mockResolvedValueOnce(page);
    await testing.act(async () => testing.fireEvent.click(next));
    vi.mocked(backend.usageQuery).mockResolvedValue({
      ...page,
      dataset_revision: 4,
    });
    await testing.act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(backend.usageQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: null, anchor: "request:2:1:2" }),
    );
  });

  it.each(["Next", "Previous", "Page size"])(
    "keeps %s mounted across failure and Retry",
    async (label) => {
      fakeClock();
      vi.mocked(backend.usageQuery).mockResolvedValueOnce({
        ...result(),
        has_more: true,
        next_cursor: "page-two",
        previous_cursor: "page-zero",
      });
      await renderPage();
      const size = testing.screen.getByRole(
        label === "Page size" ? "combobox" : "button",
        { name: label },
      );
      const params =
        label === "Page size"
          ? { limit: 50, cursor: null }
          : { limit: 20, cursor: label === "Next" ? "page-two" : "page-zero" };
      const target = label === "Page size" ? label : `${label} page`;
      const table = testing.screen.getByRole("table", {
        name: "Request records",
      });
      const read = deferred<UsageResult>();
      vi.mocked(backend.usageQuery).mockReturnValueOnce(read.promise);
      size.focus();
      const operate = () =>
        label === "Page size"
          ? testing.fireEvent.change(size, { target: { value: "50" } })
          : testing.fireEvent.click(size);
      await testing.act(async () => operate());
      expect(document.activeElement).toBe(size);
      expect(
        testing.screen.getByRole(
          label === "Page size" ? "combobox" : "button",
          { name: label },
        ),
      ).toBe(size);
      expect(backend.usageQuery).toHaveBeenLastCalledWith(
        expect.objectContaining(params),
      );
      await testing.act(async () => operate());
      expect(backend.usageQuery).toHaveBeenCalledTimes(2);
      await testing.act(async () =>
        read.reject(
          new BackendError(
            "timeout",
            "Request timed out. Try reading again.",
            true,
            "usage.query",
          ),
        ),
      );
      const retry = testing.screen.getByRole("button", { name: "Retry" });
      expect(table.closest("section")?.contains(retry)).toBe(true);
      expect(testing.screen.getByRole("status").textContent).toContain(
        `${target} unavailable`,
      );
      const recovered = deferred<UsageResult>();
      vi.mocked(backend.usageQuery).mockReturnValueOnce(recovered.promise);
      retry.focus();
      await testing.act(async () => testing.fireEvent.click(retry));
      expect(document.activeElement).toBe(size);
      expect(backend.usageQuery).toHaveBeenLastCalledWith(
        expect.objectContaining(params),
      );
      await testing.act(async () => recovered.resolve(result("2345")));
      expect(document.activeElement).toBe(size);
      expect(testing.screen.queryByRole("alert")).toBeNull();
      expect(
        testing.screen.getByRole("table", { name: "Request records" }),
      ).toBe(table);
    },
  );

  it("leaves the chosen focus and scroll position after a pending page completes", async () => {
    vi.mocked(backend.usageQuery).mockResolvedValueOnce({
      ...result(),
      has_more: true,
      next_cursor: "page-two",
    });
    await renderPage();
    const table = testing.screen.getByRole("table", {
      name: "Request records",
    });
    const records = table.closest("section")?.parentElement;
    if (!records) throw new Error("Request region is missing");
    const scroll = vi.spyOn(records, "scrollIntoView").mockClear();
    const next = testing.screen.getByRole("button", { name: "Next" });
    const read = deferred<UsageResult>();
    vi.mocked(backend.usageQuery).mockReturnValueOnce(read.promise);
    next.focus();
    await testing.act(async () => testing.fireEvent.click(next));
    const filter = testing.screen.getByLabelText("From UTC");
    filter.focus();
    await testing.act(async () => read.resolve(result("2345")));
    expect(document.activeElement).toBe(filter);
    expect(scroll).not.toHaveBeenCalled();
    const stale = deferred<UsageResult>();
    vi.mocked(backend.usageQuery).mockResolvedValueOnce({
      ...result(),
      has_more: true,
      next_cursor: "page-three",
    });
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Refresh" }),
      ),
    );
    vi.mocked(backend.usageQuery).mockReturnValueOnce(stale.promise);
    next.focus();
    await testing.act(async () => testing.fireEvent.click(next));
    filter.focus();
    await testing.act(async () =>
      testing.fireEvent.change(filter, {
        target: { value: "2026-10-01T00:00" },
      }),
    );
    await testing.act(async () => stale.resolve(result("999999")));
    expect(document.activeElement).toBe(filter);
    expect(testing.screen.queryByText("999,999")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("keeps an opened detail focused and discards a page after unmount", async () => {
    fakeClock();
    const first = { ...result(), has_more: true, next_cursor: "page-two" };
    vi.mocked(backend.usageQuery).mockResolvedValueOnce(first);
    vi.spyOn(backend, "usageRead").mockResolvedValue(detail());
    await renderPage();
    const table = testing.screen.getByRole("table", {
      name: "Request records",
    });
    const records = table.closest("section")?.parentElement;
    if (!records) throw new Error("Request region is missing");
    const scroll = vi.spyOn(records, "scrollIntoView").mockClear();
    const page = deferred<UsageResult>();
    vi.mocked(backend.usageQuery).mockReturnValueOnce(page.promise);
    const next = testing.screen.getByRole("button", { name: "Next" });
    next.focus();
    await testing.act(async () => testing.fireEvent.click(next));
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Inspect" }),
      ),
    );
    const modal = testing.screen.getByRole("dialog");
    const copy = testing
      .within(modal)
      .getByRole("button", { name: "Copy JSON" });
    copy.focus();
    await testing.act(async () =>
      page.resolve({ ...first, next_cursor: "page-three" }),
    );
    expect(testing.screen.getByRole("dialog")).toBe(modal);
    expect(document.activeElement).toBe(copy);
    expect(scroll).not.toHaveBeenCalled();
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.within(modal).getAllByRole("button", { name: "Close" })[0],
      ),
    );
    const stale = deferred<UsageResult>();
    vi.mocked(backend.usageQuery).mockReturnValueOnce(stale.promise);
    next.focus();
    await testing.act(async () => testing.fireEvent.click(next));
    await testing.act(async () => testing.cleanup());
    await testing.act(async () => stale.resolve(result("999999")));
    await testing.act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(scroll).not.toHaveBeenCalled();
    expect(backend.usageQuery).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["usage.query", "timeout"],
    ["usage.read", "timeout"],
    ["usage.query", "disconnected"],
    ["usage.read", "disconnected"],
  ])(
    "recovers %s after Backend %s through regional Retry",
    async (method, code) => {
      fakeClock();
      const sent: { id: number; method: string }[] = [];
      const socket: Socket = {
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close: vi.fn(),
        send: (data) => {
          const frame = JSON.parse(data);
          sent.push(frame);
          if (frame.method !== method)
            socket.onmessage?.(
              new window.MessageEvent("message", {
                data: JSON.stringify({
                  type: "response",
                  id: frame.id,
                  result: result(),
                }),
              }),
            );
        },
      };
      const transport = new Backend(
        () => ({ url: "ws://localhost/ws?token=test" }),
        () => socket,
      );
      const connecting = transport.connect();
      socket.onopen?.(new Event("open"));
      await connecting;
      vi.mocked(backend.usageQuery).mockImplementation(
        transport.usageQuery.bind(transport),
      );
      vi.spyOn(backend, "usageRead").mockImplementation(
        transport.usageRead.bind(transport),
      );
      vi.mocked(backend.onEvent).mockImplementation(
        transport.onEvent.bind(transport),
      );
      vi.spyOn(backend, "disconnected", "get").mockImplementation(
        () => transport.disconnected,
      );
      vi.spyOn(backend, "reconnect").mockImplementation(async () => {
        const reconnecting = transport.reconnect();
        socket.onopen?.(new Event("open"));
        await reconnecting;
      });
      const failures = vi.fn();
      transport.onFailure(failures);
      await renderPage();
      if (method === "usage.read")
        await testing.act(async () =>
          testing.fireEvent.click(
            testing.screen.getByRole("button", { name: "Inspect" }),
          ),
        );
      await testing.act(async () => {
        if (code === "timeout") await vi.advanceTimersByTimeAsync(60000);
        else socket.onclose?.(new window.CloseEvent("close"));
      });
      const region =
        method === "usage.read"
          ? testing.within(testing.screen.getByRole("dialog"))
          : testing.screen;
      expect(region.getByRole("alert").textContent).toContain(
        code === "timeout"
          ? "Request timed out. Try reading again."
          : "Connection lost. Reconnect to continue.",
      );
      expect(failures.mock.calls.length).toBeGreaterThan(0);
      expect(failures.mock.calls.every(([error]) => error.code === code)).toBe(
        true,
      );
      if (code === "timeout")
        expect(failures.mock.calls[0][0].operation).toBe(method);
      const retry = region.getByRole("button", { name: "Retry" });
      retry.focus();
      await testing.act(async () => testing.fireEvent.click(retry));
      const requests = sent.filter((frame) => frame.method === method);
      const reply = (frame: Frame) =>
        socket.onmessage?.(
          new window.MessageEvent("message", { data: JSON.stringify(frame) }),
        );
      await testing.act(async () => {
        reply({
          type: "response",
          id: requests[0].id,
          result: method === "usage.read" ? detail("999999") : result("999999"),
        });
        reply({
          type: "response",
          id: requests[requests.length - 1].id,
          result: method === "usage.read" ? detail("2345") : result("2345"),
        });
      });
      expect(region.queryByRole("alert")).toBeNull();
      expect(region.queryByText("999,999")).toBeNull();
      expect(region.getAllByText("2,345").length).toBeGreaterThan(0);
      expect(transport.disconnected).toBe(false);
    },
  );

  it("retains connection errors across filter identities and retries through Backend reconnect", async () => {
    await renderPage();
    const listeners = vi.mocked(backend.onEvent).mock.calls;
    const listener = listeners[listeners.length - 1][0];
    await testing.act(async () =>
      listener?.({
        type: "connection.closed",
        error: new BackendError("disconnected", "Transport closed", true),
      }),
    );
    expect(testing.screen.getByRole("alert").textContent).toContain(
      "Transport closed",
    );
    await testing.act(async () =>
      testing.fireEvent.change(testing.screen.getByLabelText("From UTC"), {
        target: { value: "2026-10-01T00:00" },
      }),
    );
    expect(backend.usageQuery).toHaveBeenCalledTimes(1);
    expect(testing.screen.getByRole("alert").textContent).toContain(
      "Transport closed",
    );
    const reconnect = vi
      .spyOn(backend, "reconnect")
      .mockImplementation(async () => {
        const listeners = vi.mocked(backend.onEvent).mock.calls;
        listeners[listeners.length - 1][0]({ type: "connection.restored" });
      });
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Retry" }),
      ),
    );
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(backend.usageQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ start_at: "2026-10-01T00:00:00+00:00" }),
    );
    expect(testing.screen.queryByRole("alert")).toBeNull();
  });

  it("retains successful details after a refresh timeout and retries independently", async () => {
    fakeClock();
    const read = vi.spyOn(backend, "usageRead").mockResolvedValue(detail());
    const reconnect = vi.spyOn(backend, "reconnect");
    await renderPage();
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Inspect" }),
      ),
    );
    read.mockRejectedValueOnce(
      new BackendError(
        "timeout",
        "Request timed out. Try reading again.",
        true,
        "usage.read",
      ),
    );
    vi.mocked(backend.usageQuery).mockResolvedValue({
      ...result(),
      dataset_revision: 4,
    });
    await testing.act(async () => vi.advanceTimersByTimeAsync(5000));
    const modal = testing.screen.getByRole("dialog");
    expect(testing.within(modal).getByRole("alert").textContent).toContain(
      "Request timed out. Try reading again.",
    );
    expect(modal.textContent).toContain("cache_read_tokens");
    read.mockResolvedValue(detail("2345"));
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.within(modal).getByRole("button", { name: "Retry" }),
      ),
    );
    expect(testing.within(modal).queryByRole("alert")).toBeNull();
    expect(testing.within(modal).getAllByText("2,345").length).toBeGreaterThan(
      0,
    );
    expect(backend.usageQuery).toHaveBeenCalledTimes(2);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("rechecks an unfinished index and refreshes an identical filter target", async () => {
    fakeClock();
    vi.mocked(backend.usageQuery).mockResolvedValueOnce({
      ...result(),
      index: { ready: 0, revision: 3 },
    });
    await renderPage();
    vi.mocked(backend.usageQuery).mockResolvedValue({
      ...result("2345"),
      dataset_revision: 4,
    });
    await testing.act(async () => vi.advanceTimersByTimeAsync(100));
    expect(testing.screen.getAllByText("2,345").length).toBeGreaterThan(0);
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Clear Filters" }),
      ),
    );
    expect(testing.screen.getAllByText("2,345").length).toBeGreaterThan(0);
    expect(backend.usageQuery).toHaveBeenCalledTimes(3);
  });

  it("keeps exact integers beyond Number precision and distinguishes missing values", () => {
    expect(usageNumber("9007199254740993")).toBe("9,007,199,254,740,993");
    expect(usageNumber("0")).toBe("0");
    expect(usageNumber(null)).toBe("Unavailable");
  });

  it("opens the Agent range and applies model selection to the complete query", async () => {
    await renderPage(2);
    expect(backend.usageQuery).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: 2 }),
    );
    expect(testing.screen.getAllByText("Total tokens").length).toBeGreaterThan(
      0,
    );
    const group = testing.screen.getByRole("table", { name: "Usage by model" });
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.within(group).getByRole("button", { name: "View Requests" }),
      ),
    );
    expect(backend.usageQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ agent_id: 2, model_key: "model-key" }),
    );
  });

  it("rejects late responses after changing filters", async () => {
    let finish: (value: UsageResult) => void = () => {};
    vi.mocked(backend.usageQuery).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await renderPage();
    await testing.act(async () =>
      testing.fireEvent.change(testing.screen.getByLabelText("From UTC"), {
        target: { value: "2026-10-01T00:00" },
      }),
    );
    await testing.act(async () => finish(result("999999")));
    expect(testing.screen.queryByText("999,999")).toBeNull();
    expect(testing.screen.getAllByText("1,234").length).toBeGreaterThan(0);
  });

  it("preserves filters after failure and retries", async () => {
    vi.mocked(backend.usageQuery).mockRejectedValueOnce(
      new BackendError("offline", "Disconnected"),
    );
    await renderPage(2);
    expect(testing.screen.getByRole("alert").textContent).toContain(
      "Disconnected",
    );
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Retry" }),
      ),
    );
    expect(backend.usageQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ agent_id: 2 }),
    );
    expect(testing.screen.queryByRole("alert")).toBeNull();
  });

  it("recovers a changed page using the current reading anchor", async () => {
    vi.mocked(backend.usageQuery).mockResolvedValueOnce({
      ...result(),
      has_more: true,
      next_cursor: "page-two",
    });
    await renderPage();
    vi.mocked(backend.usageQuery).mockRejectedValueOnce(
      new BackendError("usage_changed", "Changed"),
    );
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Next" }),
      ),
    );
    expect(backend.usageQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ anchor: "request:2:1:1" }),
    );
  });

  it("shows each grouped field's recorded range for incomplete usage", async () => {
    const data = result("0");
    const metrics = {
      ...data.summary,
      records: 2,
      input_tokens: "7",
      requests: "2",
      input_known: 2,
      output_known: 1,
      total_known: 1,
      requests_known: 2,
    };
    vi.mocked(backend.usageQuery).mockResolvedValue({
      ...data,
      summary: metrics,
      coverage: { recorded: 1, field_missing: 1 },
      groups: {
        model_key: [{ ...metrics, model_key: "model-key" }],
        agent_id: [{ ...metrics, agent_id: 2 }],
      },
      records: [
        data.records[0],
        {
          ...data.records[0],
          record_id: "request:2:1:2",
          ordinal: 2,
          input_tokens: "7",
          output_tokens: null,
          total_tokens: null,
          coverage: "field_missing",
        },
      ],
    });
    await renderPage();
    const group = testing.screen.getByRole("table", { name: "Usage by model" });
    const row = testing.within(group).getAllByRole("row")[1];
    const cells = testing.within(row).getAllByRole("cell");
    expect(cells[1].textContent).toBe("7");
    expect(cells[2].textContent).toContain("1 of 2 records");
    expect(cells[3].textContent).toContain("1 of 2 records");
    expect(testing.screen.getByText(/For each complete record/)).toBeTruthy();
  });

  it("refreshes the complete range after persisted Turn events and reconnects", async () => {
    await renderPage();
    const listener = vi.mocked(backend.onEvent).mock.calls[0][0];
    vi.mocked(backend.usageQuery).mockResolvedValue({
      ...result("2345"),
      dataset_revision: 4,
    });
    await testing.act(async () => {
      listener({ type: "turn.progress", agent_id: 2 });
      listener({ type: "turn.finished", agent_id: 2 });
      await new Promise((resolve) => setTimeout(resolve, 175));
    });
    expect(backend.usageQuery).toHaveBeenCalledTimes(2);
    expect(testing.screen.getAllByText("2,345").length).toBeGreaterThan(0);
    await testing.act(async () => {
      listener({ type: "connection.restored" });
      await new Promise((resolve) => setTimeout(resolve, 175));
    });
    expect(backend.usageQuery).toHaveBeenCalledTimes(3);
  });

  it("applies each Router Agent identity to usageQuery and retains identical routes", async () => {
    await testing.act(async () =>
      testing.render(
        <RouterProvider>
          <TooltipProvider>
            <UsageNavigation />
          </TooltipProvider>
        </RouterProvider>,
      ),
    );
    for (const [label, agent_id] of [
      ["Agent 2 usage", 2],
      ["Agent 3 usage", 3],
      ["All usage", undefined],
    ] as const) {
      await testing.act(async () =>
        testing.fireEvent.click(
          testing.screen.getByRole("button", { name: label }),
        ),
      );
      expect(backend.usageQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({ agent_id }),
      );
      const calls = vi.mocked(backend.usageQuery).mock.calls.length;
      await testing.act(async () =>
        testing.fireEvent.click(
          testing.screen.getByRole("button", { name: label }),
        ),
      );
      expect(backend.usageQuery).toHaveBeenCalledTimes(calls);
    }
  });

  it("recovers the selected detail independently and displays all saved fields", async () => {
    const read = vi
      .spyOn(backend, "usageRead")
      .mockRejectedValueOnce(new BackendError("offline", "Detail unavailable"));
    read.mockResolvedValue({
      ...result().records[0],
      dataset_revision: 3,
      usage_json:
        '{"input_tokens":1234,"output_tokens":0,"output_reasoning_tokens":0,"details":{"long_extra_field":7}}',
      turn_summary: null,
      turn_summary_json: null,
      summary_mismatch: false,
      traceable_requests: 1,
      provider_field_presence: "unknown",
    });
    await renderPage();
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Inspect" }),
      ),
    );
    const modal = testing.screen.getByRole("dialog");
    expect(testing.within(modal).getByRole("alert").textContent).toContain(
      "Detail unavailable",
    );
    await testing.act(async () =>
      testing.fireEvent.click(
        testing.within(modal).getByRole("button", { name: "Retry" }),
      ),
    );
    expect(modal.textContent).toContain("output_reasoning_tokens");
    expect(modal.textContent).toContain("long_extra_field");
    expect(modal.textContent).toContain("retained member record");
    expect(modal.textContent).toContain("Deleted");
    expect(backend.usageQuery).toHaveBeenCalledTimes(1);
  });
});
