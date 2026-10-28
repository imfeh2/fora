import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/features/discussions/composer";
import { MIB } from "@/lib/limits";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(URL, "createObjectURL", {
    value: () => "blob:preview",
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: () => {},
    configurable: true,
  });
  Object.defineProperty(document, "fonts", {
    value: { ready: Promise.resolve() },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function clipboard(files: File[], text = "") {
  return {
    clipboardData: {
      files,
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  };
}

function scene() {
  return (
    <Composer
      discussionId={1}
      members={[]}
      memberIds={new Set([3])}
      busy={false}
      placeholder="Message"
      onSend={async () => true}
      onHeightChange={() => {}}
      onOpenVoiceSettings={() => {}}
    />
  );
}

function pasted(name: string) {
  return screen.queryByTitle(name) !== null;
}

describe("composer paste", () => {
  it("puts a pasted file that is not an image into the attachments", () => {
    render(scene());
    const pdf = new File(["%PDF-1.4"], "report.pdf", {
      type: "application/pdf",
    });

    const notCancelled = fireEvent.paste(
      screen.getByRole("combobox"),
      clipboard([pdf]),
    );

    expect(pasted("report.pdf")).toBe(true);
    expect(notCancelled).toBe(false);
  });

  it("puts a pasted file into the attachments and lets pasted text through", () => {
    render(scene());
    const pdf = new File(["%PDF-1.4"], "report.pdf", {
      type: "application/pdf",
    });

    const notCancelled = fireEvent.paste(
      screen.getByRole("combobox"),
      clipboard([pdf], "hello"),
    );

    expect(pasted("report.pdf")).toBe(true);
    expect(notCancelled).toBe(true);
  });

  it("keeps a pasted image working", () => {
    render(scene());
    const image = new File(["png"], "shot.png", { type: "image/png" });

    const notCancelled = fireEvent.paste(
      screen.getByRole("combobox"),
      clipboard([image]),
    );

    expect(pasted("shot.png")).toBe(true);
    expect(notCancelled).toBe(false);
  });

  it("puts a pasted file over 20 MiB into the attachments", () => {
    render(scene());
    const clip = new File(["report"], "clip.mp4", { type: "video/mp4" });
    Object.defineProperty(clip, "size", { value: 21 * MIB });

    fireEvent.paste(screen.getByRole("combobox"), clipboard([clip]));

    expect(pasted("clip.mp4")).toBe(true);
  });

  it("leaves a pasted file over 200 MiB out of the attachments", () => {
    render(scene());
    const huge = new File(["report"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(huge, "size", { value: 200 * MIB + 1 });

    fireEvent.paste(screen.getByRole("combobox"), clipboard([huge]));

    expect(pasted("huge.pdf")).toBe(false);
  });
});
