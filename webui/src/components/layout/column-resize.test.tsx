import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ColumnResizeHandle, useColumnWidth } from "./column-resize";

function Harness() {
  const column = useColumnWidth({
    storageKey: "fora.test-width",
    initial: 248,
    min: 200,
    max: 480,
  });
  return (
    <div data-testid="column" style={{ width: column.width }}>
      <ColumnResizeHandle
        label="Resize test column"
        min={200}
        max={480}
        width={column.width}
        resizing={column.resizing}
        className="sidebar-resize"
        onPointerDown={column.startResize}
        onKeyDown={column.resizeWithKeys}
        onDoubleClick={column.reset}
      />
    </div>
  );
}

function widthOf(): string {
  return screen.getByTestId("column").style.width;
}

function drag(from: number, to: number): void {
  const handle = screen.getByRole("separator");
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    button: 0,
    pointerType: "mouse",
    clientX: from,
  });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to });
}

describe("column resize", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("follows the pointer and stores the width when the drag ends", () => {
    render(<Harness />);
    expect(widthOf()).toBe("248px");
    drag(248, 328);
    expect(widthOf()).toBe("328px");
    expect(window.localStorage.getItem("fora.test-width")).toBeNull();
    expect(document.body.classList.contains("sidebar-resizing")).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(window.localStorage.getItem("fora.test-width")).toBe("328");
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
  });

  it("keeps the width between the bounds", () => {
    render(<Harness />);
    drag(248, 2000);
    expect(widthOf()).toBe("480px");
    fireEvent.pointerUp(window, { pointerId: 1 });
    drag(0, -2000);
    expect(widthOf()).toBe("200px");
    fireEvent.pointerUp(window, { pointerId: 1 });
  });

  it("restores the stored width on mount", () => {
    window.localStorage.setItem("fora.test-width", "360");
    render(<Harness />);
    expect(widthOf()).toBe("360px");
  });

  it("moves with the arrow keys and jumps to the ends", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthOf()).toBe("264px");
    expect(handle.getAttribute("aria-valuenow")).toBe("264");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthOf()).toBe("248px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(widthOf()).toBe("200px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(widthOf()).toBe("480px");
    expect(window.localStorage.getItem("fora.test-width")).toBe("480");
  });

  it("resets with a double click", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.doubleClick(handle);
    expect(widthOf()).toBe("248px");
    expect(window.localStorage.getItem("fora.test-width")).toBe("248");
  });
});
