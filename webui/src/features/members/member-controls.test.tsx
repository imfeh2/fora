import { StrictMode, useState } from "react";
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
import { OrganizationProvider } from "@/app/organization";
import { RouterProvider, useRouter } from "@/app/router";
import {
  type AgentDetail,
  backend,
  type Member,
  type ModelCatalog,
} from "@/lib/backend";

let testing: typeof import("@testing-library/react");
let screen: typeof testing.screen;
let fireEvent: typeof testing.fireEvent;
let act: typeof testing.act;
let render: typeof testing.render;
let closeDom: () => void;
let TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
let MemberPage: typeof import("@/features/members/detail").MemberPage;
let MemberRow: typeof import("@/features/members/list").MemberRow;
let MembersPage: typeof import("@/features/members/list").MembersPage;
let Toaster: typeof import("@/components/ui/toast").Toaster;
let clearToasts: typeof import("@/components/ui/toast").clearToasts;
let AgentModelDialog: typeof import("@/features/settings/model").AgentModelDialog;

beforeAll(async () => {
  const packageName = "jsdom";
  const { JSDOM } = await import(packageName);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  closeDom = () => dom.window.close();
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "getComputedStyle",
  ])
    vi.stubGlobal(name, name === "window" ? dom.window : dom.window[name]);
  vi.stubGlobal(
    "requestAnimationFrame",
    dom.window.requestAnimationFrame.bind(dom.window),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    dom.window.cancelAnimationFrame.bind(dom.window),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  testing = await import("@testing-library/react");
  ({ screen, fireEvent, act, render } = testing);
  ({ TooltipProvider } = await import("@/components/ui/tooltip"));
  ({ Toaster, clearToasts } = await import("@/components/ui/toast"));
  ({ MemberPage } = await import("@/features/members/detail"));
  ({ MemberRow, MembersPage } = await import("@/features/members/list"));
  ({ AgentModelDialog } = await import("@/features/settings/model"));
});

const catalog: ModelCatalog = {
  version: 2,
  providers: [],
  models: [],
  default_model_id: null,
  default_thinking: "default",
  agent_configs: { "2": { model_id: null, thinking: "high" } },
};
const detail: AgentDetail = {
  id: 2,
  workspace: [],
  runs: [],
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    cache_read_tokens: 0,
    requests: 1,
  },
  token_limit: 0,
  over_token_limit: false,
  idle: false,
  idle_streak: 0,
  no_tool_streak: 0,
  pause_reason: null,
  window: { number: 1, since_sequence: 0, reset_at: null, reason: null },
};

beforeEach(() => {
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
  vi.spyOn(backend, "agentDetail").mockResolvedValue(detail);
  vi.spyOn(backend, "agentHistoryWindows").mockResolvedValue({
    agent_id: 2,
    current_window_number: 1,
    windows: [
      {
        number: 1,
        since_sequence: 1,
        started_at: null,
        start_reason: null,
        ended_at: null,
        end_reason: null,
        is_current: true,
      },
    ],
    has_unassigned: false,
    has_before: false,
    next_before: null,
  });
  vi.spyOn(backend, "agentHistory").mockResolvedValue({
    agent_id: 2,
    window_number: 1,
    runs: [],
    windows: [],
    has_before: false,
    next_before: null,
    windows_has_more: false,
    windows_next_after: null,
  });
});

afterEach(async () => {
  testing.cleanup();
  clearToasts();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  vi.restoreAllMocks();
});
afterAll(() => {
  closeDom();
  vi.unstubAllGlobals();
});

const renamedMember: Member = {
  id: 2,
  name: "Edited Helper",
  type: "agent",
  state: "idle",
};
type RenameLocation = "human" | "agent" | "detail";
function mountRename(location: RenameLocation, refresh = async () => {}) {
  render(
    <TooltipProvider>
      <RouterProvider>
        <OrganizationProvider
          value={{
            members: [
              {
                id: 2,
                name: "Helper",
                type: location === "human" ? "human" : "agent",
                state: "idle",
              },
            ],
            humanId: 1,
            discussions: [],
            connectionError: null,
            organizationError: null,
            discussionsError: null,
            retry: async () => {},
            refresh,
          }}
        >
          {location === "detail" ? (
            <MemberPage id={2} />
          ) : (
            <MembersPage tokenLimit={0} />
          )}
          <Toaster />
        </OrganizationProvider>
      </RouterProvider>
    </TooltipProvider>,
  );
  const opener = screen.getByRole("button", {
    name: location === "human" ? "Helper" : "Actions for Helper",
  });
  opener.focus();
  fireEvent.click(opener);
  if (location !== "human")
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  return opener;
}
let navigate: ReturnType<typeof useRouter>["navigate"];
function ModelHarness() {
  const router = useRouter();
  navigate = router.navigate;
  const [open, setOpen] = useState(false);
  return (
    <>
      <output data-testid="route">{router.route.name}</output>
      <button type="button" onClick={() => setOpen(true)}>
        Edit model
      </button>
      {open ? (
        <AgentModelDialog agentId={2} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
function mountModel() {
  vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalog);
  return render(
    <StrictMode>
      <TooltipProvider>
        <RouterProvider>
          <ModelHarness />
        </RouterProvider>
      </TooltipProvider>
    </StrictMode>,
  );
}

describe("Member controls", () => {
  it.each(["human", "agent", "detail"] as const)(
    "protects %s rename drafts on all close paths and returns focus",
    async (location) => {
      const save = vi
        .spyOn(backend, "renameMember")
        .mockResolvedValue(renamedMember);
      const opener = mountRename(location);
      const input = (await screen.findByRole("textbox", {
        name: "Name",
      })) as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: "Edited Helper" } });
      for (const [path, close] of [
        [
          "Cancel",
          () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
        ],
        [
          "Close",
          () => fireEvent.click(screen.getByRole("button", { name: "Close" })),
        ],
        ["Escape", () => fireEvent.keyDown(input, { key: "Escape" })],
        [
          "Overlay",
          () => {
            fireEvent.pointerDown(document.body, {
              button: 0,
              pointerType: "mouse",
            });
            fireEvent.click(document.body);
          },
        ],
      ] as const) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        close();
        await testing.waitFor(() =>
          expect(
            screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
            path,
          ).toBeTruthy(),
        );
        fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
        await testing.waitFor(() => expect(document.activeElement).toBe(input));
        expect(input.value).toBe("Edited Helper");
        expect(save).not.toHaveBeenCalled();
      }
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
      await testing.waitFor(() =>
        expect(screen.queryByRole("dialog")).toBeNull(),
      );
      expect(document.activeElement).toBe(opener);
      fireEvent.click(opener);
      if (location !== "human")
        fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
      const reopened = (await screen.findByRole("textbox", {
        name: "Name",
      })) as HTMLInputElement;
      expect(reopened.value).toBe("Helper");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(
        screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
      ).toBeNull();
    },
  );
  it.each(["human", "agent", "detail"] as const)(
    "keeps %s rename drafts and focus while saving and after failure",
    async (location) => {
      let rejectSave!: (error: Error) => void;
      const pending = new Promise<Member>((_resolve, reject) => {
        rejectSave = reject;
      });
      const save = vi
        .spyOn(backend, "renameMember")
        .mockReturnValueOnce(pending);
      const opener = mountRename(location);
      const input = (await screen.findByRole("textbox", {
        name: "Name",
      })) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Edited Helper" } });
      const submit = screen.getByRole("button", { name: "Rename" });
      fireEvent.click(submit);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(save).toHaveBeenCalledOnce();
      expect(input.readOnly).toBe(true);
      expect(document.activeElement).toBe(input);
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      fireEvent.keyDown(input, { key: "Escape" });
      expect(
        screen.getByRole("dialog", { name: "Rename Member" }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
      ).toBeNull();
      await act(async () => rejectSave(new Error("Rename failed")));
      expect(input.value).toBe("Edited Helper");
      expect(input.readOnly).toBe(false);
      await testing.waitFor(() => expect(document.activeElement).toBe(input));
      expect(await screen.findByText("Rename failed")).toBeTruthy();
      save.mockResolvedValue(renamedMember);
      await act(async () => fireEvent.click(submit));
      expect(save).toHaveBeenLastCalledWith(2, "Edited Helper");
      expect(save).toHaveBeenCalledTimes(2);
      await testing.waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Rename Member" }),
        ).toBeNull(),
      );
      expect(document.activeElement).toBe(opener);
    },
  );
  it("keeps the rename window through organization refresh and retains the draft on refresh failure", async () => {
    let rejectRefresh!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const refresh = vi.fn().mockReturnValueOnce(pending);
    vi.spyOn(backend, "renameMember").mockResolvedValue(renamedMember);
    mountRename("human", refresh);
    const input = (await screen.findByRole("textbox", {
      name: "Name",
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Edited Helper" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await testing.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Rename Member" })).toBeTruthy();
    expect(input.readOnly).toBe(true);
    await act(async () => rejectRefresh(new Error("Refresh failed")));
    expect(input.value).toBe("Edited Helper");
    expect(input.readOnly).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeTruthy();
  });
  it("keeps row actions independent from navigation and limits Human actions", () => {
    const open = vi.fn();
    const rename = vi.fn();
    const toggle = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <ul>
          <MemberRow
            member={{ id: 2, name: "Helper", type: "agent", state: "running" }}
            tokenLimit={0}
            onOpen={open}
            onRename={rename}
            onToggle={toggle}
            onDelete={() => {}}
          />
        </ul>
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(toggle).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Helper" }));
    expect(open).toHaveBeenCalledOnce();
    rerender(
      <TooltipProvider>
        <ul>
          <MemberRow
            member={{ id: 1, name: "You", type: "human", state: "idle" }}
            tokenLimit={0}
            onOpen={open}
            onRename={rename}
            onToggle={toggle}
            onDelete={() => {}}
          />
        </ul>
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "You" }));
    expect(rename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });
  it("keeps context statistics behind the inspector and retries detail reads with the member identity", async () => {
    vi.mocked(backend.agentDetail)
      .mockRejectedValueOnce(new Error("Read failed"))
      .mockResolvedValue(detail);
    render(
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider
            value={{
              members: [
                { id: 2, name: "Helper", type: "agent", state: "idle" },
              ],
              humanId: 1,
              discussions: [],
              connectionError: null,
              organizationError: null,
              discussionsError: null,
              retry: async () => {},
              refresh: async () => {},
            }}
          >
            <MemberPage id={2} />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Helper" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No activity yet")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Token spend")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect context" }));
    expect(await screen.findByText("Token spend")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Full context" })).toBeTruthy();
  });
  it("preserves model edits on close and navigation until explicitly discarded", async () => {
    mountModel();
    const opener = screen.getByRole("button", { name: "Edit model" });
    opener.focus();
    fireEvent.click(opener);
    const thinking = await screen.findByRole("combobox", {
      name: "Thinking effort",
    });
    fireEvent.change(thinking, { target: { value: "low" } });
    await act(async () => navigate({ name: "discussions" }));
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
    await act(async () => navigate({ name: "members" }));
    expect(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
    expect((thinking as HTMLSelectElement).value).toBe("low");
    expect(screen.getByTestId("route").textContent).toBe("discussions");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
    await act(async () => navigate({ name: "members" }));
    await act(async () => navigate({ name: "library" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByTestId("route").textContent).toBe("members");
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => navigate({ name: "library" }));
    expect(screen.getByTestId("route").textContent).toBe("library");
  });
  it("blocks navigation while saving, retains a failed draft and allows navigation after saving", async () => {
    let rejectSave!: (error: Error) => void;
    const pending = new Promise<ModelCatalog>((_resolve, reject) => {
      rejectSave = reject;
    });
    const save = vi
      .spyOn(backend, "configureModel")
      .mockReturnValueOnce(pending);
    mountModel();
    fireEvent.click(screen.getByRole("button", { name: "Edit model" }));
    const thinking = await screen.findByRole("combobox", {
      name: "Thinking effort",
    });
    fireEvent.change(thinking, { target: { value: "low" } });
    const submit = screen.getByRole("button", { name: "Save model settings" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(save).toHaveBeenCalledOnce();
    await act(async () => navigate({ name: "member", id: 3 }));
    expect(screen.getByTestId("route").textContent).toBe("discussions");
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
    await act(async () => rejectSave(new Error("Save failed")));
    expect((thinking as HTMLSelectElement).value).toBe("low");
    await act(async () => navigate({ name: "member", id: 3 }));
    expect(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
    save.mockResolvedValue({
      ...catalog,
      agent_configs: { "2": { model_id: null, thinking: "low" } },
    });
    await act(async () => fireEvent.click(submit));
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => navigate({ name: "members" }));
    expect(screen.getByTestId("route").textContent).toBe("members");
    expect(
      screen.queryByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeNull();
  });
  it("shows a local model Retry and keeps controls unavailable until catalog data arrives", async () => {
    mountModel();
    const read = vi
      .mocked(backend.modelCatalog)
      .mockRejectedValue(new Error("Catalog failed"));
    fireEvent.click(screen.getByRole("button", { name: "Edit model" }));
    expect(await screen.findByText("Catalog failed")).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Thinking effort" }),
    ).toBeNull();
    read.mockResolvedValue(catalog);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("combobox", { name: "Thinking effort" }),
    ).toBeTruthy();
    expect(screen.queryByText("Catalog failed")).toBeNull();
  });
});
