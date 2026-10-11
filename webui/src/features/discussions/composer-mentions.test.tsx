import { useSyncExternalStore } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { DraftController } from "@/features/discussions/draft";
import type { Member } from "@/lib/backend";

const harness = vi.hoisted(() => ({
  controller: null as DraftController | null,
  put: vi.fn(),
}));
vi.mock("idb", () => ({
  openDB: async () => ({ put: harness.put, close: () => {} }),
}));
vi.mock("@/features/discussions/draft", async (original) => ({
  ...(await original<typeof import("@/features/discussions/draft")>()),
  useDraft: () => {
    const controller = harness.controller;
    const snapshot = controller?.snapshot ?? (() => null);
    const subscribe = controller?.subscribe ?? (() => () => {});
    return {
      controller,
      view: useSyncExternalStore(subscribe, snapshot, snapshot),
      error: null,
    };
  },
}));

let cleanup: typeof import("@testing-library/react").cleanup;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let Composer: typeof import("@/features/discussions/composer").Composer;
let closeDom: () => void;

const members: Member[] = [
  { id: 1, type: "human", name: "You", state: "idle" },
  { id: 2, type: "agent", name: "ALL", state: "paused" },
  { id: 3, type: "agent", name: "All Hands", state: "idle" },
  { id: 4, type: "agent", name: "Allison", state: "idle" },
];

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  closeDom = () => dom.window.close();
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLTextAreaElement",
    "Element",
    "Node",
    "MutationObserver",
    "Event",
    "EventTarget",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
  ]) {
    vi.stubGlobal(name, Reflect.get(dom.window, name));
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({
    lineHeight: "20px",
    paddingTop: "0px",
    paddingBottom: "0px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
  }));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  ({ cleanup, fireEvent, render, act } = await import(
    "@testing-library/react"
  ));
  ({ Composer } = await import("@/features/discussions/composer"));
}, 30000);

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 375,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: undefined,
  });
  harness.put.mockReset().mockResolvedValue(undefined);
  harness.controller = new DraftController(1, {
    key: "mentions:1:1:tab",
    updatedAt: 0,
    body: "",
    bodyRevision: 0,
    files: [],
    pending: null,
  });
});
afterEach(async () => {
  await act(async () => {
    await vi.waitFor(() =>
      expect(harness.controller?.snapshot().saving).toBe(false),
    );
  });
  cleanup();
  await new Promise<void>((resolve) => setImmediate(resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  closeDom();
  vi.unstubAllGlobals();
});

function mount(people = members, memberIds = new Set([1, 2, 3])) {
  const onSend = vi.fn(async () => true);
  const view = render(
    <Composer
      discussionId={1}
      members={people}
      memberIds={memberIds}
      busy={false}
      placeholder="Message"
      onSend={onSend}
      onHeightChange={() => {}}
      onOpenVoiceSettings={() => {}}
    />,
  );
  const input = view.getByRole("combobox") as HTMLTextAreaElement;
  const type = (text: string, caret = text.length) =>
    act(async () => {
      fireEvent.change(input, {
        target: { value: text, selectionStart: caret },
      });
      await vi.waitFor(() =>
        expect(harness.controller?.snapshot().saving).toBe(false),
      );
    });
  const options = () => view.queryAllByRole("option");
  const interact = (action: () => void) =>
    act(async () => {
      action();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() =>
        expect(harness.controller?.snapshot().saving).toBe(false),
      );
    });
  const key = (event: Record<string, unknown>) =>
    interact(() => fireEvent.keyDown(input, event));
  const select = (index: number) =>
    interact(() => fireEvent.mouseDown(options()[index]));
  return { ...view, input, type, options, onSend, key, select };
}

it.each(["Enter", "Tab"])(
  "completes everyone on %s and places the caret after the space",
  async (key) => {
    const view = mount();
    await view.type("hello @AL");
    expect(view.options().map((item) => item.textContent)).toEqual([
      "allEveryone",
      "All Handsidle",
      "Allison",
    ]);
    const first = view.options()[0];
    expect(first.id.endsWith("-all")).toBe(true);
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(view.input.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(view.getByText("Not in this Discussion")).toBeDefined();
    await view.key({ key });
    expect(view.input.value).toBe("hello @all ");
    expect(view.input.selectionStart).toBe(11);
    expect(view.options()).toEqual([]);
    expect(view.onSend).not.toHaveBeenCalled();
    await act(async () => {
      await vi.waitFor(() =>
        expect(harness.controller?.snapshot().saving).toBe(false),
      );
    });
    expect(harness.controller?.snapshot().draft.body).toBe("hello @all ");
  },
);

it("cycles through members and everyone with arrow keys", async () => {
  const view = mount();
  await view.type("@al");
  await view.key({ key: "ArrowUp" });
  expect(view.options()[2].getAttribute("aria-selected")).toBe("true");
  await view.key({ key: "ArrowDown" });
  expect(view.options()[0].getAttribute("aria-selected")).toBe("true");
  await view.key({ key: "ArrowDown" });
  await view.key({ key: "Tab" });
  expect(view.input.value).toBe("@All Hands ");
  expect(view.options()).toEqual([]);
});

it("accepts everyone with the mouse and dismisses suggestions with Escape", async () => {
  const view = mount();
  await view.type("@a");
  await view.select(0);
  expect(view.input.value).toBe("@all ");
  expect(view.input.selectionStart).toBe(5);
  expect(view.options()).toEqual([]);
  await view.type("@al");
  await view.key({ key: "Escape" });
  expect(view.options()).toEqual([]);
  expect(view.input.value).toBe("@al");
});

it("completes at a UTF-16 caret inside the body and preserves following text", async () => {
  const view = mount();
  await view.type("😀 @AL suffix", 6);
  await view.key({ key: "Tab" });
  expect(view.input.value).toBe("😀 @all  suffix");
  expect(view.input.selectionStart).toBe(8);
  expect(document.activeElement).toBe(view.input);
  expect(view.options()).toEqual([]);
});

it("keeps IME and Shift+Enter input while everyone is selected", async () => {
  const view = mount();
  await view.type("@all");
  await view.key({ key: "Enter", isComposing: true });
  expect(view.input.value).toBe("@all");
  expect(view.options()[0].getAttribute("aria-selected")).toBe("true");
  await view.key({ key: "Enter", shiftKey: true });
  expect(view.input.value).toBe("@all");
  expect(view.onSend).not.toHaveBeenCalled();
});

it("counts everyone toward the eight option limit", async () => {
  const people = [
    ...members,
    ...Array.from(
      { length: 10 },
      (_, index): Member => ({
        id: index + 5,
        name: `Agent ${index}`,
        type: "agent",
        state: "idle",
      }),
    ),
  ];
  const view = mount(people, new Set(people.map((member) => member.id)));
  await view.type("@");
  expect(view.options()).toHaveLength(8);
  expect(view.options()[0].textContent).toBe("allEveryone");
});

it.each([
  [0, "all"],
  [1, "All Hands"],
])(
  "accepts touch candidate %s and retains the draft identity",
  async (index, name) => {
    const view = mount();
    const controller = harness.controller;
    await view.type("😀 @AL suffix", 6);
    const option = view.options()[index];
    await act(async () => {
      fireEvent.touchStart(option, {
        touches: [{ clientX: 20, clientY: 30 }],
      });
      fireEvent.touchEnd(option, {
        changedTouches: [{ clientX: 24, clientY: 34 }],
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() => expect(controller?.snapshot().saving).toBe(false));
    });
    const text = `😀 @${name}  suffix`;
    expect(view.input.value).toBe(text);
    expect(view.input.selectionStart).toBe(`😀 @${name} `.length);
    expect(document.activeElement).toBe(view.input);
    expect(view.options()).toEqual([]);
    expect(harness.controller).toBe(controller);
    expect(controller?.snapshot().draft.key).toBe("mentions:1:1:tab");
    expect(controller?.snapshot().draft.body).toBe(text);
    expect(view.onSend).not.toHaveBeenCalled();
  },
);

it.each([
  [10, 0],
  [0, 10],
  [0, 45],
])("keeps the draft during a touch movement of %s/%s", async (dx, dy) => {
  const view = mount();
  await view.type("@al");
  const option = view.options()[0];
  await act(async () => {
    fireEvent.touchStart(option, {
      touches: [{ clientX: 20, clientY: 30 }],
    });
    fireEvent.touchEnd(option, {
      changedTouches: [{ clientX: 20 + dx, clientY: 30 + dy }],
    });
  });
  expect(view.input.value).toBe("@al");
  expect(harness.controller?.snapshot().draft.body).toBe("@al");
  expect(view.options()).toHaveLength(3);
  fireEvent.touchEnd(option, {
    changedTouches: [{ clientX: 20, clientY: 30 }],
  });
  expect(view.input.value).toBe("@al");
  expect(view.onSend).not.toHaveBeenCalled();
});

it("updates candidate height with the current visual viewport", async () => {
  const viewport = Object.assign(new EventTarget(), { offsetTop: 20 });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  const view = mount();
  const card = view.getByRole("group", { name: "Message composer" });
  let top = 200;
  const rect = vi
    .spyOn(card, "getBoundingClientRect")
    .mockImplementation(() => ({
      x: 0,
      y: top,
      top,
      bottom: top + 52,
      left: 0,
      right: 375,
      width: 375,
      height: 52,
      toJSON: () => ({}),
    }));
  await view.type("@al");
  const menu = view.getByRole("listbox");
  expect(menu.style.maxHeight).toBe("172px");
  await act(async () => {
    viewport.offsetTop = 100;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(menu.style.maxHeight).toBe("92px");
  await act(async () => {
    top = 600;
    window.dispatchEvent(new Event("scroll"));
  });
  expect(menu.style.maxHeight).toBe("264px");
  await act(async () => {
    top = 80;
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(menu.style.maxHeight).toBe("0px");
  rect.mockRestore();
});

it("offers no everyone option for an empty discussion", async () => {
  const view = mount(members, new Set());
  await view.type("@all");
  expect(view.options().map((item) => item.textContent)).toEqual([
    "Allison",
    "All Hands",
  ]);
});
