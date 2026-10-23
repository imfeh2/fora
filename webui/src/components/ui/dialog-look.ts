export type DialogLook = 1 | 2 | 3;

export function readLook(search: string): DialogLook {
  const requested = new URLSearchParams(search).get("dialog");
  if (requested === "2") return 2;
  if (requested === "3") return 3;
  return 1;
}

export const dialogLook = readLook(location.search);
