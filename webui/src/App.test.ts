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
import { useApplication } from "@/App";
import { clearToasts, readToasts } from "@/components/ui/toast";
import {
  Backend,
  BackendError,
  type BackendEvent,
  backend,
  type Socket,
} from "@/lib/backend";

let renderHook: typeof import("@testing-library/react").renderHook;
let act: typeof import("@testing-library/react").act;
let closeDom: () => void;
let result: { current: ReturnType<typeof useApplication> };

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
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ({ renderHook, act } = await import("@testing-library/react"));
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const organization = {
  id: 1,
  uuid: "test-organization",
  members: [],
  human_id: 1,
  token_limit: 10,
};
let events: Set<(event: BackendEvent) => void>;
let failures: Set<(error: BackendError) => void>;
let cleanup: (() => void)[];
let closed: boolean;
let page: EventTarget & { visibilityState: string };
let network: { onLine: boolean };

function render() {
  return result.current;
}
function mount() {
  const mounted = renderHook(() => useApplication());
  result = mounted.result;
  cleanup.push(mounted.unmount);
  return result.current;
}
function emit(event: BackendEvent) {
  act(() => {
    for (const listener of events) listener(event);
  });
}
function notifyFailure(
  error = new BackendError("disconnected", "Connection lost", true),
) {
  closed = true;
  act(() => {
    for (const listener of failures) listener(error);
  });
  return error;
}
function disconnect(
  error = new BackendError("disconnected", "Connection lost", true),
) {
  notifyFailure(error);
  emit({ type: "connection.closed", error });
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

async function advance(duration: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(duration);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  cleanup = [];
  events = new Set();
  failures = new Set();
  closed = false;
  clearToasts();
  page = document;
  Object.defineProperty(page, "visibilityState", {
    configurable: true,
    writable: true,
    value: "visible",
  });
  network = { onLine: true };
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => network.onLine,
  });
  vi.spyOn(backend, "disconnected", "get").mockImplementation(() => closed);
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    events.add(listener);
    return () => {
      events.delete(listener);
    };
  });
  vi.spyOn(backend, "onFailure").mockImplementation((listener) => {
    failures.add(listener);
    return () => {
      failures.delete(listener);
    };
  });
  vi.spyOn(backend, "connect").mockResolvedValue();
  vi.spyOn(backend, "reconnect").mockImplementation(async () => {
    if (closed) {
      emit({ type: "connection.reconnecting" });
      closed = false;
      emit({ type: "connection.restored" });
    }
  });
  vi.spyOn(backend, "organization").mockResolvedValue(organization);
  vi.spyOn(backend, "discussions").mockResolvedValue([]);
});
afterEach(() => {
  for (const off of cleanup) off();
  clearToasts();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("application live resources", () => {
  it("batches quick reads from the first event without extending the deadline", async () => {
    mount();
    await settle();
    for (let index = 0; index < 20; index += 1) {
      emit({ type: "usage.updated", agent_id: 2 });
      emit({ type: "discussion.updated", discussion_id: 1 });
      await advance(50);
      expect(backend.organization).toHaveBeenCalledTimes(
        1 + Math.floor(((index + 1) * 50) / 150),
      );
      expect(backend.discussions).toHaveBeenCalledTimes(
        1 + Math.floor(((index + 1) * 50) / 150),
      );
    }
    await advance(50);
    expect(backend.organization).toHaveBeenCalledTimes(8);
    expect(backend.discussions).toHaveBeenCalledTimes(8);
  });

  it("reads the finished Turn immediately and clears its scheduled batch", async () => {
    mount();
    await settle();
    emit({ type: "usage.updated", agent_id: 2 });
    await advance(100);
    expect(backend.organization).toHaveBeenCalledTimes(1);
    emit({ type: "turn.finished", agent_id: 2 });
    await settle();
    expect(backend.organization).toHaveBeenCalledTimes(2);
    await advance(200);
    expect(backend.organization).toHaveBeenCalledTimes(2);
    expect(backend.discussions).toHaveBeenCalledTimes(1);
  });

  it.each(["disconnect", "unmount"])(
    "clears both scheduled resources on %s",
    async (condition) => {
      mount();
      await settle();
      emit({ type: "usage.updated", agent_id: 2 });
      emit({ type: "discussion.updated", discussion_id: 1 });
      if (condition === "disconnect") {
        page.visibilityState = "hidden";
        disconnect();
        emit({ type: "usage.updated", agent_id: 2 });
      } else {
        for (const off of cleanup.splice(0)) off();
      }
      await advance(200);
      expect(backend.organization).toHaveBeenCalledTimes(1);
      expect(backend.discussions).toHaveBeenCalledTimes(1);
      if (condition === "disconnect") {
        closed = false;
        emit({ type: "connection.restored" });
        await settle();
        expect(backend.organization).toHaveBeenCalledTimes(2);
        expect(backend.discussions).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each([0, 1, 12])(
    "publishes continuously with %i Agents during 50ms events and 300ms reads",
    async (agents) => {
      mount();
      await settle();
      vi.useFakeTimers();
      let version = 0;
      let activeReads = 0;
      let maximumReads = 0;
      const publishedValues = new Set<number>();
      const members = Array.from({ length: agents }, (_, index) => ({
        id: index + 2,
        name: `Agent ${index + 2}`,
        type: "agent" as const,
        state: "running" as const,
      }));
      vi.mocked(backend.organization).mockImplementation(() => {
        const observed = version;
        activeReads += 1;
        maximumReads = Math.max(maximumReads, activeReads);
        return new Promise((resolve) => {
          setTimeout(() => {
            activeReads -= 1;
            resolve({ ...organization, members, token_limit: observed });
          }, 300);
        });
      });
      try {
        for (version = 1; version <= 200; version += 1) {
          emit({ type: "usage.updated", agent_id: 2 });
          await advance(50);
          const value = render().organization.data?.token_limit;
          if (value !== null && value !== undefined) publishedValues.add(value);
        }
        version = 200;
        await advance(600);
        expect(maximumReads).toBe(1);
        expect(publishedValues.size).toBeGreaterThan(25);
        expect(render().organization.data?.token_limit).toBe(200);
        expect(
          vi.mocked(backend.organization).mock.calls.length,
        ).toBeLessThanOrEqual(36);
        expect(backend.discussions).toHaveBeenCalledTimes(1);
        expect(activeReads).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("publishes member data while a discussion read is still running", async () => {
    mount();
    await settle();
    const delayed = deferred<[]>();
    vi.mocked(backend.discussions).mockReturnValueOnce(delayed.promise);
    vi.mocked(backend.organization).mockResolvedValueOnce({
      ...organization,
      token_limit: 42,
    });
    emit({ type: "discussion.updated" });
    emit({ type: "usage.updated", agent_id: 2 });
    await advance(150);
    await settle();
    expect(render().organization.data?.token_limit).toBe(42);
    expect(render().loading).toBe(true);
    delayed.resolve([]);
    await settle();
    expect(render().loading).toBe(false);
  });

  it("does not reread discussions for tool progress or member usage", async () => {
    mount();
    await settle();
    emit({ type: "tool.updated", agent_id: 2 });
    emit({ type: "turn.progress", agent_id: 2, phase: "tool.result" });
    await settle();
    expect(backend.organization).toHaveBeenCalledTimes(1);
    expect(backend.discussions).toHaveBeenCalledTimes(1);
    emit({ type: "usage.updated", agent_id: 2 });
    await advance(150);
    await settle();
    expect(backend.organization).toHaveBeenCalledTimes(2);
    expect(backend.discussions).toHaveBeenCalledTimes(1);
    emit({ type: "message.created", discussion_id: 1 });
    await advance(150);
    await settle();
    expect(backend.organization).toHaveBeenCalledTimes(2);
    expect(backend.discussions).toHaveBeenCalledTimes(2);
  });

  it("keeps an error for the failed resource when another resource succeeds", async () => {
    mount();
    await settle();
    vi.mocked(backend.discussions).mockRejectedValueOnce(
      new BackendError("internal_error", "Discussion failed"),
    );
    emit({ type: "discussion.updated" });
    await advance(150);
    await settle();
    emit({ type: "usage.updated", agent_id: 2 });
    await advance(150);
    await settle();
    expect(render().discussions.error?.message).toBe("Discussion failed");
    expect(render().failure).toBeNull();
    expect(readToasts().filter((item) => item.open)).toHaveLength(0);
  });
});

describe("application recovery with React effects", () => {
  it.each([
    ["organization.changed", "scheduler_stopped", 10],
    ["settings.updated", "model_unavailable", 10],
    ["settings.updated", "token_limit", 1],
  ] as const)("refreshes %s for %s", async (type, code, tokenLimit) => {
    mount();
    await settle();
    const members = [
      {
        id: 2,
        name: "Main",
        type: "agent" as const,
        state: "blocked" as const,
        pause_requested: false,
        reasons: [{ code, message: code, recovery: "Review settings" }],
      },
    ];
    vi.mocked(backend.organization).mockResolvedValueOnce({
      ...organization,
      members,
      token_limit: tokenLimit,
    });
    emit({ type });
    await advance(150);
    await settle();
    expect(backend.organization).toHaveBeenCalledTimes(2);
    expect(render().organization.data?.members).toEqual(members);
    expect(render().organization.data?.token_limit).toBe(tokenLimit);
  });

  it("merges organization and settings changes during an active read", async () => {
    const first = deferred<typeof organization>();
    vi.mocked(backend.organization)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ...organization, token_limit: 20 });
    mount();
    await settle();
    emit({ type: "organization.changed" });
    emit({ type: "settings.updated" });
    emit({ type: "organization.changed" });
    expect(backend.organization).toHaveBeenCalledTimes(1);
    first.resolve(organization);
    await settle();
    expect(backend.organization).toHaveBeenCalledTimes(2);
    expect(render().organization.data?.token_limit).toBe(20);
  });

  it.each(["internal_error", "timeout"])(
    "retries an initial %s on an open connection",
    async (code) => {
      const error = new BackendError(code, "Read failed", code === "timeout");
      vi.mocked(backend.organization).mockRejectedValueOnce(error);
      mount();
      await settle();
      expect(render().organization.error).toBe(error);
      await act(() => render().retryResource("organization"));
      await settle();
      expect(render().organization.data?.human_id).toBe(1);
      expect(render().organization.error).toBeNull();
      expect(render().failure).toBeNull();
      expect(backend.organization).toHaveBeenCalledTimes(2);
      expect(backend.reconnect).not.toHaveBeenCalled();
    },
  );

  it.each(["connection_timeout", "connection_failed"] as const)(
    "waits for %s recovery before showing a connection notice",
    async (code) => {
      mount();
      await settle();
      const error = new BackendError(code, "Connection failed", true);
      notifyFailure(error);
      expect(
        readToasts().find((item) => item.id === "connection"),
      ).toBeUndefined();
      emit({ type: "connection.closed", error });
      await settle();
      expect(closed).toBe(false);
      expect(
        readToasts().find((item) => item.id === "connection"),
      ).toBeUndefined();
    },
  );

  it.each(["connection_timeout", "connection_failed"] as const)(
    "reports one %s notice after automatic recovery fails",
    async (code) => {
      mount();
      await settle();
      const error = new BackendError(code, "Connection failed", true);
      let automaticAttempted = false;
      vi.mocked(backend.reconnect).mockImplementation((automatic = false) => {
        if (!automatic || automaticAttempted) return Promise.resolve();
        automaticAttempted = true;
        emit({ type: "connection.reconnecting" });
        return Promise.resolve().then(() => {
          notifyFailure(error);
          emit({ type: "connection.closed", error });
          return Promise.reject(error);
        });
      });
      notifyFailure(error);
      emit({ type: "connection.closed", error });
      await settle();
      expect(render().reconnecting).toBe(false);
      expect(
        readToasts().filter((item) => item.open && item.id === "connection"),
      ).toHaveLength(1);
    },
  );

  it("keeps an unconfirmed write result visible during disconnect recovery", async () => {
    mount();
    await settle();
    const uncertain = new BackendError(
      "unconfirmed",
      "Check the current operation before retrying.",
      true,
      "organization.rename_member",
    );
    notifyFailure(uncertain);
    emit({
      type: "connection.closed",
      error: new BackendError("disconnected", "Connection lost", true),
    });
    await settle();
    expect(
      readToasts().find(
        (item) => item.open && item.title === "Check operation result",
      ),
    ).toMatchObject({
      title: "Check operation result",
      description: "Check the current operation before retrying.",
    });
  });

  it.each(["usage.query", "usage.read"])(
    "keeps %s timeouts in the reading region",
    async (operation) => {
      vi.useFakeTimers();
      const sent: { id: number }[] = [];
      const socket: Socket = {
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close: vi.fn(),
        send: (data) => sent.push(JSON.parse(data)),
      };
      const transport = new Backend(
        () => ({ url: "ws://localhost/ws?token=test" }),
        () => socket,
      );
      const connecting = transport.connect();
      socket.onopen?.(new Event("open"));
      await connecting;
      vi.mocked(backend.onFailure).mockImplementation(
        transport.onFailure.bind(transport),
      );
      mount();
      await settle();
      const before = readToasts().filter((item) => item.open);
      const read = () =>
        operation === "usage.query"
          ? transport.usageQuery({})
          : transport.usageRead("request:2:1:1");
      const pending = read().catch((error) => error);
      await advance(60000);
      expect(await pending).toMatchObject({ code: "timeout", operation });
      expect(readToasts().filter((item) => item.open)).toEqual(before);
      const recovered = read();
      await settle();
      socket.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "response",
            id: sent[1].id,
            result: { dataset_revision: 3 },
          }),
        }),
      );
      await expect(recovered).resolves.toEqual({ dataset_revision: 3 });
      expect(readToasts().filter((item) => item.open)).toEqual(before);
    },
  );

  it("suppresses an unconfirmed Discussion send from global feedback", async () => {
    mount();
    await settle();
    const uncertain = new BackendError(
      "unconfirmed",
      "Your message may have been sent. Check the discussion before sending it again.",
      true,
      "discussion.send",
    );
    notifyFailure(uncertain);
    emit({
      type: "connection.closed",
      error: new BackendError("disconnected", "Connection lost", true),
    });
    await settle();
    expect(
      readToasts().find(
        (item) => item.open && item.title === "Check operation result",
      ),
    ).toBeUndefined();
  });

  it.each(["upload.create", "upload.status", "upload.cancel"] as const)(
    "suppresses an unconfirmed %s from global feedback",
    async (operation) => {
      mount();
      await settle();
      notifyFailure(
        new BackendError(
          "unconfirmed",
          "The upload operation may have completed.",
          true,
          operation,
        ),
      );
      await settle();
      expect(
        readToasts().find(
          (item) => item.open && item.title === "Check operation result",
        ),
      ).toBeUndefined();
    },
  );

  it.each(["close-first", "visible-first"])(
    "recovers with %s ordering",
    async (order) => {
      page.visibilityState = "hidden";
      mount();
      await settle();
      if (order === "close-first") disconnect();
      page.visibilityState = "visible";
      act(() => {
        page.dispatchEvent(new Event("visibilitychange"));
      });
      if (order === "visible-first") disconnect();
      await settle();
      expect(closed).toBe(false);
      expect(backend.organization).toHaveBeenCalledTimes(2);
    },
  );

  it("waits for both online and visible before automatic recovery", async () => {
    mount();
    await settle();
    network.onLine = false;
    disconnect();
    await settle();
    expect(backend.reconnect).not.toHaveBeenCalled();
    page.visibilityState = "hidden";
    network.onLine = true;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect(backend.reconnect).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    act(() => {
      page.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(closed).toBe(false);
  });

  it("subscribes before a synchronous startup failure", async () => {
    vi.mocked(backend.connect).mockImplementationOnce(() => {
      expect(events.size).toBeGreaterThan(0);
      disconnect();
      return Promise.reject(new BackendError("disconnected", "Closed", true));
    });
    mount();
    await settle();
    expect(render().organization.data?.human_id).toBe(1);
    expect(render().failure).toBeNull();
  });

  it("shows the affected region loading while an initial retry is pending", async () => {
    vi.mocked(backend.organization).mockRejectedValueOnce(
      new BackendError("internal_error", "Read failed"),
    );
    mount();
    await settle();
    const next = deferred<typeof organization>();
    vi.mocked(backend.organization).mockReturnValueOnce(next.promise);
    let retry!: Promise<void>;
    act(() => {
      retry = render().retryResource("organization");
    });
    await settle();
    expect(render().organization.status).toBe("pending");
    expect(render().organization.error).toBeNull();
    expect(render().loading).toBe(true);
    next.resolve(organization);
    await act(() => retry);
    expect(render().failure).toBeNull();
    expect(render().loading).toBe(false);
  });

  it("invalidates old reads without letting their finally clear the new request", async () => {
    const old = deferred<typeof organization>();
    vi.mocked(backend.organization).mockReturnValueOnce(old.promise);
    mount();
    await settle();
    const next = deferred<typeof organization>();
    vi.mocked(backend.organization).mockReturnValueOnce(next.promise);
    disconnect();
    await settle();
    old.resolve({ ...organization, human_id: 99 });
    await settle();
    expect(render().organization.data).toBeNull();
    let retry!: Promise<void>;
    act(() => {
      retry = render().retry();
    });
    await settle();
    expect(backend.organization).toHaveBeenCalledTimes(2);
    next.resolve(organization);
    await act(() => retry);
    await settle();
    expect(render().organization.data?.human_id).toBe(1);
  });

  it("merges events during a read and retains loaded data on a failed follow-up", async () => {
    const first = deferred<typeof organization>();
    vi.mocked(backend.organization)
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(
        new BackendError("internal_error", "Follow-up failed"),
      );
    mount();
    await settle();
    emit({ type: "member.updated" });
    emit({ type: "discussion.updated" });
    first.resolve(organization);
    await settle();
    expect(render().organization.data?.human_id).toBe(1);
    expect(backend.organization).toHaveBeenCalledTimes(2);
    expect(render().organization.error?.message).toBe("Follow-up failed");
    expect(readToasts().filter((item) => item.open)).toHaveLength(0);
    await act(() => render().retryResource("organization"));
    await settle();
    expect(backend.organization).toHaveBeenCalledTimes(3);
    expect(render().organization.error).toBeNull();
  });

  it("shows a retryable read error after connection restoration", async () => {
    mount();
    await settle();
    const snapshot = render().discussions.data;
    vi.mocked(backend.discussions).mockRejectedValueOnce(
      new BackendError("timeout", "Read timed out", true),
    );
    disconnect();
    await settle();
    expect(render().discussions.data).toBe(snapshot);
    expect(render().discussions.error?.code).toBe("timeout");
    expect(render().failure).toBeNull();
    expect(readToasts().filter((item) => item.open)).toHaveLength(0);
    await act(() => render().retryResource("discussions"));
    await settle();
    expect(render().discussions.error).toBeNull();
    expect(backend.discussions).toHaveBeenCalledTimes(3);
  });

  it("coalesces repeated retry and visibility events during a read", async () => {
    mount();
    await settle();
    const pending = deferred<typeof organization>();
    vi.mocked(backend.organization).mockReturnValueOnce(pending.promise);
    let first!: Promise<void>;
    act(() => {
      first = render().retry();
      void render().retry();
    });
    act(() => {
      page.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect(backend.organization).toHaveBeenCalledTimes(2);
    pending.resolve(organization);
    await act(() => first);
    expect(render().failure).toBeNull();
  });

  it("ignores results after unmount and removes lifecycle subscriptions", async () => {
    const pending = deferred<typeof organization>();
    vi.mocked(backend.organization).mockReturnValueOnce(pending.promise);
    mount();
    await settle();
    for (const off of cleanup.splice(0)) off();
    pending.resolve(organization);
    await settle();
    expect(render().organization.data).toBeNull();
    expect(events.size).toBe(0);
    expect(failures.size).toBe(0);
    closed = true;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(backend.reconnect).not.toHaveBeenCalled();
  });
});
