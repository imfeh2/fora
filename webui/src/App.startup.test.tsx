import { StrictMode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { BackendEvent, DiscussionSummary, Member } from "@/lib/backend";

let App: typeof import("@/App").default;
let OrganizationProvider: typeof import("@/app/organization").OrganizationProvider;
let RouterProvider: typeof import("@/app/router").RouterProvider;
let useRouter: typeof import("@/app/router").useRouter;
let MemberPage: typeof import("@/features/members/detail").MemberPage;
let DocumentPage: typeof import("@/features/library/document").DocumentPage;
let AgentPanel: typeof import("@/features/settings/agent").AgentPanel;
let ExecutionPanel: typeof import("@/features/settings/execution").ExecutionPanel;
let LangfusePanel: typeof import("@/features/settings/langfuse").LangfusePanel;
let ModelPanel: typeof import("@/features/settings/model").ModelPanel;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let backend: typeof import("@/lib/backend").backend;
let BackendError: typeof import("@/lib/backend").BackendError;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let clearToasts: typeof import("@/components/ui/toast").clearToasts;
let readToasts: typeof import("@/components/ui/toast").readToasts;
let closeDom: () => void;
let events: Set<(event: BackendEvent) => void>;
let failures: Set<(error: InstanceType<typeof BackendError>) => void>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const members: Member[] = [
  { id: 7, name: "You", type: "human", state: "idle" },
  { id: 8, name: "Helper", type: "agent", state: "idle" },
];
const organization = {
  id: 1,
  uuid: "startup-test",
  members,
  human_id: 7,
  token_limit: 100,
};
const discussions: DiscussionSummary[] = [
  {
    id: 4,
    topic: "Startup review",
    member_ids: [7, 8],
    archived: false,
    unread: 2,
  },
];
let connection: ReturnType<typeof deferred<void>>;
let organizationRead: ReturnType<typeof deferred<typeof organization>>;
let discussionsRead: ReturnType<typeof deferred<DiscussionSummary[]>>;

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  closeDom = () => dom.window.close();
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  for (const name of [
    "HTMLElement",
    "Element",
    "Node",
    "MutationObserver",
    "Event",
    "EventTarget",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "AbortController",
    "AbortSignal",
    "HTMLInputElement",
    "HTMLTextAreaElement",
  ])
    vi.stubGlobal(name, dom.window[name]);
  vi.stubGlobal(
    "getComputedStyle",
    dom.window.getComputedStyle.bind(dom.window),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  ({ render, cleanup, act, fireEvent } = await import(
    "@testing-library/react"
  ));
  ({ backend, BackendError } = await import("@/lib/backend"));
  ({ clearToasts, readToasts } = await import("@/components/ui/toast"));
  ({ default: App } = await import("@/App"));
  ({ OrganizationProvider } = await import("@/app/organization"));
  ({ RouterProvider, useRouter } = await import("@/app/router"));
  ({ MemberPage } = await import("@/features/members/detail"));
  ({ DocumentPage } = await import("@/features/library/document"));
  ({ AgentPanel } = await import("@/features/settings/agent"));
  ({ ExecutionPanel } = await import("@/features/settings/execution"));
  ({ LangfusePanel } = await import("@/features/settings/langfuse"));
  ({ ModelPanel } = await import("@/features/settings/model"));
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
}, 30000);

beforeEach(() => {
  events = new Set();
  failures = new Set();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  connection = deferred<void>();
  organizationRead = deferred<typeof organization>();
  discussionsRead = deferred<DiscussionSummary[]>();
  vi.spyOn(backend, "connect").mockReturnValue(connection.promise);
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
  vi.spyOn(backend, "disconnected", "get").mockReturnValue(false);
  vi.spyOn(backend, "organization").mockReturnValue(organizationRead.promise);
  vi.spyOn(backend, "discussions").mockReturnValue(discussionsRead.promise);
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

async function connect() {
  await act(async () => {
    connection.resolve();
  });
}

it.each([false, true])(
  "shows the shell and independent resources with StrictMode=%s",
  async (strict) => {
    const view = render(
      strict ? (
        <StrictMode>
          <App />
        </StrictMode>
      ) : (
        <App />
      ),
    );
    expect(view.getByText("Fora")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Discussions" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Members" })).toBeTruthy();
    expect(view.queryByText("Starting Fora…")).toBeNull();
    expect(view.queryByText("No Discussions yet")).toBeNull();
    expect(backend.organization).not.toHaveBeenCalled();
    const input = view.getByRole("searchbox", { name: "Search messages" });
    const placeholders = view.container.querySelectorAll("[aria-busy=true]");
    expect(placeholders.length).toBeGreaterThan(0);
    for (const placeholder of placeholders)
      expect(
        placeholder.querySelector("button,input,textarea,[tabindex]"),
      ).toBeNull();
    await connect();
    await act(async () => {
      discussionsRead.resolve(discussions);
    });
    expect(view.getAllByText("Startup review").length).toBe(2);
    expect(view.queryByText("Helper")).toBeNull();
    expect(view.getByRole("searchbox", { name: "Search messages" })).toBe(
      input,
    );
    await act(async () => {
      organizationRead.resolve(organization);
    });
    expect(view.getByText("Helper")).toBeTruthy();
    expect(backend.discussions).toHaveBeenCalledTimes(1);
    expect(backend.organization).toHaveBeenCalledTimes(1);
  },
);

it("shows organization data while Discussions remains pending and preserves navigation", async () => {
  const view = render(<App />);
  fireEvent.click(view.getByRole("button", { name: "Members" }));
  expect(view.getByRole("heading", { name: "Members" })).toBeTruthy();
  expect(view.queryByText("No Members match")).toBeNull();
  const input = view.getByRole("searchbox", { name: "Search Members" });
  fireEvent.change(input, { target: { value: "Helper" } });
  await connect();
  await act(async () => {
    organizationRead.resolve(organization);
  });
  expect(view.getByText("Helper")).toBeTruthy();
  expect(view.getByRole("searchbox", { name: "Search Members" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("Helper");
  expect(view.queryByText("No Discussions yet")).toBeNull();
  await act(async () => {
    discussionsRead.resolve([]);
  });
  expect(view.getByRole("heading", { name: "Members" })).toBeTruthy();
});

it("displays an empty Discussion result only after a successful read", async () => {
  const view = render(<App />);
  await connect();
  expect(view.queryByText("No Discussions yet")).toBeNull();
  await act(async () => {
    discussionsRead.resolve([]);
  });
  expect(view.getByText("No Discussions yet")).toBeTruthy();
});

it("retries only failed Discussions while preserving the organization result", async () => {
  const view = render(<App />);
  await connect();
  await act(async () => {
    organizationRead.resolve(organization);
    discussionsRead.reject(
      new BackendError("internal_error", "Discussion read failed"),
    );
  });
  expect(view.queryByLabelText("Loading Discussions")).toBeNull();
  const next = deferred<DiscussionSummary[]>();
  vi.mocked(backend.discussions).mockReturnValue(next.promise);
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await act(async () => {
    next.resolve(discussions);
  });
  expect(view.getAllByText("Startup review").length).toBe(2);
  expect(backend.organization).toHaveBeenCalledTimes(1);
  expect(backend.discussions).toHaveBeenCalledTimes(2);
});

it("preserves a Members search through an initial organization failure and Retry", async () => {
  const view = render(<App />);
  fireEvent.click(view.getByRole("button", { name: "Members" }));
  const input = view.getByRole("searchbox", { name: "Search Members" });
  fireEvent.change(input, { target: { value: "Helper" } });
  await connect();
  await act(async () => {
    discussionsRead.resolve(discussions);
    organizationRead.reject(
      new BackendError("internal_error", "Organization unavailable"),
    );
  });
  expect(view.getByText("Startup review")).toBeTruthy();
  expect(view.queryByLabelText("Loading Members")).toBeNull();
  expect(view.getByRole("searchbox", { name: "Search Members" })).toBe(input);
  const next = deferred<typeof organization>();
  vi.mocked(backend.organization).mockReturnValue(next.promise);
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await act(async () => {
    next.resolve(organization);
  });
  expect(view.getByText("Helper")).toBeTruthy();
  expect((input as HTMLInputElement).value).toBe("Helper");
  expect(backend.organization).toHaveBeenCalledTimes(2);
  expect(backend.discussions).toHaveBeenCalledTimes(1);
});

it("waits for identity before reading a Discussion or enabling its composer", async () => {
  const page = vi.spyOn(backend, "discussionPage");
  const markRead = vi.spyOn(backend, "markRead");
  const view = render(<App />);
  await connect();
  await act(async () => {
    discussionsRead.resolve(discussions);
  });
  fireEvent.click(view.getAllByText("Startup review")[0]);
  expect(view.getByLabelText("Loading Discussion")).toBeTruthy();
  expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
  expect(page).not.toHaveBeenCalled();
  expect(markRead).not.toHaveBeenCalled();
});

function RouteProbe() {
  return <output data-testid="current-route">{useRouter().route.name}</output>;
}

it("waits for Members before deciding that a Member is missing", () => {
  const memberView = (knownMembers: Member[] | null) => (
    <RouterProvider>
      <OrganizationProvider
        value={{
          members: knownMembers,
          humanId: knownMembers === null ? null : 7,
          discussions: null,
          connectionError: null,
          organizationError: null,
          discussionsError: null,
          refresh: async () => {},
          retry: async () => {},
        }}
      >
        <MemberPage id={8} />
        <RouteProbe />
      </OrganizationProvider>
    </RouterProvider>
  );
  const view = render(memberView(null));
  expect(view.getByLabelText("Loading Member")).toBeTruthy();
  expect(view.getByTestId("current-route").textContent).toBe("discussions");
  view.rerender(memberView([members[0]]));
  expect(view.queryByLabelText("Loading Member")).toBeNull();
  expect(view.getByTestId("current-route").textContent).toBe("members");
});

it("keeps fixed Settings navigation visible while model data loads", async () => {
  const catalog = deferred<Awaited<ReturnType<typeof backend.modelCatalog>>>();
  vi.spyOn(backend, "modelCatalog").mockReturnValue(catalog.promise);
  const view = render(<App />);
  fireEvent.click(view.getByRole("button", { name: "Settings" }));
  expect(view.getByRole("heading", { name: "Settings" })).toBeTruthy();
  expect(view.getByRole("tab", { name: "Model" })).toBeTruthy();
  expect(view.getByRole("tab", { name: "Execution" })).toBeTruthy();
  expect(view.getByLabelText("Loading model settings")).toBeTruthy();
  expect(view.queryByRole("combobox")).toBeNull();
});

it("shows Library structure while entries load", async () => {
  const entries = deferred<Awaited<ReturnType<typeof backend.library>>>();
  vi.spyOn(backend, "library").mockReturnValue(entries.promise);
  const view = render(<App />);
  fireEvent.click(view.getByRole("button", { name: "Library" }));
  expect(view.getByRole("heading", { name: "Library" })).toBeTruthy();
  expect(view.getByLabelText("Loading Library")).toBeTruthy();
  expect(view.queryByText("The Library is empty")).toBeNull();
  await act(async () => {
    entries.resolve([]);
  });
  expect(view.getByText("The Library is empty")).toBeTruthy();
});

it("retains Library content and search through refresh failure", async () => {
  vi.spyOn(backend, "library").mockResolvedValue([
    {
      path: "guide.md",
      kind: "file",
      size: 3,
      modified_at: "2026-10-02T00:00:00Z",
    },
  ]);
  const view = render(<App />);
  fireEvent.click(view.getByRole("button", { name: "Library" }));
  await act(async () => {});
  const input = view.getByRole("searchbox", { name: "Search documents" });
  fireEvent.change(input, { target: { value: "guide" } });
  const next = deferred<Awaited<ReturnType<typeof backend.library>>>();
  vi.mocked(backend.library).mockReturnValue(next.promise);
  act(() => {
    for (const listener of events) listener({ type: "library.updated" });
  });
  expect(view.queryByLabelText("Loading Library")).toBeNull();
  expect(view.getByText("guide.md")).toBeTruthy();
  await act(async () => {
    next.reject(new BackendError("internal_error", "Library unavailable"));
  });
  expect(view.getByText("guide.md")).toBeTruthy();
  expect(view.getByRole("searchbox", { name: "Search documents" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("guide");
  expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it("preserves Library input when the connection closes before application resources arrive", async () => {
  vi.spyOn(backend, "library").mockResolvedValue([
    {
      path: "guide.md",
      kind: "file",
      size: 3,
      modified_at: "2026-10-02T00:00:00Z",
    },
  ]);
  const view = render(<App />);
  await connect();
  fireEvent.click(view.getByRole("button", { name: "Library" }));
  await act(async () => {});
  const input = view.getByRole("searchbox", { name: "Search documents" });
  fireEvent.change(input, { target: { value: "guide" } });
  vi.spyOn(backend, "disconnected", "get").mockReturnValue(true);
  act(() => {
    for (const listener of events)
      listener({
        type: "connection.closed",
        error: new BackendError("disconnected", "Connection lost", true),
      });
  });
  expect(view.getByRole("searchbox", { name: "Search documents" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("guide");
  expect(view.getByText("guide.md")).toBeTruthy();
  expect(view.queryByLabelText("Loading Discussions")).toBeNull();
  expect(view.getByRole("button", { name: "Reconnect" })).toBeTruthy();
});

it("ends pending Discussions placeholders after a partial startup disconnect", async () => {
  const view = render(<App />);
  await connect();
  await act(async () => {
    organizationRead.resolve(organization);
  });
  vi.spyOn(backend, "disconnected", "get").mockReturnValue(true);
  act(() => {
    for (const listener of events)
      listener({
        type: "connection.closed",
        error: new BackendError("disconnected", "Connection lost", true),
      });
  });
  expect(view.queryByLabelText("Loading Discussions")).toBeNull();
  expect(view.getByRole("heading", { name: "Discussions" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Reconnect" })).toBeTruthy();
});

it("ends Member placeholders inside ready Discussion rows after organization failure", async () => {
  const view = render(<App />);
  await connect();
  await act(async () => {
    discussionsRead.resolve(discussions);
  });
  const table = view.getByRole("table", { name: "Discussions" });
  expect(table.querySelectorAll(".animate-breathe").length).toBeGreaterThan(0);
  await act(async () => {
    organizationRead.reject(
      new BackendError("internal_error", "Organization unavailable"),
    );
  });
  expect(view.getByText("Organization unavailable")).toBeTruthy();
  expect(table.querySelectorAll(".animate-breathe")).toHaveLength(0);
  expect(view.getAllByText("Startup review")).toHaveLength(2);
});

it("ignores an archived response from a closed connection and reads after restoration", async () => {
  const view = render(<App />);
  await connect();
  await act(async () => {
    organizationRead.resolve(organization);
    discussionsRead.resolve(discussions);
  });
  const old = deferred<DiscussionSummary[]>();
  vi.mocked(backend.discussions).mockReturnValueOnce(old.promise);
  fireEvent.click(view.getByRole("button", { name: "Show archived" }));
  await act(async () => {});
  vi.spyOn(backend, "disconnected", "get").mockReturnValue(true);
  act(() => {
    for (const listener of events)
      listener({
        type: "connection.closed",
        error: new BackendError("disconnected", "Connection lost", true),
      });
  });
  await act(async () => {
    old.resolve([
      { ...discussions[0], topic: "Old archived result", archived: true },
    ]);
  });
  expect(view.queryByText("Old archived result")).toBeNull();
  vi.mocked(backend.discussions).mockResolvedValue([]);
  vi.spyOn(backend, "disconnected", "get").mockReturnValue(false);
  await act(async () => {
    for (const listener of events) listener({ type: "connection.restored" });
  });
  expect(view.getByText("No Discussions yet")).toBeTruthy();
  expect(
    vi.mocked(backend.discussions).mock.calls.filter(([archived]) => archived),
  ).toHaveLength(2);
});

async function readyApplication() {
  const view = render(<App />);
  await connect();
  await act(async () => {
    organizationRead.resolve(organization);
    discussionsRead.resolve(discussions);
  });
  return view;
}

async function emit(event: BackendEvent) {
  await act(async () => {
    for (const listener of events) listener(event);
  });
}

function archiveCalls() {
  return vi.mocked(backend.discussions).mock.calls.filter(([value]) => value);
}

it("publishes archived results and merges updates during continuous events", async () => {
  const view = await readyApplication();
  const reads = Array.from({ length: 5 }, () =>
    deferred<DiscussionSummary[]>(),
  );
  let index = 0;
  vi.mocked(backend.discussions).mockImplementation((archived) =>
    archived ? reads[index++].promise : Promise.resolve(discussions),
  );
  fireEvent.click(view.getByRole("button", { name: "Show archived" }));
  await act(async () => {});
  const input = view.getByRole("searchbox", { name: "Search messages" });
  for (let position = 0; position < 4; position += 1) {
    await emit({ type: "message.created", discussion_id: 99 });
    await emit({ type: "discussion.updated", discussion_id: 99 });
    expect(archiveCalls()).toHaveLength(position + 1);
    await act(async () => {
      reads[position].resolve([
        {
          ...discussions[0],
          topic: `Archived result ${position}`,
          archived: true,
        },
      ]);
    });
    expect(view.getByText(`Archived result ${position}`)).toBeTruthy();
    expect(view.queryByLabelText("Loading Discussions")).toBeNull();
    expect(archiveCalls()).toHaveLength(position + 2);
    expect(view.getByRole("searchbox", { name: "Search messages" })).toBe(
      input,
    );
  }
  await act(async () => {
    reads[4].resolve([
      { ...discussions[0], topic: "Final archived result", archived: true },
    ]);
  });
  expect(view.getByText("Final archived result")).toBeTruthy();
  expect(archiveCalls()).toHaveLength(5);
});

it.each(["internal_error", "timeout"])(
  "retries only archived Discussions after an initial %s failure",
  async (code) => {
    const view = await readyApplication();
    const first = deferred<DiscussionSummary[]>();
    const next = deferred<DiscussionSummary[]>();
    let reads = 0;
    vi.mocked(backend.discussions).mockImplementation((archived) =>
      archived
        ? reads++ === 0
          ? first.promise
          : next.promise
        : Promise.resolve(discussions),
    );
    fireEvent.click(view.getByRole("button", { name: "Show archived" }));
    await act(async () => {});
    const error = new BackendError(
      code,
      "Archived read unavailable",
      code === "timeout",
      "discussion.list",
    );
    await act(async () => {
      if (error.transport) for (const listener of failures) listener(error);
      first.reject(error);
    });
    expect(view.getByText("Archived read unavailable")).toBeTruthy();
    expect(view.queryByLabelText("Loading Discussions")).toBeNull();
    expect(view.queryByText("No Discussions yet")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await act(async () => {
      next.resolve([
        { ...discussions[0], topic: "Recovered archive", archived: true },
      ]);
    });
    expect(view.getByText("Recovered archive")).toBeTruthy();
    expect(view.queryByText("Archived read unavailable")).toBeNull();
    expect(archiveCalls()).toHaveLength(2);
    expect(backend.organization).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(backend.discussions).mock.calls.filter(([value]) => !value),
    ).toHaveLength(1);
  },
);

it.each(["internal_error", "timeout"])(
  "retains archived rows and search input through refresh %s and Retry",
  async (code) => {
    const view = await readyApplication();
    const archived = [
      { ...discussions[0], topic: "Saved archive", archived: true },
    ];
    vi.mocked(backend.discussions).mockImplementation((value) =>
      Promise.resolve(value ? archived : discussions),
    );
    fireEvent.click(view.getByRole("button", { name: "Show archived" }));
    await act(async () => {});
    const input = view.getByRole("searchbox", { name: "Search messages" });
    const row = view.getByText("Saved archive");
    const refresh = deferred<DiscussionSummary[]>();
    vi.mocked(backend.discussions).mockImplementation((value) =>
      value ? refresh.promise : Promise.resolve(discussions),
    );
    await emit({ type: "mention.acked", discussion_id: 4 });
    expect(view.getByText("Saved archive")).toBe(row);
    expect(view.queryByLabelText("Loading Discussions")).toBeNull();
    await act(async () => {
      refresh.reject(
        new BackendError(
          code,
          "Archived refresh unavailable",
          code === "timeout",
          "discussion.list",
        ),
      );
    });
    expect(view.getByText("Saved archive")).toBe(row);
    expect(view.getByText("Archived refresh unavailable")).toBeTruthy();
    fireEvent.change(input, { target: { value: "saved search draft" } });
    vi.mocked(backend.discussions).mockImplementation((value) =>
      Promise.resolve(value ? archived : discussions),
    );
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(view.getByRole("searchbox", { name: "Search messages" })).toBe(
      input,
    );
    expect((input as HTMLInputElement).value).toBe("saved search draft");
    expect(view.queryByText("Archived refresh unavailable")).toBeNull();
    fireEvent.change(input, { target: { value: "" } });
    expect(view.getByText("Saved archive")).toBeTruthy();
    expect(archiveCalls()).toHaveLength(3);
  },
);

it("ignores archived reads after switching and merges every update event", async () => {
  const view = await readyApplication();
  const old = deferred<DiscussionSummary[]>();
  const next = deferred<DiscussionSummary[]>();
  let reads = 0;
  vi.mocked(backend.discussions).mockImplementation((archived) => {
    if (!archived) return Promise.resolve(discussions);
    reads += 1;
    return reads === 1
      ? old.promise
      : reads === 2
        ? next.promise
        : Promise.resolve([
            { ...discussions[0], topic: "Current archive", archived: true },
          ]);
  });
  const toggle = view.getByRole("button", { name: "Show archived" });
  fireEvent.click(toggle);
  await act(async () => {});
  fireEvent.click(toggle);
  for (const type of [
    "message.created",
    "mention.acked",
    "mention.revoked",
    "discussion.created",
    "discussion.updated",
  ])
    await emit({ type, discussion_id: 99 });
  expect(archiveCalls()).toHaveLength(1);
  fireEvent.click(toggle);
  await act(async () => {});
  for (const type of [
    "message.created",
    "mention.acked",
    "mention.revoked",
    "discussion.created",
    "discussion.updated",
  ])
    await emit({ type, discussion_id: 99 });
  expect(archiveCalls()).toHaveLength(2);
  await act(async () => {
    old.resolve([
      { ...discussions[0], topic: "Obsolete archive", archived: true },
    ]);
  });
  expect(view.queryByText("Obsolete archive")).toBeNull();
  expect(view.getByLabelText("Loading Discussions")).toBeTruthy();
  await act(async () => {
    next.resolve([
      { ...discussions[0], topic: "Next archive", archived: true },
    ]);
  });
  expect(view.getByText("Current archive")).toBeTruthy();
  expect(archiveCalls()).toHaveLength(3);
});

it("invalidates archived reads and removes subscriptions when leaving the page", async () => {
  const view = await readyApplication();
  const old = deferred<DiscussionSummary[]>();
  vi.mocked(backend.discussions).mockImplementation((archived) =>
    archived ? old.promise : Promise.resolve(discussions),
  );
  fireEvent.click(view.getByRole("button", { name: "Show archived" }));
  await act(async () => {});
  const listeners = events.size;
  fireEvent.click(view.getByRole("button", { name: "Members" }));
  expect(events.size).toBeLessThan(listeners);
  await emit({ type: "message.created", discussion_id: 99 });
  expect(archiveCalls()).toHaveLength(1);
  await act(async () => {
    old.resolve([
      { ...discussions[0], topic: "Unmounted archive", archived: true },
    ]);
  });
  fireEvent.click(view.getByRole("button", { name: /^Discussions/ }));
  expect(view.queryByText("Unmounted archive")).toBeNull();
  expect(view.getAllByText("Startup review")).toHaveLength(2);
  expect(archiveCalls()).toHaveLength(1);
});

it("retains archived rows and input across disconnect and restoration", async () => {
  const view = await readyApplication();
  const archived = [
    { ...discussions[0], topic: "Saved archive", archived: true },
  ];
  vi.mocked(backend.discussions).mockImplementation((value) =>
    Promise.resolve(value ? archived : discussions),
  );
  fireEvent.click(view.getByRole("button", { name: "Show archived" }));
  await act(async () => {});
  const old = deferred<DiscussionSummary[]>();
  let reads = 0;
  vi.mocked(backend.discussions).mockImplementation((value) =>
    value && reads++ === 0
      ? old.promise
      : Promise.resolve(value ? archived : discussions),
  );
  await emit({ type: "discussion.updated", discussion_id: 99 });
  const input = view.getByRole("searchbox", { name: "Search messages" });
  vi.spyOn(backend, "disconnected", "get").mockReturnValue(true);
  await emit({
    type: "connection.closed",
    error: new BackendError("disconnected", "Connection lost", true),
  });
  expect(view.getByText("Saved archive")).toBeTruthy();
  expect(view.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.change(input, { target: { value: "connection search draft" } });
  await act(async () => {
    old.resolve([
      { ...discussions[0], topic: "Closed archive", archived: true },
    ]);
  });
  vi.spyOn(backend, "disconnected", "get").mockReturnValue(false);
  await emit({ type: "connection.restored" });
  expect(view.getByRole("searchbox", { name: "Search messages" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("connection search draft");
  fireEvent.change(input, { target: { value: "" } });
  expect(view.queryByText("Closed archive")).toBeNull();
  expect(view.getByText("Saved archive")).toBeTruthy();
  expect(archiveCalls()).toHaveLength(3);
});

it("ends document and toolbar placeholders after an initial read failure", async () => {
  vi.spyOn(backend, "readLibrary").mockRejectedValue(
    new BackendError("internal_error", "Document unavailable"),
  );
  const view = render(
    <RouterProvider>
      <DocumentPage path="missing.md" />
    </RouterProvider>,
  );
  expect(
    view.container.querySelectorAll(".animate-breathe").length,
  ).toBeGreaterThan(0);
  await act(async () => {});
  expect(view.getByRole("alert")).toBeTruthy();
  expect(view.container.querySelectorAll(".animate-breathe")).toHaveLength(0);
});

const regions = [
  "agent",
  "execution",
  "langfuse",
  "model",
  "document",
] as const;
type Region = (typeof regions)[number];

function RegionalPanel({ region }: { region: Region }) {
  if (region === "agent") return <AgentPanel />;
  if (region === "execution") return <ExecutionPanel />;
  if (region === "langfuse") return <LangfusePanel />;
  if (region === "model")
    return (
      <TooltipProvider>
        <ModelPanel />
      </TooltipProvider>
    );
  return <DocumentPage path="guide.md" />;
}

function regionalReads() {
  const settings = vi
    .spyOn(backend, "settings")
    .mockImplementation(async (section) => {
      if (section === "agent")
        return {
          context_window_tokens: 1000,
          memory_index_bytes: 2000,
          exchange_nudge_after: 10,
          idle_streak_after: 2,
          no_tool_turns_before_pause: 3,
          max_concurrent_turns: 4,
          token_limit: 5000,
          request_limit: 6,
        };
      if (section === "execution")
        return {
          write_directories: ["/project"],
          unusable_write_directories: [],
          error: null,
        };
      return {
        enabled: false,
        base_url: "https://example.test",
        keys_set: false,
      };
    });
  const model = vi.spyOn(backend, "modelCatalog").mockResolvedValue({
    version: 2,
    providers: [],
    models: [],
    default_model_id: null,
    default_thinking: "default",
    agent_configs: {},
  });
  const documentRead = vi.spyOn(backend, "readLibrary").mockResolvedValue({
    path: "guide.md",
    content: "Saved document",
    hash: "saved-hash",
  });
  return { settings, model, documentRead };
}

function regionalRead(region: Region, reads: ReturnType<typeof regionalReads>) {
  return region === "model"
    ? reads.model
    : region === "document"
      ? reads.documentRead
      : reads.settings;
}

function regionalInput(region: Region, view: ReturnType<typeof render>) {
  if (region === "execution")
    fireEvent.click(view.getByRole("button", { name: "Add directory" }));
  const label = {
    agent: "Context window (tokens)",
    execution: "New directory path",
    langfuse: "Base URL",
    model: "Provider name",
    document: "Document",
  }[region];
  return view.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
}

it.each(regions)(
  "recovers the first %s read locally without a toast",
  async (region) => {
    const reads = regionalReads();
    const read = regionalRead(region, reads);
    read.mockRejectedValueOnce(
      new BackendError("internal_error", `${region} read unavailable`),
    );
    const view = render(
      <RouterProvider>
        <RegionalPanel region={region} />
      </RouterProvider>,
    );
    await act(async () => {});
    expect(readToasts()).toEqual([]);
    clearToasts();
    expect(view.getByRole("alert").textContent).toContain(
      `${region} read unavailable`,
    );
    const retry = view.getByRole("button", { name: "Retry" });
    expect(retry.matches(":disabled")).toBe(false);
    const retrying = deferred<never>();
    read.mockReturnValueOnce(retrying.promise);
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.container.querySelector("[aria-busy=true]")).toBeTruthy();
    await act(async () => {
      retrying.reject(new Error(`${region} retry unavailable`));
    });
    expect(view.getByRole("alert").textContent).toContain(
      `${region} retry unavailable`,
    );
    expect(view.container.querySelector("[aria-busy=true]")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
    });
    expect(view.queryByRole("alert")).toBeNull();
    expect(regionalInput(region, view)).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(3);
    expect(backend.organization).not.toHaveBeenCalled();
    expect(backend.discussions).not.toHaveBeenCalled();
    if (region === "model" || region === "document")
      expect(reads.settings).not.toHaveBeenCalled();
    if (region !== "model") expect(reads.model).not.toHaveBeenCalled();
    if (region !== "document")
      expect(reads.documentRead).not.toHaveBeenCalled();
  },
);

it.each(regions)(
  "retains the %s input through refresh failure and local Retry",
  async (region) => {
    const reads = regionalReads();
    const read = regionalRead(region, reads);
    const view = render(
      <RouterProvider>
        <RegionalPanel region={region} />
      </RouterProvider>,
    );
    await act(async () => {});
    const input = regionalInput(region, view);
    const value =
      region === "agent"
        ? "333"
        : region === "langfuse"
          ? "https://draft.test"
          : "local draft";
    fireEvent.change(input, { target: { value } });
    let publicKey: HTMLInputElement | undefined;
    let secretKey: HTMLInputElement | undefined;
    if (region === "langfuse") {
      publicKey = view.getByLabelText("Public key") as HTMLInputElement;
      secretKey = view.getByLabelText("Secret key") as HTMLInputElement;
      fireEvent.change(publicKey, { target: { value: "test-public-input" } });
      fireEvent.change(secretKey, { target: { value: "test-secret-input" } });
    }
    read.mockRejectedValueOnce(new Error(`${region} refresh unavailable`));
    await emit({ type: "connection.restored" });
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe(value);
    expect(view.getByRole("alert").textContent).toContain(
      `${region} refresh unavailable`,
    );
    expect(readToasts()).toEqual([]);
    const retry = view.getByRole("button", { name: "Retry" });
    expect(retry.matches(":disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(view.queryByRole("alert")).toBeNull();
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe(value);
    if (publicKey && secretKey) {
      expect(publicKey.value).toBe("test-public-input");
      expect(secretKey.value).toBe("test-secret-input");
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(backend.organization).not.toHaveBeenCalled();
    expect(backend.discussions).not.toHaveBeenCalled();
  },
);

it.each(regions)(
  "reports a connection failure once from %s without a local Retry",
  async (region) => {
    const reads = regionalReads();
    const failure = new BackendError("disconnected", "Connection lost", true);
    regionalRead(region, reads).mockRejectedValueOnce(failure);
    vi.spyOn(backend, "disconnected", "get").mockReturnValue(true);
    const report = vi
      .spyOn(backend, "reportFailure")
      .mockImplementation(() => {});
    const view = render(
      <RouterProvider>
        <RegionalPanel region={region} />
      </RouterProvider>,
    );
    await act(async () => {});
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.container.querySelectorAll(".animate-breathe")).toHaveLength(0);
    expect(readToasts()).toEqual([]);
  },
);

it.each([false, true])(
  "keeps Langfuse saving and its draft through an earlier read with failure=%s",
  async (fails) => {
    const reads = regionalReads();
    const earlier = deferred<Record<string, unknown>>();
    reads.settings.mockReturnValueOnce(earlier.promise);
    const view = render(<LangfusePanel />);
    await emit({ type: "connection.restored" });
    const input = view.getByLabelText("Base URL") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://saved-draft.test" } });
    const saving = deferred<Record<string, unknown>>();
    vi.spyOn(backend, "updateSettings").mockReturnValueOnce(saving.promise);
    const save = view.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    await emit({ type: "connection.restored" });
    expect(reads.settings).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (fails) earlier.reject(new Error("Outdated Langfuse read"));
      else earlier.resolve({ enabled: false, base_url: "https://old.test" });
    });
    expect(input.value).toBe("https://saved-draft.test");
    expect(save.matches(":disabled")).toBe(true);
    expect(view.queryByRole("alert")).toBeNull();
    await act(async () => {
      saving.resolve({
        enabled: false,
        base_url: "https://saved-draft.test",
        keys_set: false,
      });
    });
    expect(save.matches(":disabled")).toBe(false);
    expect(input.value).toBe("https://saved-draft.test");
    expect(readToasts()).toEqual([]);
    view.unmount();
    expect(events.size).toBe(0);
  },
);

it("keeps the shell visible on authentication failure", async () => {
  const view = render(<App />);
  await act(async () => {
    connection.reject(
      new BackendError("authentication_missing", "Open the access link"),
    );
  });
  expect(view.getByText("Fora")).toBeTruthy();
  expect(view.getByRole("button", { name: "Members" })).toBeTruthy();
  expect(view.getByText("Access to Fora requires authentication")).toBeTruthy();
  expect(view.queryByLabelText("Loading Discussions")).toBeNull();
});
