import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OrganizationProvider } from "@/app/organization";
import type { PreviewState } from "@/features/discussions/thread-previews";
import type { Message } from "@/lib/backend";

let testing: typeof import("@testing-library/react");
let MessageRow: typeof import("@/features/discussions/thread").MessageRow;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let closeDom: () => void;
const history = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/features/members/detail", () => ({
  TurnHistoryModal: (props: unknown) => {
    history.open(props);
    return null;
  },
}));

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  closeDom = () => dom.window.close();
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "MutationObserver",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "NodeFilter",
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
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  testing = await import("@testing-library/react");
  ({ MessageRow } = await import("@/features/discussions/thread"));
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
});
afterEach(async () => {
  await testing.act(async () => testing.cleanup());
  vi.clearAllMocks();
});
afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

function preview(
  status: "generating" | "failed" | "interrupted" = "generating",
): PreviewState {
  const source = "@文档助手 **正文**\n\n```ts\nconst value = 1";
  const bytes = new TextEncoder().encode(source).length;
  return {
    loading: false,
    error: null,
    data: {
      metadata: {
        preview_id: "preview",
        key: {
          agent_id: 2,
          sequence: 4,
          ordinal: 3,
          part_index: 0,
          request_id: "request",
          run_id: "run",
        },
        discussion_id: 8,
        revision: 7,
        status,
        error: status === "generating" ? null : "Request timed out",
        message_id: null,
        created_at: "2026-10-11T09:00:00Z",
        updated_at: "2026-10-11T09:01:00Z",
      },
      text: {
        revision: 7,
        offset: 0,
        next_offset: bytes,
        total_bytes: bytes,
        value: source,
        has_more: false,
      },
    },
  };
}
function view(
  saved: PreviewState,
  message?: Message,
  callbacks: { onMore?: () => void; onRetry?: () => void } = {},
) {
  return (
    <TooltipProvider>
      <OrganizationProvider
        value={{
          members: [
            { id: 2, name: "文档助手", type: "agent", state: "running" },
          ],
          humanId: 1,
          discussions: [],
          refresh: async () => {},
          connectionError: null,
          organizationError: null,
          discussionsError: null,
          retry: async () => {},
        }}
      >
        <MessageRow
          {...callbacks}
          discussionId={8}
          message={message}
          preview={message ? undefined : saved}
          identity="preview:preview"
          compact={false}
          fresh={false}
          pending={false}
          acknowledged={false}
          busy={false}
          onAck={() => {}}
          onRevoke={() => {}}
        />
      </OrganizationProvider>
    </TooltipProvider>
  );
}

describe("preview message rendering", () => {
  it("renders current Markdown and copies its original text with no preview mention marks", async () => {
    const saved = preview();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const mounted = testing.render(view(saved));
    expect(mounted.container.querySelector("mark")).toBeNull();
    expect(mounted.container.querySelector("[data-message-id]")).toBeNull();
    expect(
      testing.screen
        .getByRole("status", { name: "Generating" })
        .classList.contains("size-[6px]"),
    ).toBe(true);
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Copy message text" }),
    );
    await testing.waitFor(() =>
      expect(copy).toHaveBeenCalledWith(saved.data?.text.value),
    );
    expect(testing.screen.queryByText("Mark handled")).toBeNull();
  });

  it("preserves its message node when the formal body and effective mentions arrive", () => {
    const saved = preview();
    const mounted = testing.render(view(saved));
    const node = mounted.container.querySelector(".message-row");
    mounted.rerender(
      view(saved, {
        id: 14,
        sender_id: 2,
        sender_name: "文档助手",
        body: "@文档助手 正式正文",
        mentions: [{ member_id: 2, position: 0, length: 5 }],
        attachments: [],
        created_at: "2026-10-11T09:02:00Z",
      }),
    );
    expect(mounted.container.querySelector(".message-row")).toBe(node);
    expect(node?.getAttribute("data-message-id")).toBe("14");
    expect(node?.querySelector("mark")?.textContent).toBe("@文档助手");
    expect(
      testing.screen.queryByRole("status", { name: "Generating" }),
    ).toBeNull();
  });

  it("requests bounded text continuation and displays its waiting state", () => {
    const saved = preview();
    if (!saved.data) throw new Error("Preview test text is missing");
    saved.data.text.has_more = true;
    saved.data.text.total_bytes += 6;
    const more = vi.fn();
    const mounted = testing.render(view(saved, undefined, { onMore: more }));
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Load more text" }),
    );
    expect(more).toHaveBeenCalledOnce();
    mounted.rerender(
      view({ ...saved, loading: true }, undefined, { onMore: more }),
    );
    const waiting = testing.screen.getByRole("button", {
      name: "Load more text",
    }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    expect(waiting.getAttribute("aria-busy")).toBe("true");
    expect(waiting.querySelector(".animate-spin")).not.toBeNull();
    testing.fireEvent.click(waiting);
    expect(more).toHaveBeenCalledOnce();
  });

  it.each(["failed", "interrupted"] as const)(
    "opens the exact saved request after %s",
    (status) => {
      const saved = preview(status);
      const mounted = testing.render(view(saved));
      const name = `${status === "failed" ? "Not sent" : "Interrupted"}: Request timed out`;
      const trigger = testing.screen.getByRole("button", { name });
      expect(trigger.closest("div")?.querySelector("time")).not.toBeNull();
      expect(mounted.container.querySelector("[data-message-id]")).toBeNull();
      testing.fireEvent.click(trigger);
      expect(history.open).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 2,
          sequence: 4,
          initialOrdinal: 3,
          open: true,
        }),
      );
      expect(
        mounted.container.querySelector(".markdown-content")?.textContent,
      ).toContain("正文");
    },
  );
});
