import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationProvider } from "@/app/organization";
import { RouterProvider } from "@/app/router";
import { OverflowMenu } from "@/components/ui/menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DiscussionRow, DiscussionsPage } from "@/features/discussions/list";

vi.mock("@/components/ui/menu", () => ({ OverflowMenu: vi.fn(() => null) }));

afterEach(() => vi.clearAllMocks());

describe("discussions page", () => {
  it("offers search, an archived toggle and the primary action, and nothing else before the list loads", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider
            value={{
              members: [{ id: 1, name: "You", type: "human", state: "idle" }],
              humanId: 1,
              discussions: null,
              refresh: async () => {},
              connectionError: null,
              organizationError: null,
              discussionsError: null,
              retry: async () => {},
            }}
          >
            <DiscussionsPage />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>,
    );
    expect(html).toMatch(/<h1\b[^>]*>Discussions<\/h1>/);
    expect(html).toContain('placeholder="Search messages"');
    expect(html).toContain('aria-label="Show archived"');
    expect(html).toContain('aria-pressed="false"');
    expect(html.match(/New Discussion/g)).toHaveLength(1);
    expect(html).not.toContain("No Discussions yet");
    expect(html).not.toContain("0 Discussions");
    expect(html).not.toContain("Refresh");
    expect(html).not.toContain("Delete");
  });

  it.each([false, true])(
    "offers only archiving for archived=%s",
    (archived) => {
      const onArchive = vi.fn();
      renderToStaticMarkup(
        <DiscussionRow
          item={{
            id: 1,
            topic: "Release",
            member_ids: [],
            archived,
            unread: 0,
          }}
          byId={new Map()}
          onOpen={() => {}}
          onArchive={onArchive}
        />,
      );
      const { actions } = vi.mocked(OverflowMenu).mock.calls[0][0];
      expect(actions.map((action) => action.label)).toEqual([
        archived ? "Unarchive" : "Archive",
      ]);
      actions[0].onSelect();
      expect(onArchive).toHaveBeenCalledOnce();
    },
  );
});
