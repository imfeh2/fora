import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  type AgentHistoryRead,
  BackendError,
  type BackendEvent,
  backend,
  type HistoryBinary,
  type HistoryImage,
  type HistoryMessages,
  type HistoryText,
  type LivePage,
} from "@/lib/backend";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

const listeners = new Set<(event: BackendEvent) => void>();
let act: typeof import("@testing-library/react").act;
let cleanup: typeof import("@testing-library/react").cleanup;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let screen: typeof import("@testing-library/react").screen;
let waitFor: typeof import("@testing-library/react").waitFor;
let closeDom: () => void;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let LiveTools: typeof import("@/features/members/detail").LiveTools;
let TurnHistoryModal: typeof import("@/features/members/detail").TurnHistoryModal;

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  closeDom = () => dom.window.close();
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("NodeFilter", dom.window.NodeFilter);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("EventTarget", dom.window.EventTarget);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal("AbortController", dom.window.AbortController);
  vi.stubGlobal("AbortSignal", dom.window.AbortSignal);
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
  dom.window.requestAnimationFrame = vi.fn();
  dom.window.cancelAnimationFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", dom.window.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", dom.window.cancelAnimationFrame);
  const tooltip = await import("@/components/ui/tooltip");
  TooltipProvider = tooltip.TooltipProvider;
  const detail = await import("@/features/members/detail");
  LiveTools = detail.LiveTools;
  TurnHistoryModal = detail.TurnHistoryModal;
  const testing = await import("@testing-library/react");
  act = testing.act;
  cleanup = testing.cleanup;
  fireEvent = testing.fireEvent;
  render = testing.render;
  screen = testing.screen;
  waitFor = testing.waitFor;
}, 30000);

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  vi.spyOn(backend, "disconnected", "get").mockReturnValue(false);
  vi.spyOn(backend, "agentLive").mockResolvedValue({
    runtime_epoch: "epoch",
    turn: null,
  });
});

afterEach(() => {
  cleanup();
  expect(listeners.size).toBe(0);
  vi.restoreAllMocks();
});

async function emit(event: BackendEvent) {
  await act(async () => {
    for (const listener of listeners) listener(event);
  });
}

function textReference(
  version = "v1",
  epoch = "epoch",
  saved = false,
): HistoryText {
  return {
    kind: "text",
    source: saved ? "response" : "live",
    request_ordinal: 1,
    message_index: 0,
    path: ["parts", 0, "content"],
    ...(saved
      ? {}
      : {
          runtime_epoch: epoch,
          part_index: 0,
          content_source: "response" as const,
          content_version: version,
        }),
    offset: 0,
    next_offset: 2,
    total_bytes: 4,
    value: "AA",
    has_more: true,
  };
}

function imageReference(
  version = "v1",
  epoch = "epoch",
  saved = false,
): HistoryBinary {
  return {
    kind: "binary",
    source: saved ? "response" : "live",
    request_ordinal: 1,
    message_index: 0,
    path: ["parts", 1, "content"],
    ...(saved
      ? {}
      : {
          runtime_epoch: epoch,
          part_index: 0,
          content_source: "response" as const,
          content_version: version,
        }),
    media_type: "image/png",
    size: 3,
    identifier: "same-image-name",
  };
}

function historyPage({
  version = "v1",
  epoch = "epoch",
  saved = false,
  image = false,
} = {}): AgentHistoryRead {
  const field = (source: HistoryText["source"]): HistoryText => ({
    ...textReference(),
    source,
    runtime_epoch: undefined,
    part_index: undefined,
    content_source: undefined,
    content_version: undefined,
    value: "{}",
    total_bytes: 2,
    has_more: false,
  });
  const empty = { messages: [], offset: 0, total: 0, has_more: false };
  const summary = {
    ordinal: 1,
    request_id: "request-1",
    run_id: "run-4",
    window_number: 1,
    status: "pending",
    started_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    streaming: false,
    input_length: 0,
    parameters_length: 2,
    settings_length: 2,
    model_length: 2,
    response_length: 4,
    input_count: 0,
    response_count: 1,
    related_count: 0,
    error: null,
  };
  return {
    agent_id: 2,
    run: {
      sequence: 4,
      run_id: "run-4",
      status: "running",
      started_at: summary.started_at,
      completed_at: null,
      last_saved_at: null,
      window_number: 1,
      window_reset_at: null,
      window_reason: null,
      request_count: 1,
      usage: null,
      error: null,
      legacy: false,
    },
    windows: [],
    windows_has_more: false,
    windows_next_after: null,
    requests: [summary],
    requests_has_more: false,
    requests_next_after: null,
    messages: empty,
    missing: [],
    request: {
      summary,
      input: empty,
      related: empty,
      parameters: field("parameters"),
      settings: field("settings"),
      model: field("model"),
      response_saved: saved,
      response: {
        offset: 0,
        total: 1,
        has_more: false,
        saved,
        messages: [
          {
            kind: "response",
            parts: [
              {
                part_kind: "text",
                content: textReference(version, epoch, saved),
              },
              ...(image ? [imageReference(version, epoch, saved)] : []),
            ],
          },
        ],
      },
    },
  };
}

function openHistory(inline = false) {
  return render(
    <TooltipProvider>
      <TurnHistoryModal
        agentId={2}
        sequence={4}
        open
        inline={inline}
        onOpenChange={() => {}}
      />
    </TooltipProvider>,
  );
}

const tail = (value: string) => ({
  offset: 2,
  next_offset: 4,
  total_bytes: 4,
  value,
  has_more: false,
});

const imageData = (data: string): HistoryImage => ({
  media_type: "image/png",
  size: 3,
  identifier: "same-image-name",
  data,
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "isolates same-prefix text versions with inline=%s and lateFailure=%s",
  async (inline, lateFailure) => {
    let version = "v1";
    const history = vi
      .spyOn(backend, "agentHistoryRead")
      .mockImplementation(async () => historyPage({ version }));
    const oldRead = deferred<ReturnType<typeof tail>>();
    const currentRead = deferred<ReturnType<typeof tail>>();
    const text = vi
      .spyOn(backend, "agentHistoryText")
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(currentRead.promise);
    openHistory(inline);
    fireEvent.click(
      await screen.findByRole("button", { name: "Load more text" }),
    );
    expect(text.mock.calls[0][2]).toMatchObject({
      ...textReference(),
      offset: 2,
    });
    version = "v2";
    await emit({ type: "turn.progress", agent_id: 2, sequence: 4 });
    expect(history).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Load more text" }));
    expect(text.mock.calls[1][2].content_version).toBe("v2");
    await act(async () => {
      if (lateFailure)
        oldRead.reject(new BackendError("stale", "old text failure"));
      else oldRead.resolve(tail("V1"));
    });
    expect(screen.queryByText("AAV1")).toBeNull();
    expect(screen.queryByText("old text failure")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Load more text" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(text).toHaveBeenCalledTimes(2);
    await act(async () => currentRead.resolve(tail("V2")));
    expect(screen.getByText("AAV2")).toBeTruthy();
  },
);

it("replaces loaded same-prefix text and retries the current version", async () => {
  let version = "v1";
  vi.spyOn(backend, "agentHistoryRead").mockImplementation(async () =>
    historyPage({ version }),
  );
  const text = vi
    .spyOn(backend, "agentHistoryText")
    .mockResolvedValueOnce(tail("V1"))
    .mockRejectedValueOnce(
      new BackendError("text_unavailable", "current text failure"),
    )
    .mockResolvedValueOnce(tail("V2"));
  openHistory();
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more text" }),
  );
  await screen.findByText("AAV1");
  await emit({ type: "turn.progress", agent_id: 2, sequence: 4 });
  expect(screen.getByText("AAV1")).toBeTruthy();
  expect(text).toHaveBeenCalledTimes(1);
  version = "v2";
  await emit({ type: "turn.progress", agent_id: 2, sequence: 4 });
  expect(screen.queryByText("AAV1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more text" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByText("AAV2");
  expect(
    text.mock.calls.slice(1).map((call) => call[2].content_version),
  ).toEqual(["v2", "v2"]);
  expect(screen.queryByText("current text failure")).toBeNull();
});

it.each([false, true])(
  "isolates pending images and current Retry with lateFailure=%s",
  async (lateFailure) => {
    let version = "v1";
    vi.spyOn(backend, "agentHistoryRead").mockImplementation(async () =>
      historyPage({ version, image: true }),
    );
    const oldRead = deferred<HistoryImage>();
    const currentRead = deferred<HistoryImage>();
    const retryRead = deferred<HistoryImage>();
    const image = vi
      .spyOn(backend, "agentHistoryImage")
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(currentRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    openHistory();
    await waitFor(() => expect(image).toHaveBeenCalledTimes(1));
    version = "v2";
    await emit({ type: "turn.progress", agent_id: 2, sequence: 4 });
    expect(image).toHaveBeenCalledTimes(2);
    expect(image.mock.calls[1][2]).toEqual(imageReference("v2"));
    await act(async () => {
      if (lateFailure)
        oldRead.reject(new BackendError("stale", "old image failure"));
      else oldRead.resolve(imageData("old-image"));
    });
    expect(screen.queryByAltText("Saved model content")).toBeNull();
    expect(screen.queryByText(/old image failure/)).toBeNull();
    await act(async () =>
      currentRead.reject(
        new BackendError("image_unavailable", "current image failure"),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry image" }));
    expect(image.mock.calls[2][2].content_version).toBe("v2");
    expect(
      screen
        .getByRole("button", { name: "Retry image" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => retryRead.resolve(imageData("current-image")));
    expect(screen.getByAltText("Saved model content").getAttribute("src")).toBe(
      "data:image/png;base64,current-image",
    );
  },
);

it("clears loaded temporary images and zoom when their version changes", async () => {
  let version = "v1";
  vi.spyOn(backend, "agentHistoryRead").mockImplementation(async () =>
    historyPage({ version, image: true }),
  );
  const next = deferred<HistoryImage>();
  const image = vi
    .spyOn(backend, "agentHistoryImage")
    .mockResolvedValueOnce(imageData("first-image"))
    .mockReturnValueOnce(next.promise);
  openHistory();
  await screen.findByAltText("Saved model content");
  fireEvent.click(screen.getByRole("button", { name: "Open history image" }));
  expect(screen.getByRole("dialog", { name: "History image" })).toBeTruthy();
  version = "v2";
  await emit({ type: "turn.progress", agent_id: 2, sequence: 4 });
  expect(screen.queryByAltText("Saved model content")).toBeNull();
  expect(screen.queryByRole("dialog", { name: "History image" })).toBeNull();
  expect(image.mock.calls[1][2].content_version).toBe("v2");
  await act(async () => next.resolve(imageData("second-image")));
  expect(
    screen.getByAltText("Saved model content").getAttribute("src"),
  ).toContain("second-image");
});

it("isolates temporary text and image reads through persistence and preserves saved pagination", async () => {
  let saved = false;
  vi.spyOn(backend, "agentHistoryRead").mockImplementation(async () =>
    historyPage({ saved, image: true }),
  );
  const oldText = deferred<ReturnType<typeof tail>>();
  const oldImage = deferred<HistoryImage>();
  const text = vi
    .spyOn(backend, "agentHistoryText")
    .mockReturnValueOnce(oldText.promise)
    .mockResolvedValue(tail("DB"));
  const image = vi
    .spyOn(backend, "agentHistoryImage")
    .mockReturnValueOnce(oldImage.promise)
    .mockResolvedValue(imageData("saved-image"));
  openHistory();
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more text" }),
  );
  saved = true;
  await emit({ type: "turn.progress", agent_id: 2, sequence: 4 });
  fireEvent.click(screen.getByRole("button", { name: "Load more text" }));
  await screen.findByText("AADB");
  expect(text.mock.calls[1][2].source).toBe("response");
  expect(image.mock.calls[1][2].source).toBe("response");
  await act(async () => {
    oldText.resolve(tail("V1"));
    oldImage.resolve(imageData("old-image"));
  });
  expect(screen.queryByText("AAV1")).toBeNull();
  expect(
    screen.getByAltText("Saved model content").getAttribute("src"),
  ).toContain("saved-image");
  await emit({ type: "turn.progress", agent_id: 2, sequence: 4 });
  expect(screen.getByText("AADB")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more text" })).toBeNull();
  expect(text).toHaveBeenCalledTimes(2);
  expect(image).toHaveBeenCalledTimes(2);
});

it.each(["epoch", "new-epoch"])(
  "isolates Full context reads across reconnection into %s",
  async (nextEpoch) => {
    let epoch = "epoch";
    let version = "v1";
    vi.spyOn(backend, "agentHistoryRead").mockImplementation(async () =>
      historyPage({ epoch, version, image: true }),
    );
    const oldText = deferred<ReturnType<typeof tail>>();
    const oldImage = deferred<HistoryImage>();
    const text = vi
      .spyOn(backend, "agentHistoryText")
      .mockReturnValueOnce(oldText.promise)
      .mockResolvedValue(tail("V2"));
    const image = vi
      .spyOn(backend, "agentHistoryImage")
      .mockReturnValueOnce(oldImage.promise)
      .mockResolvedValue(imageData("new-image"));
    openHistory();
    fireEvent.click(
      await screen.findByRole("button", { name: "Load more text" }),
    );
    await emit({ type: "connection.closed" });
    epoch = nextEpoch;
    version = "v2";
    await emit({ type: "connection.restored" });
    const currentButton = await screen.findByRole("button", {
      name: "Load more text",
    });
    fireEvent.click(currentButton);
    await screen.findByText("AAV2");
    expect(text.mock.lastCall?.[2]).toMatchObject({
      runtime_epoch: nextEpoch,
      content_version: "v2",
    });
    expect(image.mock.lastCall?.[2]).toMatchObject({
      runtime_epoch: nextEpoch,
      content_version: "v2",
    });
    await act(async () => {
      oldText.resolve(tail("V1"));
      oldImage.reject(new BackendError("stale", "old epoch image failure"));
    });
    expect(screen.getByText("AAV2")).toBeTruthy();
    expect(screen.queryByText(/old epoch image failure/)).toBeNull();
    expect(
      screen.getByAltText("Saved model content").getAttribute("src"),
    ).toContain("new-image");
  },
);

function livePage(version: string, source: "tool" | "response"): LivePage {
  return {
    runtime_epoch: "epoch",
    turn: {
      agent_id: 2,
      sequence: 4,
      run_id: "run-4",
      live_revision: version === "v1" ? 1 : 2,
      status: "unsaved",
      error: null,
      has_more: false,
      next_after: null,
      requests: [
        {
          ordinal: 1,
          request_id: "request-1",
          started_at: "2026-01-01T00:00:00Z",
          has_response: source === "response",
          response_saved: false,
          response_version: version,
          tools_has_more: false,
          tools_next_after: null,
          tools:
            source === "response"
              ? []
              : [
                  {
                    part_index: 0,
                    tool_call_id: "call-1",
                    tool_name: "read",
                    status: "completed",
                    started_at: null,
                    completed_at: null,
                    saved: false,
                    has_result: true,
                    content_version: version,
                  },
                ],
        },
      ],
    },
  };
}

const contentPage = (content: string): HistoryMessages => ({
  messages: [{ content }],
  offset: 0,
  total: 1,
  has_more: false,
});

it.each([
  ["response", false],
  ["response", true],
  ["tool", false],
  ["tool", true],
] as const)(
  "binds LiveContent %s reads to versions with lateFailure=%s",
  async (source, lateFailure) => {
    let version = "v1";
    vi.mocked(backend.agentLive).mockImplementation(async () =>
      livePage(version, source),
    );
    const oldRead = deferred<HistoryMessages>();
    const currentRead = deferred<HistoryMessages>();
    const read = vi
      .spyOn(backend, "agentLiveRead")
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(currentRead.promise);
    render(<LiveTools agentId={2} sequence={4} ordinal={1} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenLastCalledWith(2, 4, 1, 0, "epoch", source, "v1");
    version = "v2";
    await emit({ type: "turn.finished", agent_id: 2, sequence: 4 });
    expect(read).toHaveBeenLastCalledWith(2, 4, 1, 0, "epoch", source, "v2");
    await act(async () => {
      if (lateFailure)
        oldRead.reject(new BackendError("stale", "old live failure"));
      else oldRead.resolve(contentPage("old live content"));
    });
    expect(screen.queryByText("old live content")).toBeNull();
    expect(screen.queryByText("old live failure")).toBeNull();
    await act(async () =>
      currentRead.resolve(contentPage("current live content")),
    );
    expect(screen.getByText("current live content")).toBeTruthy();
  },
);
