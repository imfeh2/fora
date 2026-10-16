import { describe, expect, it } from "vitest";
import { navIdOf, pageKeyOf } from "@/app/router";

describe("navIdOf", () => {
  it("maps detail routes to their section", () => {
    expect(navIdOf({ name: "discussion", id: 4 })).toBe("discussions");
    expect(navIdOf({ name: "document", path: "a.md" })).toBe("library");
    expect(navIdOf({ name: "library", path: "runbooks/on-call" })).toBe(
      "library",
    );
    expect(navIdOf({ name: "settings", section: "langfuse" })).toBe("settings");
  });
});

describe("pageKeyOf", () => {
  it("remounts the Library for a different folder destination", () => {
    expect(pageKeyOf({ name: "library", path: "runbooks" })).toBe(
      "library:runbooks",
    );
    expect(pageKeyOf({ name: "library", path: "runbooks" })).not.toBe(
      pageKeyOf({ name: "library", path: "notes" }),
    );
    expect(pageKeyOf({ name: "library", path: undefined })).toBe(
      pageKeyOf({ name: "library" }),
    );
  });
  it("changes only when the page or its subject changes", () => {
    expect(pageKeyOf({ name: "discussion", id: 4 })).not.toBe(
      pageKeyOf({ name: "discussion", id: 5 }),
    );
    expect(pageKeyOf({ name: "settings", section: "model" })).toBe(
      pageKeyOf({ name: "settings", section: "agent" }),
    );
    expect(pageKeyOf({ name: "library" })).not.toBe(
      pageKeyOf({ name: "document", path: "library" }),
    );
  });
});
