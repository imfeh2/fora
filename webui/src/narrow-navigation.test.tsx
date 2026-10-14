import { StrictMode } from "react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { backend, type DiscussionSummary, type Member } from "@/lib/backend";

const storage = vi.hoisted(() => ({ put: vi.fn(async () => {}) }));
const navigation = vi.hoisted(() => ({ requests: vi.fn() }));
vi.mock("@/app/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/router")>();
  const { useCallback } = await import("react");
  return {
    ...actual,
    useNavigate: () => {
      const navigate = actual.useNavigate();
      return useCallback(
        (route: import("@/app/router").Route) => {
          navigation.requests(route);
          navigate(route);
        },
        [navigate],
      );
    },
  };
});
vi.mock("idb", () => ({
  openDB: async () => ({
    get: async () => undefined,
    getAll: async () => [],
    put: storage.put,
    close: () => {},
  }),
}));

let testing: typeof import("@testing-library/react");
let App: typeof import("@/App").default;
let clearToasts: typeof import("@/components/ui/toast").clearToasts;
let closeDom: () => void;
let applicationRoot: HTMLElement | null = null;

async function prepareDom() {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  closeDom = () => dom.window.close();
  for (const name of [
    "window",
    "document",
    "navigator",
    "sessionStorage",
    "Element",
    "HTMLElement",
    "SVGElement",
    "ShadowRoot",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "Event",
    "EventTarget",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "AbortController",
    "AbortSignal",
    "getComputedStyle",
  ])
    vi.stubGlobal(name, name === "window" ? dom.window : dom.window[name]);
  vi.stubGlobal(
    "requestAnimationFrame",
    dom.window.requestAnimationFrame.bind(dom.window),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    dom.window.cancelAnimationFrame.bind(dom.window),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(dom.window.document, "fonts", {
    value: { ready: Promise.resolve() },
  });
  Object.defineProperty(dom.window.navigator, "locks", {
    value: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<unknown>,
      ) => callback({}),
    },
  });
  testing = await import("@testing-library/react");
  ({ default: App } = await import("@/App"));
  ({ clearToasts } = await import("@/components/ui/toast"));
}

await prepareDom();

const members: Member[] = [
  { id: 1, name: "Human", type: "human", state: "idle" },
  { id: 2, name: "ReadingAgent", type: "agent", state: "running", tokens: 0 },
];
const discussion: DiscussionSummary = {
  id: 1,
  topic: "Saved Discussion",
  member_ids: [1, 2],
  archived: false,
  unread: 3,
};

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 375,
  });
  storage.put.mockClear();
  navigation.requests.mockClear();
  vi.spyOn(backend, "connect").mockResolvedValue();
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
  vi.spyOn(backend, "onFailure").mockReturnValue(() => {});
  vi.spyOn(backend, "organization").mockResolvedValue({
    id: 1,
    uuid: "narrow-test",
    members,
    human_id: 1,
    token_limit: null,
  });
  vi.spyOn(backend, "discussions").mockResolvedValue([discussion]);
  vi.spyOn(backend, "discussionPreviews").mockImplementation(async (id) => ({
    discussion_id: id,
    previews: [],
    has_more: false,
    next_before: null,
  }));
  vi.spyOn(backend, "modelCatalog").mockResolvedValue({
    version: 2,
    providers: [],
    models: [],
    default_model_id: null,
    default_thinking: "default",
    agent_configs: {},
  });
  vi.spyOn(backend, "settings").mockResolvedValue({
    context_window_tokens: 8192,
    memory_index_bytes: 64000,
    exchange_nudge_after: 24,
    idle_streak_after: 3,
    no_tool_turns_before_pause: 5,
    max_concurrent_turns: 4,
    token_limit: 100000,
    request_limit: 0,
  });
});

afterEach(async () => {
  testing.cleanup();
  applicationRoot = null;
  clearToasts();
  await testing.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  vi.restoreAllMocks();
});
afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

function requiredElement<T extends Element>(element: T | null): T {
  if (!element) throw new Error("Expected an element");
  return element;
}

function navigationTrigger() {
  const root = requiredElement(applicationRoot);
  expect(root.isConnected).toBe(true);
  const button = requiredElement(
    root.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]'),
  );
  return testing
    .within(requiredElement(button.parentElement))
    .getByRole("button", { name: "Open navigation" });
}

async function mount() {
  await testing.act(async () => {
    applicationRoot = testing.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ).container;
  });
  return navigationTrigger();
}
async function openNavigation(trigger = navigationTrigger()) {
  await testing.act(async () => {
    trigger.focus();
    testing.fireEvent.click(trigger);
  });
  const dialog = await testing.screen.findByRole("dialog", {
    name: "Navigation",
  });
  const close = testing
    .within(dialog)
    .getByRole("button", { name: "Close navigation" });
  await testing.waitFor(() => expect(document.activeElement).toBe(close));
  return dialog;
}
async function closedNavigation(knownTrigger?: HTMLElement) {
  await testing.waitFor(() =>
    expect(
      testing.screen.queryByRole("dialog", { name: "Navigation" }),
    ).toBeNull(),
  );
  const trigger = knownTrigger ?? navigationTrigger();
  await testing.waitFor(() => {
    expect(trigger.isConnected).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });
}
async function resize(width: number) {
  await testing.act(async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    });
    window.dispatchEvent(new Event("resize"));
  });
}

it("keeps every navigation entry accessible and traps Tab around the drawer", async () => {
  const trigger = await mount();
  const dialog = await openNavigation(trigger);
  const scope = testing.within(dialog);
  const [discussions, savedDiscussion, , , settings] = [
    /Discussions\s*3/,
    /Saved Discussion\s*3/,
    "Members",
    "Library",
    "Settings",
    "New Discussion",
  ].map((name) => {
    const button = scope.getByRole("button", { name });
    expect(button).toBeDefined();
    return button;
  });
  expect(
    testing.screen.getAllByRole("button", { name: "Members" }),
  ).toHaveLength(1);
  const close = scope.getByRole("button", { name: "Close navigation" });
  testing.act(() => settings.focus());
  testing.fireEvent.keyDown(settings, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  testing.fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(settings);
  const navigation = scope.getByRole("navigation", { name: "Sections" });
  for (const button of navigation.querySelectorAll("button"))
    Object.defineProperty(button, "offsetParent", {
      configurable: true,
      value: navigation,
    });
  testing.act(() => discussions.focus());
  testing.fireEvent.keyDown(discussions, { key: "ArrowDown" });
  expect(document.activeElement).toBe(savedDiscussion);
});

it.each(["button", "escape", "overlay"])(
  "closes with %s and restores the public trigger",
  async (path) => {
    await mount();
    const dialog = await openNavigation();
    if (path === "button")
      testing.fireEvent.click(
        testing
          .within(dialog)
          .getByRole("button", { name: "Close navigation" }),
      );
    if (path === "escape")
      testing.fireEvent.keyDown(requiredElement(document.activeElement), {
        key: "Escape",
      });
    if (path === "overlay") {
      await testing.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      const overlay = requiredElement(dialog.previousElementSibling);
      testing.fireEvent.pointerDown(overlay, { pointerType: "mouse" });
      testing.fireEvent.click(overlay);
    }
    await closedNavigation();
  },
);

it("preserves the page, search draft and reading position through every boundary", async () => {
  const trigger = await mount();
  const toolbar = requiredElement(trigger.parentElement);
  const dialog = await openNavigation(trigger);
  testing.fireEvent.click(
    testing.within(dialog).getByRole("button", { name: "Members" }),
  );
  await closedNavigation(trigger);
  const main = await testing.screen.findByRole("main");
  const page = testing.within(main);
  await page.findByRole("heading", { name: "Members" });
  const input = page.getByRole("searchbox", {
    name: "Search Members",
  }) as HTMLInputElement;
  testing.fireEvent.change(input, { target: { value: "Human" } });
  const body = requiredElement(main.lastElementChild);
  body.scrollTop = 123;
  for (const width of [639, 640, 641, 375]) {
    if (width === 641)
      await openNavigation(
        testing
          .within(toolbar)
          .getByRole("button", { name: "Open navigation" }),
      );
    await resize(width);
    const currentTrigger =
      width === 641
        ? null
        : testing
            .within(toolbar)
            .getByRole("button", { name: "Open navigation" });
    if (currentTrigger) await openNavigation(currentTrigger);
    if (width === 641) {
      await testing.waitFor(() =>
        expect(
          testing.screen.queryByRole("dialog", { name: "Navigation" }),
        ).toBeNull(),
      );
      await testing.waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-current")).toBe(
          "page",
        ),
      );
    } else if (testing.screen.queryByRole("dialog", { name: "Navigation" })) {
      testing.fireEvent.keyDown(requiredElement(document.activeElement), {
        key: "Escape",
      });
      await closedNavigation(currentTrigger ?? undefined);
    }
    expect(page.getByRole("searchbox", { name: "Search Members" })).toBe(input);
    expect(input.value).toBe("Human");
    expect(body.scrollTop).toBe(123);
  }
});

it("opens creation only after the drawer closes and restores focus after cancellation", async () => {
  await mount();
  const dialog = await openNavigation();
  testing.fireEvent.click(
    testing.within(dialog).getByRole("button", { name: "New Discussion" }),
  );
  const topic = await testing.screen.findByRole("textbox", { name: "Topic" });
  await testing.waitFor(() => expect(document.activeElement).toBe(topic));
  expect(testing.screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    testing.screen.queryByRole("dialog", { name: "Navigation" }),
  ).toBeNull();
  testing.fireEvent.click(
    testing.screen.getByRole("button", { name: "Cancel" }),
  );
  await closedNavigation();
});

it("keeps close controls available while Settings navigation is restricted", async () => {
  let finish!: (value: Record<string, unknown>) => void;
  vi.spyOn(backend, "updateSettings").mockImplementation(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  const drawer = await openNavigation();
  testing.fireEvent.click(
    testing.within(drawer).getByRole("button", { name: "Settings" }),
  );
  await testing.screen.findByRole("heading", { name: "Settings" });
  await closedNavigation();
  const sameRoute = await openNavigation();
  testing.fireEvent.click(
    testing.within(sameRoute).getByRole("button", { name: "Settings" }),
  );
  await closedNavigation();
  testing.fireEvent.click(testing.screen.getByRole("tab", { name: "Agent" }));
  const field = await testing.screen.findByLabelText("Model requests per Turn");
  testing.fireEvent.change(field, { target: { value: "1" } });
  testing.fireEvent.click(testing.screen.getByRole("button", { name: "Save" }));
  await testing.waitFor(() =>
    expect(backend.updateSettings).toHaveBeenCalled(),
  );
  const navigation = await openNavigation();
  testing.fireEvent.click(
    testing.within(navigation).getByRole("button", { name: "Library" }),
  );
  expect(testing.screen.getByRole("dialog", { name: "Navigation" })).toBe(
    navigation,
  );
  testing.fireEvent.keyDown(requiredElement(document.activeElement), {
    key: "Escape",
  });
  await closedNavigation();
  expect(
    testing.screen.getByRole("heading", { name: "Settings" }),
  ).toBeDefined();
  await testing.act(async () => {
    finish({});
  });
});

it("removes all viewport subscriptions on StrictMode unmount", async () => {
  const added = vi.spyOn(window, "addEventListener");
  const removed = vi.spyOn(window, "removeEventListener");
  await mount();
  testing.cleanup();
  const subscriptions = added.mock.calls.filter(([type]) => type === "resize");
  const removals = removed.mock.calls.filter(([type]) => type === "resize");
  expect(subscriptions.length).toBeGreaterThan(0);
  expect(removals).toHaveLength(subscriptions.length);
  for (const [, listener] of subscriptions)
    expect(removals.some(([, candidate]) => candidate === listener)).toBe(true);
});

it("moves focus to the ready Composer after a created Discussion", async () => {
  vi.spyOn(backend, "createDiscussion").mockResolvedValue({
    ...discussion,
    id: 2,
    topic: "New topic",
    unread: 0,
  });
  vi.spyOn(backend, "discussionPage").mockResolvedValue({
    id: 2,
    messages: [],
    read_through: 0,
    latest_id: 0,
    has_before: false,
    has_after: false,
    previous_sender_id: null,
    awaiting_ack: [],
    acknowledged: [],
    pending_count: 0,
    metadata: {
      topic: "New topic",
      archived: false,
      members: [
        { id: 1, name: "Human" },
        { id: 2, name: "ReadingAgent" },
      ],
    },
  });
  await mount();
  const dialog = await openNavigation();
  testing.fireEvent.click(
    testing.within(dialog).getByRole("button", { name: "New Discussion" }),
  );
  testing.fireEvent.change(
    await testing.screen.findByRole("textbox", { name: "Topic" }),
    { target: { value: "New topic" } },
  );
  testing.fireEvent.click(
    testing.screen.getByRole("checkbox", { name: /ReadingAgent\s*Agent/ }),
  );
  testing.fireEvent.click(
    testing.screen.getByRole("button", { name: "Create Discussion" }),
  );
  const input = await testing.screen.findByRole("combobox", {
    name: "Message",
  });
  await testing.waitFor(() => expect(document.activeElement).toBe(input));
  expect(backend.createDiscussion).toHaveBeenCalledWith("New topic", [2]);
  expect(testing.screen.queryByRole("dialog")).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const created: DiscussionSummary = {
  ...discussion,
  id: 2,
  topic: "Created topic",
  unread: 0,
};
const createdPage = {
  id: created.id,
  messages: [],
  read_through: 0,
  latest_id: 0,
  has_before: false,
  has_after: false,
  previous_sender_id: null,
  awaiting_ack: [],
  acknowledged: [],
  pending_count: 0,
  metadata: {
    topic: created.topic,
    archived: false,
    members: members.map(({ id, name }) => ({ id, name })),
  },
};
const entries = ["navigation", "page"] as const;
const closingPaths = ["Cancel", "Close", "Escape", "overlay"] as const;

type CreationDialog = {
  root: HTMLElement;
  topic: HTMLElement;
  member: HTMLElement;
  submit: HTMLElement;
  opener: HTMLElement;
};

async function openCreation(
  entry: (typeof entries)[number],
): Promise<CreationDialog> {
  let opener: HTMLElement;
  if (entry === "navigation") {
    opener = navigationTrigger();
    const drawer = await openNavigation(opener);
    const create = testing
      .within(drawer)
      .getByRole("button", { name: "New Discussion" });
    await testing.act(async () => testing.fireEvent.click(create));
  } else {
    const page = testing.screen.getByRole("main");
    opener = testing.within(page).getByRole("button", {
      name: "New Discussion",
    });
    await testing.act(async () => {
      opener.focus();
      testing.fireEvent.click(opener);
    });
  }
  const dialog = await testing.screen.findByRole("dialog", {
    name: "New Discussion",
  });
  const scope = testing.within(dialog);
  const topic = scope.getByRole("textbox", { name: "Topic" });
  const member = scope.getByRole("checkbox", { name: /ReadingAgent\s*Agent/ });
  const submit = scope.getByRole("button", { name: "Create Discussion" });
  await testing.waitFor(() => expect(document.activeElement).toBe(topic));
  expect(testing.screen.getAllByRole("dialog")).toHaveLength(1);
  return { root: dialog, topic, member, submit, opener };
}

function fillCreation(dialog: CreationDialog, topic = created.topic) {
  expect(dialog.root.isConnected).toBe(true);
  testing.fireEvent.change(dialog.topic, { target: { value: topic } });
  testing.fireEvent.click(dialog.member);
  expect(dialog.submit.isConnected).toBe(true);
  return dialog.submit;
}

async function closeCreation(
  dialog: CreationDialog,
  path: (typeof closingPaths)[number],
  entry: (typeof entries)[number],
) {
  if (path === "Escape")
    await testing.act(async () =>
      testing.fireEvent.keyDown(dialog.topic, { key: "Escape" }),
    );
  else if (path === "overlay") {
    await testing.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const overlay = requiredElement(dialog.root.previousElementSibling);
    await testing.act(async () => {
      testing.fireEvent.pointerDown(overlay, { pointerType: "mouse" });
      testing.fireEvent.click(overlay);
    });
  } else {
    const close = testing
      .within(dialog.root)
      .getByRole("button", { name: path });
    await testing.act(async () => testing.fireEvent.click(close));
  }
  await testing.waitFor(() =>
    expect(testing.screen.queryByRole("dialog")).toBeNull(),
  );
  const trigger = testing
    .within(requiredElement(dialog.opener.parentElement))
    .getByRole("button", {
      name: entry === "navigation" ? "Open navigation" : "New Discussion",
    });
  expect(trigger).toBe(dialog.opener);
  await testing.waitFor(() => expect(document.activeElement).toBe(trigger));
}

it.each(entries)(
  "delivers one creation and ready Composer focus from %s after waiting and failure recovery",
  async (entry) => {
    const failed = deferred<DiscussionSummary>();
    const succeeded = deferred<DiscussionSummary>();
    const page = deferred<typeof createdPage>();
    vi.spyOn(backend, "createDiscussion")
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(succeeded.promise);
    vi.spyOn(backend, "discussionPage").mockReturnValue(page.promise);
    await mount();
    const dialog = await openCreation(entry);
    const submit = fillCreation(dialog);
    const topic = dialog.topic as HTMLInputElement;
    testing.fireEvent.click(submit);
    testing.fireEvent.click(submit);
    expect(backend.createDiscussion).toHaveBeenCalledOnce();
    expect(topic.readOnly).toBe(true);
    expect(document.activeElement).toBe(topic);
    expect(navigation.requests).not.toHaveBeenCalled();
    await testing.act(async () => failed.reject(new Error("Creation failed")));
    expect(await testing.screen.findByText("Creation failed")).toBeDefined();
    expect(topic.value).toBe(created.topic);
    expect(topic.readOnly).toBe(false);
    expect(document.activeElement).toBe(topic);
    testing.fireEvent.click(submit);
    testing.fireEvent.click(submit);
    expect(backend.createDiscussion).toHaveBeenCalledTimes(2);
    await testing.act(async () => succeeded.resolve(created));
    await testing.waitFor(() =>
      expect(testing.screen.queryByRole("dialog")).toBeNull(),
    );
    expect(navigation.requests).toHaveBeenCalledExactlyOnceWith({
      name: "discussion",
      id: created.id,
    });
    const input = (await testing.screen.findByRole("combobox", {
      name: "Message",
    })) as HTMLTextAreaElement;
    await testing.act(async () => page.resolve(createdPage));
    await testing.waitFor(() => expect(document.activeElement).toBe(input));
    testing.fireEvent.change(input, { target: { value: "Saved draft" } });
    const trigger = navigationTrigger();
    testing.act(() => trigger.focus());
    await resize(640);
    expect(input.value).toBe("Saved draft");
    expect(document.activeElement).toBe(trigger);
    expect(navigation.requests).toHaveBeenCalledOnce();
  },
);

it.each(
  entries.flatMap((entry) => closingPaths.map((path) => ({ entry, path }))),
)(
  "keeps a cancelled $entry operation separate after $path and late success",
  async ({ entry, path }) => {
    const pending = deferred<DiscussionSummary>();
    vi.spyOn(backend, "createDiscussion").mockReturnValue(pending.promise);
    vi.spyOn(backend, "discussionPage").mockResolvedValue(createdPage);
    await mount();
    const dialog = await openCreation(entry);
    const submit = fillCreation(dialog);
    testing.fireEvent.click(submit);
    testing.fireEvent.click(submit);
    expect(backend.createDiscussion).toHaveBeenCalledOnce();
    await closeCreation(dialog, path, entry);
    await testing.act(async () => pending.resolve(created));
    expect(navigation.requests).not.toHaveBeenCalled();
    expect(backend.discussionPage).not.toHaveBeenCalled();
    expect(
      testing.screen.getByRole("heading", { name: "Discussions" }),
    ).toBeDefined();
    const reopened = await openCreation(entry);
    expect(
      (
        testing
          .within(reopened.root)
          .getByRole("textbox", { name: "Topic" }) as HTMLInputElement
      ).value,
    ).toBe("");
    await closeCreation(reopened, path, entry);
    expect(navigation.requests).not.toHaveBeenCalled();
    expect(backend.createDiscussion).toHaveBeenCalledOnce();
  },
);

it.each(
  entries.flatMap((entry) => closingPaths.map((path) => ({ entry, path }))),
)(
  "keeps a reopened $entry operation independent after $path and late failure",
  async ({ entry, path }) => {
    const old = deferred<DiscussionSummary>();
    const current = deferred<DiscussionSummary>();
    vi.spyOn(backend, "createDiscussion")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    vi.spyOn(backend, "discussionPage").mockResolvedValue(createdPage);
    await mount();
    const dialog = await openCreation(entry);
    testing.fireEvent.click(fillCreation(dialog, "Cancelled topic"));
    await closeCreation(dialog, path, entry);
    const reopened = await openCreation(entry);
    const submit = fillCreation(reopened);
    testing.fireEvent.click(submit);
    await testing.act(async () =>
      old.reject(new Error("Cancelled request failed")),
    );
    expect(testing.screen.queryByText("Cancelled request failed")).toBeNull();
    expect(testing.screen.getByRole("dialog", { name: "New Discussion" })).toBe(
      reopened.root,
    );
    expect(
      (
        testing
          .within(reopened.root)
          .getByRole("textbox", { name: "Topic" }) as HTMLInputElement
      ).readOnly,
    ).toBe(true);
    testing.fireEvent.click(submit);
    expect(backend.createDiscussion).toHaveBeenCalledTimes(2);
    expect(navigation.requests).not.toHaveBeenCalled();
    await testing.act(async () => current.resolve(created));
    const input = await testing.screen.findByRole("combobox", {
      name: "Message",
    });
    await testing.waitFor(() => expect(document.activeElement).toBe(input));
    expect(navigation.requests).toHaveBeenCalledExactlyOnceWith({
      name: "discussion",
      id: created.id,
    });
  },
);

it.each(entries)(
  "keeps a reopened %s operation independent from an earlier success",
  async (entry) => {
    const old = deferred<DiscussionSummary>();
    const current = deferred<DiscussionSummary>();
    vi.spyOn(backend, "createDiscussion")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    vi.spyOn(backend, "discussionPage").mockResolvedValue(createdPage);
    await mount();
    const dialog = await openCreation(entry);
    testing.fireEvent.click(fillCreation(dialog, "Cancelled topic"));
    await closeCreation(dialog, "Cancel", entry);
    const reopened = await openCreation(entry);
    const submit = fillCreation(reopened);
    await testing.act(async () => old.resolve({ ...created, id: 3 }));
    expect(navigation.requests).not.toHaveBeenCalled();
    expect(
      (
        testing
          .within(reopened.root)
          .getByRole("textbox", { name: "Topic" }) as HTMLInputElement
      ).value,
    ).toBe(created.topic);
    testing.fireEvent.click(submit);
    expect(backend.createDiscussion).toHaveBeenCalledTimes(2);
    await testing.act(async () => current.resolve(created));
    const input = await testing.screen.findByRole("combobox", {
      name: "Message",
    });
    await testing.waitFor(() => expect(document.activeElement).toBe(input));
    expect(navigation.requests).toHaveBeenCalledExactlyOnceWith({
      name: "discussion",
      id: created.id,
    });
  },
);

it.each(["success", "failure"])(
  "cleans up a pending creation before late %s under StrictMode",
  async (outcome) => {
    const pending = deferred<DiscussionSummary>();
    vi.spyOn(backend, "createDiscussion").mockReturnValue(pending.promise);
    await mount();
    const dialog = await openCreation("navigation");
    testing.fireEvent.click(fillCreation(dialog));
    testing.cleanup();
    await testing.act(async () => {
      if (outcome === "success") pending.resolve(created);
      else pending.reject(new Error("Unmounted request failed"));
    });
    expect(navigation.requests).not.toHaveBeenCalled();
    expect(testing.screen.queryByText("Unmounted request failed")).toBeNull();
  },
);
