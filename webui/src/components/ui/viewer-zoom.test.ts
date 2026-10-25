import { waitFor } from "@testing-library/react";
import { zoomIdentity } from "d3-zoom";
import { describe, expect, it, vi } from "vitest";
import {
  connectImageZoom,
  drawableTransform,
  interpolateView,
  zoomPercent,
} from "./viewer-zoom";

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

describe("image gesture connection", () => {
  it("eases mouse and wheel input to their exact targets and removes handlers on disposal", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const view = frame.contentWindow;
    if (!view) throw new Error("Missing test window");
    const viewport = document.createElement("div");
    const image = document.createElement("img");
    viewport.append(image);
    document.body.append(viewport);
    Object.defineProperties(viewport, {
      clientWidth: { value: 1440 },
      clientHeight: { value: 900 },
    });
    Object.defineProperties(image, {
      naturalWidth: { value: 300 },
      naturalHeight: { value: 200 },
    });
    const onScale = vi.fn();
    const actions = connectImageZoom(viewport, image, onScale);
    expect(image.style.transform).toBe("translate(45px, 0px) scale(4.5)");
    actions.scaleBy(0.01);
    expect(image.style.transform).toBe("translate(45px, 0px) scale(4.5)");
    await waitFor(() => expect(onScale).toHaveBeenLastCalledWith(0.045));
    viewport.dispatchEvent(
      new MouseEvent("mousedown", {
        view,
        clientX: 200,
        clientY: 300,
        bubbles: true,
      }),
    );
    view.dispatchEvent(
      new MouseEvent("mousemove", {
        view,
        clientX: 280,
        clientY: 360,
        buttons: 1,
      }),
    );
    expect(image.style.transform).not.toBe(
      "translate(793.25px, 505.5px) scale(0.045)",
    );
    await waitFor(() =>
      expect(image.style.transform).toBe(
        "translate(793.25px, 505.5px) scale(0.045)",
      ),
    );
    actions.stop();
    view.dispatchEvent(
      new MouseEvent("mouseup", { view, clientX: 280, clientY: 360 }),
    );
    viewport.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -500,
        clientX: 200,
        clientY: 300,
        cancelable: true,
      }),
    );
    await waitFor(() => expect(onScale).toHaveBeenLastCalledWith(0.09));
    expect(image.style.transform).toBe(
      "translate(1386.5px, 711px) scale(0.09)",
    );
    actions.fit();
    await waitFor(() =>
      expect(image.style.transform).toBe("translate(45px, 0px) scale(4.5)"),
    );
    actions.dispose();
    const calls = onScale.mock.calls.length;
    viewport.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -500, cancelable: true }),
    );
    expect(onScale).toHaveBeenCalledTimes(calls);
    expect(image.style.transform).toBe("translate(45px, 0px) scale(4.5)");
    viewport.remove();
    frame.remove();
  });
});

it("interpolates without overshoot and preserves exact endpoints at extreme scales", () => {
  const start = zoomIdentity.translate(400, 300).scale(1e30);
  const target = zoomIdentity.translate(-900, -700).scale(1e-30);
  expect(interpolateView(start, target, 0)).toBe(start);
  expect(interpolateView(start, target, 1)).toBe(target);
  let previous = start;
  for (let index = 1; index <= 100; index += 1) {
    const current = interpolateView(start, target, index / 100);
    expect(current.k).toBeGreaterThanOrEqual(target.k);
    expect(current.k).toBeLessThanOrEqual(previous.k);
    expect(current.x).toBeGreaterThanOrEqual(target.x);
    expect(current.x).toBeLessThanOrEqual(previous.x);
    expect(current.y).toBeGreaterThanOrEqual(target.y);
    expect(current.y).toBeLessThanOrEqual(previous.y);
    previous = current;
  }
});
