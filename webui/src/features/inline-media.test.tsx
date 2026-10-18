import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@/app/router";
import {
  estimateInlineMediaSize,
  scanInlineMedia,
} from "@/features/inline-media";
import { MarkdownContent } from "@/features/markdown";
import { backend } from "@/lib/backend";

class Observer {
  static live: Observer[] = [];
  callback: IntersectionObserverCallback;
  targets: Element[] = [];
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    Observer.live.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
    this.report(target, true);
  }
  unobserve() {}
  disconnect() {
    Observer.live = Observer.live.filter((entry) => entry !== this);
  }
  report(target: Element, isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  static report(target: Element, isIntersecting: boolean) {
    for (const entry of Observer.live)
      if (entry.targets.includes(target)) entry.report(target, isIntersecting);
  }
}

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", Observer);
  URL.createObjectURL = vi.fn(() => "blob:inline-media");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(backend, "library").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(backend, "library").mockResolvedValue([]);
});

function pending() {
  return vi
    .spyOn(backend, "libraryFile")
    .mockImplementation(() => new Promise(() => {}));
}

function renderMessage(source: string, inlineMedia = true) {
  return render(
    <RouterProvider>
      <MarkdownContent
        source={source}
        identity="test-message"
        inlineMedia={inlineMedia}
      />
    </RouterProvider>,
  );
}

async function play(container: HTMLElement, name: string) {
  const button = await waitFor(() => {
    const element = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Play ${name}"]`,
    );
    if (element === null) throw new Error("play button is missing");
    return element;
  });
  fireEvent.click(button);
}

describe("inline media scope", () => {
  it("keeps image syntax as a link when inlineMedia is off", () => {
    pending();
    const { container } = renderMessage("![图](/tasks/a.png)", false);
    expect(container.querySelector(".inline-media")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/tasks/a.png",
    );
  });

  it("renders a library image as media when inlineMedia is on", () => {
    pending();
    const { container } = renderMessage("![图](/tasks/a.png)");
    expect(container.querySelectorAll(".inline-media").length).toBe(1);
    expect(container.textContent).toContain("Loading image…");
    expect(container.querySelector('a[href="/tasks/a.png"]')).toBeNull();
  });

  it("keeps external and non-media addresses as text links", () => {
    const libraryFile = pending();
    const { container } = renderMessage(
      "![站外](https://example.com/a.png)\n\n![报告](/tasks/report.pdf)",
    );
    expect(container.querySelectorAll(".inline-media").length).toBe(0);
    expect(
      container.querySelector('a[href="https://example.com/a.png"]'),
    ).not.toBeNull();
    expect(libraryFile).not.toHaveBeenCalled();
  });

  it("keeps plain paragraphs as paragraphs", () => {
    pending();
    const { container } = renderMessage("一段只有文字的正文。");
    expect(container.querySelectorAll("p").length).toBe(1);
    expect(container.querySelector(".inline-media")).toBeNull();
  });

  it("uses a block wrapper only when text and media are mixed", () => {
    pending();
    const { container } = renderMessage("文字 ![图](/tasks/a.png) 收尾。");
    expect(container.querySelectorAll("p").length).toBe(0);
    expect(container.querySelectorAll(".inline-media").length).toBe(1);
  });

  it("reports a failed image with its alt text and a retry", async () => {
    vi.spyOn(backend, "libraryFile").mockRejectedValue(new Error("missing"));
    const { container } = renderMessage("![构建日志](/tasks/a.png)");
    await waitFor(() =>
      expect(container.textContent).toContain("Image could not be loaded."),
    );
    expect(container.textContent).toContain("构建日志");
    expect(container.textContent).toContain("Retry");
  });
});

describe("image groups", () => {
  it("keeps separate paragraphs as separate blocks", () => {
    pending();
    const { container } = renderMessage(
      "![一](/tasks/a.png)\n\n![二](/tasks/b.png)",
    );
    expect(container.querySelectorAll(".inline-media").length).toBe(2);
    expect(container.querySelectorAll(".inline-media-grid").length).toBe(0);
  });

  it("lays three images in one row of three", () => {
    pending();
    const { container } = renderMessage(
      "![一](/tasks/a.png)\n![二](/tasks/b.png)\n![三](/tasks/c.png)",
    );
    const rows = container.querySelectorAll(".inline-media-row");
    expect(rows.length).toBe(1);
    expect(rows[0].querySelectorAll(".inline-media-cell").length).toBe(3);
  });

  it("drops two images into one row of two", () => {
    pending();
    const { container } = renderMessage(
      "![一](/tasks/a.png)\n![二](/tasks/b.png)",
    );
    const rows = container.querySelectorAll(".inline-media-row");
    expect(rows.length).toBe(1);
    expect(rows[0].className).toContain("inline-media-row-200");
  });

  it("lays four images in two rows of two", () => {
    pending();
    const { container } = renderMessage(
      "![一](/tasks/a.png)\n![二](/tasks/b.png)\n![三](/tasks/c.png)\n![四](/tasks/d.png)",
    );
    const rows = [...container.querySelectorAll(".inline-media-row")];
    expect(rows.length).toBe(2);
    expect(rows[0].className).toContain("inline-media-row-160");
    expect(rows[0].querySelectorAll(".inline-media-cell").length).toBe(2);
  });

  it("fills the last row when five images are present", () => {
    pending();
    const { container } = renderMessage(
      ["一", "二", "三", "四", "五"]
        .map((name, index) => `![${name}](/tasks/${index}.png)`)
        .join("\n"),
    );
    const rows = [...container.querySelectorAll(".inline-media-row")];
    expect(rows.length).toBe(2);
    expect(rows[0].querySelectorAll(".inline-media-cell").length).toBe(3);
    expect(rows[1].querySelectorAll(".inline-media-cell").length).toBe(2);
  });

  it("shows nine cells with a counted overflow for ten images", () => {
    pending();
    const { container } = renderMessage(
      Array.from(
        { length: 10 },
        (_, index) => `![图${index}](/tasks/${index}.png)`,
      ).join("\n"),
    );
    const cells = container.querySelectorAll(".inline-media-cell");
    expect(cells.length).toBe(9);
    const more = container.querySelector(".inline-media-more");
    expect(more?.getAttribute("aria-label")).toBe("View all 10 images");
    expect(more?.textContent).toBe("+2");
  });
});

describe("videos", () => {
  it("inlines at most two videos and leaves the rest as links", () => {
    const libraryFile = pending();
    const { container } = renderMessage(
      "![一](/tasks/a.mp4)\n\n![二](/tasks/b.mp4)\n\n![三](/tasks/c.mp4)",
    );
    expect(container.querySelectorAll(".inline-media-video").length).toBe(2);
    expect(
      container.querySelector('a[href="/library/tasks/c.mp4"]'),
    ).not.toBeNull();
    expect(libraryFile).not.toHaveBeenCalled();
  });

  it("does not fetch a video before the play request", () => {
    const libraryFile = pending();
    const { container } = renderMessage("![演示](/tasks/demo.mp4)");
    expect(container.querySelector(".inline-media-video")).not.toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(libraryFile).not.toHaveBeenCalled();
  });
});

describe("video lifecycle", () => {
  it("drops the download when the player unmounts before it finishes", async () => {
    const created = vi.fn(() => "blob:cancel");
    URL.createObjectURL = created;
    const revoked = vi.fn();
    URL.revokeObjectURL = revoked;
    const signals: AbortSignal[] = [];
    let finish: (blob: Blob) => void = () => {};
    vi.spyOn(backend, "libraryFile").mockImplementation((_path, signal) => {
      signals.push(signal);
      return new Promise<Blob>((resolve) => {
        finish = resolve;
      });
    });
    const { container, unmount } = renderMessage(
      "![下载中](/tasks/cancel.mp4)",
    );
    await play(container, "下载中");
    await waitFor(() => expect(signals.length).toBe(1));
    unmount();
    expect(signals[0].aborted).toBe(true);
    finish(new Blob(["video"]));
    await waitFor(() => expect(created).not.toHaveBeenCalled());
    expect(revoked).not.toHaveBeenCalled();
  });

  it("keeps the shared url alive while another player still uses it", async () => {
    const created = vi.fn(() => "blob:shared");
    URL.createObjectURL = created;
    const revoked = vi.fn();
    URL.revokeObjectURL = revoked;
    vi.spyOn(backend, "libraryFile").mockResolvedValue(new Blob(["video"]));
    const first = renderMessage("![共用](/tasks/shared.mp4)");
    const second = renderMessage("![共用](/tasks/shared.mp4)");
    await play(first.container, "共用");
    await waitFor(() =>
      expect(first.container.querySelector("video")?.getAttribute("src")).toBe(
        "blob:shared",
      ),
    );
    await play(second.container, "共用");
    await waitFor(() =>
      expect(second.container.querySelector("video")?.getAttribute("src")).toBe(
        "blob:shared",
      ),
    );
    first.unmount();
    await waitFor(() =>
      expect(second.container.querySelector("video")?.getAttribute("src")).toBe(
        "blob:shared",
      ),
    );
    expect(revoked).not.toHaveBeenCalled();
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("lets each visible player hold its url and trims the unheld cache", async () => {
    const created: string[] = [];
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:hold-${created.length + 1}`;
      created.push(url);
      return url;
    });
    const revoked = vi.fn();
    URL.revokeObjectURL = revoked;
    vi.spyOn(backend, "libraryFile").mockResolvedValue(new Blob(["video"]));
    const names = ["甲", "乙", "丙"];
    const players = names.map((name) =>
      renderMessage(`![${name}](/tasks/hold-${name}.mp4)`),
    );
    for (const [index, player] of players.entries()) {
      await play(player.container, names[index]);
      await waitFor(() =>
        expect(
          player.container.querySelector("video")?.getAttribute("src"),
        ).toBe(`blob:hold-${index + 1}`),
      );
    }
    for (const player of players)
      fireEvent.pause(
        player.container.querySelector("video") as HTMLVideoElement,
      );
    await waitFor(() =>
      expect(players[2].container.querySelector("video")).not.toBeNull(),
    );
    expect(revoked).not.toHaveBeenCalled();
    const roots = players.map(
      (player) =>
        player.container.querySelector(".inline-media-video") as Element,
    );
    Observer.report(roots[0], false);
    Observer.report(roots[1], false);
    await waitFor(() =>
      expect(players[0].container.querySelector("video")).toBeNull(),
    );
    expect(
      players[2].container.querySelector("video")?.getAttribute("src"),
    ).toBe("blob:hold-3");
    Observer.report(roots[2], false);
    await waitFor(() =>
      expect(players[2].container.querySelector("video")).toBeNull(),
    );
    await waitFor(() => expect(revoked).toHaveBeenCalled());
    expect(created.length - revoked.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("keeps the object url across a pause and trims nothing it holds", async () => {
    const created = vi.fn(() => "blob:pause");
    URL.createObjectURL = created;
    const revoked = vi.fn();
    URL.revokeObjectURL = revoked;
    vi.spyOn(backend, "libraryFile").mockResolvedValue(new Blob(["video"]));
    const { container } = renderMessage("![暂停](/tasks/pause.mp4)");
    await play(container, "暂停");
    const video = await waitFor(() => {
      const element = container.querySelector("video");
      if (element === null) throw new Error("player is missing");
      return element;
    });
    fireEvent.play(video);
    fireEvent.pause(video);
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(
        "blob:pause",
      ),
    );
    expect(revoked).not.toHaveBeenCalled();
    fireEvent.play(video);
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toBe(
        "blob:pause",
      ),
    );
    expect(created).toHaveBeenCalledTimes(1);
  });
});

describe("scanning", () => {
  it("keeps only library images and videos in source order", () => {
    const entries = scanInlineMedia(
      "![一](/tasks/a.png)\n\n![外](https://example.com/b.png)\n\n![片](./tasks/c.mp4)\n\n![文档](/tasks/d.pdf)",
    );
    expect(entries.map((entry) => [entry.path, entry.kind])).toEqual([
      ["tasks/a.png", "image"],
      ["tasks/c.mp4", "video"],
    ]);
  });

  it("estimates the block heights for a message body", () => {
    expect(estimateInlineMediaSize("![一](/tasks/a.png)")).toBe(376);
    expect(
      estimateInlineMediaSize(
        "![一](/tasks/a.png)\n![二](/tasks/b.png)\n![三](/tasks/c.png)",
      ),
    ).toBe(136);
    expect(estimateInlineMediaSize("一段文字")).toBe(0);
  });
});
