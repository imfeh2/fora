import { describe, expect, it } from "vitest";
import { folderTree } from "@/features/library/folder-tree";
import {
  creationDestination,
  creationNameError,
  libraryActions,
} from "@/features/library/list";
import type { LibraryEntry } from "@/lib/backend";

function entry(
  path: string,
  kind: LibraryEntry["kind"] = "file",
): LibraryEntry {
  return { path, kind, size: 0, modified_at: "2026-10-25T00:00:00Z" };
}

const handlers = {
  rename: () => {},
  create: () => {},
  remove: () => {},
};

describe("folderTree", () => {
  it("keeps files beside folders, with folders first", () => {
    const roots = folderTree([
      entry("notes/plan.md"),
      entry("notes", "directory"),
      entry("README.md"),
      entry("media", "directory"),
    ]);

    expect(roots.map((node) => node.name)).toEqual([
      "media",
      "notes",
      "README.md",
    ]);
    expect(roots[1].children.map((node) => node.name)).toEqual(["plan.md"]);
  });

  it("puts a nested file under its folder instead of the root", () => {
    const roots = folderTree([
      entry("docs", "directory"),
      entry("docs/reports", "directory"),
      entry("docs/reports/final.pdf"),
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0].children[0].children[0].path).toBe(
      "docs/reports/final.pdf",
    );
  });
});

describe("libraryActions", () => {
  it("keeps rename on a file, so it can move to another folder", () => {
    const labels = libraryActions(entry("docs/plan.md"), handlers).map(
      (action) => action.label,
    );

    expect(labels).toEqual(["Rename", "Delete"]);
  });

  it("adds creation actions on a folder", () => {
    const labels = libraryActions(entry("docs", "directory"), handlers).map(
      (action) => action.label,
    );

    expect(labels).toEqual(["Rename", "New document", "New folder", "Delete"]);
  });
});

describe("creationDestination", () => {
  it("puts a new entry under the picked folder", () => {
    expect(
      creationDestination({ kind: "file", parent: "docs/reports" }, "plan.md"),
    ).toBe("docs/reports/plan.md");
  });

  it("allows a name at the library root", () => {
    expect(creationDestination({ kind: "file", parent: "" }, "plan.md")).toBe(
      "plan.md",
    );
  });

  it("rejects a name that carries a path", () => {
    expect(creationNameError("docs/plan.md")).toBeDefined();
    expect(() =>
      creationDestination({ kind: "file", parent: "" }, "docs/plan.md"),
    ).toThrow();
  });
});
