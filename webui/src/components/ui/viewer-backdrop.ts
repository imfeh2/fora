export function connectBackdropClick(
  viewport: HTMLElement,
  close: () => void,
): () => void {
  const pointers = new Set<number>();
  let press: { id: number; x: number; y: number } | null = null;
  let touchClick = false;
  const down = (event: PointerEvent) => {
    pointers.add(event.pointerId);
    press =
      pointers.size === 1 && event.button === 0 && event.target === viewport
        ? { id: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
  };
  const move = (event: PointerEvent) => {
    if (
      press?.id === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 5
    )
      press = null;
  };
  const up = (event: PointerEvent) => {
    move(event);
    const clicked = press?.id === event.pointerId;
    pointers.delete(event.pointerId);
    press = null;
    if (clicked) {
      if (event.pointerType === "touch") touchClick = true;
      else close();
    }
  };
  const cancel = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    press = null;
    touchClick = false;
  };
  const touchEnd = (event: TouchEvent) => {
    if (!touchClick) return;
    touchClick = false;
    event.preventDefault();
    close();
  };
  const clear = () => {
    pointers.clear();
    press = null;
    touchClick = false;
  };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", clear);
  window.addEventListener("touchend", touchEnd, {
    capture: true,
    passive: false,
  });
  return () => {
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("blur", clear);
    window.removeEventListener("touchend", touchEnd, true);
  };
}
