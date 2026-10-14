import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Organization } from "@/app/organization";
import type { DiscussionSummary, FoundMessage, Member } from "@/lib/backend";

vi.mock("@/features/discussions/create", () => ({
  CreateDiscussionDialog: () => null,
}));

let cleanup: typeof import("@testing-library/react").cleanup;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let waitFor: typeof import("@testing-library/react").waitFor;
let within: typeof import("@testing-library/react").within;
let DiscussionsPage: typeof import("@/features/discussions/list").DiscussionsPage;
let DiscussionCard: typeof import("@/features/discussions/list").DiscussionCard;
let OrganizationProvider: typeof import("@/app/organization").OrganizationProvider;
let RouterProvider: typeof import("@/app/router").RouterProvider;
let useRouter: typeof import("@/app/router").useRouter;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let backend: typeof import("@/lib/backend").backend;
let BackendError: typeof import("@/lib/backend").BackendError;
let closeDom: () => void;

const longTopic = "讨论名称需要完整呈现".repeat(12);
const longName = "MemberWithoutSpaces".repeat(12);
const people: Member[] = [
  { id: 1, name: "You", type: "human", state: "idle" },
  { id: 2, name: longName, type: "agent", state: "idle" },
  { id: 3, name: "中文成员名称".repeat(16), type: "agent", state: "idle" },
  { id: 4, name: "Fourth", type: "human", state: "idle" },
];
const discussions: DiscussionSummary[] = [
  {
    id: 7,
    topic: longTopic,
    member_ids: [1, 2, 3, 4],
    archived: false,
    unread: 32,
  },
  {
    id: 3,
    topic: "UnbrokenTopic".repeat(16),
    member_ids: [2],
    archived: true,
    unread: 12,
  },
  {
    id: 9,
    topic: "Latest discussion",
    member_ids: [],
    archived: false,
    unread: 0,
  },
];
const found: FoundMessage[] = [
  {
    id: 11,
    discussion_id: 3,
    sender_name: longName,
    body: `A matching message ${"UnbrokenBody".repeat(16)}`,
    mentions: [],
  },
];

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  closeDom = () => dom.window.close();
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal(
    "getComputedStyle",
    dom.window.getComputedStyle.bind(dom.window),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ({ cleanup, fireEvent, render, act, waitFor, within } = await import(
    "@testing-library/react"
  ));
  ({ DiscussionsPage, DiscussionCard } = await import(
    "@/features/discussions/list"
  ));
  ({ OrganizationProvider } = await import("@/app/organization"));
  ({ RouterProvider, useRouter } = await import("@/app/router"));
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
  ({ backend, BackendError } = await import("@/lib/backend"));
}, 30000);

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    members: people,
    humanId: 1,
    discussions,
    refresh: vi.fn(async () => {}),
    connectionError: null,
    organizationError: null,
    discussionsError: null,
    retry: vi.fn(async () => {}),
    ...overrides,
  };
}

function RouteProbe() {
  const { route } = useRouter();
  return <output aria-label="Current route">{JSON.stringify(route)}</output>;
}

function view(value: Organization) {
  return (
    <TooltipProvider>
      <RouterProvider>
        <OrganizationProvider value={value}>
          <DiscussionsPage />
          <RouteProbe />
        </OrganizationProvider>
      </RouterProvider>
    </TooltipProvider>
  );
}

function wrap(children: ReactNode) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setWidth(375);
  vi.spyOn(backend, "onEvent").mockReturnValue(vi.fn());
  vi.spyOn(backend, "discussions").mockResolvedValue(discussions);
  vi.spyOn(backend, "searchMessages").mockResolvedValue(found);
  vi.spyOn(backend, "archiveDiscussion").mockResolvedValue({ id: 7 });
});

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

describe("discussion list viewport branches", () => {
  it.each([375, 639, 640, 641])(
    "keeps loading, ready, archive and search branches at %ipx",
    async (width) => {
      setWidth(width);
      const narrow = width <= 640;
      const value = organization({ discussions: null });
      const page = render(view(value));
      const loading = page.getByRole("region", { name: "Loading Discussions" });
      expect(loading.getAttribute("aria-busy")).toBe("true");
      expect(loading.querySelector('[role="status"]')?.textContent).toBe(
        "Loading Discussions",
      );
      expect(loading.querySelectorAll("button")).toHaveLength(0);
      expect(loading.querySelectorAll("table")).toHaveLength(narrow ? 0 : 1);
      if (narrow) {
        const placeholders = loading.querySelector(
          '[aria-hidden="true"]',
        )?.firstElementChild;
        expect(placeholders?.children).toHaveLength(3);
      } else {
        expect(loading.querySelectorAll("tbody tr")).toHaveLength(3);
      }

      page.rerender(view(organization()));
      expect(
        page.queryByRole("region", { name: "Loading Discussions" }),
      ).toBeNull();
      expect(page.container.querySelectorAll("table")).toHaveLength(
        narrow ? 0 : 1,
      );
      const content = narrow
        ? page.getByRole("feed", { name: "Discussions" })
        : page.getByRole("table", { name: "Discussions" });
      const topics = Array.from(content.querySelectorAll("button")).filter(
        (button) => !button.hasAttribute("aria-haspopup"),
      );
      expect(topics.map((button) => button.textContent)).toEqual(
        discussions.map((item) => item.topic),
      );
      expect(content.textContent).toContain(longName);
      expect(content.textContent).toContain(people[2].name);
      expect(content.textContent).toContain("+1");
      expect(content.textContent).toContain("32");
      expect(content.textContent).toContain("Archived");

      const archive = deferred<DiscussionSummary[]>();
      vi.mocked(backend.discussions).mockReturnValueOnce(archive.promise);
      fireEvent.click(page.getByRole("button", { name: "Show archived" }));
      await waitFor(() =>
        expect(backend.discussions).toHaveBeenCalledWith(true),
      );
      expect(
        page
          .getByRole("button", { name: "Show archived" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        page
          .getByRole("region", { name: "Loading Discussions" })
          .querySelectorAll("table"),
      ).toHaveLength(narrow ? 0 : 1);
      await act(async () => archive.resolve([discussions[1]]));
      expect(page.container.querySelectorAll("table")).toHaveLength(
        narrow ? 0 : 1,
      );
      fireEvent.click(
        page.getByRole("button", {
          name: `Actions for ${discussions[1].topic}`,
        }),
      );
      const unarchive = page.getByRole("menuitem", { name: "Unarchive" });
      fireEvent.click(unarchive);
      await waitFor(() =>
        expect(backend.archiveDiscussion).toHaveBeenCalledWith(3, false),
      );

      fireEvent.change(
        page.getByRole("searchbox", { name: "Search messages" }),
        { target: { value: "matching" } },
      );
      await waitFor(() =>
        expect(backend.searchMessages).toHaveBeenCalledWith("matching"),
      );
      await waitFor(() =>
        expect(page.container.textContent).toContain(found[0].body),
      );
      expect(page.container.querySelectorAll("table")).toHaveLength(
        narrow ? 0 : 1,
      );
      const results = narrow
        ? page.getByRole("feed", { name: "Search results" })
        : page.getByRole("table", { name: "Search results" });
      expect(results.querySelector("mark")?.textContent).toBe("matching");
      expect(results.textContent).toContain(longName);
      expect(results.textContent).toContain(discussions[1].topic);
      const message = within(results).getByRole("button", { name: /matching/ });
      expect(message.textContent).toBe(found[0].body);
      fireEvent.click(message);
      expect(page.getByLabelText("Current route").textContent).toBe(
        '{"name":"discussion","id":3}',
      );
    },
  );

  it("uses the same viewport snapshot while preserving loaded search and archive state", async () => {
    setWidth(641);
    const page = render(view(organization()));
    fireEvent.click(page.getByRole("button", { name: "Show archived" }));
    await waitFor(() => expect(backend.discussions).toHaveBeenCalledWith(true));
    fireEvent.change(page.getByRole("searchbox", { name: "Search messages" }), {
      target: { value: "matching" },
    });
    await waitFor(() =>
      expect(page.container.querySelector("mark")).not.toBeNull(),
    );
    const searchCalls = vi.mocked(backend.searchMessages).mock.calls.length;
    const archiveCalls = vi.mocked(backend.discussions).mock.calls.length;
    expect(page.getByRole("table", { name: "Search results" })).toBeDefined();
    for (const width of [640, 375, 639, 641]) {
      await act(async () => {
        setWidth(width);
        window.dispatchEvent(new Event("resize"));
      });
      expect(page.container.querySelectorAll("table")).toHaveLength(
        width <= 640 ? 0 : 1,
      );
      expect(page.getByRole("searchbox").getAttribute("value")).toBe(
        "matching",
      );
      expect(
        page
          .getByRole("button", { name: "Show archived" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    }
    expect(backend.searchMessages).toHaveBeenCalledTimes(searchCalls);
    expect(backend.discussions).toHaveBeenCalledTimes(archiveCalls);
  });

  it("changes a pending list between cards and table without adding loading controls", async () => {
    const page = render(view(organization({ discussions: null })));
    for (const width of [641, 640, 639, 375]) {
      await act(async () => {
        setWidth(width);
        window.dispatchEvent(new Event("resize"));
      });
      const loading = page.getByRole("region", { name: "Loading Discussions" });
      expect(loading.querySelectorAll("table")).toHaveLength(
        width <= 640 ? 0 : 1,
      );
      expect(loading.querySelectorAll("button")).toHaveLength(0);
      expect(loading.getAttribute("aria-busy")).toBe("true");
    }
  });
});

it("keeps empty and failure states in their original regions and preserves retry", () => {
  const retry = vi.fn(async () => {});
  const page = render(view(organization({ discussions: [] })));
  expect(page.getByText("No Discussions yet")).toBeDefined();
  expect(page.container.querySelector("table")).toBeNull();
  page.rerender(
    view(
      organization({
        discussions: null,
        discussionsError: new BackendError(
          "request_failed",
          "List unavailable",
        ),
        retry,
      }),
    ),
  );
  expect(
    page.queryByRole("region", { name: "Loading Discussions" }),
  ).toBeNull();
  expect(page.getByText("List unavailable")).toBeDefined();
  fireEvent.click(page.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledWith("discussions");
  page.rerender(
    view(
      organization({
        discussions: null,
        connectionError: new BackendError(
          "connection_closed",
          "Connection unavailable",
        ),
      }),
    ),
  );
  expect(
    page.queryByRole("region", { name: "Loading Discussions" }),
  ).toBeNull();
  expect(page.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("keeps topic navigation separate from the original archive action and disabled state", () => {
  const onOpen = vi.fn();
  const onArchive = vi.fn();
  const item = discussions[0];
  const page = render(
    wrap(
      <DiscussionCard
        item={item}
        byId={new Map(people.map((person) => [person.id, person]))}
        onOpen={onOpen}
        onArchive={onArchive}
        archiveBusy
      />,
    ),
  );
  const topic = page.getByRole("button", { name: item.topic });
  const actions = page.getByRole("button", {
    name: `Actions for ${item.topic}`,
  });
  expect(topic.contains(actions)).toBe(false);
  expect(actions.contains(topic)).toBe(false);
  fireEvent.click(topic);
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onArchive).not.toHaveBeenCalled();
  fireEvent.click(actions);
  expect(onOpen).toHaveBeenCalledOnce();
  const disabled = page.getByRole("menuitem", {
    name: "Archive",
  }) as HTMLButtonElement;
  expect(disabled.disabled).toBe(true);
  page.rerender(
    wrap(
      <DiscussionCard
        item={item}
        byId={null}
        onOpen={onOpen}
        onArchive={onArchive}
      />,
    ),
  );
  const enabled = page.getByRole("menuitem", {
    name: "Archive",
  }) as HTMLButtonElement;
  expect(enabled.disabled).toBe(false);
  fireEvent.click(enabled);
  expect(onArchive).toHaveBeenCalledOnce();
  expect(onOpen).toHaveBeenCalledOnce();
});
