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
import type { BackendEvent, DiscussionSummary } from "@/lib/backend";

let App: typeof import("@/App").default;
let backend: typeof import("@/lib/backend").backend;
let BackendError: typeof import("@/lib/backend").BackendError;
let testing: typeof import("@testing-library/react");
let clearToasts: typeof import("@/components/ui/toast").clearToasts;
let readToasts: typeof import("@/components/ui/toast").readToasts;
let closeDom: () => void;
let listeners: Set<(event: BackendEvent) => void>;
let closed: boolean;

const organization = {
  id: 1,
  uuid: "live-resources",
  human_id: 1,
  token_limit: 100,
  members: [
    { id: 1, name: "You", type: "human" as const, state: "idle" as const },
    { id: 2, name: "Helper", type: "agent" as const, state: "idle" as const },
  ],
};
const discussions: DiscussionSummary[] = [
  {
    id: 1,
    topic: "Project discussion",
    archived: false,
    member_ids: [1, 2],
    unread: 3,
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function emit(event: BackendEvent) {
  for (const listener of listeners) listener(event);
}

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
  vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("EventTarget", dom.window.EventTarget);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal("AbortController", dom.window.AbortController);
  vi.stubGlobal("AbortSignal", dom.window.AbortSignal);
  vi.stubGlobal(
    "getComputedStyle",
    dom.window.getComputedStyle.bind(dom.window),
  );
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  testing = await import("@testing-library/react");
  ({ default: App } = await import("@/App"));
  ({ backend, BackendError } = await import("@/lib/backend"));
  ({ clearToasts, readToasts } = await import("@/components/ui/toast"));
}, 30000);

beforeEach(() => {
  closed = false;
  listeners = new Set();
  clearToasts();
  vi.spyOn(backend, "disconnected", "get").mockImplementation(() => closed);
  vi.spyOn(backend, "connect").mockResolvedValue();
  vi.spyOn(backend, "reconnect").mockResolvedValue();
  vi.spyOn(backend, "onFailure").mockReturnValue(() => {});
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  vi.spyOn(backend, "organization").mockResolvedValue(organization);
  vi.spyOn(backend, "discussions").mockResolvedValue(discussions);
});

afterEach(async () => {
  testing.cleanup();
  vi.useRealTimers();
  await testing.act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  clearToasts();
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

function select(label: string) {
  testing.fireEvent.click(testing.screen.getByRole("button", { name: label }));
}

async function settle() {
  await testing.act(async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
  });
}

describe("Application resource regions", () => {
  it.each(["organization", "discussions"] as const)(
    "keeps the shell and publishes the first %s result independently",
    async (first) => {
      const members = deferred<typeof organization>();
      const list = deferred<DiscussionSummary[]>();
      vi.mocked(backend.organization).mockReturnValue(members.promise);
      vi.mocked(backend.discussions).mockReturnValue(list.promise);
      const view = testing.render(<App />);
      expect(
        testing.screen.getByRole("button", { name: "Members" }),
      ).toBeTruthy();
      expect(
        testing.screen.getByRole("button", { name: "Usage" }),
      ).toBeTruthy();
      const shell = view.container.firstElementChild;
      if (first === "organization") {
        await testing.act(async () => members.resolve(organization));
        select("Members");
        expect(testing.screen.getByText("Helper")).toBeTruthy();
        expect(
          testing.screen.getByLabelText("Loading Discussions"),
        ).toBeTruthy();
        await testing.act(async () => list.resolve(discussions));
      } else {
        await testing.act(async () => list.resolve(discussions));
        expect(
          testing.screen.getAllByText("Project discussion").length,
        ).toBeGreaterThan(0);
        select("Members");
        expect(testing.screen.getByLabelText("Loading Members")).toBeTruthy();
        expect(testing.screen.queryByText("No Members match")).toBeNull();
        await testing.act(async () => members.resolve(organization));
        expect(testing.screen.getByText("Helper")).toBeTruthy();
      }
      expect(view.container.firstElementChild).toBe(shell);
      expect(backend.organization).toHaveBeenCalledTimes(1);
      expect(backend.discussions).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["organization", "discussions"] as const)(
    "recovers only the failed %s region while the other remains usable",
    async (failed) => {
      const problem = new BackendError(
        "internal_error",
        `${failed} unavailable`,
      );
      if (failed === "organization")
        vi.mocked(backend.organization).mockRejectedValueOnce(problem);
      else vi.mocked(backend.discussions).mockRejectedValueOnce(problem);
      testing.render(<App />);
      await settle();
      if (failed === "organization") {
        expect(
          testing.screen.getAllByText("Project discussion").length,
        ).toBeGreaterThan(0);
        select("Members");
      } else {
        select("Members");
        expect(testing.screen.getByText("Helper")).toBeTruthy();
        select("Discussions");
      }
      const membersRecovery = deferred<typeof organization>();
      const discussionsRecovery = deferred<DiscussionSummary[]>();
      if (failed === "organization")
        vi.mocked(backend.organization).mockReturnValueOnce(
          membersRecovery.promise,
        );
      else
        vi.mocked(backend.discussions).mockReturnValueOnce(
          discussionsRecovery.promise,
        );
      expect(testing.screen.getByRole("alert").textContent).toContain(
        problem.message,
      );
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: "Retry" }),
      );
      await settle();
      expect(backend.organization).toHaveBeenCalledTimes(
        failed === "organization" ? 2 : 1,
      );
      expect(backend.discussions).toHaveBeenCalledTimes(
        failed === "discussions" ? 2 : 1,
      );
      await testing.act(async () => {
        if (failed === "organization") membersRecovery.resolve(organization);
        else discussionsRecovery.resolve(discussions);
      });
      expect(testing.screen.queryByRole("alert")).toBeNull();
      expect(readToasts().filter((item) => item.open)).toHaveLength(0);
    },
  );

  it("preserves Members search and content through a failed refresh and local Retry", async () => {
    testing.render(<App />);
    await settle();
    select("Members");
    const search = testing.screen.getByRole("searchbox", {
      name: "Search Members",
    });
    testing.fireEvent.change(search, { target: { value: "Helper" } });
    vi.mocked(backend.organization).mockRejectedValueOnce(
      new BackendError("internal_error", "Refresh unavailable"),
    );
    vi.useFakeTimers();
    await testing.act(async () => {
      emit({ type: "usage.updated", agent_id: 2 });
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(testing.screen.getByText("Helper")).toBeTruthy();
    expect(
      testing.screen.getByRole("searchbox", { name: "Search Members" }),
    ).toBe(search);
    expect((search as HTMLInputElement).value).toBe("Helper");
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry" }),
    );
    await settle();
    expect(testing.screen.queryByRole("alert")).toBeNull();
    expect((search as HTMLInputElement).value).toBe("Helper");
    expect(backend.discussions).toHaveBeenCalledTimes(1);
  });

  it("keeps one connection recovery entry inside the fixed shell", async () => {
    closed = true;
    vi.mocked(backend.connect).mockRejectedValue(
      new BackendError("connection_failed", "Connection unavailable", true),
    );
    const view = testing.render(<App />);
    await settle();
    expect(
      testing.screen.getByRole("button", { name: "Members" }),
    ).toBeTruthy();
    expect(
      testing.screen.getAllByRole("button", { name: "Reconnect" }),
    ).toHaveLength(1);
    expect(view.container.querySelectorAll("main")).toHaveLength(1);
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Reconnect" }),
    );
    expect(backend.reconnect).toHaveBeenCalledTimes(1);
    await testing.act(async () => {
      closed = false;
      emit({ type: "connection.restored" });
    });
    expect(
      testing.screen.queryByRole("button", { name: "Reconnect" }),
    ).toBeNull();
    expect(
      testing.screen.getAllByText("Project discussion").length,
    ).toBeGreaterThan(0);
  });

  it("publishes known Members before a Cold usage index finishes advancing", async () => {
    const advancing =
      deferred<Awaited<ReturnType<typeof backend.usageAdvance>>>();
    vi.spyOn(backend, "usageAdvance").mockReturnValue(advancing.promise);
    vi.mocked(backend.organization)
      .mockResolvedValueOnce({
        ...organization,
        usage_version: {
          dataset_revision: 1,
          index: { ready: 0, revision: 1 },
        },
      })
      .mockResolvedValue({
        ...organization,
        usage_version: {
          dataset_revision: 2,
          index: { ready: 1, revision: 2 },
        },
      });
    testing.render(<App />);
    await settle();
    select("Members");
    expect(testing.screen.getByText("Helper")).toBeTruthy();
    expect(backend.organization).toHaveBeenCalledTimes(1);
    expect(backend.usageAdvance).toHaveBeenCalledTimes(1);
    await testing.act(async () => advancing.resolve({ ready: 1, revision: 2 }));
    expect(backend.organization).toHaveBeenCalledTimes(2);
    expect(testing.screen.getByText("Helper")).toBeTruthy();
  });
});
