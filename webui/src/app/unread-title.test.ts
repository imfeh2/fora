import { afterEach, describe, expect, it } from "vitest";
import {
  applyUnreadTitle,
  resetUnreadTitle,
  unreadMentions,
  unreadTitle,
} from "@/app/unread-title";
import type { DiscussionSummary } from "@/lib/backend";

function summary(id: number, mentions: number): DiscussionSummary {
  return {
    id,
    topic: `discussion ${id}`,
    member_ids: [1, 2],
    archived: false,
    unread: mentions + 3,
    mentions,
  };
}

afterEach(() => {
  document.title = "Fora";
});

describe("unreadMentions", () => {
  it("adds the mentions of every discussion", () => {
    expect(unreadMentions([])).toBe(0);
    expect(unreadMentions([summary(1, 2)])).toBe(2);
    expect(unreadMentions([summary(1, 2), summary(2, 0), summary(3, 5)])).toBe(
      7,
    );
  });

  it("ignores plain unread messages", () => {
    expect(unreadMentions([summary(1, 0)])).toBe(0);
  });
});

describe("unreadTitle", () => {
  it("writes the count in front of the application name", () => {
    expect(unreadTitle(2)).toBe("(2) Fora");
    expect(unreadTitle(99)).toBe("(99) Fora");
  });

  it("falls back to the bare name without mentions", () => {
    expect(unreadTitle(0)).toBe("Fora");
    expect(unreadTitle(-1)).toBe("Fora");
  });

  it("caps the count above ninety nine", () => {
    expect(unreadTitle(100)).toBe("(99+) Fora");
    expect(unreadTitle(1234)).toBe("(99+) Fora");
  });
});

describe("applyUnreadTitle", () => {
  it("keeps the last title while the discussions are unknown", () => {
    document.title = "(2) Fora";
    applyUnreadTitle(null);
    expect(document.title).toBe("(2) Fora");
  });

  it("follows the discussions down to zero", () => {
    applyUnreadTitle([summary(1, 2)]);
    expect(document.title).toBe("(2) Fora");
    applyUnreadTitle([summary(1, 0)]);
    expect(document.title).toBe("Fora");
  });

  it("goes back to the bare name when reset", () => {
    applyUnreadTitle([summary(1, 100)]);
    expect(document.title).toBe("(99+) Fora");
    resetUnreadTitle();
    expect(document.title).toBe("Fora");
  });
});
