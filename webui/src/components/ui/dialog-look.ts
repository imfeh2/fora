export type DialogLook = 1 | 2 | 3;

function readLook(): DialogLook {
  const requested = new URLSearchParams(location.search).get("dialog");
  if (requested === "2") return 2;
  if (requested === "3") return 3;
  return 1;
}

export const dialogLook = readLook();
