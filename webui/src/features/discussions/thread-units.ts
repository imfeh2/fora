import type { ThreadMessage } from "@/features/discussions/thread-data";

export type ThreadUnit = {
  key: string;
  senderId: number;
  timestamp: string;
  message: ThreadMessage;
};

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
