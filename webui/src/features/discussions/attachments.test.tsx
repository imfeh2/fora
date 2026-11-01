import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RouterProvider } from "@/app/router";
import { clearToasts, Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  MessageAttachment,
  MessageAttachments,
} from "@/features/discussions/attachments";
import { type Attachment, BackendError, backend } from "@/lib/backend";

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
  clearToasts();
  vi.restoreAllMocks();
});

beforeEach(() => {
  clearToasts();
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

function file(id: string): Attachment {
  return {
    id,
    name: `${id}.pdf`,
    size: 2048,
    media_type: "application/pdf",
    sha256: "checksum",
    width: null,
    height: null,
  };
}

function withHost(children: ReactNode) {
  return render(
    <TooltipProvider>
      <RouterProvider>
        {children}
        <Toaster />
      </RouterProvider>
    </TooltipProvider>,
  );
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

  it("reports a failed file download as a toast", async () => {
    vi.spyOn(backend, "attachmentFile").mockRejectedValue(
      new BackendError("not_found", "The attachment is gone"),
    );
    const { container } = withHost(
      <MessageAttachment
        discussionId={1}
        messageId={2}
        attachment={file("f1")}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download f1.pdf" }));

    expect(await screen.findByText("Could not download the file")).toBeTruthy();
    expect(screen.getByText("The attachment is gone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a failed image download as a toast", async () => {
    const read = vi
      .spyOn(backend, "attachmentFile")
      .mockResolvedValue(new Blob(["x"]));
    const { container } = withHost(
      <MessageAttachments
        discussionId={1}
        messageId={2}
        attachments={[image("a", 480, 640)]}
      />,
    );

    const view = await screen.findByRole("button", { name: "View a.png" });
    read.mockRejectedValue(new BackendError("not_found", "The image is gone"));
    fireEvent.contextMenu(view);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));

    expect(
      await screen.findByText("Could not download the image"),
    ).toBeTruthy();
    expect(screen.getByText("The image is gone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
