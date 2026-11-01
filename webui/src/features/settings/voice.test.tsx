import {
  act,
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
import { clearToasts, Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VoicePanel } from "@/features/settings/voice";
import { BackendError, backend } from "@/lib/backend";

const voice = vi.hoisted(() => ({
  emitters: [] as ((event: unknown) => void)[],
}));

vi.mock("@/lib/voice", () => ({
  VoiceRecording: class {
    constructor(emit: (event: unknown) => void) {
      voice.emitters.push(emit);
    }
    async start() {}
    stop() {}
    cancel() {}
  },
}));

function renderPanel() {
  return render(
    <TooltipProvider>
      <VoicePanel />
      <Toaster />
    </TooltipProvider>,
  );
}

beforeAll(() => {
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
});

beforeEach(() => {
  clearToasts();
  voice.emitters.length = 0;
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
});

const values = {
  address: "wss://api.openai.com/v1/realtime",
  model: "gpt-realtime",
  api_key_set: true,
};

describe("voice settings", () => {
  it("takes over the content area when the settings cannot be loaded", async () => {
    vi.spyOn(backend, "settings").mockRejectedValue(
      new BackendError(
        "storage_read_failed",
        "The voice settings are unreadable",
      ),
    );
    const { container } = renderPanel();

    expect(
      await screen.findByText(/The voice settings are unreadable/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByText("Could not save the voice settings")).toBeNull();
  });

  it("reports a refused save as a toast without an inline alert", async () => {
    vi.spyOn(backend, "settings").mockResolvedValue(values);
    vi.spyOn(backend, "updateSettings").mockRejectedValue(
      new BackendError("invalid_address", "That address is not reachable"),
    );
    const { container } = renderPanel();

    fireEvent.change(await screen.findByLabelText("Service address"), {
      target: { value: "wss://example.test/v1/realtime" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Could not save the voice settings"),
    ).toBeTruthy();
    expect(screen.getByText("That address is not reachable")).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a repeated save failure to a single toast", async () => {
    vi.spyOn(backend, "settings").mockResolvedValue(values);
    const update = vi
      .spyOn(backend, "updateSettings")
      .mockRejectedValue(
        new BackendError("invalid_address", "That address is not reachable"),
      );
    renderPanel();

    fireEvent.change(await screen.findByLabelText("Service address"), {
      target: { value: "wss://example.test/v1/realtime" },
    });
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    await screen.findByText("Could not save the voice settings");
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));

    expect(
      screen.getAllByText("Could not save the voice settings"),
    ).toHaveLength(1);
  });

  it("keeps a repeated microphone failure to a single toast", async () => {
    vi.spyOn(backend, "settings").mockResolvedValue(values);
    renderPanel();

    const start = await screen.findByRole("button", {
      name: "Start microphone test",
    });
    fireEvent.click(start);
    act(() => {
      voice.emitters[voice.emitters.length - 1]?.({
        type: "error",
        message: "The microphone is blocked",
      });
    });
    await screen.findByText("Could not test the microphone");
    fireEvent.click(start);
    act(() => {
      voice.emitters[voice.emitters.length - 1]?.({
        type: "error",
        message: "The microphone is blocked",
      });
    });
    await waitFor(() => expect(voice.emitters).toHaveLength(2));

    expect(screen.getAllByText("Could not test the microphone")).toHaveLength(
      1,
    );
  });
});
