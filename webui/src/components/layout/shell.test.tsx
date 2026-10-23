import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Shell } from "@/components/layout/shell";

function renderShell() {
  const view = render(
    <Shell sidebar={<div>navigation</div>}>
      <div>body</div>
    </Shell>,
  );
  return view.container.firstElementChild as HTMLElement;
}

function widthOf(root: HTMLElement) {
  return root.style.getPropertyValue("--sidebar-width");
}

function drag(handle: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    pointerType: "mouse",
    clientX: from,
  });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to });
}

describe("sidebar resize", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("follows the pointer and stores the width when the drag ends", () => {
    const root = renderShell();
    const handle = screen.getByRole("separator");
    expect(widthOf(root)).toBe("240px");
    drag(handle, 240, 320);
    expect(widthOf(root)).toBe("320px");
    expect(window.localStorage.getItem("fora.sidebar-width")).toBeNull();
    expect(document.body.classList.contains("sidebar-resizing")).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(window.localStorage.getItem("fora.sidebar-width")).toBe("320");
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
  });

  it("keeps the width between 200 and 400", () => {
    const root = renderShell();
    const handle = screen.getByRole("separator");
    drag(handle, 240, 900);
    expect(widthOf(root)).toBe("400px");
    fireEvent.pointerUp(window, { pointerId: 1 });
    drag(handle, 240, -900);
    expect(widthOf(root)).toBe("200px");
    fireEvent.pointerUp(window, { pointerId: 1 });
  });

  it("moves with the arrow keys and jumps to the ends", () => {
    const root = renderShell();
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthOf(root)).toBe("256px");
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthOf(root)).toBe("240px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(widthOf(root)).toBe("200px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(widthOf(root)).toBe("400px");
    expect(window.localStorage.getItem("fora.sidebar-width")).toBe("400");
  });

  it("resets with a double click", () => {
    const root = renderShell();
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.doubleClick(handle);
    expect(widthOf(root)).toBe("240px");
    expect(window.localStorage.getItem("fora.sidebar-width")).toBe("240");
  });

  it("has no handle on a narrow viewport", () => {
    const original = window.innerWidth;
    window.innerWidth = 600;
    renderShell();
    expect(screen.queryByRole("separator")).toBeNull();
    window.innerWidth = original;
  });
});
