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
import type { Organization } from "@/app/organization";
import type { DiscussionPage } from "@/lib/backend";

let act: typeof import("@testing-library/react").act;
let cleanup: typeof import("@testing-library/react").cleanup;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let OrganizationProvider: typeof import("@/app/organization").OrganizationProvider;
let RouterProvider: typeof import("@/app/router").RouterProvider;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let ThreadPage: typeof import("@/features/discussions/thread").ThreadPage;
let backend: typeof import("@/lib/backend").backend;

const scrollButton = vi.hoisted(() => {
  const state = {
    atEnd: false,
    composerHeight: 64,
    count: 0,
    frames: new Map<number, FrameRequestCallback>(),
    nextFrame: 1,
    resizeCallbacks: [] as (() => void)[],
    viewportHeight: 768,
    viewportListeners: new Set<() => void>(),
    onHeightChange: null as ((height: number) => void) | null,
    eventListener: null as
      | ((event: { type: string; id?: number; discussion_id?: number }) => void)
      | null,
    scrollToEnd: vi.fn(),
    scrollToOffset: vi.fn(),
    scrollToIndex: vi.fn(),
  };
  const virtual = {
    getVirtualItems: () =>
      Array.from({ length: state.count }, (_, index) => ({
        key: index,
        index,
        start: index * 96,
      })),
    getTotalSize: () => state.count * 96,
    measureElement: () => {},
    isAtEnd: () => state.atEnd,
    scrollToEnd: state.scrollToEnd,
    scrollToOffset: state.scrollToOffset,
    scrollToIndex: state.scrollToIndex,
  };
  return { state, virtual };
});

vi.mock("@tanstack/react-virtual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-virtual")>()),
  useVirtualizer: (options: { count: number }) => {
    scrollButton.state.count = options.count;
    return scrollButton.virtual;
  },
}));

vi.mock("@/components/ui/menu", () => ({ OverflowMenu: vi.fn(() => null) }));

const scrollButtonToasts = vi.hoisted(() => ({
  items: [] as {
    id?: string;
    action?: { label: string; onClick: () => void };
  }[],
}));

vi.mock("@/components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/toast")>()),
  toast: (options: {
    id?: string;
    action?: { label: string; onClick: () => void };
  }) => {
    scrollButtonToasts.items.push(options);
    return options.id ?? "toast";
  },
  dismissToast: () => {},
}));

vi.mock("@/features/discussions/composer", async () => {
  const { useEffect } = await import("react");
  return {
    Composer: (props: {
      onHeightChange: (height: number) => void;
      placeholder: string;
    }) => {
      useEffect(() => {
        scrollButton.state.onHeightChange = props.onHeightChange;
        props.onHeightChange(scrollButton.state.composerHeight);
        return () => {
          scrollButton.state.onHeightChange = null;
        };
      }, [props.onHeightChange]);
      return (
        <div data-composer>
          <textarea aria-label="Message" placeholder={props.placeholder} />
        </div>
      );
    },
  };
});

let closeDom: (() => void) | undefined;

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
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("EventTarget", dom.window.EventTarget);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal(
    "getComputedStyle",
    dom.window.getComputedStyle.bind(dom.window),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = scrollButton.state.nextFrame;
    scrollButton.state.nextFrame += 1;
    scrollButton.state.frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    scrollButton.state.frames.delete(id);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        scrollButton.state.resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  Object.defineProperty(dom.window, "visualViewport", {
    configurable: true,
    value: {
      scale: 1,
      offsetTop: 0,
      get height() {
        return scrollButton.state.viewportHeight;
      },
      addEventListener: (_type: string, listener: () => void) => {
        scrollButton.state.viewportListeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        scrollButton.state.viewportListeners.delete(listener);
      },
    },
  });
  ({ act, cleanup, fireEvent, render } = await import(
    "@testing-library/react"
  ));
  ({ OrganizationProvider } = await import("@/app/organization"));
  ({ RouterProvider } = await import("@/app/router"));
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
  ({ ThreadPage } = await import("@/features/discussions/thread"));
  ({ backend } = await import("@/lib/backend"));
});

afterAll(() => {
  if (closeDom) closeDom();
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const organization: Organization = {
  members: [
    { id: 1, name: "You", type: "human", state: "idle" },
    { id: 2, name: "Helper", type: "agent", state: "idle" },
  ],
  humanId: 1,
  discussions: [],
  connectionError: null,
  organizationError: null,
  discussionsError: null,
  retry: async () => {},
  refresh: async () => {},
};

describe("scroll to bottom button production lifecycle", () => {
  function page(
    count = 3,
    latest = count,
    firstUnreadId: number | null = null,
  ): DiscussionPage {
    return {
      id: 1,
      messages: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        sender_id: 2,
        sender_name: "Helper",
        body: `Message ${index + 1}`,
        mentions: [],
        attachments: [],
        created_at: "2026-10-10T00:00:00Z",
      })),
      latest_id: latest,
      read_through: count,
      first_unread_id: firstUnreadId,
      previous_sender_id: null,
      has_before: false,
      has_after: false,
      awaiting_ack: [],
      acknowledged: [],
      pending_count: 0,
      metadata: {
        topic: "Release",
        archived: false,
        members: [{ id: 1, name: "You" }],
      },
    };
  }

  function mount(unread: number) {
    return render(
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider
            value={{
              ...organization,
              discussions: [
                {
                  id: 1,
                  topic: "Release",
                  member_ids: [1, 2],
                  archived: false,
                  unread,
                },
              ],
            }}
          >
            <ThreadPage id={1} />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>,
    );
  }

  function findButton(container: HTMLElement) {
    return container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Scroll to latest"]',
    );
  }

  function button(container: HTMLElement) {
    const element = findButton(container);
    if (!element) throw new Error("Scroll to bottom button is missing");
    return element;
  }

  function messageInput(container: HTMLElement) {
    const element = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    );
    if (!element) throw new Error("Message input is missing");
    return element;
  }

  function scrollRoot(container: HTMLElement) {
    const element = container.querySelector<HTMLDivElement>(".overflow-y-auto");
    if (!element) throw new Error("Thread scroll container is missing");
    return element;
  }

  function triggerResize() {
    const callback =
      scrollButton.state.resizeCallbacks[
        scrollButton.state.resizeCallbacks.length - 1
      ];
    if (!callback) throw new Error("Thread resize observer is missing");
    callback();
  }

  function reachEnd() {
    return act(async () => {
      scrollButton.state.atEnd = true;
      triggerResize();
    });
  }

  async function shrinkViewport(height: number) {
    await act(async () => {
      scrollButton.state.viewportHeight = height;
      for (const listener of [...scrollButton.state.viewportListeners])
        listener();
    });
    await flush();
  }

  async function refreshMessages() {
    await act(async () => {
      scrollButton.state.eventListener?.({
        type: "mention.acked",
        discussion_id: 1,
      });
    });
    await flush();
  }

  async function flush() {
    await act(async () => {});
  }

  async function runFrames(count = 1) {
    for (let index = 0; index < count; index += 1) {
      const pending = [...scrollButton.state.frames.values()];
      scrollButton.state.frames.clear();
      if (!pending.length) return;
      await act(async () => {
        for (const callback of pending) callback(0);
      });
    }
  }

  async function settle() {
    await flush();
    await runFrames(2);
    await flush();
  }

  async function clickButton(container: HTMLElement) {
    await act(async () => {
      fireEvent.click(button(container));
    });
    await flush();
  }

  beforeEach(() => {
    scrollButton.state.atEnd = false;
    scrollButton.state.composerHeight = 64;
    scrollButton.state.frames.clear();
    scrollButton.state.nextFrame = 1;
    scrollButton.state.resizeCallbacks = [];
    scrollButton.state.viewportHeight = 768;
    scrollButton.state.viewportListeners.clear();
    scrollButton.state.eventListener = null;
    scrollButtonToasts.items = [];
    vi.spyOn(backend, "discussionPreviews").mockResolvedValue({
      discussion_id: 1,
      previews: [],
      has_more: false,
      next_before: null,
    });
    vi.spyOn(backend, "discussionPage").mockResolvedValue(page());
    vi.spyOn(backend, "markRead").mockResolvedValue({ read_through: 3 });
    vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
      scrollButton.state.eventListener = listener as unknown as (event: {
        type: string;
        id?: number;
      }) => void;
      return () => {};
    });
  });

  it("keeps the button and its real unread badge until the virtual list reaches the end", async () => {
    const view = mount(2);
    await settle();
    expect(button(view.container).textContent).toBe("2");

    await clickButton(view.container);
    expect(scrollButton.state.scrollToEnd).toHaveBeenLastCalledWith({
      behavior: "smooth",
    });
    expect(findButton(view.container)).not.toBeNull();

    await reachEnd();
    await runFrames(2);
    await flush();
    expect(findButton(view.container)).toBeNull();
  });

  it("returns focus to the message input when the button stands down while holding focus", async () => {
    const view = mount(0);
    await settle();
    await act(async () => {
      button(view.container).focus();
    });
    expect(document.activeElement).toBe(button(view.container));

    await reachEnd();
    await settle();
    expect(findButton(view.container)).toBeNull();
    expect(document.activeElement).toBe(messageInput(view.container));
  });

  it("leaves focus where the user put it when the button stands down", async () => {
    const view = mount(0);
    await settle();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    await act(async () => {
      button(view.container).focus();
    });
    await act(async () => {
      elsewhere.focus();
    });

    await reachEnd();
    await settle();
    expect(findButton(view.container)).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("monitors one smooth positioning across frames and yields to a scroll key", async () => {
    const view = mount(0);
    await settle();
    await clickButton(view.container);
    const smoothCalls = scrollButton.state.scrollToEnd.mock.calls.length;
    expect(smoothCalls).toBeGreaterThan(0);
    expect(findButton(view.container)).not.toBeNull();

    const root = scrollRoot(view.container);
    root.scrollTop = 240;
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "PageDown" });
    });
    expect(scrollButton.state.scrollToOffset).toHaveBeenLastCalledWith(240, {
      behavior: "auto",
    });
    await runFrames(3);
    expect(scrollButton.state.scrollToEnd.mock.calls.length).toBe(smoothCalls);
    expect(findButton(view.container)).not.toBeNull();
  });

  it("keeps the positioning owned across composer size, keyboard offset and message updates, and still yields to a scroll key", async () => {
    const view = mount(0);
    await settle();
    await clickButton(view.container);
    const smoothCalls = scrollButton.state.scrollToEnd.mock.calls.length;
    expect(smoothCalls).toBeGreaterThan(0);

    await act(async () => {
      scrollButton.state.onHeightChange?.(300);
    });
    await flush();
    expect(scrollButton.state.scrollToEnd.mock.calls.length).toBe(smoothCalls);

    await shrinkViewport(400);
    expect(scrollButton.state.scrollToEnd.mock.calls.length).toBe(smoothCalls);

    await refreshMessages();
    expect(scrollButton.state.scrollToEnd.mock.calls.length).toBe(smoothCalls);
    expect(findButton(view.container)).not.toBeNull();

    const root = scrollRoot(view.container);
    root.scrollTop = 200;
    scrollButton.state.scrollToOffset.mockClear();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "PageDown" });
    });
    expect(scrollButton.state.scrollToOffset).toHaveBeenLastCalledWith(200, {
      behavior: "auto",
    });
    await runFrames(2);
    const afterInterrupt = scrollButton.state.scrollToOffset.mock.calls.length;

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "PageDown" });
    });
    expect(scrollButton.state.scrollToOffset.mock.calls.length).toBe(
      afterInterrupt,
    );
    expect(scrollButton.state.scrollToEnd.mock.calls.length).toBe(smoothCalls);
    expect(findButton(view.container)).not.toBeNull();

    await reachEnd();
    await settle();
    expect(findButton(view.container)).toBeNull();
  });

  it("lets a gesture stop the positioning after the composer size changes", async () => {
    const view = mount(0);
    await settle();
    await clickButton(view.container);
    const smoothCalls = scrollButton.state.scrollToEnd.mock.calls.length;

    await act(async () => {
      scrollButton.state.onHeightChange?.(300);
    });
    await flush();

    const root = scrollRoot(view.container);
    root.scrollTop = 150;
    scrollButton.state.scrollToOffset.mockClear();
    await act(async () => {
      fireEvent.wheel(root, { deltaY: 120 });
    });
    expect(scrollButton.state.scrollToOffset).toHaveBeenCalledWith(150, {
      behavior: "auto",
    });
    expect(scrollButton.state.scrollToEnd.mock.calls.length).toBe(smoothCalls);
    expect(findButton(view.container)).not.toBeNull();
  });

  it("abandons a latest request cancelled before its response arrives", async () => {
    const view = mount(0);
    await settle();
    let resolvePage!: (value: DiscussionPage) => void;
    const pending = new Promise<DiscussionPage>((resolve) => {
      resolvePage = resolve;
    });
    vi.spyOn(backend, "discussionPage").mockImplementation(() => pending);

    await clickButton(view.container);
    scrollRoot(view.container).scrollTop = 120;
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "PageDown" });
    });
    await act(async () => {
      resolvePage(page());
    });
    await settle();

    expect(scrollButton.state.scrollToEnd).not.toHaveBeenCalledWith({
      behavior: "smooth",
    });
    expect(findButton(view.container)).not.toBeNull();
  });

  it("ends the click intent when the latest request fails", async () => {
    const view = mount(0);
    await settle();
    vi.spyOn(backend, "discussionPage").mockRejectedValue(new Error("offline"));
    scrollButton.state.scrollToOffset.mockClear();

    await clickButton(view.container);
    scrollRoot(view.container).scrollTop = 80;
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "PageDown" });
    });

    expect(scrollButton.state.scrollToOffset).not.toHaveBeenCalled();
    expect(scrollButton.state.scrollToEnd).not.toHaveBeenCalledWith({
      behavior: "smooth",
    });
    expect(findButton(view.container)).not.toBeNull();
  });

  it("follows the end on reconnection without treating the auto request as a user intent", async () => {
    const view = mount(0);
    await settle();
    await reachEnd();
    await settle();
    expect(findButton(view.container)).toBeNull();

    await act(async () => {
      scrollButton.state.eventListener?.({ type: "connection.restored" });
    });
    await settle();

    expect(scrollButton.state.scrollToEnd).toHaveBeenLastCalledWith({
      behavior: "auto",
    });
    expect(scrollButton.state.scrollToEnd).not.toHaveBeenCalledWith({
      behavior: "smooth",
    });
  });

  it("keeps the button available when the entry positioning with a new divider is interrupted", async () => {
    vi.spyOn(backend, "discussionPage").mockResolvedValue(page(3, 3, 2));
    const view = mount(2);
    await settle();
    expect(findButton(view.container)).toBeNull();

    const root = scrollRoot(view.container);
    root.scrollTop = 96;
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "PageDown" });
    });
    await flush();

    expect(scrollButton.state.scrollToOffset).toHaveBeenLastCalledWith(96, {
      behavior: "auto",
    });
    expect(findButton(view.container)).not.toBeNull();
  });

  it("keeps the button available when the divider-free entry positioning is interrupted before its frame", async () => {
    const view = mount(2);
    await flush();
    expect(findButton(view.container)).toBeNull();

    const root = scrollRoot(view.container);
    root.scrollTop = 48;
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "PageDown" });
    });
    await flush();

    expect(scrollButton.state.scrollToOffset).toHaveBeenLastCalledWith(48, {
      behavior: "auto",
    });
    expect(findButton(view.container)).not.toBeNull();
  });

  it("returns to the latest messages when the failed user request is retried", async () => {
    const view = mount(3);
    await settle();
    vi.spyOn(backend, "discussionPage").mockRejectedValue(new Error("offline"));
    await clickButton(view.container);
    await settle();

    const retry = scrollButtonToasts.items.find(
      (item) => item.action?.label === "Retry",
    );
    expect(retry).toBeDefined();
    expect(scrollButton.state.scrollToEnd).not.toHaveBeenCalledWith({
      behavior: "smooth",
    });

    vi.spyOn(backend, "discussionPage").mockResolvedValue(page());
    await act(async () => {
      retry?.action?.onClick();
    });
    await settle();

    expect(scrollButton.state.scrollToEnd).toHaveBeenCalledWith({
      behavior: "smooth",
    });
    expect(findButton(view.container)).not.toBeNull();
  });

  it("terminates the owned target when smooth positioning stalls before the end", async () => {
    const view = mount(0);
    await settle();
    await clickButton(view.container);
    const endCalls = scrollButton.state.scrollToEnd.mock.calls.length;
    expect(endCalls).toBeGreaterThan(0);
    expect(findButton(view.container)).not.toBeNull();

    const root = scrollRoot(view.container);
    root.scrollTop = 0;
    scrollButton.state.scrollToOffset.mockClear();

    await runFrames(5);

    expect(scrollButton.state.scrollToOffset).toHaveBeenCalledWith(0, {
      behavior: "auto",
    });
    expect(findButton(view.container)).not.toBeNull();

    scrollButton.state.scrollToOffset.mockClear();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "PageDown" });
    });
    expect(scrollButton.state.scrollToOffset).not.toHaveBeenCalled();
    expect(scrollButton.state.scrollToEnd.mock.calls.length).toBe(endCalls);
  });
});
