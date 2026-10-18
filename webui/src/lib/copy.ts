import copy from "copy-to-clipboard";

export async function copyText(text: string): Promise<void> {
  const copied = await copy(text);
  if (!copied) throw new Error("Copy is not available in this browser");
}
