import { describe, expect, it } from "vitest";
import { mediaKind } from "@/features/library/media";

describe("mediaKind", () => {
  it("recognises the file types the page renders with a native element", () => {
    expect(mediaKind("artifacts/instance-ui.png")).toBe("image");
    expect(mediaKind("artifacts/photo.JPEG")).toBe("image");
    expect(mediaKind("artifacts/scan.webp")).toBe("image");
    expect(mediaKind("artifacts/spin.gif")).toBe("image");
    expect(mediaKind("artifacts/instance-ui-playwright.mp4")).toBe("video");
    expect(mediaKind("artifacts/clip.webm")).toBe("video");
    expect(mediaKind("artifacts/voice.mp3")).toBe("audio");
  });

  it("leaves files the page cannot render to the text editor", () => {
    expect(mediaKind("AGENTS.md")).toBeNull();
    expect(mediaKind("runbooks/page.html")).toBeNull();
    expect(mediaKind("artifacts/drawing.svg")).toBeNull();
    expect(mediaKind("tasks/2026-10-15-prompt-learning.pdf")).toBeNull();
    expect(mediaKind("README")).toBeNull();
    expect(mediaKind("artifacts/.png")).toBeNull();
  });
});
