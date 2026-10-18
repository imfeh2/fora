import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/copy";

const writeText = vi.fn();

function secureContext(value: boolean) {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value,
  });
}

function clipboard(value: { writeText: typeof writeText } | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

function execCommand(value: (command: string) => boolean) {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  writeText.mockReset();
  secureContext(true);
  clipboard({ writeText });
  execCommand(() => true);
});

afterEach(() => {
  clipboard(undefined);
  secureContext(false);
});

describe("copyText", () => {
  it("writes through the clipboard API in a secure context", async () => {
    writeText.mockResolvedValue(undefined);
    await copyText("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("copies in an insecure context without the clipboard API", async () => {
    secureContext(false);
    clipboard(undefined);
    const exec = vi.fn(() => true);
    execCommand(exec);
    await copyText("insecure");
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("throws when neither the clipboard nor the fallback copies", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    execCommand(() => false);
    await expect(copyText("nope")).rejects.toThrow(
      "Copy is not available in this browser",
    );
  });
});
