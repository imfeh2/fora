import { describe, expect, it } from "vitest";
import {
  clampSearchIndex,
  matchMessageIds,
  normalizeSearchQuery,
  stepSearchIndex,
} from "@/features/discussions/thread-search";
import type { Message } from "@/lib/backend";

function message(id: number, body: string): Message {
  return {
    id,
    sender_id: 1,
    sender_name: "You",
    body,
    mentions: [],
    attachments: [],
    created_at: "2026-10-30T00:00:00.000Z",
  };
}

describe("normalizeSearchQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeSearchQuery("  Bash  ")).toBe("bash");
  });
  it("returns empty for blank input", () => {
    expect(normalizeSearchQuery("   ")).toBe("");
  });
});

describe("matchMessageIds", () => {
  it("matches message bodies case-insensitively", () => {
    const messages = [
      message(1, "git commit -m 'release'"),
      message(2, "Nothing here"),
    ];
    expect(matchMessageIds(messages, "GIT")).toEqual([1]);
  });

  it("counts a message once even with several occurrences", () => {
    expect(matchMessageIds([message(1, "bash bash bash")], "bash")).toEqual([
      1,
    ]);
  });

  it("returns nothing for a blank query", () => {
    expect(matchMessageIds([message(1, "bash")], "  ")).toEqual([]);
  });

  it("matches inside code fences and table rows", () => {
    const messages = [
      message(1, "```bash\ngit status\n```"),
      message(2, "| a | b |\n| --- | --- |"),
    ];
    expect(matchMessageIds(messages, "git status")).toEqual([1]);
    expect(matchMessageIds(messages, "| a |")).toEqual([2]);
  });
});

describe("stepSearchIndex", () => {
  it("wraps forward and backward", () => {
    expect(stepSearchIndex(2, 3, 1)).toBe(0);
    expect(stepSearchIndex(0, 3, -1)).toBe(2);
  });

  it("stays at zero without hits", () => {
    expect(stepSearchIndex(0, 0, 1)).toBe(0);
  });
});

describe("clampSearchIndex", () => {
  it("clamps past the end and below zero", () => {
    expect(clampSearchIndex(5, 3)).toBe(2);
    expect(clampSearchIndex(-1, 3)).toBe(0);
  });

  it("returns zero without hits", () => {
    expect(clampSearchIndex(4, 0)).toBe(0);
  });
});
