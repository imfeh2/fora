import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RouterProvider } from "@/app/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModelPanel } from "@/features/settings/model";
import { backend, type ModelCatalog } from "@/lib/backend";

const KEY = "sk-test-deepseek";

const catalog: ModelCatalog = {
  version: 2,
  providers: [
    {
      id: "deepseek",
      name: "DeepSeek",
      api_type: "openai-chat",
      base_url: "https://api.deepseek.com",
      api_key: KEY,
      api_key_set: true,
      enabled: true,
    },
  ],
  models: [],
  default_model_id: null,
  default_thinking: "default",
  agent_configs: {},
};

function renderPanel() {
  return render(
    <TooltipProvider>
      <RouterProvider>
        <ModelPanel view="providers" />
      </RouterProvider>
    </TooltipProvider>,
  );
}

async function openProvider(container: HTMLElement): Promise<void> {
  const row = await waitFor(() => {
    const target = container.querySelector<HTMLButtonElement>(
      "[data-provider-target]",
    );
    if (target === null) throw new Error("provider row is missing");
    return target;
  });
  fireEvent.click(row);
}

beforeAll(() => {
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.spyOn(backend, "onEvent").mockReturnValue(() => {});
});

describe("provider key", () => {
  it("prefills the stored key and drops the hidden-key controls", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalog);
    const { container } = renderPanel();
    await openProvider(container);
    const input = (await waitFor(() =>
      screen.getByLabelText("API key"),
    )) as HTMLInputElement;
    expect(input.value).toBe(KEY);
    expect(input.type).toBe("password");
    expect(container.textContent).not.toContain("Key stored");
    expect(container.textContent).not.toContain("Clear stored key");
    expect(container.textContent).not.toContain("Leave blank");
    const footer = container.querySelector(".provider-form .dialog-actions");
    expect(footer).not.toBeNull();
    expect(
      within(footer as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["Cancel", "Save"]);
  });

  it("reveals the key only after the eye button is pressed", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalog);
    const { container } = renderPanel();
    await openProvider(container);
    const input = (await waitFor(() =>
      screen.getByLabelText("API key"),
    )) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show API key" }));
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide API key" }));
    expect(input.type).toBe("password");
  });

  it("saves an emptied field as an empty key", async () => {
    vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalog);
    const configure = vi.spyOn(backend, "configureModel").mockResolvedValue({
      ...catalog,
      providers: [{ ...catalog.providers[0], api_key: "", api_key_set: false }],
    });
    const { container } = renderPanel();
    await openProvider(container);
    const input = (await waitFor(() =>
      screen.getByLabelText("API key"),
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(configure).toHaveBeenCalled());
    const call = configure.mock.calls[0];
    expect(call[0]).toBe("save_provider");
    expect(call[1]).toBe("deepseek");
    expect(call[2]).toMatchObject({ api_key: "" });
    expect(call[2]).not.toHaveProperty("clear_key");
  });
});
