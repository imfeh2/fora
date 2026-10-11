const scrollKeys = new Set([
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
  " ",
]);

const nonScrollInteractiveSelector =
  "textarea, input, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='combobox'], [role='listbox'], [role='option'], [role='slider'], [role='switch'], [role='checkbox'], [role='radio']";

export function centeredScrollTop(
  scrollTop: number,
  maxScrollTop: number,
  markerTop: number,
  readableTop: number,
  readableBottom: number,
): number {
  const target = (readableTop + readableBottom) / 2;
  return Math.max(0, Math.min(maxScrollTop, scrollTop + markerTop - target));
}

export function shouldStopPositioningForKey(
  key: string,
  target: Pick<Element, "closest">,
): boolean {
  if (!scrollKeys.has(key)) return false;
  return target.closest(nonScrollInteractiveSelector) === null;
}
