import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@/app/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageAttachments } from "@/features/discussions/attachments";
import { type Attachment, backend } from "@/lib/backend";

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
}

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", Observer);
  URL.createObjectURL = vi.fn(() => "blob:attachment");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function image(id: string, width: number, height: number): Attachment {
  return {
    id,
    name: `${id}.png`,
    size: 4096,
    media_type: "image/png",
    sha256: "checksum",
    width,
    height,
  };
}

function renderAttachments(attachments: Attachment[]) {
  vi.spyOn(backend, "attachmentFile").mockImplementation(
    () => new Promise(() => {}),
  );
  return render(
    <TooltipProvider>
      <RouterProvider>
        <MessageAttachments
          discussionId={1}
          messageId={2}
          attachments={attachments}
        />
      </RouterProvider>
    </TooltipProvider>,
  );
}

describe("attachment image loading state", () => {
  it("keeps a single image frame at its final size without text", () => {
    const { container } = renderAttachments([image("a", 480, 640)]);
    const frame = container.querySelector(
      ".inline-media-single",
    ) as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.getPropertyValue("--inline-single-width")).toBe("300px");
    expect(frame.style.aspectRatio).toBe("480 / 640");
    expect(frame.textContent).toBe("");
    expect(container.querySelector("[role=status]")).toBeNull();
    expect(container.querySelector(".inline-media-placeholder")).toBeNull();
  });

  it("leaves grid cells empty while the images load", () => {
    const { container } = renderAttachments([
      image("a", 800, 500),
      image("b", 800, 500),
      image("c", 800, 500),
      image("d", 800, 500),
    ]);
    const cells = [...container.querySelectorAll(".inline-media-cell")];
    expect(cells.length).toBe(4);
    expect(container.querySelector("[role=status]")).toBeNull();
    expect(container.textContent).toBe("");
    for (const cell of cells) expect(cell.childElementCount).toBe(0);
  });
});
