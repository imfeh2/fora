import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { Composer } from "@/features/discussions/composer";
import {
  type Draft,
  type SendDraft,
  useDraft,
} from "@/features/discussions/draft";
import {
  draftDatabase,
  OwnedDraftStore,
} from "@/features/discussions/draft-storage";
import { backend } from "@/lib/backend";

let cleanup: typeof import("@testing-library/react").cleanup;
let render: typeof import("@testing-library/react").render;
let renderHook: typeof import("@testing-library/react").renderHook;
let screen: typeof import("@testing-library/react").screen;
let waitFor: typeof import("@testing-library/react").waitFor;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let closeDom: () => void;

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://100.80.240.31:2461/",
  });
  closeDom = () => dom.window.close();
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("getComputedStyle", () => ({
    borderBottomWidth: "0px",
    borderTopWidth: "0px",
    lineHeight: "20px",
    paddingBottom: "12px",
    paddingTop: "12px",
  }));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  ({ cleanup, render, renderHook, screen, waitFor, act, fireEvent } =
    await import("@testing-library/react"));
}, 30000);

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.spyOn(backend, "organization").mockResolvedValue({
    uuid: "http-organization",
    human_id: 1,
  } as Awaited<ReturnType<typeof backend.organization>>);
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
});

afterEach(async () => {
  await act(async () => cleanup());
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

async function seed(id: number, extra: Partial<Draft> = {}) {
  const previous: Draft = {
    key: `http-organization:1:${id}:previous-document`,
    updatedAt: 100,
    body: "Saved HTTP draft",
    bodyRevision: 4,
    files: [],
    pending: null,
    ...extra,
  };
  const db = await draftDatabase();
  try {
    await db.put("drafts", previous);
  } finally {
    db.close();
  }
  return previous;
}

async function mount(
  id: number,
  disabled = false,
  onSend: SendDraft = async () => true,
) {
  await act(async () => {
    render(
      <Composer
        discussionId={id}
        members={[]}
        memberIds={new Set<number>()}
        busy={false}
        disabled={disabled}
        placeholder="Message"
        onSend={onSend}
        onHeightChange={() => {}}
        onOpenVoiceSettings={() => {}}
      />,
    );
  });
  await waitFor(() => expect(input().disabled).toBe(false));
}

function input() {
  return screen.getByRole("combobox", {
    name: "Message",
  }) as HTMLTextAreaElement;
}

it("retains HTTP recovery and result checks while read availability blocks every send entry", async () => {
  const previous = await seed(508, {
    pending: {
      id: "saved-http-send",
      body: "Original pending message",
      bodyRevision: 3,
      files: [],
      phase: "sending",
    },
  });
  const status = vi.spyOn(backend, "sendStatus").mockResolvedValue({
    state: "unknown",
    message: null,
  });
  const send = vi.fn(async () => true);
  await mount(508, true, send);
  expect(status).not.toHaveBeenCalled();
  await act(async () =>
    screen.getByRole("button", { name: "Recover saved draft" }).click(),
  );
  const retry = (await screen.findByRole("button", {
    name: "Retry send",
  })) as HTMLButtonElement;
  const hook = renderHook(() => useDraft(508));
  await waitFor(() => expect(hook.result.current.controller).not.toBeNull());
  const controller = hook.result.current.controller;
  if (!controller) throw new Error("The draft has not loaded");
  const attempt = vi.spyOn(controller, "send");
  expect(input().value).toBe(previous.body);
  expect(input().disabled).toBe(false);
  expect(retry.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(retry);
    for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }])
      fireEvent.keyDown(input(), { key: "Enter", ...modifiers });
  });
  expect(attempt).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(controller.snapshot().draft.pending?.id).toBe("saved-http-send");
  const lookup = screen.getByRole("button", {
    name: "Check result",
  }) as HTMLButtonElement;
  expect(lookup.disabled).toBe(false);
  await act(async () => fireEvent.click(lookup));
  await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  expect(status).toHaveBeenLastCalledWith(508, "saved-http-send");
  expect(controller.snapshot().draft.pending?.id).toBe("saved-http-send");
});

it("offers an explicit saved draft action without Web Locks or closing events", async () => {
  const previous = await seed(501);
  sessionStorage.setItem("fora.draft-tab", "previous-document");
  expect(navigator.locks).toBeUndefined();
  await mount(501);
  expect(input().value).toBe("");
  expect(screen.getByText(/Stop sending in other tabs first/)).toBeTruthy();
  await act(async () =>
    screen.getByRole("button", { name: "Recover saved draft" }).click(),
  );
  await waitFor(() => expect(input().value).toBe("Saved HTTP draft"));
  expect(
    screen.queryByRole("button", { name: "Recover saved draft" }),
  ).toBeNull();
  const db = await draftDatabase();
  try {
    expect(await db.get("drafts", previous.key)).toBeUndefined();
    const saved = (await db.getAll("drafts")).find((draft) => draft.body);
    expect(saved?.bodyRevision).toBe(4);
    expect(saved?.owner).toBeTruthy();
    expect(saved?.key).not.toBe(previous.key);
  } finally {
    db.close();
  }
});

it("disables saving retries while recovering and clears the old storage error on success", async () => {
  const previous = await seed(507);
  await mount(507);
  const hook = renderHook(() => useDraft(507));
  await waitFor(() => expect(hook.result.current.controller).not.toBeNull());
  const controller = hook.result.current.controller;
  const storage = controller?.storage;
  if (!controller || !storage) throw new Error("The draft has not loaded");
  const save = vi.spyOn(storage, "save");
  save.mockRejectedValueOnce(new Error("Storage unavailable"));
  await act(async () => {
    controller.saveAgain();
    await vi.waitFor(() => expect(controller.snapshot().saving).toBe(false));
    await controller.refreshRecovery();
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Storage unavailable",
  );
  const original = storage.recover.bind(storage);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(storage, "recover").mockImplementation(async (...args) => {
    const recovered = await original(...args);
    await gate;
    return recovered;
  });
  let recovering!: Promise<void>;
  await act(async () => {
    recovering = controller.recover();
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Retry saving draft",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () => {
    screen.getByRole("button", { name: "Retry saving draft" }).click();
    controller.saveAgain();
    resume();
    await recovering;
  });
  expect(save).toHaveBeenCalledOnce();
  expect(input().value).toBe(previous.body);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Retry saving draft" }),
  ).toBeNull();
  const db = await draftDatabase();
  try {
    expect(await db.get("drafts", previous.key)).toBeUndefined();
    expect((await db.get("drafts", storage.key))?.body).toBe(previous.body);
  } finally {
    db.close();
  }
});

it("invalidates the recovery prompt when the current draft starts editing", async () => {
  const previous = await seed(502);
  await mount(502);
  const hook = renderHook(() => useDraft(502));
  await waitFor(() => expect(hook.result.current.controller).not.toBeNull());
  await act(async () => {
    hook.result.current.controller?.setBody("New draft");
    await vi.waitFor(() =>
      expect(hook.result.current.controller?.snapshot().saving).toBe(false),
    );
  });
  await waitFor(() => expect(input().value).toBe("New draft"));
  expect(
    screen.queryByRole("button", { name: "Recover saved draft" }),
  ).toBeNull();
  const db = await draftDatabase();
  try {
    expect((await db.get("drafts", previous.key))?.body).toBe(
      "Saved HTTP draft",
    );
  } finally {
    db.close();
  }
});

it("shows ownership loss after a saving failure and retains a copyable old body", async () => {
  await mount(503);
  const hook = renderHook(() => useDraft(503));
  await waitFor(() => expect(hook.result.current.controller).not.toBeNull());
  await act(async () => {
    hook.result.current.controller?.setBody("Current body");
    await vi.waitFor(() =>
      expect(hook.result.current.controller?.snapshot().saving).toBe(false),
    );
  });
  await waitFor(() => expect(hook.result.current.view?.saving).toBe(false));
  const controller = hook.result.current.controller;
  if (!controller?.storage) throw new Error("The draft has not loaded");
  const save = vi.spyOn(controller.storage, "save");
  save.mockRejectedValueOnce(new Error("Storage unavailable"));
  await act(async () => {
    controller.setBody("Unsaved copy");
    await vi.waitFor(() => expect(controller.snapshot().saving).toBe(false));
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Storage unavailable",
  );
  expect(
    screen.getByRole("button", { name: "Retry saving draft" }),
  ).toBeTruthy();
  const previous = hook.result.current.view?.draft;
  if (!previous) throw new Error("The draft has not loaded");
  const target = new OwnedDraftStore(
    "http-organization:1:503:another",
    "http-organization:1:503:",
    "other-owner",
  );
  await target.open({
    ...previous,
    key: target.key,
    body: "",
    files: [],
    pending: null,
  });
  await target.recover((await target.candidates())[0], () => true);
  await act(async () => window.dispatchEvent(new Event("pageshow")));
  await waitFor(() => expect(hook.result.current.view?.moved).toBe(true));
  expect(screen.getByRole("alert").textContent).toContain(
    "Draft moved to another tab",
  );
  expect(hook.result.current.view?.storageError).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Retry saving draft" }),
  ).toBeNull();
  expect(screen.getByRole("alert").textContent).not.toContain(
    "Storage unavailable",
  );
  expect(input().value).toBe("Unsaved copy");
  expect(input().readOnly).toBe(true);
  expect(input().disabled).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "Start voice input",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(input(), { target: { value: "Another edit" } });
  expect(hook.result.current.view?.draft.body).toBe("Unsaved copy");
  await act(async () => controller.saveAgain());
  expect(save).toHaveBeenCalledOnce();
  const db = await draftDatabase();
  try {
    expect(await db.get("drafts", previous.key)).toBeUndefined();
    expect((await db.get("drafts", target.key))?.body).toBe("Current body");
  } finally {
    db.close();
  }
});

it("checks a recovered pending send using the original identity and file order", async () => {
  const file = new File(["attachment"], "one.txt");
  await seed(504, {
    files: [{ id: "file-id", clientId: "client-id", file }],
    pending: {
      id: "pending-send",
      body: "Original message",
      bodyRevision: 3,
      files: [
        {
          id: "first",
          clientId: "first-client",
          file,
          upload: {
            id: "first-upload",
            state: "ready",
            expires_at: 9999999999,
          },
        },
        {
          id: "second",
          clientId: "second-client",
          file,
          upload: {
            id: "second-upload",
            state: "ready",
            expires_at: 9999999999,
          },
        },
      ],
      phase: "sending",
    },
  });
  vi.spyOn(backend, "sendStatus").mockResolvedValue({
    state: "unknown",
    message: null,
  });
  await mount(504);
  expect(backend.sendStatus).not.toHaveBeenCalled();
  await act(async () =>
    screen.getByRole("button", { name: "Recover saved draft" }).click(),
  );
  await waitFor(() =>
    expect(backend.sendStatus).toHaveBeenCalledWith(504, "pending-send"),
  );
  const hook = renderHook(() => useDraft(504));
  await waitFor(() =>
    expect(hook.result.current.view?.draft.pending).toBeTruthy(),
  );
  expect(
    hook.result.current.view?.draft.pending?.files.map(
      (file) => file.upload?.id,
    ),
  ).toEqual(["first-upload", "second-upload"]);
  expect(input().value).toBe("Saved HTTP draft");
});

it("does not recreate an inactive document key on re-entry after another tab recovered it", async () => {
  const first = renderHook(() => useDraft(505));
  await waitFor(() => expect(first.result.current.controller).not.toBeNull());
  await act(async () => {
    first.result.current.controller?.setBody("Saved before leaving");
    await vi.waitFor(() =>
      expect(first.result.current.controller?.snapshot().saving).toBe(false),
    );
  });
  const previous = first.result.current.view?.draft;
  if (!previous) throw new Error("The draft has not loaded");
  await act(async () => first.unmount());
  const target = new OwnedDraftStore(
    "http-organization:1:505:another",
    "http-organization:1:505:",
    "other-owner",
  );
  await target.open({
    ...previous,
    key: target.key,
    body: "",
    files: [],
    pending: null,
  });
  await target.recover((await target.candidates())[0], () => true);
  const reentry = renderHook(() => useDraft(505));
  await waitFor(() =>
    expect(reentry.result.current.error).toContain(
      "Draft moved to another tab",
    ),
  );
  const db = await draftDatabase();
  try {
    expect(await db.get("drafts", previous.key)).toBeUndefined();
    expect((await db.get("drafts", target.key))?.body).toBe(
      "Saved before leaving",
    );
  } finally {
    db.close();
  }
});

it("keeps native lock collision handling and automatic saved draft recovery", async () => {
  const previous = await seed(506);
  sessionStorage.setItem("fora.draft-tab", "duplicated-tab");
  const held = new Set(["fora-draft-tab:duplicated-tab"]);
  const request = vi.fn(
    async (
      name: string,
      _options: unknown,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      return callback({});
    },
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request },
  });
  try {
    await mount(506);
    expect(input().value).toBe("Saved HTTP draft");
    expect(
      screen.queryByRole("button", { name: "Recover saved draft" }),
    ).toBeNull();
    expect(sessionStorage.getItem("fora.draft-tab")).not.toBe("duplicated-tab");
    expect(request.mock.calls[0][0]).toBe("fora-draft-tab:duplicated-tab");
    expect(request.mock.calls[1][0]).not.toBe("fora-draft-tab:duplicated-tab");
    const db = await draftDatabase();
    try {
      expect(await db.get("drafts", previous.key)).toBeUndefined();
      expect((await db.getAll("drafts"))[0].bodyRevision).toBe(4);
    } finally {
      db.close();
    }
  } finally {
    Reflect.deleteProperty(navigator, "locks");
  }
});
