import { Virtualizer } from "@tanstack/react-virtual";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type Organization, OrganizationProvider } from "@/app/organization";
import { RouterProvider } from "@/app/router";
import { Avatar, AvatarStack } from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { clearToasts, readToasts } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  MessageRow,
  ScrollToBottomButton,
  ThreadPage,
} from "@/features/discussions/thread";
import {
  type RequestHandle,
  useThreadData,
} from "@/features/discussions/thread-data";
import { shouldStopPositioningForKey } from "@/features/discussions/thread-position";
import {
  backend,
  type DiscussionDetail,
  type DiscussionPage,
  type MessageMention,
} from "@/lib/backend";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});
vi.mock("@/components/ui/menu", () => ({ OverflowMenu: vi.fn(() => null) }));
vi.mock("@/features/discussions/thread-previews", async (original) => ({
  ...(await original<
    typeof import("@/features/discussions/thread-previews")
  >()),
  useDiscussionPreviews: () => ({
    state: {
      metadata: {},
      resources: {},
      aliases: {},
      loading: false,
      error: null,
      before: null,
    },
  }),
}));

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
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal(
    "requestAnimationFrame",
    dom.window.requestAnimationFrame.bind(dom.window),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    dom.window.cancelAnimationFrame.bind(dom.window),
  );
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
  connectionError: null,
  organizationError: null,
  discussionsError: null,
  retry: async () => {},
  discussions: [],
  refresh: async () => {},
};

function render(
  pending: boolean,
  acknowledged: boolean,
  busy = false,
  mentions: MessageMention[] = [{ member_id: 1, position: 0, length: 4 }],
) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <OrganizationProvider value={organization}>
        <MessageRow
          discussionId={1}
          message={{
            id: 1,
            sender_id: 2,
            sender_name: "Helper",
            body: "@You please review",
            mentions,
            attachments: [],
            created_at: "2026-01-01T00:00:00Z",
          }}
          compact={false}
          fresh={false}
          pending={pending}
          acknowledged={acknowledged}
          busy={busy}
          onAck={() => {}}
          onRevoke={() => {}}
        />
      </OrganizationProvider>
    </TooltipProvider>,
  );
}

describe("message avatar", () => {
  it("uses the historical sender ID even when absent from current members", () => {
    function historical(senderName: string) {
      return renderToStaticMarkup(
        <TooltipProvider>
          <OrganizationProvider value={{ ...organization, members: [] }}>
            <MessageRow
              discussionId={1}
              message={{
                id: 10,
                sender_id: 42,
                sender_name: senderName,
                body: "Historical message",
                mentions: [],
                attachments: [],
                created_at: "2026-01-01T00:00:00Z",
              }}
              compact={false}
              fresh={false}
              pending={false}
              acknowledged={false}
              busy={false}
              onAck={() => {}}
              onRevoke={() => {}}
            />
          </OrganizationProvider>
        </TooltipProvider>,
      );
    }
    const avatar = renderToStaticMarkup(<Avatar memberId={42} />);
    expect(historical("Deleted agent")).toContain(avatar);
    expect(historical("Renamed agent")).toContain(avatar);
    expect(historical("Renamed agent")).toContain("Renamed agent");
  });
});

describe("message acknowledgement", () => {
  it("offers confirmation for a pending mention", () => {
    const html = render(true, false);
    expect(html).toContain("Mark handled");
    expect(html).not.toContain("Undo confirmation");
  });

  it("offers undo for the current member's confirmation", () => {
    const html = render(false, true);
    expect(html).toContain("Handled");
    expect(html).toContain('aria-label="Undo confirmation"');
    expect(html).not.toContain("Mark handled");
  });

  it("offers no confirmation actions for other messages", () => {
    const html = render(false, false);
    expect(html).not.toContain("Undo confirmation");
    expect(html).not.toContain("Mark handled");
  });

  it("disables undo while a change is pending", () => {
    expect(render(false, true, true)).toContain('disabled=""');
  });
});

describe("message mentions", () => {
  it("marks only the kernel-recorded spans", () => {
    expect(render(false, false)).toContain("<mark>@You</mark> please review");
    expect(render(false, false, false, [])).toContain("@You please review");
    expect(render(false, false, false, [])).not.toContain("<mark>");
  });
});

describe("message timestamp", () => {
  it("keeps the exact time in a tooltip instead of a title attribute", () => {
    const html = render(false, false);
    expect(html).toMatch(/<time[^>]*datetime="2026-01-01T00:00:00Z"/i);
    expect(html).not.toContain("title=");
  });
});

describe("thread page", () => {
  function page(discussions: Organization["discussions"]) {
    return renderToStaticMarkup(
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider value={{ ...organization, discussions }}>
            <ThreadPage id={1} />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>,
    );
  }

  it("seeds the title and composer from the listed topic before the thread loads", () => {
    const html = page([
      {
        id: 1,
        topic: "Release notes",
        member_ids: [1, 2],
        archived: false,
        unread: 0,
      },
    ]);
    expect(html).toMatch(/<h1\b[^>]*>Release notes<\/h1>/);
    expect(html).toContain('placeholder="Message Release notes"');
    expect(html).toContain('aria-label="Start voice input"');
    expect(html).toMatch(/<textarea[^>]*rows="1"[^>]*aria-label="Message"/);
    expect(html).not.toContain("crumb");
    expect(html).not.toContain("thread-strip");
    expect(html).not.toContain("thread-banner");
    expect(html).not.toContain("composer-hint");
  });

  it.each([false, true])(
    "has no delete action after loading archived=%s",
    (archived) => {
      const detail: DiscussionDetail = {
        id: 1,
        topic: "Release",
        members: [
          { id: 2, name: "Helper" },
          { id: 1, name: "You" },
        ],
        total_messages: 0,
        archived,
        read_through: 0,
        awaiting_ack: [],
        acknowledged: [],
        messages: [],
      };
      function LoadedThread() {
        vi.mocked(useState).mockReturnValueOnce([detail, vi.fn()]);
        return <ThreadPage id={1} />;
      }
      const html = renderToStaticMarkup(
        <TooltipProvider>
          <RouterProvider>
            <OrganizationProvider value={organization}>
              <LoadedThread />
            </OrganizationProvider>
          </RouterProvider>
        </TooltipProvider>,
      );
      expect(html).toMatch(/<h1\b[^>]*>Release<\/h1>/);
      expect(html).toContain(
        renderToStaticMarkup(<AvatarStack members={detail.members} />),
      );
      const { actions } = vi.mocked(OverflowMenu).mock.calls[0][0];
      expect(actions.map((action) => action.label)).toEqual([
        "Members",
        archived ? "Unarchive" : "Archive",
      ]);
      expect(html).not.toContain("Delete");
    },
  );

  it("shows placeholders for an unlisted thread", () => {
    const html = page([]);
    expect(html).toMatch(/<h1\b[^>]*><span[^>]*aria-hidden="true"/);
    expect(html).toContain('aria-label="Loading Discussion"');
    expect(html).toContain('placeholder="Message"');
  });
});

describe("virtualized composer scroll anchoring", () => {
  function measured(height: number, viewport: number, top: number) {
    const area = {
      scrollHeight: height,
      clientHeight: viewport,
      scrollTop: top,
    } as HTMLDivElement;
    const scrollToFn = vi.fn();
    const virtual = new Virtualizer<HTMLDivElement, HTMLLIElement>({
      count: 2,
      getScrollElement: () => area,
      estimateSize: () => 100,
      observeElementRect: () => {},
      observeElementOffset: () => {},
      scrollToFn,
      paddingStart: 16,
      paddingEnd: 116 + 16 + 24,
      scrollEndThreshold: 1,
    });
    virtual.scrollElement = area;
    virtual.scrollRect = { width: 800, height: viewport };
    virtual.scrollOffset = top;
    virtual.getTotalSize();
    return { virtual, area, scrollToFn };
  }

  it("targets the actual scroll end rather than the last row or a marker", () => {
    const { virtual, area, scrollToFn } = measured(915, 600, 291.5);
    expect(virtual.isAtEnd()).toBe(false);
    virtual.scrollToEnd();
    expect(scrollToFn.mock.calls[0][0]).toBe(315);
    Object.defineProperty(area, "scrollHeight", { value: 983 });
    virtual.scrollToEnd();
    expect(scrollToFn.mock.calls[1][0]).toBe(383);
  });

  it("includes the composer bottom offset and 24px gap once in virtual height", () => {
    const { virtual } = measured(800, 600, 200);
    expect(virtual.getTotalSize()).toBe(16 + 200 + 116 + 16 + 24);
  });

  it("recognizes subpixel bottom attachment without claiming historical positions", () => {
    expect(measured(915, 623, 291.5).virtual.isAtEnd()).toBe(true);
    expect(measured(915, 623, 250).virtual.isAtEnd()).toBe(false);
    expect(measured(500, 623, 0).virtual.isAtEnd()).toBe(true);
  });
});

describe("scroll to bottom button", () => {
  it("renders circular 40px fab with 44px touch target on mobile and touch", () => {
    const html = renderToStaticMarkup(
      <ScrollToBottomButton
        unreadCount={0}
        loading={false}
        onClick={() => {}}
      />,
    );
    expect(html).toContain("size-10");
    expect(html).toContain("rounded-full");
    expect(html).toContain("shadow-md");
    expect(html).toContain("bg-surface");
    expect(html).toContain("text-fg");
    expect(html).toContain("narrow:before:-inset-0.5");
    expect(html).toContain("touch:before:-inset-0.5");
    expect(html).toContain('aria-label="Scroll to latest messages"');
    expect(html).not.toContain("animate-spin");
  });

  it("renders loader and disables clicking when loading latest messages", () => {
    const html = renderToStaticMarkup(
      <ScrollToBottomButton
        unreadCount={0}
        loading={true}
        onClick={() => {}}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("animate-spin");
  });

  it.each([
    [0, null, "Scroll to latest messages"],
    [1, "1", "Scroll to latest messages (1 unread)"],
    [42, "42", "Scroll to latest messages (42 unread)"],
    [99, "99", "Scroll to latest messages (99 unread)"],
    [100, "99+", "Scroll to latest messages (99+ unread)"],
    [150, "99+", "Scroll to latest messages (99+ unread)"],
  ])(
    "formats unread badge for count %i",
    (count, expectedText, expectedLabel) => {
      const html = renderToStaticMarkup(
        <ScrollToBottomButton
          unreadCount={count}
          loading={false}
          onClick={() => {}}
        />,
      );
      expect(html).toContain(`aria-label="${expectedLabel}"`);
      if (expectedText === null) {
        expect(html).not.toContain("data-unread-badge");
      } else {
        expect(html).toContain("data-unread-badge");
        expect(html).toContain(`>${expectedText}</span>`);
      }
    },
  );
});

describe("keyboard scroll key interruption and editing preservation", () => {
  it("recognizes scroll keys on non-editing targets, preserves editing in text inputs, and preserves interactive control semantics", () => {
    const button = document.createElement("button");
    const div = document.createElement("div");
    const textarea = document.createElement("textarea");
    const input = document.createElement("input");
    const contenteditable = document.createElement("div");
    contenteditable.setAttribute("contenteditable", "true");

    const select = document.createElement("select");
    const menuItem = document.createElement("div");
    menuItem.setAttribute("role", "menuitem");
    const combobox = document.createElement("div");
    combobox.setAttribute("role", "combobox");
    const slider = document.createElement("div");
    slider.setAttribute("role", "slider");
    const option = document.createElement("div");
    option.setAttribute("role", "option");

    expect(shouldStopPositioningForKey("ArrowDown", button)).toBe(true);
    expect(shouldStopPositioningForKey("PageDown", button)).toBe(true);
    expect(shouldStopPositioningForKey(" ", div)).toBe(true);
    expect(shouldStopPositioningForKey("Home", div)).toBe(true);
    expect(shouldStopPositioningForKey("End", div)).toBe(true);

    expect(shouldStopPositioningForKey("ArrowDown", textarea)).toBe(false);
    expect(shouldStopPositioningForKey("PageDown", textarea)).toBe(false);
    expect(shouldStopPositioningForKey(" ", textarea)).toBe(false);
    expect(shouldStopPositioningForKey("ArrowUp", input)).toBe(false);
    expect(shouldStopPositioningForKey(" ", contenteditable)).toBe(false);

    expect(shouldStopPositioningForKey("ArrowDown", select)).toBe(false);
    expect(shouldStopPositioningForKey("ArrowUp", menuItem)).toBe(false);
    expect(shouldStopPositioningForKey(" ", combobox)).toBe(false);
    expect(shouldStopPositioningForKey("ArrowDown", slider)).toBe(false);
    expect(shouldStopPositioningForKey(" ", option)).toBe(false);

    expect(shouldStopPositioningForKey("KeyA", button)).toBe(false);
    expect(shouldStopPositioningForKey("Escape", button)).toBe(false);
  });
});

const testEntryPage: DiscussionPage = {
  id: 1,
  messages: [
    {
      id: 1,
      sender_id: 1,
      sender_name: "Member",
      body: "Initial",
      created_at: "2026-10-10T00:00:00Z",
      mentions: [],
      attachments: [],
    },
  ],
  latest_id: 1,
  read_through: 1,
  first_unread_id: 1,
  previous_sender_id: null,
  has_before: false,
  has_after: false,
  awaiting_ack: [],
  acknowledged: [],
  pending_count: 0,
  metadata: {
    topic: "Topic",
    archived: false,
    members: [{ id: 1, name: "Member" }],
  },
};

describe("production useThreadData request and position lifecycle", () => {
  it("synchronously issues sequence and accepts request, while rejecting concurrent in-flight requests", async () => {
    vi.spyOn(backend, "discussionPage").mockResolvedValueOnce(testEntryPage);
    const { result } = renderHook(() => useThreadData(1, 1));
    await act(async () => {});

    vi.spyOn(backend, "discussionPage").mockImplementation(
      () => new Promise(() => {}),
    );
    let first!: RequestHandle;
    act(() => {
      first = result.current.request("latest", { source: "user" });
    });
    expect(first.accepted).toBe(true);
    expect(first.sequence).toBe(2);

    const concurrent = result.current.request("before");
    expect(concurrent.accepted).toBe(false);
    expect(concurrent.sequence).toBeUndefined();
  });

  it("updates position with user sequence upon successful response and clears it on positioned", async () => {
    vi.spyOn(backend, "discussionPage").mockResolvedValueOnce(testEntryPage);
    const { result } = renderHook(() => useThreadData(1, 1));
    await act(async () => {});

    let resolvePage!: (value: DiscussionPage) => void;
    vi.spyOn(backend, "discussionPage").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );

    let handle!: RequestHandle;
    act(() => {
      handle = result.current.request("latest", { source: "user" });
    });
    expect(handle.accepted).toBe(true);
    expect(handle.sequence).toBe(2);

    await act(async () => {
      resolvePage({
        ...testEntryPage,
        messages: [
          ...testEntryPage.messages,
          {
            id: 10,
            sender_id: 1,
            sender_name: "Member",
            body: "Msg",
            created_at: "2026-10-10T00:00:00Z",
            mentions: [],
            attachments: [],
          },
        ],
        latest_id: 10,
      });
      await handle;
    });

    expect(result.current.position).toEqual({
      mode: "latest",
      source: "user",
      sequence: 2,
    });

    act(() => {
      result.current.positioned();
    });
    expect(result.current.position).toBeNull();
  });

  it("keeps the positioning ownership of a retried latest request", async () => {
    vi.spyOn(backend, "discussionPage").mockResolvedValueOnce(testEntryPage);
    clearToasts();
    const { result } = renderHook(() => useThreadData(1, 1));
    await act(async () => {});

    let rejectPage!: (error: Error) => void;
    vi.spyOn(backend, "discussionPage").mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectPage = reject;
        }),
    );

    let handle!: RequestHandle;
    act(() => {
      handle = result.current.request("latest", { source: "user" });
    });
    expect(handle.accepted).toBe(true);
    expect(handle.sequence).toBe(2);
    expect(result.current.positioningIntent.current).toEqual({
      sequence: 2,
      cancelled: false,
    });

    await act(async () => {
      rejectPage(new Error("Network failed"));
      await handle;
    });

    expect(result.current.failed).toBe(true);
    expect(result.current.position).toBeNull();
    expect(result.current.positioningIntent.current).toBeNull();

    const failureToast = readToasts()
      .filter((item) => item.open)
      .find((item) => item.id === "thread-1-page");
    expect(failureToast?.action?.label).toBe("Retry");

    let retryCalledWithMetadata: boolean | undefined;
    vi.spyOn(backend, "discussionPage").mockImplementation(
      async (_id, page) => {
        retryCalledWithMetadata = Boolean(page.metadata);
        return testEntryPage;
      },
    );

    await act(async () => {
      failureToast?.action?.onClick();
    });

    expect(retryCalledWithMetadata).toBe(true);
    expect(result.current.position).toEqual({
      mode: "latest",
      source: "user",
      sequence: 3,
    });
    expect(result.current.consumePositioningIntent(3)).toBe(true);
  });

  it("retries an automatic latest request without creating a user positioning intent", async () => {
    let eventListener!: (event: { type: string; id?: number }) => void;
    vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
      eventListener = listener as (event: {
        type: string;
        id?: number;
      }) => void;
      return () => {};
    });
    vi.spyOn(backend, "discussionPage").mockResolvedValueOnce(testEntryPage);
    clearToasts();
    const { result } = renderHook(() => useThreadData(1, 1));
    await act(async () => {});

    act(() => {
      result.current.view([1], true);
    });
    act(() => {
      result.current.positioned();
    });

    let rejectPage!: (error: Error) => void;
    vi.spyOn(backend, "discussionPage").mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectPage = reject;
        }),
    );

    await act(async () => {
      eventListener({ type: "connection.restored" });
    });
    await act(async () => {
      rejectPage(new Error("Network failed"));
      await Promise.resolve();
    });

    const failureToast = readToasts()
      .filter((item) => item.open)
      .find((item) => item.id === "thread-1-page");
    expect(failureToast?.action?.label).toBe("Retry");

    vi.spyOn(backend, "discussionPage").mockResolvedValue(testEntryPage);
    await act(async () => {
      failureToast?.action?.onClick();
    });

    expect(result.current.position).toEqual({
      mode: "latest",
      source: "auto",
      sequence: 3,
    });
    expect(result.current.positioningIntent.current).toBeNull();
  });

  it("cancels a user positioning intent that is still in flight", async () => {
    vi.spyOn(backend, "discussionPage").mockResolvedValue(testEntryPage);
    const { result } = renderHook(() => useThreadData(1, 1));
    await act(async () => {});

    let handle!: RequestHandle;
    act(() => {
      handle = result.current.request("latest", { source: "user" });
    });
    expect(result.current.positioningIntent.current).not.toBeNull();

    act(() => {
      result.current.cancelPositioningIntent();
    });
    await act(async () => {
      await handle;
    });

    expect(
      result.current.consumePositioningIntent(handle.sequence as number),
    ).toBe(false);
    expect(result.current.positioningIntent.current).toBeNull();
  });

  it("initiates auto latest request upon connection restoration", async () => {
    let eventListener!: (event: { type: string; id?: number }) => void;
    vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
      eventListener = listener as (event: {
        type: string;
        id?: number;
      }) => void;
      return () => {};
    });
    vi.spyOn(backend, "discussionPage").mockResolvedValue(testEntryPage);

    const { result } = renderHook(() => useThreadData(1, 1));
    await act(async () => {});

    act(() => {
      result.current.view([1], true);
    });
    act(() => {
      result.current.positioned();
    });
    expect(result.current.position).toBeNull();

    await act(async () => {
      eventListener({ type: "connection.restored" });
    });

    await waitFor(() => {
      expect(result.current.position).toEqual({
        mode: "latest",
        source: "auto",
        sequence: 2,
      });
    });
  });
});
