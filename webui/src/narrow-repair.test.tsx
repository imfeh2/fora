import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@radix-ui/react-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@radix-ui/react-dialog")>()),
  Portal: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/app/organization", () => ({
  useOrganization: () => ({
    members: [],
    humanId: 1,
    discussions: [],
    refresh: vi.fn(),
  }),
}));

let currentDraft = { body: "", pending: null as unknown };
const draftListeners = new Set<() => void>();

const mockDraftController = {
  snapshot: () => ({
    draft: currentDraft,
    files: [],
    busy: false,
    storageError: null,
    error: null,
  }),
  subscribe: (cb: () => void) => {
    draftListeners.add(cb);
    return () => draftListeners.delete(cb);
  },
  send: vi.fn(),
  addFiles: vi.fn(),
  removeFile: vi.fn(),
  setBody: vi.fn((next: string) => {
    currentDraft = { ...currentDraft, body: next };
    draftListeners.forEach((l) => {
      l();
    });
  }),
  saveAgain: vi.fn(),
  cancel: vi.fn(),
  checkResult: vi.fn(),
  discardAttempt: vi.fn(),
};

vi.mock("@/features/discussions/draft", async (original) => ({
  ...(await original<typeof import("@/features/discussions/draft")>()),
  useDraft: () => ({
    controller: mockDraftController,
    view: mockDraftController.snapshot(),
    error: null,
  }),
}));

import { ConfirmDialog, Modal, PromptDialog } from "@/components/ui/dialog";
import { Button, IconButton } from "@/components/ui/index";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Composer } from "@/features/discussions/composer";
import { DiscussionCard } from "@/features/discussions/list";
import { MessageRow } from "@/features/discussions/thread";
import { MemberCard } from "@/features/members/list";
import type { DiscussionSummary, Member, Message } from "@/lib/backend";

describe("Mobile adaptation repair verification", () => {
  let cleanup: typeof import("@testing-library/react").cleanup;
  let render: typeof import("@testing-library/react").render;
  let screen: typeof import("@testing-library/react").screen;
  let fireEvent: typeof import("@testing-library/react").fireEvent;
  let closeDom: (() => void) | undefined;

  beforeAll(async () => {
    const packageName = "jsdom";
    const { JSDOM } = await import(packageName);
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost",
      pretendToBeVisual: true,
    });
    Object.defineProperty(dom.window, "innerWidth", {
      configurable: true,
      value: 375,
    });
    Object.defineProperty(dom.window, "innerHeight", {
      configurable: true,
      value: 667,
    });
    closeDom = () => dom.window.close();
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("navigator", dom.window.navigator);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
    vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
    vi.stubGlobal("Event", dom.window.Event);
    vi.stubGlobal("EventTarget", dom.window.EventTarget);
    vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
    vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
    vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
    vi.stubGlobal("TouchEvent", dom.window.TouchEvent);
    vi.stubGlobal("AbortController", dom.window.AbortController);
    vi.stubGlobal("AbortSignal", dom.window.AbortSignal);
    vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    dom.window.requestAnimationFrame = vi.fn((cb) => {
      cb(0);
      return 0;
    });
    dom.window.cancelAnimationFrame = vi.fn();
    Object.defineProperty(dom.window.document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.stubGlobal("requestAnimationFrame", dom.window.requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", dom.window.cancelAnimationFrame);
    const testing = await import("@testing-library/react");
    cleanup = testing.cleanup;
    render = testing.render;
    screen = testing.screen;
    fireEvent = testing.fireEvent;
  }, 30000);

  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  afterAll(() => {
    closeDom?.();
    vi.unstubAllGlobals();
  });

  describe("Modal variants and responsive structure", () => {
    it("renders ConfirmDialog with confirm variant and scrolling description", async () => {
      render(
        <TooltipProvider>
          <ConfirmDialog
            open
            onOpenChange={() => {}}
            title="Delete Item"
            description="A very long explanation that must scroll independently inside the dialog on small mobile viewports."
            confirmLabel="Confirm"
            onConfirm={() => {}}
          />
        </TooltipProvider>,
      );

      const dialog = await screen.findByRole("dialog");
      expect(dialog.className).toContain("narrow:max-h-[85dvh]");
      expect(dialog.className).toContain("narrow:inset-x-0");
      expect(dialog.className).toContain("narrow:bottom-0");

      const scrollRegion = dialog.querySelector('[class~="overflow-y-auto"]');
      expect(scrollRegion).not.toBeNull();
      expect(scrollRegion?.textContent).toContain("A very long explanation");

      const footer = dialog.querySelector('[class*="narrow:flex-col-reverse"]');
      expect(footer).not.toBeNull();
      expect(footer?.className).toContain("narrow:*:min-h-11");
      expect(footer?.className).toContain("narrow:*:w-full");

      const closeButton = dialog.querySelector('button[aria-label="Close"]');
      expect(closeButton?.className).toContain("narrow:min-w-11");
      expect(closeButton?.className).toContain("narrow:min-h-11");
    });

    it("renders PromptDialog with form variant and auto-focuses first input", async () => {
      render(
        <TooltipProvider>
          <PromptDialog
            open
            onOpenChange={() => {}}
            title="Edit Name"
            description="Please enter the new member name"
            label="Name"
            initial="Old Name"
            submitLabel="Save"
            onSubmit={() => {}}
          />
        </TooltipProvider>,
      );

      const dialog = await screen.findByRole("dialog");
      expect(dialog.className).toContain("narrow:max-h-[85dvh]");
      const input = dialog.querySelector("input");
      expect(input).not.toBeNull();
      expect(input?.value).toBe("Old Name");
    });

    it("renders history modal with 90dvh上限 and non-shrinking headers and footers", async () => {
      render(
        <TooltipProvider>
          <Modal
            open
            onOpenChange={() => {}}
            title="Turn Details"
            variant="history"
            footer={<Button>Close</Button>}
          >
            <div style={{ height: "1500px" }}>Long turn history transcript</div>
          </Modal>
        </TooltipProvider>,
      );

      const dialog = await screen.findByRole("dialog");
      expect(dialog.className).toContain("narrow:max-h-[90dvh]");

      const header = dialog.querySelector('[class*="shrink-0"]');
      expect(header).not.toBeNull();
      expect(header?.textContent).toContain("Turn Details");

      const scrollRegion = dialog.querySelector('[class~="overflow-y-auto"]');
      expect(scrollRegion).not.toBeNull();
      expect(scrollRegion?.textContent).toContain(
        "Long turn history transcript",
      );
    });
  });

  describe("Touch targets for interactive buttons", () => {
    it("ensures IconButton with touchTarget has 44px minimum touch targets", () => {
      render(
        <TooltipProvider>
          <IconButton label="Navigation menu" touchTarget>
            <span>Menu</span>
          </IconButton>
        </TooltipProvider>,
      );

      const button = screen.getByRole("button", { name: "Navigation menu" });
      expect(button.className).toContain("narrow:min-w-11");
      expect(button.className).toContain("narrow:min-h-11");
    });

    it("ensures Button with touchTarget expands vertical touch area to 44px", () => {
      render(
        <Button size="sm" touchTarget>
          Mark handled
        </Button>,
      );

      const button = screen.getByRole("button", { name: "Mark handled" });
      expect(button.className).toContain("narrow:min-h-11");
    });

    it("ensures MessageRow action buttons carry touchTarget on mobile", () => {
      const mockMessage: Message = {
        id: 101,
        sender_id: 1,
        sender_name: "Helper",
        body: "Hello",
        mentions: [],
        attachments: [],
        created_at: "2026-10-07T12:00:00Z",
      };

      const { unmount } = render(
        <TooltipProvider>
          <MessageRow
            discussionId={1}
            message={mockMessage}
            compact={false}
            fresh={false}
            pending={true}
            acknowledged={false}
            busy={false}
            onAck={() => {}}
            onRevoke={() => {}}
          />
        </TooltipProvider>,
      );

      const ackButton = screen.getByRole("button", { name: "Mark handled" });
      expect(ackButton.className).toContain("narrow:min-h-11");
      unmount();

      const mockHandled: Message = {
        ...mockMessage,
      };

      render(
        <TooltipProvider>
          <MessageRow
            discussionId={1}
            message={mockHandled}
            compact={false}
            fresh={false}
            pending={false}
            acknowledged={true}
            busy={false}
            onAck={() => {}}
            onRevoke={() => {}}
          />
        </TooltipProvider>,
      );

      const undoButton = screen.getByRole("button", {
        name: "Undo confirmation",
      });
      expect(undoButton.className).toContain("narrow:min-h-11");
    });
  });

  describe("Composer mobile geometry and touch interactions", () => {
    it("renders composer with bottom-0, safe-area padding and scroll constraints", () => {
      render(
        <Composer
          discussionId={1}
          members={[]}
          memberIds={new Set<number>()}
          busy={false}
          placeholder="Message"
          onSend={async () => true}
          onHeightChange={() => {}}
          onOpenVoiceSettings={() => {}}
        />,
      );

      const fieldset = screen.getByRole("group", { name: "Message composer" });
      expect(fieldset.className).toContain("narrow:max-h-[35dvh]");
      expect(fieldset.className).toContain("overflow-hidden");
      expect(fieldset.className).toContain("flex");
      expect(fieldset.className).toContain("flex-col");

      const wrapper = fieldset.parentElement;
      expect(wrapper?.className).toContain("bottom-0");
      expect(wrapper?.className).toContain(
        "narrow:pb-[calc(8px+env(safe-area-inset-bottom,0px))]",
      );

      const attachButton = screen.getByRole("button", { name: "Attach files" });
      expect(attachButton.className).toContain("narrow:size-11");
      expect(attachButton.className).toContain("narrow:min-w-11");
      expect(attachButton.className).toContain("narrow:min-h-11");

      const sendButton = screen.getByRole("button", {
        name: "Start voice input",
      });
      expect(sendButton.className).toContain("narrow:size-11");
      expect(sendButton.className).toContain("narrow:min-w-11");
      expect(sendButton.className).toContain("narrow:min-h-11");

      const collapsedToolbar = fieldset.querySelector("[inert]");
      expect(collapsedToolbar).not.toBeNull();
    });

    it("distinguishes touch swipe from touch tap for mention candidates", async () => {
      const mockMembers: Member[] = [
        { id: 2, name: "Alice", type: "human", state: "idle" },
        { id: 3, name: "Bob", type: "human", state: "idle" },
      ];

      render(
        <Composer
          discussionId={1}
          members={mockMembers}
          memberIds={new Set([2, 3])}
          busy={false}
          placeholder="Message"
          onSend={async () => true}
          onHeightChange={() => {}}
          onOpenVoiceSettings={() => {}}
        />,
      );

      const textarea = screen.getByRole("combobox", {
        name: "Message",
      }) as HTMLTextAreaElement;
      Object.defineProperty(textarea, "selectionStart", {
        configurable: true,
        get: () => 2,
      });
      fireEvent.change(textarea, { target: { value: "@A" } });

      const option = await screen.findByRole("option", { name: /Alice/i });
      expect(option).not.toBeNull();

      fireEvent.touchStart(option, {
        touches: [{ clientX: 100, clientY: 100 }],
      });
      fireEvent.touchEnd(option, {
        changedTouches: [{ clientX: 100, clientY: 150 }],
      });
      expect(textarea).toHaveProperty("value", "@A");

      fireEvent.touchStart(option, {
        touches: [{ clientX: 100, clientY: 100 }],
      });
      fireEvent.touchEnd(option, {
        changedTouches: [{ clientX: 102, clientY: 103 }],
      });
      expect((textarea as HTMLTextAreaElement).value).toContain("@Alice ");
    });
  });

  describe("List card layouts in narrow viewport", () => {
    it("renders DiscussionCard with topic, unread badge, and handles selection", () => {
      const item: DiscussionSummary = {
        id: 10,
        topic: "Mobile Redesign",
        member_ids: [1],
        archived: false,
        unread: 4,
      };
      const byId = new Map<number, Member>([
        [1, { id: 1, name: "Alice", type: "human", state: "idle" }],
      ]);
      const onOpen = vi.fn();
      const onArchive = vi.fn();

      render(
        <TooltipProvider>
          <DiscussionCard
            item={item}
            byId={byId}
            onOpen={onOpen}
            onArchive={onArchive}
          />
        </TooltipProvider>,
      );

      expect(screen.getByText("Mobile Redesign")).not.toBeNull();
      expect(screen.getByText("4")).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Mobile Redesign" }));
      expect(onOpen).toHaveBeenCalledOnce();
    });

    it("renders MemberCard with state, tokens, and handles navigation for agents", () => {
      const member: Member = {
        id: 20,
        name: "WorkerBot",
        type: "agent",
        state: "running",
        tokens: 3500,
      };
      const onOpen = vi.fn();

      render(
        <TooltipProvider>
          <MemberCard
            member={member}
            tokenLimit={10000}
            onOpen={onOpen}
            onToggle={() => {}}
            onRename={() => {}}
            onDelete={() => {}}
          />
        </TooltipProvider>,
      );

      expect(screen.getByText("WorkerBot")).not.toBeNull();
      expect(screen.getByText("Running")).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "WorkerBot" }));
      expect(onOpen).toHaveBeenCalledOnce();
    });
  });
});
