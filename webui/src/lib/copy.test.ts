import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/copy";

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(() => true),
  });
});

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

describe("copyText", () => {
  it("writes through the clipboard when it is available", async () => {
    writeText.mockResolvedValue(undefined);
    await copyText("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to a textarea when the clipboard is missing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: exec,
    });
    await copyText("fallback");
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("throws when the clipboard rejects and the fallback fails", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    await expect(copyText("nope")).rejects.toThrow(
      "Copy is not available in this browser",
    );
  });
});
