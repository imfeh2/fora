import { StrictMode, useSyncExternalStore } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { type Draft, DraftController } from "@/features/discussions/draft";
import { backend } from "@/lib/backend";
import type { VoiceEvent } from "@/lib/voice";

const harness = vi.hoisted(() => ({
  controller: null as DraftController | null,
  put: vi.fn(),
  voice: null as ((event: VoiceEvent) => void) | null,
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
vi.mock("@/lib/voice", () => ({
  VoiceRecording: class {
    constructor(callback: (event: VoiceEvent) => void) {
      harness.voice = callback;
    }
    start = async () => harness.voice?.({ type: "state", state: "recording" });
    cancel = vi.fn();
  },
}));

let cleanup: typeof import("@testing-library/react").cleanup;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let Composer: typeof import("@/features/discussions/composer").Composer;
let closeDom: () => void;
let compactWidth = 600;
let visibleWidth = 600;
let scrollbarWidth = 0;
let extraHeight = 0;
let stretchedHeight = 202;
let borderWidth = 0;
let boxSizing = "border-box";
let fontReady!: () => void;
const reads: { width: number; left: number; right: number; padding: number }[] =
  [];
const observers: GeometryObserver[] = [];

class GeometryObserver {
  elements = new Set<Element>();
  disconnected = false;
  constructor(readonly callback: () => void) {
    observers.push(this);
  }
  observe = (element: Element) => this.elements.add(element);
  disconnect = () => {
    this.disconnected = true;
    this.elements.clear();
  };
  notify = () => {
    if (!this.disconnected) this.callback();
  };
}

function isInput(element: Element) {
  return element.getAttribute("aria-label") === "Message";
}
function isProbe(element: Element) {
  return element instanceof HTMLTextAreaElement && !isInput(element);
}
function rect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: height,
    right: width,
    width,
    height,
    toJSON: () => ({}),
  };
}
function naturalHeight(element: HTMLTextAreaElement) {
  const left = Number.parseFloat(element.style.paddingLeft || "16");
  const right = Number.parseFloat(element.style.paddingRight || "48");
  const padding = Number.parseFloat(element.style.paddingBlock || "12") * 2;
  const width = isInput(element)
    ? visibleWidth - scrollbarWidth
    : Number.parseFloat(element.style.width || String(compactWidth));
  const columns = Math.max(
    1,
    Math.floor((width - left - right - 2 * borderWidth) / 8),
  );
  const lines = element.value
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(Array.from(line).length / columns)),
      0,
    );
  if (isProbe(element)) reads.push({ width, left, right, padding });
  return lines * 22 + padding;
}

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
    "HTMLFieldSetElement",
    "Element",
    "Node",
    "MutationObserver",
    "Event",
    "File",
  ]) {
    vi.stubGlobal(name, Reflect.get(dom.window, name));
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", GeometryObserver);
  vi.stubGlobal("getComputedStyle", (element: HTMLElement) => ({
    fontFamily: "Inter",
    fontSize: "14px",
    fontWeight: "400",
    fontStyle: "normal",
    fontStretch: "normal",
    fontVariant: "normal",
    fontFeatureSettings: "normal",
    fontVariationSettings: "normal",
    lineHeight: "22px",
    letterSpacing: "0px",
    wordSpacing: "0px",
    textIndent: "0px",
    textTransform: "none",
    textRendering: "auto",
    direction: "ltr",
    whiteSpace: "pre-wrap",
    wordBreak: "normal",
    overflowWrap: "break-word",
    tabSize: "8",
    boxSizing,
    paddingTop: element.style.paddingBlock || "12px",
    paddingBottom: element.style.paddingBlock || "12px",
    paddingLeft: element.style.paddingLeft || "16px",
    paddingRight: element.style.paddingRight || "48px",
    borderTopWidth: `${borderWidth}px`,
    borderBottomWidth: `${borderWidth}px`,
    borderLeftWidth: `${borderWidth}px`,
    borderRightWidth: `${borderWidth}px`,
    borderStyle: "solid",
  }));
  ({ cleanup, fireEvent, render, act } = await import(
    "@testing-library/react"
  ));
  ({ Composer } = await import("@/features/discussions/composer"));
}, 30000);

beforeEach(() => {
  compactWidth = 600;
  visibleWidth = 600;
  scrollbarWidth = 0;
  extraHeight = 0;
  stretchedHeight = 202;
  borderWidth = 0;
  boxSizing = "border-box";
  reads.length = 0;
  observers.length = 0;
  harness.voice = null;
  harness.put.mockReset().mockResolvedValue(undefined);
  harness.controller = new DraftController(1, {
    key: "height:1:1:tab",
    updatedAt: 0,
    body: "",
    bodyRevision: 0,
    files: [],
    pending: null,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1440,
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      ready: new Promise<void>((resolve) => {
        fontReady = resolve;
      }),
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (isInput(this))
        return rect(visibleWidth, Number.parseFloat(this.style.height || "46"));
      if (this.classList.contains("invisible"))
        return rect(compactWidth + 2, 0);
      if (this.classList.contains("shrink-0"))
        return rect(visibleWidth, extraHeight);
      if (this instanceof HTMLFieldSetElement)
        return rect(visibleWidth, Number.parseFloat(this.style.height || "48"));
      const card = this.querySelector<HTMLFieldSetElement>("fieldset");
      return rect(
        visibleWidth,
        card ? Number.parseFloat(card.style.height) + 16 : 0,
      );
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return isInput(this)
        ? visibleWidth - scrollbarWidth - 2 * borderWidth
        : compactWidth;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return isInput(this) ? visibleWidth : compactWidth + 2;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      if (!(this instanceof HTMLTextAreaElement)) return 0;
      const natural = naturalHeight(this);
      return isInput(this) ? Math.max(stretchedHeight, natural) : natural;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return Number.parseFloat(this.style.height || "0");
    },
  );
});
afterEach(async () => {
  await act(async () => {
    await vi.waitFor(() =>
      expect(harness.controller?.snapshot().saving).toBe(false),
    );
    cleanup();
  });
  expect(observers.every((observer) => observer.disconnected)).toBe(true);
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
});
afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

function mount(initial: Partial<Draft> = {}, strict = false) {
  const current = harness.controller;
  if (!current) throw new Error("Draft controller is missing");
  harness.controller = new DraftController(1, {
    ...current.snapshot().draft,
    ...initial,
  });
  const onHeightChange = vi.fn();
  const composer = (
    <Composer
      discussionId={1}
      members={[]}
      memberIds={new Set()}
      busy={false}
      placeholder="Message"
      onSend={async () => true}
      onHeightChange={onHeightChange}
      onOpenVoiceSettings={() => {}}
    />
  );
  const view = render(strict ? <StrictMode>{composer}</StrictMode> : composer);
  const input = view.getByRole("combobox") as HTMLTextAreaElement;
  const card = view.getByRole("group", { name: "Message composer" });
  const probe = view.container.querySelector<HTMLTextAreaElement>(
    "textarea[tabindex='-1']",
  );
  if (!probe) throw new Error("Measurement probe is missing");
  const type = async (text: string) =>
    act(async () => {
      fireEvent.change(input, { target: { value: text } });
      await vi.waitFor(() =>
        expect(harness.controller?.snapshot().saving).toBe(false),
      );
    });
  const notify = async () =>
    act(async () => {
      for (const observer of [...observers]) observer.notify();
    });
  return { ...view, input, card, probe, type, notify, onHeightChange };
}

it("measures explicit lines independently of a stretched visible textarea", async () => {
  const view = mount();
  for (const [lines, inputHeight, cardHeight] of [
    [0, 46, 48],
    [1, 46, 48],
    [2, 72, 120],
    [3, 94, 142],
    [5, 138, 186],
    [8, 204, 252],
    [12, 204, 252],
  ]) {
    await view.type(Array.from({ length: lines }, () => "text").join("\n"));
    expect(view.input.style.height).toBe(`${inputHeight}px`);
    expect(view.card.style.height).toBe(`${cardHeight}px`);
    expect(view.input.scrollHeight).toBeGreaterThanOrEqual(stretchedHeight);
    expect(view.probe.style.height).toBe("auto");
    expect(view.probe.style.maxHeight).toBe("none");
  }
  await view.type("single");
  expect(view.card.dataset.expanded).toBe("false");
  expect(view.input.style.height).toBe("46px");
  expect(view.card.style.height).toBe("48px");
});

it("keeps compact wrapping stable while the expanded width changes repeatedly", async () => {
  compactWidth = 160;
  visibleWidth = 160;
  const view = mount({ body: "中文😀".repeat(8) });
  expect(view.card.dataset.expanded).toBe("true");
  expect(view.input.style.height).toBe("72px");
  for (const width of [180, 220, 260, 220, 180, 160]) {
    visibleWidth = width;
    await view.notify();
    expect(view.card.dataset.expanded).toBe("true");
  }
  expect(view.input.style.height).toBe("72px");
  visibleWidth = 600;
  compactWidth = 600;
  await view.notify();
  expect(view.card.dataset.expanded).toBe("false");
  expect(view.input.style.height).toBe("46px");
  expect(view.probe.style.width).toBe("");
  const measuring = observers.find((observer) =>
    observer.elements.has(view.input),
  );
  expect(measuring?.elements.has(view.probe)).toBe(false);
  expect(measuring?.elements.has(view.probe.parentElement as Element)).toBe(
    true,
  );
});

it("uses the current target padding and excludes visible scrollbar width", async () => {
  compactWidth = 160;
  visibleWidth = 200;
  scrollbarWidth = 4;
  const view = mount({ body: "中文😀".repeat(8) });
  expect(reads).toContainEqual({
    width: 160,
    left: 44,
    right: 48,
    padding: 24,
  });
  expect(reads).toContainEqual({
    width: 196,
    left: 16,
    right: 48,
    padding: 28,
  });
  expect(view.input.style.height).toBe("72px");
  const count = reads.length;
  scrollbarWidth = 12;
  await view.notify();
  expect(reads.length).toBeGreaterThan(count);
  expect(reads).toContainEqual({
    width: 188,
    left: 16,
    right: 48,
    padding: 28,
  });
  await view.type("short");
  expect(view.input.style.paddingLeft).toBe("44px");
  expect(view.input.style.paddingBlock).toBe("12px");
  expect(view.input.style.height).toBe("46px");
});

it("retains the node, selection and scrolling during width and font notifications", async () => {
  const view = mount({ body: "line\n".repeat(12) });
  view.input.focus();
  view.input.setSelectionRange(3, 7, "backward");
  view.input.scrollTop = 40;
  const original = view.input;
  visibleWidth = 580;
  await view.notify();
  await act(async () => {
    fontReady();
  });
  expect(view.getByRole("combobox")).toBe(original);
  expect(document.activeElement).toBe(original);
  expect(original.selectionStart).toBe(3);
  expect(original.selectionEnd).toBe(7);
  expect(original.selectionDirection).toBe("backward");
  expect(original.scrollTop).toBe(40);
  expect(original.style.height).toBe("204px");
  expect(view.probe.style.fontFamily).toBe("");
});

it("appends actual attachment height to the capped body and reports wrapper height", async () => {
  extraHeight = 80;
  const file = new File(["content"], "notes.txt", { type: "text/plain" });
  const view = mount({
    body: "line\n".repeat(12),
    files: [{ id: "file", clientId: "client", file }],
  });
  await view.notify();
  expect(view.input.style.height).toBe("204px");
  expect(view.card.style.height).toBe("332px");
  expect(view.onHeightChange).toHaveBeenLastCalledWith(348);
  expect(
    view.getByRole("list", { name: "Draft attachments" }).firstElementChild
      ?.className,
  ).toContain("border-line");
  expect(view.card.className).toContain("narrow:max-h-[35dvh]");
  await act(async () => {
    extraHeight = 0;
    fireEvent.click(view.getByRole("button", { name: "Remove notes.txt" }));
    for (const observer of [...observers]) observer.notify();
    await vi.waitFor(() =>
      expect(harness.controller?.snapshot().saving).toBe(false),
    );
  });
  await view.notify();
  expect(view.card.style.height).toBe("252px");
  await view.type("");
  expect(view.card.style.height).toBe("48px");
});

it("expands a pending message and keeps its status height outside the body limit", () => {
  extraHeight = 70;
  const view = mount({
    pending: {
      id: "pending",
      body: "saved",
      bodyRevision: 0,
      files: [],
      phase: "sending",
    },
  });
  expect(view.card.dataset.expanded).toBe("true");
  expect(view.input.style.height).toBe("68px");
  expect(view.card.style.height).toBe("186px");
  expect(view.getByText("Pending message")).toBeDefined();
});

it.each([375, 640])(
  "uses narrow compact height and target padding at %s",
  async (width) => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    });
    const view = mount();
    expect(view.input.style.height).toBe("46px");
    expect(view.card.style.height).toBe("52px");
    expect(view.input.style.paddingLeft).toBe("52px");
    await view.type("first\nsecond");
    expect(view.input.style.height).toBe("72px");
    expect(view.card.style.height).toBe("120px");
    expect(view.input.style.paddingLeft).toBe("14px");
    expect(view.input.style.paddingRight).toBe("52px");
  },
);

it("uses touch sizing and the viewport limit on a wide coarse-pointer screen", () => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      media: "(pointer: coarse)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
  const view = mount();
  expect(view.input.style.height).toBe("46px");
  expect(view.card.style.height).toBe("52px");
  expect(view.card.className).toContain("touch:max-h-[35dvh]");
});

it("expands for recording and contracts after recording closes", async () => {
  vi.spyOn(backend, "settings").mockResolvedValue({ api_key_set: true });
  const view = mount();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Start voice input" }));
    await vi.waitFor(() => expect(harness.voice).not.toBeNull());
  });
  expect(view.card.dataset.expanded).toBe("true");
  expect(view.input.style.height).toBe("68px");
  await act(async () => harness.voice?.({ type: "state", state: "closed" }));
  expect(view.card.dataset.expanded).toBe("false");
  expect(view.input.style.height).toBe("46px");
});

it("converts borders and content-box height without adding them to measured content", () => {
  borderWidth = 1;
  boxSizing = "content-box";
  const view = mount({ body: "first\nsecond" });
  expect(view.input.style.height).toBe("44px");
  expect(view.card.style.height).toBe("122px");
});

it("releases observers and ignores late font completion after StrictMode unmount", async () => {
  const view = mount({ body: "first\nsecond\n" }, true);
  expect(view.input.style.height).toBe("94px");
  view.unmount();
  const count = reads.length;
  await act(async () => {
    fontReady();
    for (const observer of observers) observer.notify();
  });
  expect(reads).toHaveLength(count);
  expect(observers.every((observer) => observer.disconnected)).toBe(true);
});
