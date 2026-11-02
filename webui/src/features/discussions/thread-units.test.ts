import { describe, expect, it } from "vitest";
import { sameGroup } from "@/features/discussions/thread-units";

const row = (senderId: number, timestamp: string) => ({ senderId, timestamp });

describe("sameGroup", () => {
  it("keeps messages of one sender together within five minutes", () => {
    const first = row(2, "2026-10-21T10:00:00.000Z");
    expect(sameGroup(first, row(2, "2026-10-21T10:00:30.000Z"))).toBe(true);
    expect(sameGroup(first, row(2, "2026-10-21T10:05:00.000Z"))).toBe(true);
  });

  it("starts a new group once the gap passes five minutes", () => {
    const first = row(2, "2026-10-21T10:00:00.000Z");
    expect(sameGroup(first, row(2, "2026-10-21T10:05:01.000Z"))).toBe(false);
    expect(sameGroup(first, row(2, "2026-10-21T13:00:00.000Z"))).toBe(false);
  });

  it("starts a new group when another member writes", () => {
    const first = row(2, "2026-10-21T10:00:00.000Z");
    expect(sameGroup(first, row(3, "2026-10-21T10:00:30.000Z"))).toBe(false);
  });
});
