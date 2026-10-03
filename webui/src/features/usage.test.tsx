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
import { BackendError, backend, type UsageResult } from "@/lib/backend";

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

describe("usage records", () => {
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
    expect(backend.usageQuery).toHaveBeenCalledTimes(1);
  });
});
