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
let backend: typeof import("@/lib/backend").backend;
let BackendError: typeof import("@/lib/backend").BackendError;
let render: typeof import("@testing-library/react").render;
let cleanup: typeof import("@testing-library/react").cleanup;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let clearToasts: typeof import("@/components/ui/toast").clearToasts;
let closeDom: () => void;
let events: Set<(event: BackendEvent) => void>;

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
  ({ clearToasts } = await import("@/components/ui/toast"));
  ({ default: App } = await import("@/App"));
  ({ OrganizationProvider } = await import("@/app/organization"));
  ({ RouterProvider, useRouter } = await import("@/app/router"));
  ({ MemberPage } = await import("@/features/members/detail"));
  ({ DocumentPage } = await import("@/features/library/document"));
}, 30000);

beforeEach(() => {
  events = new Set();
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
  vi.spyOn(backend, "onFailure").mockReturnValue(() => {});
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
