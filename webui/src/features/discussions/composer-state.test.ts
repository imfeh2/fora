import { describe, expect, it } from "vitest";
import { pasteFiles } from "@/features/discussions/composer-state";

function clipboard(files: File[], text = "") {
  return {
    files,
    getData: (type: string) => (type === "text/plain" ? text : ""),
  };
}

describe("pasteFiles", () => {
  it("keeps a file that is not an image", () => {
    const file = new File(["report"], "report.pdf", {
      type: "application/pdf",
    });
    const pasted = pasteFiles(clipboard([file]));

    expect(pasted.files).toEqual([file]);
    expect(pasted.swallow).toBe(true);
  });

  it("keeps an unknown file type", () => {
    const file = new File(["notes"], "notes.txt", { type: "" });

    expect(pasteFiles(clipboard([file])).files).toEqual([file]);
  });

  it("keeps an image and lets pasted text through", () => {
    const image = new File(["png"], "shot.png", { type: "image/png" });
    const pasted = pasteFiles(clipboard([image], "hello"));

    expect(pasted.files).toEqual([image]);
    expect(pasted.swallow).toBe(false);
  });

  it("does nothing when the clipboard carries no files", () => {
    const pasted = pasteFiles(clipboard([], "hello"));

    expect(pasted.files).toEqual([]);
    expect(pasted.swallow).toBe(false);
  });
});
