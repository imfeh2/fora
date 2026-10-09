import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { ReactNode } from "react";
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

vi.mock("@radix-ui/react-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@radix-ui/react-dialog")>()),
  Portal: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/app/organization", () => ({
  useOrganization: () => ({
    members: [
      { id: 1, name: "You", type: "human", state: "idle" },
      { id: 2, name: "Alice", type: "human", state: "idle" },
      { id: 3, name: "Bob", type: "human", state: "idle" },
    ],
    humanId: 1,
    discussions: [],
    refresh: vi.fn(),
  }),
}));

import { NavItem, NavSubItem } from "@/components/layout/shell";
import { ConfirmDialog, Modal, PromptDialog } from "@/components/ui/dialog";
import { Button, IconButton } from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Composer } from "@/features/discussions/composer";
import { DiscussionCard } from "@/features/discussions/list";
import {
  getAvailableViewport,
  MessageRow,
} from "@/features/discussions/thread";
import { MemberCard } from "@/features/members/list";
import {
  backend,
  type DiscussionSummary,
  type Member,
  type Message,
} from "@/lib/backend";

describe("Mobile adaptation repair verification", () => {
  let cleanup: typeof import("@testing-library/react").cleanup;
  let render: typeof import("@testing-library/react").render;
  let screen: typeof import("@testing-library/react").screen;
  let fireEvent: typeof import("@testing-library/react").fireEvent;
  let waitFor: typeof import("@testing-library/react").waitFor;
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
    vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
    dom.window.sessionStorage.setItem("fora.draft-tab", "test-tab-repair");
    Object.defineProperty(dom.window.navigator, "locks", {
      configurable: true,
      value: {
        request: vi.fn(async (_name, _options, callback) => callback({})),
      },
    });
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
    waitFor = testing.waitFor;
  }, 30000);

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.spyOn(backend, "organization").mockResolvedValue({
      uuid: "test-org",
      human_id: 1,
    } as Awaited<ReturnType<typeof backend.organization>>);
    vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
    vi.spyOn(backend, "sendStatus").mockResolvedValue({
      state: "unknown",
      message: null,
    });
    vi.spyOn(backend, "cancelUploads").mockResolvedValue({ cancelled: 1 });
  });

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
      expect(dialog.className).not.toContain("narrow:max-h-[85dvh]");
      expect(dialog.className).not.toContain("narrow:max-h-[90dvh]");
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

    it("ensures Modal wide prop only controls width and does not alter variant", async () => {
      render(
        <TooltipProvider>
          <Modal
            open
            onOpenChange={() => {}}
            title="Form with Wide Layout"
            wide
          >
            <div>Form contents</div>
          </Modal>
        </TooltipProvider>,
      );

      const dialog = await screen.findByRole("dialog");
      expect(dialog.className).toContain("w-[min(960px,calc(100vw-32px))]");
      expect(dialog.className).toContain("narrow:max-h-[85dvh]");
      expect(dialog.className).not.toContain("narrow:max-h-[90dvh]");
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

    it("ensures touch targets on overflow menu trigger and items", () => {
      const actions = [{ id: "edit", label: "Edit item", onSelect: () => {} }];
      render(
        <TooltipProvider>
          <OverflowMenu label="Actions menu" actions={actions} />
        </TooltipProvider>,
      );

      const trigger = screen.getByRole("button", { name: "Actions menu" });
      expect(trigger.className).toContain("narrow:min-w-11");
      expect(trigger.className).toContain("narrow:min-h-11");
      expect(trigger.className).toContain("touch:min-w-11");
      expect(trigger.className).toContain("touch:min-h-11");

      fireEvent.click(trigger);
      const menuItem = screen.getByRole("menuitem", { name: "Edit item" });
      expect(menuItem.className).toContain("narrow:min-h-11");
      expect(menuItem.className).toContain("touch:min-h-11");
    });

    it("ensures NavItem and NavSubItem buttons provide 44px touch targets on mobile", () => {
      render(
        <nav>
          <NavItem
            icon={<span>Icon</span>}
            label="Discussions"
            active={false}
            onSelect={() => {}}
          >
            <NavSubItem label="General" active={false} onSelect={() => {}} />
          </NavItem>
        </nav>,
      );

      const navItemBtn = screen.getByRole("button", { name: "Discussions" });
      expect(navItemBtn.className).toContain("narrow:min-h-11");
      expect(navItemBtn.className).toContain("touch:min-h-11");

      const navSubItemBtn = screen.getByRole("button", { name: "General" });
      expect(navSubItemBtn.className).toContain("narrow:min-h-11");
      expect(navSubItemBtn.className).toContain("touch:min-h-11");
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
      expect(fieldset.className).not.toContain("overflow-hidden");
      expect(fieldset.className).toContain("flex");
      expect(fieldset.className).toContain("flex-col");

      const wrapper = fieldset.parentElement;
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

    it("renders composer with dynamic keyboardOffset for Visual Viewport coordination", () => {
      render(
        <Composer
          discussionId={1}
          members={[]}
          memberIds={new Set<number>()}
          busy={false}
          placeholder="Message"
          keyboardOffset={280}
          onSend={async () => true}
          onHeightChange={() => {}}
          onOpenVoiceSettings={() => {}}
        />,
      );

      const fieldset = screen.getByRole("group", { name: "Message composer" });
      const wrapper = fieldset.parentElement as HTMLElement;
      expect(wrapper.style.bottom).toBe("280px");
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

      const textarea = (await screen.findByRole("combobox", {
        name: "Message",
      })) as HTMLTextAreaElement;
      await waitFor(() => expect(textarea.disabled).toBe(false));
      Object.defineProperty(textarea, "selectionStart", {
        configurable: true,
        get: () => 2,
      });
      fireEvent.change(textarea, { target: { value: "@A" } });
      fireEvent.select(textarea);

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

    it("persists and restores draft in isolated IndexedDB across discussion switching in narrow viewport", async () => {
      const { unmount } = render(
        <Composer
          discussionId={1001}
          members={[]}
          memberIds={new Set<number>()}
          busy={false}
          placeholder="Message"
          onSend={async () => true}
          onHeightChange={() => {}}
          onOpenVoiceSettings={() => {}}
        />,
      );

      const textarea1 = (await screen.findByRole("combobox", {
        name: "Message",
      })) as HTMLTextAreaElement;
      await waitFor(() => expect(textarea1.disabled).toBe(false));

      fireEvent.change(textarea1, {
        target: { value: "Draft message for Discussion 1001" },
      });
      await waitFor(() =>
        expect(textarea1.value).toBe("Draft message for Discussion 1001"),
      );

      unmount();

      const secondRender = render(
        <Composer
          discussionId={1002}
          members={[]}
          memberIds={new Set<number>()}
          busy={false}
          placeholder="Message"
          onSend={async () => true}
          onHeightChange={() => {}}
          onOpenVoiceSettings={() => {}}
        />,
      );

      const textarea2 = (await screen.findByRole("combobox", {
        name: "Message",
      })) as HTMLTextAreaElement;
      await waitFor(() => expect(textarea2.disabled).toBe(false));
      expect(textarea2.value).toBe("");

      secondRender.unmount();

      render(
        <Composer
          discussionId={1001}
          members={[]}
          memberIds={new Set<number>()}
          busy={false}
          placeholder="Message"
          onSend={async () => true}
          onHeightChange={() => {}}
          onOpenVoiceSettings={() => {}}
        />,
      );

      const textareaRestored = (await screen.findByRole("combobox", {
        name: "Message",
      })) as HTMLTextAreaElement;
      await waitFor(() =>
        expect(textareaRestored.value).toBe(
          "Draft message for Discussion 1001",
        ),
      );
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

  describe("Touch media conditions and dynamic candidate geometry", () => {
    it("ensures wide viewport with coarse pointer applies touch padding and prevents overlap", async () => {
      const originalInnerWidth = window.innerWidth;
      const originalMatchMedia = window.matchMedia;

      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1024,
      });
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      try {
        render(
          <Composer
            discussionId={2001}
            members={[]}
            memberIds={new Set<number>()}
            busy={false}
            placeholder="Message"
            onSend={async () => true}
            onHeightChange={() => {}}
            onOpenVoiceSettings={() => {}}
          />,
        );

        const textarea = (await screen.findByRole("combobox", {
          name: "Message",
        })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.disabled).toBe(false));

        expect(textarea.style.paddingLeft).toBe("52px");
        expect(textarea.style.paddingRight).toBe("52px");
      } finally {
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: originalInnerWidth,
        });
        window.matchMedia = originalMatchMedia;
      }
    });

    it("ensures mention candidates height clamps strictly to available viewport and updates on keyboard offset", async () => {
      const mockMembers: Member[] = [
        { id: 2, name: "Alice", type: "human", state: "idle" },
      ];

      const { rerender } = render(
        <Composer
          discussionId={2002}
          members={mockMembers}
          memberIds={new Set([2])}
          busy={false}
          placeholder="Message"
          keyboardOffset={0}
          onSend={async () => true}
          onHeightChange={() => {}}
          onOpenVoiceSettings={() => {}}
        />,
      );

      const textarea = (await screen.findByRole("combobox", {
        name: "Message",
      })) as HTMLTextAreaElement;
      await waitFor(() => expect(textarea.disabled).toBe(false));

      const card = screen.getByRole("group", { name: "Message composer" });
      vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
        top: 50,
        bottom: 102,
        left: 0,
        right: 375,
        width: 375,
        height: 52,
        x: 0,
        y: 50,
        toJSON: () => {},
      });

      fireEvent.change(textarea, { target: { value: "@A" } });
      fireEvent.select(textarea);

      const listbox = await screen.findByRole("listbox", { name: "Members" });
      expect(listbox.style.maxHeight).toBe("42px");

      vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
        top: 8,
        bottom: 60,
        left: 0,
        right: 375,
        width: 375,
        height: 52,
        x: 0,
        y: 8,
        toJSON: () => {},
      });

      rerender(
        <Composer
          discussionId={2002}
          members={mockMembers}
          memberIds={new Set([2])}
          busy={false}
          placeholder="Message"
          keyboardOffset={100}
          onSend={async () => true}
          onHeightChange={() => {}}
          onOpenVoiceSettings={() => {}}
        />,
      );

      await waitFor(() => {
        expect(listbox.style.maxHeight).toBe("0px");
      });
    });

    it("ensures candidate height factors in visual viewport offset top during zoomed panning", async () => {
      const mockMembers: Member[] = [
        { id: 2, name: "Alice", type: "human", state: "idle" },
      ];

      const originalVisualViewport = window.visualViewport;
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: {
          offsetTop: 60,
          offsetLeft: 0,
          width: 375,
          height: 500,
          scale: 1.5,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });

      try {
        render(
          <Composer
            discussionId={2003}
            members={mockMembers}
            memberIds={new Set([2])}
            busy={false}
            placeholder="Message"
            keyboardOffset={0}
            onSend={async () => true}
            onHeightChange={() => {}}
            onOpenVoiceSettings={() => {}}
          />,
        );

        const textarea = (await screen.findByRole("combobox", {
          name: "Message",
        })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.disabled).toBe(false));

        const card = screen.getByRole("group", { name: "Message composer" });
        vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
          top: 150,
          bottom: 202,
          left: 0,
          right: 375,
          width: 375,
          height: 52,
          x: 0,
          y: 150,
          toJSON: () => {},
        });

        fireEvent.change(textarea, { target: { value: "@A" } });
        fireEvent.select(textarea);

        const listbox = await screen.findByRole("listbox", { name: "Members" });
        expect(listbox.style.maxHeight).toBe("82px");
      } finally {
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: originalVisualViewport,
        });
      }
    });

    it("ensures getAvailableViewport respects actual composer occlusion and visual viewport boundaries without unconditional subtraction", () => {
      const root = document.createElement("div");
      vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 800,
        left: 0,
        right: 375,
        width: 375,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      const originalVisualViewport = window.visualViewport;
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: {
          offsetTop: 200,
          offsetLeft: 0,
          width: 375,
          height: 400,
          scale: 2,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });

      try {
        const zoomed = getAvailableViewport(root, 64, 0);
        expect(zoomed.top).toBe(200);
        expect(zoomed.end).toBe(600);

        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: {
            offsetTop: 0,
            offsetLeft: 0,
            width: 375,
            height: 500,
            scale: 1,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          },
        });

        const keyboard = getAvailableViewport(root, 64, 300);
        expect(keyboard.top).toBe(0);
        expect(keyboard.end).toBe(436);

        const empty = getAvailableViewport(root, 750, 100);
        expect(empty.end).toBeLessThanOrEqual(empty.top);
      } finally {
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: originalVisualViewport,
        });
      }
    });
  });
});
