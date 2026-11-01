import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OrganizationProvider } from "@/app/organization";
import { RouterProvider } from "@/app/router";
import { clearToasts, Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MembersPage } from "@/features/members/list";
import { BackendError, backend, type Member } from "@/lib/backend";

const agent: Member = {
  id: 3,
  type: "agent",
  name: "Worker",
  state: "idle",
};

async function renderPage(): Promise<HTMLElement> {
  const refresh = vi.fn(async () => {});
  const { container } = render(
    <TooltipProvider>
      <RouterProvider>
        <OrganizationProvider
          value={{
            members: [agent],
            humanId: 1,
            discussions: null,
            refresh,
            connectionError: null,
            organizationError: null,
            discussionsError: null,
            retry: async () => {},
          }}
        >
          <MembersPage />
          <Toaster />
        </OrganizationProvider>
      </RouterProvider>
    </TooltipProvider>,
  );
  await screen.findByText("Worker");
  return container;
}

beforeAll(() => {
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
});

beforeEach(() => {
  clearToasts();
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
});

describe("member actions", () => {
  it("reports a refused pause as a toast instead of text under the row", async () => {
    vi.spyOn(backend, "pauseAgent").mockRejectedValue(
      new BackendError("busy", "The Agent is finishing a turn"),
    );
    const container = await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByText("Could not pause the Agent")).toBeTruthy();
    expect(screen.getByText("The Agent is finishing a turn")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a refused resume as a toast", async () => {
    vi.spyOn(backend, "resumeAgent").mockRejectedValue(
      new BackendError("not_found", "The Agent no longer exists"),
    );
    const paused: Member = { ...agent, state: "paused" };
    const { container } = render(
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider
            value={{
              members: [paused],
              humanId: 1,
              discussions: null,
              refresh: async () => {},
              connectionError: null,
              organizationError: null,
              discussionsError: null,
              retry: async () => {},
            }}
          >
            <MembersPage />
            <Toaster />
          </OrganizationProvider>
        </RouterProvider>
      </TooltipProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));

    expect(await screen.findByText("Could not resume the Agent")).toBeTruthy();
    expect(screen.getByText("The Agent no longer exists")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a repeated pause failure to a single toast", async () => {
    const pause = vi
      .spyOn(backend, "pauseAgent")
      .mockRejectedValue(
        new BackendError("busy", "The Agent is finishing a turn"),
      );
    await renderPage();

    const button = screen.getByRole("button", { name: "Pause" });
    fireEvent.click(button);
    await screen.findByText("Could not pause the Agent");
    fireEvent.click(button);
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(2));

    expect(screen.getAllByText("Could not pause the Agent")).toHaveLength(1);
  });
});
