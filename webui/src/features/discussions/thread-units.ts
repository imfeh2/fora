import type { ThreadMessage } from "@/features/discussions/thread-data";

export type ThreadUnit = {
  key: string;
  senderId: number;
  timestamp: string;
  message: ThreadMessage;
};

const GROUP_WINDOW_MS = 5 * 60 * 1000;

type GroupedMessage = Pick<ThreadUnit, "senderId" | "timestamp">;

export function sameGroup(
  previous: GroupedMessage,
  current: GroupedMessage,
): boolean {
  if (previous.senderId !== current.senderId) return false;
  const gap =
    new Date(current.timestamp).getTime() -
    new Date(previous.timestamp).getTime();
  return gap <= GROUP_WINDOW_MS;
}

export function combineThreadUnits(
  messages: ThreadMessage[],
  cache?: Map<string, ThreadUnit>,
): ThreadUnit[] {
  return messages.map((message) => {
    const key = `message:${message.id}`;
    const cached = cache?.get(key);
    if (cached && cached.message === message) return cached;
    const unit = {
      key,
      timestamp: message.created_at,
      senderId: message.sender_id,
      message,
    };
    cache?.set(key, unit);
    return unit;
  });
}
