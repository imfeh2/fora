import { describe, expect, it } from "vitest";
import { draftEntry, targetParts } from "@/features/members/permissions";
import type { PermissionAction } from "@/lib/backend";

const catalog: PermissionAction[] = [
  {
    node: ["library", "write"],
    name: "library:write",
    target: "path",
    description: "",
  },
];

describe("permission entries", () => {
  it("splits a target on either kind of slash", () => {
    expect(targetParts("/project/fora/")).toEqual(["project", "fora"]);
    expect(targetParts("C:\\Users\\me")).toEqual(["C:", "Users", "me"]);
    expect(targetParts("")).toEqual([]);
  });

  it("builds a node from the action and its target", () => {
    expect(
      draftEntry(
        {
          key: 1,
          sign: "+",
          action: "library:write",
          target: "rules/flow.md",
          delegable: true,
        },
        catalog,
      ),
    ).toEqual({
      sign: "+",
      node: ["library", "write", "rules", "flow.md"],
      delegable: true,
    });
  });

  it("treats everything as the empty node and never marks exclusions delegable", () => {
    expect(
      draftEntry(
        { key: 2, sign: "-", action: "*", target: "", delegable: true },
        catalog,
      ),
    ).toEqual({ sign: "-", node: [] });
  });
});
