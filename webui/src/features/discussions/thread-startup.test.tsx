import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { Draft, DraftController } from "@/features/discussions/draft";
import type { BackendEvent, DiscussionPage, Member } from "@/lib/backend";

const storage = vi.hoisted(() => ({
  get: vi.fn(),
  getAll: vi.fn(),
  put: vi.fn(),
  close: vi.fn(),
}));
vi.mock("idb", () => ({ openDB: async () => storage }));

let App: typeof import("@/App").default;
let backend: typeof import("@/lib/backend").backend;
let BackendError: typeof import("@/lib/backend").BackendError;
let drafts: typeof import("@/features/discussions/draft");
let useDraft: typeof drafts.useDraft;
let controller: DraftController | null;
let testing: typeof import("@testing-library/react");
let clearToasts: typeof import("@/components/ui/toast").clearToasts;
let closeDom: () => void;
let events: Set<(event: BackendEvent) => void>;
let disconnected: boolean;
let discussionId = 1000;
let read: ReturnType<typeof deferred<DiscussionPage>>;
let draft: Draft;

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
  uuid: "composer-startup",
  members,
  human_id: 7,
  token_limit: 100,
};

function page(knownMembers = members): DiscussionPage {
  return {
    id: discussionId,
    messages: [],
    latest_id: 0,
    read_through: 0,
    first_unread_id: null,
    has_before: false,
    has_after: false,
    previous_sender_id: null,
    awaiting_ack: [],
    acknowledged: [],
    pending_count: 0,
    metadata: {
      topic: "Composer review",
      archived: false,
      members: knownMembers,
    },
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
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
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
    "File",
  ])
    vi.stubGlobal(name, dom.window[name]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("getComputedStyle", () => ({
    lineHeight: "20px",
    paddingTop: "12px",
    paddingBottom: "12px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<unknown>,
      ) => callback({}),
    },
  });
  testing = await import("@testing-library/react");
  ({ backend, BackendError } = await import("@/lib/backend"));
  drafts = await import("@/features/discussions/draft");
  useDraft = drafts.useDraft;
  ({ clearToasts } = await import("@/components/ui/toast"));
  ({ default: App } = await import("@/App"));
}, 30000);

beforeEach(() => {
  discussionId += 1;
  disconnected = false;
  events = new Set();
  read = deferred<DiscussionPage>();
  draft = {
    key: "test",
    updatedAt: 0,
    body: "Saved draft",
    bodyRevision: 0,
    files: [],
    pending: null,
  };
  storage.get.mockReset().mockImplementation(async (_store, key) => ({
    ...draft,
    key,
  }));
  storage.getAll.mockReset().mockResolvedValue([]);
  storage.put.mockReset().mockResolvedValue(undefined);
  storage.close.mockReset();
  controller = null;
  vi.spyOn(drafts, "useDraft").mockImplementation((id) => {
    const result = useDraft(id);
    controller = result.controller;
    return result;
  });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.spyOn(backend, "connect").mockResolvedValue();
  vi.spyOn(backend, "disconnected", "get").mockImplementation(
    () => disconnected,
  );
  vi.spyOn(backend, "organization").mockResolvedValue(organization);
  vi.spyOn(backend, "discussions").mockResolvedValue([
    {
      id: discussionId,
      topic: "Composer review",
      member_ids: [7, 8],
      unread: 0,
      archived: false,
    },
  ]);
  vi.spyOn(backend, "discussionPage").mockReturnValue(read.promise);
  vi.spyOn(backend, "discussionPreviews").mockImplementation(async (id) => ({
    discussion_id: id,
    previews: [],
    has_more: false,
    next_before: null,
  }));
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    events.add(listener);
    return () => events.delete(listener);
  });
  vi.spyOn(backend, "onFailure").mockReturnValue(() => {});
});

afterEach(() => {
  testing.cleanup();
  clearToasts();
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

async function openThread() {
  const view = testing.render(<App />);
  await testing.act(async () => {});
  testing.fireEvent.click(view.getAllByText("Composer review")[0]);
  await testing.act(async () => {});
  return view;
}

function input(view: Awaited<ReturnType<typeof openThread>>) {
  return view.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
}

function observeSend() {
  if (!controller) throw new Error("DraftController is unavailable");
  return vi.spyOn(controller, "send");
}

async function emit(event: BackendEvent) {
  await testing.act(async () => {
    for (const listener of events) listener(event);
  });
}

it("places one composer placeholder at the bottom while identity is unknown", async () => {
  const identity = deferred<typeof organization>();
  vi.mocked(backend.organization).mockReturnValue(identity.promise);
  const view = await openThread();
  const placeholder = view.getByLabelText("Loading message composer");
  expect(placeholder.parentElement?.parentElement?.className).toContain(
    "absolute inset-x-4 bottom-4",
  );
  expect(placeholder.querySelector(".h-12")).toBeTruthy();
  expect(view.queryByRole("group", { name: "Message composer" })).toBeNull();
  expect(backend.discussionPage).not.toHaveBeenCalled();
  await testing.act(async () => identity.resolve(organization));
  expect(view.queryByLabelText("Loading message composer")).toBeNull();
  expect(view.getAllByRole("group", { name: "Message composer" })).toHaveLength(
    1,
  );
  expect(view.getByLabelText("Loading Discussion")).toBeTruthy();
  expect(view.queryByLabelText("Sending message")).toBeNull();
});

it("keeps the waiting Composer editable while every send action is disabled", async () => {
  draft.files = [
    {
      id: "saved-file",
      clientId: "saved-upload",
      file: new File(["content"], "saved.txt", { type: "text/plain" }),
    },
  ];
  const createUpload = vi.spyOn(backend, "createUpload");
  const sendVisible = vi.spyOn(backend, "sendVisible");
  const view = await openThread();
  const send = observeSend();
  const field = input(view);
  expect(field.disabled).toBe(false);
  expect(view.getByText("saved.txt")).toBeTruthy();
  expect(view.getAllByRole("group", { name: "Message composer" })).toHaveLength(
    1,
  );
  expect(
    view.getByLabelText("Loading Discussion").querySelector(".h-12"),
  ).toBeNull();
  expect(view.queryByLabelText("Sending message")).toBeNull();
  field.focus();
  testing.fireEvent.change(field, { target: { value: "Waiting draft" } });
  field.setSelectionRange(2, 5);
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }])
    testing.fireEvent.keyDown(field, { key: "Enter", ...modifiers });
  const button = view.getByRole("button", {
    name: "Send · Enter",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  testing.fireEvent.click(button);
  await testing.act(async () => {});
  expect(send).not.toHaveBeenCalled();
  expect(createUpload).not.toHaveBeenCalled();
  expect(sendVisible).not.toHaveBeenCalled();
  expect(storage.put.mock.calls.every(([, value]) => !value.pending)).toBe(
    true,
  );
  await testing.act(async () => read.resolve(page()));
  expect(input(view)).toBe(field);
  expect(field.value).toBe("Waiting draft");
  expect(field.selectionStart).toBe(2);
  expect(field.selectionEnd).toBe(5);
  expect(document.activeElement).toBe(field);
  expect(view.getByText("saved.txt")).toBeTruthy();
  expect(button.disabled).toBe(false);
  expect(view.queryByLabelText("Loading Discussion")).toBeNull();
  expect(view.queryByLabelText("Sending message")).toBeNull();
});

it("retains draft, selection and focus through initial failure and Retry", async () => {
  const view = await openThread();
  const field = input(view);
  field.focus();
  testing.fireEvent.change(field, { target: { value: "Failure draft" } });
  field.setSelectionRange(1, 4);
  await testing.act(async () => {
    read.reject(new BackendError("internal_error", "Messages unavailable"));
  });
  expect(view.queryByLabelText("Loading Discussion")).toBeNull();
  expect(view.queryByLabelText("Sending message")).toBeNull();
  expect(input(view)).toBe(field);
  const next = deferred<DiscussionPage>();
  vi.mocked(backend.discussionPage).mockReturnValue(next.promise);
  testing.fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(input(view)).toBe(field);
  expect(field.value).toBe("Failure draft");
  await testing.act(async () => next.resolve(page()));
  expect(field.selectionStart).toBe(1);
  expect(field.selectionEnd).toBe(4);
  expect(document.activeElement).toBe(field);
  expect(
    (view.getByRole("button", { name: "Send · Enter" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("blocks pending retries without changing their identity and keeps cancellation available", async () => {
  draft.pending = {
    id: "saved-attempt",
    body: "Saved draft",
    bodyRevision: 0,
    files: [],
    phase: "sending",
  };
  vi.spyOn(backend, "sendStatus").mockResolvedValue({
    state: "unknown",
    message: null,
  });
  vi.spyOn(backend, "cancelSend").mockResolvedValue({
    state: "cancelled",
    message: null,
  });
  const view = await openThread();
  const send = observeSend();
  const field = input(view);
  const retry = view.getByRole("button", {
    name: "Retry send",
  }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  testing.fireEvent.click(retry);
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }])
    testing.fireEvent.keyDown(field, { key: "Enter", ...modifiers });
  await testing.act(async () => {});
  expect(send).not.toHaveBeenCalled();
  expect(storage.put).not.toHaveBeenCalled();
  expect(view.queryByLabelText("Sending message")).toBeNull();
  testing.fireEvent.click(view.getByRole("button", { name: "Check result" }));
  await testing.act(async () => {});
  expect(backend.sendStatus).toHaveBeenCalledTimes(2);
  testing.fireEvent.click(view.getByRole("button", { name: "Cancel send" }));
  await testing.act(async () => {});
  expect(backend.cancelSend).toHaveBeenCalledWith(
    discussionId,
    "saved-attempt",
  );
  expect(view.queryByRole("button", { name: "Retry send" })).toBeNull();
  expect(field.value).toBe("Saved draft");
  expect(send).not.toHaveBeenCalled();
});

it("keeps draft and focus through disconnect and restoration while sends stay idle", async () => {
  const view = await openThread();
  await testing.act(async () => read.resolve(page()));
  const field = input(view);
  field.focus();
  testing.fireEvent.change(field, { target: { value: "Connection draft" } });
  field.setSelectionRange(3, 8);
  const send = observeSend();
  disconnected = true;
  await emit({
    type: "connection.closed",
    error: new BackendError("disconnected", "Connection lost", true),
  });
  testing.fireEvent.keyDown(field, { key: "Enter" });
  expect(send).not.toHaveBeenCalled();
  expect(view.queryByLabelText("Sending message")).toBeNull();
  expect(
    (view.getByRole("button", { name: "Send · Enter" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  disconnected = false;
  vi.mocked(backend.discussionPage).mockResolvedValue(page());
  await emit({ type: "connection.restored" });
  expect(input(view)).toBe(field);
  expect(field.value).toBe("Connection draft");
  expect(field.selectionStart).toBe(3);
  expect(field.selectionEnd).toBe(8);
  expect(document.activeElement).toBe(field);
  expect(view.queryByLabelText("Sending message")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it("restricts sending when the Human is absent from the loaded Discussion", async () => {
  const view = await openThread();
  const send = observeSend();
  await testing.act(async () => read.resolve(page([members[1]])));
  const field = input(view);
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }])
    testing.fireEvent.keyDown(field, { key: "Enter", ...modifiers });
  const button = view.getByRole("button", {
    name: "Send · Enter",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  testing.fireEvent.click(button);
  expect(send).not.toHaveBeenCalled();
  expect(view.queryByLabelText("Sending message")).toBeNull();
  expect(field.value).toBe("Saved draft");
});

it("preserves the saved pending identity until a permitted Retry sends once", async () => {
  draft.pending = {
    id: "saved-retry-attempt",
    body: "Saved draft",
    bodyRevision: 0,
    files: [],
    phase: "sending",
  };
  vi.spyOn(backend, "sendStatus").mockResolvedValue({
    state: "unknown",
    message: null,
  });
  vi.spyOn(backend, "sendVisible").mockResolvedValue({ id: 1 });
  const view = await openThread();
  const send = observeSend();
  const retry = view.getByRole("button", {
    name: "Retry send",
  }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect(backend.sendVisible).not.toHaveBeenCalled();
  await testing.act(async () => read.resolve(page()));
  expect(retry.disabled).toBe(false);
  testing.fireEvent.click(retry);
  await testing.act(async () => {});
  expect(send).toHaveBeenCalledTimes(1);
  expect(backend.sendVisible).toHaveBeenCalledExactlyOnceWith(
    discussionId,
    "Saved draft",
    [],
    "saved-retry-attempt",
  );
  expect(view.queryByRole("button", { name: "Retry send" })).toBeNull();
  expect(input(view).value).toBe("");
});

it("retains real sending status during disconnect and keeps the saved attempt", async () => {
  const view = await openThread();
  await testing.act(async () => read.resolve(page()));
  const sent = deferred<Awaited<ReturnType<typeof backend.sendVisible>>>();
  vi.spyOn(backend, "sendVisible").mockReturnValue(sent.promise);
  testing.fireEvent.click(view.getByRole("button", { name: "Send · Enter" }));
  await testing.act(async () => {});
  const pending =
    storage.put.mock.calls[storage.put.mock.calls.length - 1]?.[1].pending;
  expect(pending.phase).toBe("sending");
  disconnected = true;
  await emit({
    type: "connection.closed",
    error: new BackendError("disconnected", "Connection lost", true),
  });
  expect(view.getByLabelText("Sending message")).toBeTruthy();
  await testing.act(async () => {
    sent.reject(new BackendError("unconfirmed", "Send result unknown", true));
  });
  expect(view.queryByLabelText("Sending message")).toBeNull();
  expect(view.getByRole("button", { name: "Check result" })).toBeTruthy();
  const retry = view.getByRole("button", {
    name: "Retry send",
  }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  const persisted =
    storage.put.mock.calls[storage.put.mock.calls.length - 1]?.[1].pending;
  expect(persisted.id).toBe(pending.id);
  expect(input(view).value).toBe("Saved draft");
});

it.each(["success", "failure"])(
  "shows real Sending message until send %s completes",
  async (result) => {
    const view = await openThread();
    await testing.act(async () => read.resolve(page()));
    const sent = deferred<Awaited<ReturnType<typeof backend.sendVisible>>>();
    vi.spyOn(backend, "sendVisible").mockReturnValue(sent.promise);
    testing.fireEvent.click(view.getByRole("button", { name: "Send · Enter" }));
    await testing.act(async () => {});
    expect(view.getByLabelText("Sending message")).toBeTruthy();
    expect(backend.sendVisible).toHaveBeenCalledTimes(1);
    const field = input(view);
    field.focus();
    testing.fireEvent.change(field, {
      target: { value: "Edited during send" },
    });
    await testing.act(async () => {
      if (result === "failure")
        sent.reject(new BackendError("internal_error", "Send unavailable"));
      else sent.resolve({ id: 1 });
    });
    expect(view.queryByLabelText("Sending message")).toBeNull();
    expect(input(view)).toBe(field);
    expect(field.value).toBe("Edited during send");
    expect(document.activeElement).toBe(field);
    if (result === "failure")
      expect(view.getByText("Send unavailable")).toBeTruthy();
    else expect(view.queryByRole("button", { name: "Retry send" })).toBeNull();
  },
);
