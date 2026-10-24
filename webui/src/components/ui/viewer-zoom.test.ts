import { describe, expect, it } from "vitest";
import { drawableTransform, releaseVelocity, zoomPercent } from "./viewer-zoom";

describe("viewer scale", () => {
  it.each([
    [0.05, "5%"],
    [0.0001, "0.01%"],
    [1, "100%"],
    [20, "2000%"],
    [1000, "100000%"],
  ])("formats natural scale %s", (scale, label) => {
    expect(zoomPercent(Number(scale))).toBe(label);
  });

  it("keeps tiny positive scales visible as nonzero percentages", () => {
    expect(zoomPercent(1e-30)).toBe("1.00e-28%");
  });

  it("allows arbitrary positions and the required magnifications", () => {
    for (const k of [0.0001, 0.05, 1, 20, 1000]) {
      expect(
        drawableTransform({ k, x: -1000000, y: 1000000 }, 2880, 1800),
      ).toBe(true);
    }
  });

  it.each([0, -1, NaN, Infinity, Number.MIN_VALUE, Number.MAX_VALUE])(
    "rejects unrenderable scale %s",
    (k) => {
      expect(drawableTransform({ k, x: 0, y: 0 }, 300, 200)).toBe(false);
    },
  );
});

describe("release velocity", () => {
  const samples = [
    { x: 10, y: 20, time: 0 },
    { x: 30, y: 10, time: 20 },
    { x: 50, y: 0, time: 40 },
  ];

  it("measures screen pixels per second", () => {
    expect(releaseVelocity(samples, 40)).toEqual({ x: 1000, y: -500 });
  });

  it("includes a pause before releasing", () => {
    expect(releaseVelocity(samples, 60)).toEqual({ x: 2000 / 3, y: -1000 / 3 });
    expect(releaseVelocity(samples, 150)).toEqual({ x: 0, y: 0 });
  });

  it("ignores older movement and stationary input", () => {
    expect(
      releaseVelocity(
        [...samples, { x: 50, y: 0, time: 200 }, { x: 50, y: 0, time: 220 }],
        230,
      ),
    ).toEqual({ x: 0, y: 0 });
    expect(releaseVelocity([], 230)).toEqual({ x: 0, y: 0 });
  });
});
