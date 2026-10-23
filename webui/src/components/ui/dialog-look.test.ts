import { describe, expect, it } from "vitest";
import { readLook } from "@/components/ui/dialog-look";

describe("readLook", () => {
  it("reads the look from the dialog parameter", () => {
    expect(readLook("?dialog=2")).toBe(2);
    expect(readLook("?dialog=3")).toBe(3);
    expect(readLook("?keep=1&dialog=2")).toBe(2);
  });

  it("falls back to the first look", () => {
    expect(readLook("")).toBe(1);
    expect(readLook("?dialog=1")).toBe(1);
    expect(readLook("?dialog=4")).toBe(1);
    expect(readLook("?other=2")).toBe(1);
  });
});
