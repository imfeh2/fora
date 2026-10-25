import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FolderTree, folderTree } from "@/features/library/folder-tree";
import {
  creationDestination,
  creationNameError,
  libraryActions,
  searchResults,
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

const tree = [
  entry("media", "directory"),
  entry("media/demo.mp4"),
  entry("README.md"),
];

Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
});

function Harness({ open }: { open: string }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState(open);
  return (
    <FolderTree
      entries={tree}
      expanded={expanded}
      selected={selected}
      onToggle={(path) =>
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        })
      }
      onOpen={setSelected}
    />
  );
}

function rowFor(key: string) {
  const row = document.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
}

function iconIn(row: HTMLElement) {
  const icon = [...row.querySelectorAll("svg")].find(
    (svg) => !svg.closest("button"),
  );
  if (!icon) throw new Error("no icon in row");
  return icon;
}

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

describe("searchResults", () => {
  it("finds a file in a nested folder and keeps its folders", () => {
    const result = searchResults(
      [
        entry("docs", "directory"),
        entry("docs/reports", "directory"),
        entry("docs/reports/note-30.md"),
        entry("projects", "directory"),
        entry("projects/plan.md"),
      ],
      "NOTE",
    );

    expect(result.entries.map((item) => item.path)).toEqual([
      "docs",
      "docs/reports",
      "docs/reports/note-30.md",
    ]);
    expect([...result.expanded]).toEqual(["docs", "docs/reports"]);
  });

  it("matches nothing when no file carries the word", () => {
    const result = searchResults(
      [entry("docs", "directory"), entry("docs/plan.md")],
      "zzz-no-match",
    );

    expect(result.entries).toEqual([]);
    expect(result.expanded.size).toBe(0);
  });
});

describe("folder tree clicks", () => {
  it("expands a folder from its icon and keeps the open file current", () => {
    render(<Harness open="README.md" />);
    expect(rowFor("README.md").getAttribute("aria-current")).toBe("true");
    expect(document.querySelector('[data-key="media/demo.mp4"]')).toBeNull();

    fireEvent.click(iconIn(rowFor("media")), { detail: 1 });

    expect(rowFor("media").getAttribute("aria-expanded")).toBe("true");
    expect(
      document.querySelector('[data-key="media/demo.mp4"]'),
    ).not.toBeNull();
    expect(rowFor("media").getAttribute("aria-current")).toBeNull();
    expect(rowFor("README.md").getAttribute("aria-current")).toBe("true");
  });

  it("opens a file from its icon", () => {
    render(<Harness open="" />);
    expect(rowFor("README.md").getAttribute("aria-current")).toBeNull();

    fireEvent.click(iconIn(rowFor("README.md")), { detail: 1 });

    expect(rowFor("README.md").getAttribute("aria-current")).toBe("true");
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
