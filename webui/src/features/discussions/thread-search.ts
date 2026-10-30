import type { Message } from "@/lib/backend";

export function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function matchMessageIds(
  messages: readonly Message[],
  query: string,
): number[] {
  const needle = normalizeSearchQuery(query);
  if (!needle) return [];
  const ids: number[] = [];
  for (const message of messages) {
    if ((message.body ?? "").toLowerCase().includes(needle))
      ids.push(message.id);
  }
  return ids;
}

export function clampSearchIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.floor(index), total - 1);
}

export function stepSearchIndex(
  index: number,
  total: number,
  delta: number,
): number {
  if (total <= 0) return 0;
  const next = (index + delta) % total;
  return next < 0 ? next + total : next;
}
