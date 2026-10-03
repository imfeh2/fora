import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@/app/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DocumentPage,
  DocumentUnavailable,
  documentCrumbs,
} from "@/features/library/document";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});

afterEach(() => vi.clearAllMocks());

function render(path: string) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <RouterProvider>
        <DocumentPage path={path} />
      </RouterProvider>
    </TooltipProvider>,
  );
}

describe("document hierarchy", () => {
  it("renders the full hierarchy with a non-clickable final segment", () => {
    const html = render("runbooks/on-call/notes.md");
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain(">Library</button>");
    expect(html).toContain(">runbooks</button>");
    expect(html).toContain(">on-call</button>");
    expect(html).toContain('<span aria-current="page">notes.md</span>');
    expect(html.match(/›/g)).toHaveLength(3);
    expect(html).not.toContain(">runbooks/on-call</span>");
  });

  it("navigates to the root or the selected folder's full path", () => {
    const navigate = vi.fn();
    const crumbs = documentCrumbs("runbooks/on-call/notes.md", navigate);
    for (const crumb of crumbs.slice(0, -1)) crumb.onSelect();
    expect(navigate.mock.calls).toEqual([
      [{ name: "library" }],
      [{ name: "library", path: "runbooks" }],
      [{ name: "library", path: "runbooks/on-call" }],
    ]);
  });

  it("keeps Library clickable while root document content loads", () => {
    const html = render("notes.md");
    expect(html).toContain(">Library</button>");
    expect(html.match(/›/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Loading document"');
    expect(html).not.toContain("<textarea");
  });
});

describe("document read failures", () => {
  it.each(["not_found", "not_readable"] as const)(
    "keeps the return path and removes the editor after %s",
    (code) => {
      function FailedDocument() {
        vi.mocked(useState)
          .mockReturnValueOnce([null, vi.fn()])
          .mockReturnValueOnce(["", vi.fn()])
          .mockReturnValueOnce([code, vi.fn()]);
        return <DocumentPage path="assets/image.png" />;
      }
      const html = renderToStaticMarkup(
        <TooltipProvider>
          <RouterProvider>
            <FailedDocument />
          </RouterProvider>
        </TooltipProvider>,
      );
      expect(html).toContain('aria-label="Breadcrumb"');
      expect(html).toContain(">Library</button>");
      expect(html).toContain(">assets</button>");
      expect(html).toContain('<span aria-current="page">image.png</span>');
      expect(html).toContain(
        code === "not_readable"
          ? "Cannot read this file as UTF-8 text"
          : "Document not found",
      );
      expect(html).not.toContain("textarea");
      expect(html).not.toContain(">Save</button>");
    },
  );

  it("shows only the not_readable title", () => {
    const html = renderToStaticMarkup(
      <DocumentUnavailable code="not_readable" />,
    );
    expect(html).toContain("<h3>Cannot read this file as UTF-8 text</h3>");
    expect(html).not.toContain("<p");
    expect(html).not.toContain("textarea");
  });

  it("preserves the missing document state", () => {
    expect(
      renderToStaticMarkup(<DocumentUnavailable code="not_found" />),
    ).toContain("Document not found");
  });
});
