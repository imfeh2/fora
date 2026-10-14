import { readFileSync } from "node:fs";
import { Virtualizer } from "@tanstack/react-virtual";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { mentionSpans } from "@/features/markdown-plugins";

import {
  BackendError,
  backend,
  type HistoryText,
  type MessageMention,
} from "@/lib/backend";

let testing: typeof import("@testing-library/react");
let MarkdownContent: typeof import("@/features/markdown").MarkdownContent;
let CopyTextButton: typeof import("@/features/markdown").CopyTextButton;
let CollapsibleText: typeof import("@/features/markdown").CollapsibleText;
let HistoryValueView: typeof import("@/features/members/detail").HistoryValueView;
let Modal: typeof import("@/components/ui/dialog").Modal;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let GenerationIndicator: typeof import("@/features/generation-state").GenerationIndicator;
let closeDom: () => void;
const observers: Array<{
  callback: () => void;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

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
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  for (const name of [
    "HTMLElement",
    "HTMLInputElement",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "Event",
    "EventTarget",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "getComputedStyle",
  ] as const)
    vi.stubGlobal(name, dom.window[name]);
  vi.stubGlobal("requestAnimationFrame", dom.window.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", dom.window.cancelAnimationFrame);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      constructor(callback: () => void) {
        observers.push({ callback, disconnect: this.disconnect });
      }
      observe() {}
      unobserve() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testing = await import("@testing-library/react");
  ({ MarkdownContent, CopyTextButton, CollapsibleText } = await import(
    "@/features/markdown"
  ));
  ({ HistoryValueView } = await import("@/features/members/detail"));
  ({ Modal } = await import("@/components/ui/dialog"));
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
  ({ GenerationIndicator } = await import("@/features/generation-state"));
}, 30000);

afterEach(async () => {
  await testing.act(async () => testing.cleanup());
  vi.restoreAllMocks();
  vi.useRealTimers();
  observers.length = 0;
});
afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

function parsed(
  source: string,
  mentions: MessageMention[] = [],
  generating = false,
) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <MarkdownContent
      source={source}
      identity="test"
      mentions={mentions}
      generating={generating}
    />,
  );
  return container;
}
function mention(source: string, text: string, from = 0): MessageMention {
  const index = source.indexOf(text, from);
  if (index < 0) throw new Error("Mention is missing");
  return {
    member_id: 2,
    position: Array.from(source.slice(0, index)).length,
    length: Array.from(text).length,
  };
}

it("renders common Markdown and GFM structures", () => {
  const root = parsed(
    "# Heading\n\nParagraph **strong** and `inline`\n\n- Item\n\n> Quoted\n\n[link](https://example.com)\n\n| First | Second |\n| --- | --- |\n| One | Two |",
  );
  expect(root.querySelector("h1")?.textContent).toBe("Heading");
  expect(root.querySelector("ul li")?.textContent).toBe("Item");
  expect(root.querySelector("blockquote")?.textContent?.trim()).toBe("Quoted");
  expect(root.querySelector("code")?.textContent).toBe("inline");
  expect(root.querySelector("a")?.getAttribute("href")).toBe(
    "https://example.com/",
  );
  expect(root.querySelectorAll("table td")).toHaveLength(2);
});

it.each([
  "```ts\nconst answer = 42",
  "| First | Second |\n| --- | --- |\n| Partial |",
])("renders incomplete content through Streamdown: %s", (source) => {
  const root = parsed(source, [], true);
  expect(root.textContent).toContain(
    source.startsWith("```") ? "const answer = 42" : "Partial",
  );
  expect(
    root.querySelector(
      source.startsWith("```") ? '[data-streamdown="code-block"]' : "table",
    ),
  ).toBeTruthy();
});

it.each([
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "Before <b>inline</b> after",
])("presents raw HTML as literal text: %s", (source) => {
  const root = parsed(source);
  expect(root.querySelector("img, script, b")).toBeNull();
  expect(root.textContent).toContain(source);
});

it.each([
  "javascript:alert(1)",
  "data:text/html;base64,WA==",
  "vbscript:msgbox(1)",
])("blocks dangerous link protocols: %s", (url) => {
  const root = parsed(`[unsafe](<${url}>)`);
  expect(root.querySelector("a[href]")).toBeNull();
  expect(root.textContent).toContain("unsafe");
});

it.each(["Picture", ""])(
  "presents Markdown images as user-opened links with label %s",
  (alt) => {
    const root = parsed(`![${alt}](https://example.com/image.png)`);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("a")?.textContent).toBe(
      alt || "https://example.com/image.png",
    );
    expect(root.querySelector("a")?.className).toBe("markdown-link");
  },
);

it("converts Unicode character positions to UTF-16 source offsets and ignores invalid spans", () => {
  const source = "中文😀 @Agent";
  const valid = mention(source, "@Agent");
  expect(
    mentionSpans(source, [
      valid,
      { ...valid, member_id: 3 },
      { member_id: 4, position: -1, length: 6 },
    ]),
  ).toEqual([{ start: 5, end: 11 }]);
  expect(parsed(source, [valid]).querySelector("mark")?.textContent).toBe(
    "@Agent",
  );
});

it.each([
  "# @Agent",
  "> @Agent",
  "- @Agent",
  "| Label |\n| --- |\n| @Agent |",
  "First paragraph\n\nSecond @Agent",
  "Escaped \\* and &amp; @Agent",
  "\\@Agent",
  "> First line\n> @Agent",
  "- First line\n  @Agent",
  "First line\r\n@Agent",
  "| Label |\n| --- |\n| before \\| @Agent |",
  "~~@Agent~~",
  "- [x] @Agent",
])("marks backend spans in eligible original AST text: %s", (source) => {
  expect(
    parsed(source, [mention(source, "@Agent")]).querySelector("mark")
      ?.textContent,
  ).toBe("@Agent");
});

it.each([
  "`@Agent`",
  "```txt\n@Agent\n```",
  "[@Agent](https://example.com)",
  "$@Agent$",
  "$$\n@Agent\n$$",
])("keeps excluded contexts literal without mention marks: %s", (source) => {
  const root = parsed(source, [mention(source, "@Agent")]);
  expect(root.querySelector("mark")).toBeNull();
  expect(root.textContent).toContain("@Agent");
  if (source.startsWith("$")) expect(root.textContent).toContain(source);
});

it("marks spans across emphasis nodes using their source positions", () => {
  const source = "@Ag**ent** and @Agent";
  const root = parsed(source, [mention(source, "@Ag**ent**")]);
  expect(
    [...root.querySelectorAll("mark")].map((node) => node.textContent).join(""),
  ).toBe("@Agent");
});

it("keeps generation previews free of effective mention marks", () => {
  const source = "@Agent";
  expect(
    parsed(source, [mention(source, source)], true).querySelector("mark"),
  ).toBeNull();
});

it("uses narrow containers and local overflow styling", () => {
  const css = readFileSync(
    new URL("../styles/App.css", import.meta.url),
    "utf8",
  );
  const root = parsed(
    "```txt\nwide line\n```\n\n| Column |\n| --- |\n| Value |",
  );
  expect(root.querySelector(".markdown-content")?.className).toContain(
    "min-w-0 max-w-full",
  );
  expect(css).toContain("overflow-x: auto;");
  expect(css).toContain("max-width: 100%;");
  const thread = readFileSync(
    new URL("./discussions/thread.tsx", import.meta.url),
    "utf8",
  );
  expect(thread).toContain("narrow:px-3");
  expect(thread).toContain("scrollEndThreshold: 40");
});

it("copies received Markdown and original code without appended repair markers", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const source = "Before\n\n```ts\nconst answer = 42";
  await testing.act(async () =>
    testing.render(
      <div>
        <CopyTextButton source={source} label="Copy message text" />
        <MarkdownContent source={source} identity="copy" generating />
      </div>,
    ),
  );
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Copy message text" }),
    ),
  );
  expect(writeText).toHaveBeenLastCalledWith(source);
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Copy code" }),
    ),
  );
  expect(writeText).toHaveBeenLastCalledWith("const answer = 42");
});

it("reports clipboard failures with the existing toast and keeps the copy icon", async () => {
  const toastModule = await import("@/components/ui/toast");
  const notice = vi.spyOn(toastModule, "toast");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi
        .fn()
        .mockRejectedValue(new Error("Clipboard permission denied")),
    },
  });
  testing.render(
    <CopyTextButton source="received text" label="Copy message text" />,
  );
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Copy message text" }),
    ),
  );
  expect(testing.screen.queryByRole("button", { name: "Copied" })).toBeNull();
  expect(notice).toHaveBeenCalledWith(
    expect.objectContaining({
      tone: "danger",
      title: "Could not copy",
      description: "Clipboard permission denied",
    }),
  );
  toastModule.clearToasts();
});

it("highlights code using the installed Shiki plugin", async () => {
  const { createCodePlugin } = await import("@streamdown/code");
  const plugin = createCodePlugin({ themes: ["github-dark", "github-dark"] });
  const options = {
    code: "const answer = 42",
    language: "typescript" as const,
    themes: plugin.getThemes(),
  };
  const result = await new Promise<
    NonNullable<ReturnType<typeof plugin.highlight>>
  >((resolve) => {
    const ready = plugin.highlight(options, resolve);
    if (ready) resolve(ready);
  });
  expect(
    result.tokens
      .flat()
      .map((token) => token.content)
      .join(""),
  ).toBe(options.code);
  expect(
    result.tokens
      .flat()
      .some(
        (token) =>
          token.htmlStyle?.color && token.htmlStyle.color !== "inherit",
      ),
  ).toBe(true);
});

it("keeps trailing code newlines when copying", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  await testing.act(async () =>
    testing.render(
      <MarkdownContent source={"```text\nline\n\n```"} identity="copy-tail" />,
    ),
  );
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Copy code" }),
    ),
  );
  expect(writeText).toHaveBeenCalledWith("line\n");
});

it("clears the copied icon after two seconds and isolates pending clipboard results", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const writeText = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const view = testing.render(<CopyTextButton source="old" />);
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Copy code" }),
    ),
  );
  await testing.act(async () => view.rerender(<CopyTextButton source="new" />));
  await testing.act(async () => finish());
  expect(testing.screen.queryByRole("button", { name: "Copied" })).toBeNull();
  writeText.mockResolvedValueOnce(undefined);
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Copy code" }),
    ),
  );
  expect(testing.screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  await testing.act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(
    testing.screen.getByRole("button", { name: "Copy code" }),
  ).toBeTruthy();
});

it("maintains expanded text across updates and releases measurement resources", async () => {
  const height = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(301);
  const view = testing.render(
    <CollapsibleText>
      <p>Long content</p>
    </CollapsibleText>,
  );
  expect(
    testing.screen.getByRole("button", { name: "Show more" }),
  ).toBeTruthy();
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Show more" }),
    ),
  );
  await testing.act(async () =>
    view.rerender(
      <CollapsibleText>
        <p>Updated content</p>
      </CollapsibleText>,
    ),
  );
  expect(
    testing.screen
      .getByRole("button", { name: "Show less" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  height.mockReturnValue(300);
  await testing.act(async () => observers[0].callback());
  expect(testing.screen.queryByRole("button")).toBeNull();
  view.unmount();
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
});

it.each(["text", "thinking"])(
  "renders saved %s part content with Markdown",
  (part_kind) => {
    const html = renderToStaticMarkup(
      <HistoryValueView
        label="Part"
        value={{ part_kind, content: "# Response" }}
      />,
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector("h1")?.textContent).toBe("Response");
  },
);

it("keeps tool parameters as original structured values", () => {
  const html = renderToStaticMarkup(
    <HistoryValueView
      label="Part"
      value={{ part_kind: "tool-call", args: "# not prose" }}
    />,
  );
  expect(html).not.toContain("<h1");
  expect(html).toContain("# not prose");
});

function field(ordinal: number): HistoryText {
  return {
    kind: "text",
    source: "response",
    request_ordinal: ordinal,
    message_index: 0,
    path: ["parts", 0, "content"],
    offset: 0,
    next_offset: 4,
    total_bytes: 12,
    value: "# Hi",
    has_more: true,
  };
}
function historyValue(ordinal: number) {
  return (
    <HistoryValueView
      agentId={2}
      sequence={4}
      label="Part"
      value={{ part_kind: "text", content: field(ordinal) }}
    />
  );
}

it("appends history text with byte offsets and exposes local Retry without dropping the prefix", async () => {
  const read = vi
    .spyOn(backend, "agentHistoryText")
    .mockRejectedValueOnce(new BackendError("request_failed", "Read failed"))
    .mockResolvedValueOnce({
      value: " there",
      offset: 4,
      total_bytes: 12,
      next_offset: 12,
      has_more: false,
    });
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
  testing.render(historyValue(1));
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Load more text" }),
    ),
  );
  expect(testing.screen.getByRole("heading", { name: "Hi" })).toBeTruthy();
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Retry" }),
    ),
  );
  expect(read.mock.calls[1][2].offset).toBe(4);
  expect(
    testing.screen.getByRole("heading", { name: "Hi there" }),
  ).toBeTruthy();
  expect(
    testing.screen.queryByRole("button", { name: "Load more text" }),
  ).toBeNull();
});

it("discards late history pages after changing the original request identity", async () => {
  let finish!: (
    result: Awaited<ReturnType<typeof backend.agentHistoryText>>,
  ) => void;
  vi.spyOn(backend, "agentHistoryText").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
  const view = testing.render(historyValue(1));
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Load more text" }),
    ),
  );
  await testing.act(async () => view.rerender(historyValue(2)));
  await testing.act(async () =>
    finish({
      value: " old tail",
      offset: 4,
      total_bytes: 12,
      next_offset: 12,
      has_more: false,
    }),
  );
  expect(testing.screen.queryByText(/old tail/)).toBeNull();
  expect(
    testing.screen
      .getByRole("button", { name: "Load more text" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

it("shows only the small generating marker and removes the sent marker", () => {
  const html = renderToStaticMarkup(
    <GenerationIndicator state={{ status: "generating" }} />,
  );
  const root = document.createElement("div");
  root.innerHTML = html;
  expect(root.textContent).toBe("");
  expect(root.querySelector('[role="status"]')?.className).toContain(
    "size-[6px]",
  );
  expect(root.querySelector('[role="status"]')?.className).toContain(
    "motion-reduce:animate-none",
  );
  expect(
    renderToStaticMarkup(<GenerationIndicator state={{ status: "sent" }} />),
  ).toBe("");
});

it.each(["failed", "interrupted"] as const)(
  "exposes an accessible %s icon and opens the corresponding details",
  async (status) => {
    const open = vi.fn();
    testing.render(
      <TooltipProvider>
        <GenerationIndicator
          state={{ status, reason: "Request timed out", onOpenDetails: open }}
        />
      </TooltipProvider>,
    );
    const button = testing.screen.getByRole("button", {
      name: `${status === "failed" ? "Not sent" : "Interrupted"}: Request timed out`,
    });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.textContent).toBe("");
    await testing.act(async () => testing.fireEvent.click(button));
    expect(open).toHaveBeenCalledOnce();
  },
);

it("opens details from the failure icon with keyboard input and returns focus on close", async () => {
  const userEvent = (await import("@testing-library/user-event")).default;
  const asyncWrapper = testing.getConfig().asyncWrapper;
  testing.configure({ asyncWrapper: (callback) => callback() });
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <TooltipProvider>
        <GenerationIndicator
          state={{
            status: "failed",
            reason: "Generation failed",
            onOpenDetails: () => setOpen(true),
          }}
        />
        <Modal
          open={open}
          onOpenChange={setOpen}
          title="Turn details"
          footer={
            <button type="button" onClick={() => setOpen(false)}>
              Close details
            </button>
          }
        >
          <p>Generation failed</p>
        </Modal>
      </TooltipProvider>
    );
  }
  testing.render(<Example />);
  const icon = testing.screen.getByRole("button", {
    name: "Not sent: Generation failed",
  });
  await testing.act(async () => icon.focus());
  await testing.act(async () =>
    userEvent.setup({ document }).keyboard("{Enter}"),
  );
  expect(
    testing.screen.getByRole("dialog", { name: "Turn details" }),
  ).toBeTruthy();
  await testing.act(async () =>
    testing.fireEvent.click(
      testing.screen.getByRole("button", { name: "Close details" }),
    ),
  );
  await testing.waitFor(() => expect(document.activeElement).toBe(icon));
  await testing.act(async () => userEvent.setup({ document }).keyboard(" "));
  expect(
    testing.screen.getByRole("dialog", { name: "Turn details" }),
  ).toBeTruthy();
  testing.configure({ asyncWrapper });
});

it("uses the 40px follow boundary and preserves historical positions during row growth", () => {
  const area = {
    scrollHeight: 1000,
    clientHeight: 600,
    scrollTop: 360,
  } as HTMLDivElement;
  const scrollToFn = vi.fn();
  const virtual = new Virtualizer<HTMLDivElement, HTMLLIElement>({
    count: 3,
    getScrollElement: () => area,
    estimateSize: () => 300,
    observeElementRect: () => {},
    observeElementOffset: () => {},
    scrollToFn,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 40,
  });
  virtual.scrollElement = area;
  virtual.scrollRect = { width: 375, height: 600 };
  virtual.scrollOffset = 360;
  virtual.getTotalSize();
  expect(virtual.isAtEnd()).toBe(true);
  virtual.scrollOffset = 359;
  expect(virtual.isAtEnd()).toBe(false);
  virtual.scrollOffset = 200;
  virtual.resizeItem(2, 400);
  expect(virtual.scrollOffset).toBe(200);
});
