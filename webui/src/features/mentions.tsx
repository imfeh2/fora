import type { ReactNode } from "react";
import type { Member, MessageMention } from "@/lib/backend";

export function renderMentions(
  body: string,
  mentions: MessageMention[],
  _members: Member[],
): ReactNode[] {
  if (mentions.length === 0) return [body];
  const characters = Array.from(body);
  const nodes: ReactNode[] = [];
  let index = 0;

  for (const { position, length } of [...mentions].sort(
    (a, b) => a.position - b.position || b.length - a.length,
  )) {
    const end = position + length;
    if (
      !Number.isInteger(position) ||
      !Number.isInteger(length) ||
      position < index ||
      length <= 0 ||
      end > characters.length
    )
      continue;

    if (position > index)
      nodes.push(characters.slice(index, position).join(""));
    nodes.push(
      <mark key={position}>{characters.slice(position, end).join("")}</mark>,
    );
    index = end;
  }

  if (index < characters.length) nodes.push(characters.slice(index).join(""));
  return nodes.length > 0 ? nodes : [body];
}

const MAX_NAME_LENGTH = 64;

export type MentionQuery = { start: number; query: string };

export function mentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret <= 0) return null;
  const from = Math.max(0, caret - MAX_NAME_LENGTH - 1);
  const at = text.lastIndexOf("@", caret - 1);
  if (at < 0 || at < from) return null;

  const before = at > 0 ? text[at - 1] : "";
  if (before && /[\p{L}\p{N}]/u.test(before)) return null;

  const query = text.slice(at + 1, caret);
  if (query.includes("@") || /[\n\r]/.test(query)) return null;
  return { start: at, query };
}

export function matchMembers(members: Member[], query: string): Member[] {
  const needle = query.trim().toLowerCase();
  return members
    .filter((member) => member.name.toLowerCase().startsWith(needle))
    .sort((a, b) => a.name.length - b.name.length);
}

export type MentionCandidate =
  | { kind: "all"; id: "all"; name: "all" }
  | { kind: "member"; id: number; name: string; member: Member };

export type MentionCandidates = {
  hasAll: boolean;
  inDiscussion: Member[];
  elsewhere: Member[];
};

export function candidatesFor(
  members: Member[],
  inDiscussion: ReadonlySet<number>,
  query: string,
): MentionCandidates {
  const needle = query.trim().toLowerCase();
  const hasAll = inDiscussion.size > 0 && "all".startsWith(needle);
  const mentionable = members.filter(
    (member) => member.name.toLowerCase() !== "all",
  );
  const here = matchMembers(
    mentionable.filter((member) => inDiscussion.has(member.id)),
    query,
  );
  if (!needle) return { hasAll, inDiscussion: here, elsewhere: [] };
  return {
    hasAll,
    inDiscussion: here,
    elsewhere: matchMembers(
      mentionable.filter((member) => !inDiscussion.has(member.id)),
      query,
    ),
  };
}

export function completeMention(
  text: string,
  mention: MentionQuery,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const head = `${text.slice(0, mention.start)}@${name} `;
  return { text: head + text.slice(caret), caret: head.length };
}
