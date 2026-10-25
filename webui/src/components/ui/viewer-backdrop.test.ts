import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectBackdropClick } from "./viewer-backdrop";

let viewport: HTMLDivElement;
let image: HTMLImageElement;
let dispose: () => void;
const close = vi.fn();

function pointer(target: EventTarget, type: string, x = 100, id = 1) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: id,
      button: 0,
      clientX: x,
      clientY: 100,
    }),
  );
}

beforeEach(() => {
  close.mockClear();
  viewport = document.createElement("div");
  image = document.createElement("img");
  viewport.append(image);
  document.body.append(viewport);
  dispose = connectBackdropClick(viewport, close);
});

afterEach(() => {
  dispose();
  viewport.remove();
});

it.each([
  [0, 1],
  [1, 1],
  [4, 1],
  [5, 0],
  [6, 0],
])("closes a background press moved %s pixels %s times", (distance, calls) => {
  pointer(viewport, "pointerdown");
  pointer(viewport, "pointermove", 100 + distance);
  pointer(viewport, "pointerup", 100 + distance);
  expect(close).toHaveBeenCalledTimes(calls);
});

it("closes a touch at touchend and prevents a compatibility click reaching the page", () => {
  for (const type of ["pointerdown", "pointerup"])
    viewport.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        pointerType: "touch",
        button: 0,
      }),
    );
  expect(close).not.toHaveBeenCalled();
  const end = new TouchEvent("touchend", { bubbles: true, cancelable: true });
  viewport.dispatchEvent(end);
  expect(end.defaultPrevented).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
});

it("does not close after a drag returns to its start", () => {
  pointer(viewport, "pointerdown");
  pointer(viewport, "pointermove", 180);
  pointer(viewport, "pointerup", 100);
  expect(close).not.toHaveBeenCalled();
});

it("does not close a press that starts on the image", () => {
  pointer(image, "pointerdown");
  pointer(viewport, "pointerup");
  expect(close).not.toHaveBeenCalled();
});

it("invalidates a two-finger gesture until all fingers lift", () => {
  pointer(viewport, "pointerdown");
  pointer(viewport, "pointerdown", 200, 2);
  pointer(viewport, "pointerup", 200, 2);
  pointer(viewport, "pointerup");
  expect(close).not.toHaveBeenCalled();
  pointer(viewport, "pointerdown");
  pointer(viewport, "pointerup");
  expect(close).toHaveBeenCalledTimes(1);
});

it("invalidates cancellation and window blur and removes its listeners", () => {
  pointer(viewport, "pointerdown");
  pointer(viewport, "pointercancel");
  pointer(viewport, "pointerup");
  pointer(viewport, "pointerdown");
  window.dispatchEvent(new Event("blur"));
  pointer(viewport, "pointerup");
  dispose();
  pointer(viewport, "pointerdown");
  pointer(viewport, "pointerup");
  expect(close).not.toHaveBeenCalled();
});
