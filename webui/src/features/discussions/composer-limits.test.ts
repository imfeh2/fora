import { describe, expect, it } from "vitest";
import {
  type ComposerFile,
  fileProblem,
} from "@/features/discussions/composer-state";
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_BYTES,
  MIB,
} from "@/lib/limits";

function file(name: string, size: number, type = "application/pdf"): File {
  const item = new File([new Uint8Array(0)], name, { type });
  Object.defineProperty(item, "size", { value: size });
  return item;
}

function held(name: string, size: number): ComposerFile {
  return { id: name, file: file(name, size), clientId: name };
}

describe("composer file limits", () => {
  it("accepts a file at 200 MiB and rejects one byte more", () => {
    expect(fileProblem(file("clip.mp4", MAX_FILE_BYTES), [])).toBeNull();
    expect(fileProblem(file("clip.mp4", MAX_FILE_BYTES + 1), [])).toBe(
      "clip.mp4: files must be at most 200 MiB.",
    );
  });

  it("accepts a message totalling 500 MiB and rejects one byte more", () => {
    expect(MAX_MESSAGE_BYTES).toBe(500 * MIB);
    const four = [0, 1, 2, 3].map((index) =>
      held(`part-${index}.bin`, 100 * MIB),
    );

    expect(fileProblem(file("part-4.bin", 100 * MIB), four)).toBeNull();
    expect(fileProblem(file("part-4.bin", 100 * MIB + 1), four)).toBe(
      "Message files must total at most 500 MiB.",
    );
  });

  it("keeps the image limit at 5 MiB", () => {
    expect(
      fileProblem(file("photo.png", MAX_IMAGE_BYTES, "image/png"), []),
    ).toBeNull();
    expect(
      fileProblem(file("photo.png", MAX_IMAGE_BYTES + 1, "image/png"), []),
    ).toBe("photo.png: images must be at most 5 MiB.");
  });

  it("still caps a message at ten files", () => {
    const nine = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) =>
      held(`part-${index}.bin`, 1),
    );

    expect(fileProblem(file("part-9.bin", 1), nine)).toBeNull();
    expect(
      fileProblem(file("part-10.bin", 1), [...nine, held("part-9b.bin", 1)]),
    ).toBe("A message can contain at most 10 files.");
  });
});
