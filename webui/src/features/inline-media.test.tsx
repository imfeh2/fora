import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@/app/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  estimateInlineMediaSize,
  mediaSingleBox,
  scanInlineMedia,
} from "@/features/inline-media";
import { MarkdownContent } from "@/features/markdown";
import { backend } from "@/lib/backend";

const entry = vi.hoisted(() => ({
  current: async (
    _path: string,
  ): Promise<{ size: number; modified_at: string } | null> => null,
}));

vi.mock("@/features/library/preview", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/library/preview")>();
  return { ...actual, libraryEntry: (path: string) => entry.current(path) };
});

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
  vi.spyOn(backend, "libraryFileUrl").mockImplementation(
    async (path) =>
      `http://fora/library/content?path=${encodeURIComponent(path)}`,
  );
  vi.spyOn(backend, "libraryPoster").mockResolvedValue(
    "http://fora/library/poster?path=tasks/demo.mp4",
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  entry.current = async () => null;
  vi.spyOn(backend, "library").mockResolvedValue([]);
  vi.spyOn(backend, "libraryFileUrl").mockImplementation(
    async (path) =>
      `http://fora/library/content?path=${encodeURIComponent(path)}`,
  );
  vi.spyOn(backend, "libraryPoster").mockResolvedValue(
    "http://fora/library/poster?path=tasks/demo.mp4",
  );
});

function pending() {
  return vi
    .spyOn(backend, "libraryFile")
    .mockImplementation(() => new Promise(() => {}));
}

function renderMessage(source: string, inlineMedia = true) {
  return render(
    <TooltipProvider>
      <RouterProvider>
        <MarkdownContent
          source={source}
          identity="test-message"
          inlineMedia={inlineMedia}
        />
      </RouterProvider>
    </TooltipProvider>,
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
    expect(container.textContent).toBe("");
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
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    fireEvent.click(details?.querySelector("summary") as HTMLElement);
    await waitFor(() =>
      expect(details?.textContent).toContain(
        "File URL: http://fora/library/content?path=tasks%2Fa.png",
      ),
    );
    expect(details?.textContent).toContain("Stage: File request");
    expect(details?.textContent).toContain("Message: missing");
    expect(
      container.querySelector('button[aria-label="Copy error details"]'),
    ).not.toBeNull();
  });
});

describe("Library-root media paths", () => {
  it.each([
    ["/root/.fora/library/tasks/", "root/.fora/library/tasks/"],
    ["/etc/", "etc/"],
  ])("reports a missing Library file for %s", async (href, path) => {
    const libraryFile = pending();
    libraryFile.mockRejectedValue(new Error("File not found in Library"));
    const source = `![Photo](${href}missing.png)\n\n![Video](${href}missing.mp4)\n\n[File](${href}missing.png)`;
    const { container } = renderMessage(source);
    await waitFor(() =>
      expect(libraryFile).toHaveBeenCalledWith(
        `${path}missing.png`,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(container.querySelector("details pre")?.textContent).toContain(
        `File: ${path}missing.png`,
      ),
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `/library/${path}missing.png`,
    );
    await play(container, "Video");
    await waitFor(() =>
      expect(libraryFile).toHaveBeenCalledWith(
        `${path}missing.mp4`,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(container.querySelectorAll("details").length).toBe(2),
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.textContent).toContain(`File: ${path}missing.mp4`);
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

  it("keeps the play control before the size check and requests nothing", async () => {
    const libraryFile = pending();
    let release: (value: null) => void = () => {};
    entry.current = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const { container } = renderMessage("![演示](/tasks/big.mp4)");
    const button = await waitFor(() => {
      const element = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Play 演示"]',
      );
      if (element === null) throw new Error("play button is missing");
      return element;
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(libraryFile).not.toHaveBeenCalled();
    release(null);
    await waitFor(() => expect(libraryFile).toHaveBeenCalledTimes(1));
  });

  it("keeps the play control before the observer reports", () => {
    class Silent {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Silent);
    pending();
    try {
      const { container } = renderMessage("![演示](/tasks/demo.mp4)");
      expect(container.querySelector(".inline-media-video")).not.toBeNull();
      expect(
        container.querySelector('button[aria-label="Play 演示"]'),
      ).not.toBeNull();
    } finally {
      vi.stubGlobal("IntersectionObserver", Observer);
    }
  });

  it("shows the poster of the video before it plays", async () => {
    pending();
    const { container } = renderMessage("![演示](/tasks/demo.mp4)");
    const poster = await waitFor(() => {
      const element = container.querySelector(".inline-media-poster img");
      if (element === null) throw new Error("poster is missing");
      return element;
    });
    expect(poster.getAttribute("src")).toBe(
      "http://fora/library/poster?path=tasks/demo.mp4",
    );
    expect(container.querySelector("video")).toBeNull();
  });

  it("drops the poster when the video block leaves the viewport", async () => {
    pending();
    const { container } = renderMessage("![演示](/tasks/demo.mp4)");
    await waitFor(() => {
      expect(
        container.querySelector(".inline-media-poster img"),
      ).not.toBeNull();
    });
    Observer.report(
      container.querySelector(".inline-media-video") as Element,
      false,
    );
    await waitFor(() => {
      expect(container.querySelector(".inline-media-poster")).toBeNull();
    });
  });

  it("keeps the play placeholder when the poster cannot be loaded", async () => {
    pending();
    const { container } = renderMessage("![演示](/tasks/demo.mp4)");
    const poster = await waitFor(() => {
      const element = container.querySelector(".inline-media-poster img");
      if (element === null) throw new Error("poster is missing");
      return element;
    });
    fireEvent.error(poster);
    await waitFor(() => {
      expect(container.querySelector(".inline-media-poster")).toBeNull();
    });
    expect(container.querySelector(".inline-media-play")).not.toBeNull();
  });
});

describe("video errors", () => {
  it("distinguishes file request failures from player errors", async () => {
    vi.spyOn(backend, "libraryFile").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const request = renderMessage("![Request](/tasks/request-error.mp4)");
    await play(request.container, "Request");
    await waitFor(() =>
      expect(request.container.querySelector("details")?.textContent).toContain(
        "Stage: File request\nError: TypeError\nMessage: Failed to fetch",
      ),
    );
    request.unmount();
    vi.spyOn(backend, "libraryFile").mockResolvedValue(new Blob(["video"]));
    const playback = renderMessage("![Playback](/tasks/playback-error.mp4)");
    await play(playback.container, "Playback");
    const player = await waitFor(() => {
      const element = playback.container.querySelector("video");
      if (element === null) throw new Error("player is missing");
      return element;
    });
    Object.defineProperty(player, "error", {
      value: { code: 3, message: "Decoder error" },
    });
    fireEvent.error(player);
    await waitFor(() =>
      expect(
        playback.container.querySelector("details")?.textContent,
      ).toContain(
        "Stage: Video playback\nMediaError.code: 3\nMessage: Decoder error",
      ),
    );
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
    const revokedUrls = revoked.mock.calls.map(([url]) => url as string);
    const cached = created.filter((url) => !revokedUrls.includes(url));
    expect(cached).toEqual(["blob:hold-2", "blob:hold-3"]);
    expect(revokedUrls).not.toContain("blob:hold-2");
    expect(revokedUrls).not.toContain("blob:hold-3");
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

function stubImage({
  width,
  height,
  decode,
}: {
  width: number;
  height: number;
  decode?: () => Promise<void>;
}) {
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: decode ?? (() => Promise.resolve()),
  });
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    width,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    height,
  );
}

describe("single image", () => {
  it("derives the frame from the decoded ratio in both tiers", () => {
    const box = (width: number, height: number) =>
      mediaSingleBox({ width, height }) as Record<string, string>;
    expect(box(480, 640)["--inline-single-width"]).toBe("300px");
    expect(box(480, 640)["--inline-single-narrow-width"]).toBe("240px");
    expect(box(480, 640).aspectRatio).toBe("480 / 640");
    expect(box(1200, 1200)["--inline-single-width"]).toBe("400px");
    expect(box(1200, 1200)["--inline-single-narrow-width"]).toBe("320px");
    expect(box(1600, 533)["--inline-single-width"]).toBe("640px");
    expect(box(1600, 533)["--inline-single-narrow-width"]).toBe("961px");
    expect(box(800, 500)["--inline-single-width"]).toBe("640px");
    expect(box(800, 500)["--inline-single-narrow-width"]).toBe("512px");
  });

  it("keeps an empty placeholder card until the image decodes", async () => {
    pending();
    const { container } = renderMessage("![竖图](/tasks/portrait.png)");
    const frame = container.querySelector(
      ".inline-media-pending",
    ) as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.className).not.toContain("inline-media-single");
    expect(frame.getAttribute("style")).toBeNull();
    expect(container.textContent).toBe("");
    expect(container.querySelector("[role=status]")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("swaps the placeholder for the sized image after decode", async () => {
    vi.spyOn(backend, "libraryFile").mockResolvedValue(new Blob(["image"]));
    let release: () => void = () => {};
    stubImage({
      width: 800,
      height: 500,
      decode: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const { container } = renderMessage("![宽图](/tasks/loaded.png)");
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(container.querySelector(".inline-media-pending")).not.toBeNull();
    release();
    const image = await waitFor(() => {
      const element = container.querySelector("img");
      if (element === null) throw new Error("image is missing");
      return element;
    });
    const frame = container.querySelector(
      ".inline-media-single",
    ) as HTMLElement;
    expect(container.querySelector(".inline-media-pending")).toBeNull();
    expect(frame.style.aspectRatio).toBe("800 / 500");
    expect(frame.style.getPropertyValue("--inline-single-width")).toBe("640px");
    expect(image.getAttribute("src")).toMatch(/^blob:/);
  });

  it("reuses cached bytes without a placeholder when a message returns", async () => {
    vi.spyOn(backend, "libraryFile").mockResolvedValue(new Blob(["image"]));
    stubImage({ width: 800, height: 500 });
    const first = renderMessage("![返回](/tasks/returned.png)");
    await waitFor(() => {
      expect(first.container.querySelector("img")).not.toBeNull();
    });
    first.unmount();
    let release: () => void = () => {};
    stubImage({
      width: 800,
      height: 500,
      decode: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const second = renderMessage("![返回](/tasks/returned.png)");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second.container.querySelector(".inline-media-pending")).toBeNull();
    expect(second.container.querySelector("img")).toBeNull();
    release();
    const image = await waitFor(() => {
      const element = second.container.querySelector("img");
      if (element === null) throw new Error("image is missing");
      return element;
    });
    expect(image.getAttribute("src")).toMatch(/^blob:/);
    const frame = second.container.querySelector(
      ".inline-media-single",
    ) as HTMLElement;
    expect(frame.style.aspectRatio).toBe("800 / 500");
  });

  it("keeps the card absent while a cached image decodes", async () => {
    vi.spyOn(backend, "libraryFile").mockResolvedValue(new Blob(["image"]));
    stubImage({ width: 800, height: 500 });
    const first = renderMessage("![返回](/tasks/resumed.png)");
    await waitFor(() => {
      expect(
        first.container.querySelector(".inline-media-single"),
      ).not.toBeNull();
    });
    first.unmount();
    const appendChild = vi.spyOn(Node.prototype, "appendChild");
    const insertBefore = vi.spyOn(Node.prototype, "insertBefore");
    const second = renderMessage("![返回](/tasks/resumed.png)");
    const inserted = [...appendChild.mock.calls, ...insertBefore.mock.calls]
      .map((call) => call[0])
      .filter((node) => node instanceof HTMLElement);
    expect(
      inserted.filter((node) =>
        node.classList.contains("inline-media-pending"),
      ),
    ).toEqual([]);
    await waitFor(() => {
      expect(
        second.container.querySelector(".inline-media-single"),
      ).not.toBeNull();
    });
  });

  it("shows the failure card when the image bytes cannot be decoded", async () => {
    const libraryFile = vi
      .spyOn(backend, "libraryFile")
      .mockRejectedValueOnce(new Error("missing"))
      .mockImplementation(() => new Promise(() => {}));
    const { container } = renderMessage("![坏图](/tasks/broken.png)");
    await waitFor(() =>
      expect(container.textContent).toContain("Image could not be loaded."),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("details")?.textContent).toContain(
      "Stage: File request",
    );
    const frame = container.querySelector(".inline-media") as HTMLElement;
    expect(frame.className).toContain("inline-media-fixed");
    expect(frame.getAttribute("style")).toBeNull();
    const retry = await waitFor(() => {
      const button = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === "Retry",
      );
      if (button === undefined) throw new Error("retry is missing");
      return button;
    });
    fireEvent.click(retry);
    await waitFor(() => expect(libraryFile).toHaveBeenCalledTimes(2));
    expect(container.textContent).toContain("Image could not be loaded.");
    expect(container.querySelector(".inline-media-pending")).toBeNull();
    await waitFor(() => expect(retry).toHaveProperty("disabled", true));
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
