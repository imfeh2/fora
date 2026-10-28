import { describe, expect, it } from "vitest";
import {
  ComposerController,
  pasteFiles,
} from "@/features/discussions/composer-state";
import { MAX_FILE_BYTES, MIB, mib } from "@/lib/limits";

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

describe("ComposerController.addFiles", () => {
  it("takes a pasted file that is not an image into the draft", () => {
    const controller = new ComposerController(1);
    const pdf = new File(["%PDF-1.4"], "report.pdf", {
      type: "application/pdf",
    });

    controller.addFiles(pasteFiles(clipboard([pdf])).files);

    expect(
      controller.snapshot().draft.files.map((item) => item.file.name),
    ).toEqual(["report.pdf"]);
    expect(controller.snapshot().error).toBeNull();
  });

  it("accepts a pasted file over 20 MiB", () => {
    const controller = new ComposerController(1);
    const clip = new File(["report"], "clip.mp4", { type: "video/mp4" });
    Object.defineProperty(clip, "size", { value: 21 * MIB });

    controller.addFiles(pasteFiles(clipboard([clip])).files);

    expect(
      controller.snapshot().draft.files.map((item) => item.file.name),
    ).toEqual(["clip.mp4"]);
    expect(controller.snapshot().error).toBeNull();
    expect(mib(MAX_FILE_BYTES)).toBe(200);
  });

  it("rejects a pasted file over 200 MiB", () => {
    const controller = new ComposerController(1);
    const huge = new File(["report"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(huge, "size", { value: 200 * MIB + 1 });

    controller.addFiles(pasteFiles(clipboard([huge])).files);

    expect(controller.snapshot().draft.files).toEqual([]);
    expect(controller.snapshot().error?.kind).toBe("rejected");
    expect(controller.snapshot().error?.message).toBe(
      "huge.pdf: files must be at most 200 MiB.",
    );
  });
});
