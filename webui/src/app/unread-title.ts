import type { DiscussionSummary } from "@/lib/backend";

export const APP_TITLE = "Fora";
export const HIDDEN_REFRESH_MS = 60_000;
const COUNT_LIMIT = 99;

export function unreadMentions(discussions: DiscussionSummary[]): number {
  return discussions.reduce(
    (total, discussion) => total + discussion.mentions,
    0,
  );
}

export function unreadTitle(count: number): string {
  if (count <= 0) return APP_TITLE;
  return `(${count > COUNT_LIMIT ? `${COUNT_LIMIT}+` : count}) ${APP_TITLE}`;
}

export function applyUnreadTitle(
  discussions: DiscussionSummary[] | null,
): void {
  if (discussions === null) return;
  const title = unreadTitle(unreadMentions(discussions));
  if (document.title !== title) document.title = title;
}

export function resetUnreadTitle(): void {
  if (document.title !== APP_TITLE) document.title = APP_TITLE;
}
