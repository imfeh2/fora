import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouterProvider } from "@/app/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ModelPanel,
  ModelSelection,
  modelTestDescription,
} from "@/features/settings/model";

import type { ModelCatalog } from "@/lib/backend";

const catalog: ModelCatalog = {
  version: 2,
  providers: [
    {
      id: "p",
      name: "Provider",
      api_type: "google",
      base_url: "https://example.invalid",
      api_key_set: true,
      enabled: true,
    },
  ],
  models: [
    {
      id: "m",
      provider_id: "p",
      name: "Model",
      model: "gemini-3-pro-preview",
      enabled: true,
      thinking_budget_tokens: null,
      thinking_options: [
        "default",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
    },
  ],
  default_model_id: "m",
  default_thinking: "high",
  agent_configs: {},
};

describe("Model settings", () => {
  it("shows inherited model and supported thinking choices", () => {
    const html = renderToStaticMarkup(
      <ModelSelection
        catalog={catalog}
        value={{ model_id: null, thinking: null }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Use global default (high)");
    expect(html).toContain("Provider / Model");
    expect(html).toContain('<option value="default">default</option>');
    expect(html).toContain('<option value="xhigh">xhigh</option>');
    expect(html).toContain('<option value="max">max</option>');
  });

  it("shows the configured token count for a budget choice", () => {
    const budgetCatalog: ModelCatalog = {
      ...catalog,
      models: [
        {
          ...catalog.models[0],
          thinking_budget_tokens: 12000,
          thinking_options: [...catalog.models[0].thinking_options, "budget"],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <ModelSelection
        catalog={budgetCatalog}
        value={{ model_id: "m", thinking: "budget" }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      '<option value="budget" selected="">budget · 12000 tokens</option>',
    );
  });

  it("keeps any explicit effort visible for correction", () => {
    const html = renderToStaticMarkup(
      <ModelSelection
        catalog={catalog}
        value={{ model_id: "m", thinking: "medium" }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      '<option value="medium" selected="">medium</option>',
    );
  });

  it("explains missing configuration", () => {
    const html = renderToStaticMarkup(
      <ModelSelection
        catalog={{ ...catalog, default_model_id: null }}
        value={{ model_id: null, thinking: null }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("No model selected");
  });

  it("formats the reply as one line capped at 80 characters", () => {
    expect(modelTestDescription(1250, " \n Hello\r\n   world\t ")).toBe(
      "1,250 ms · Hello world",
    );
    expect(modelTestDescription(8, ` ${"a".repeat(100)} `)).toBe(
      `8 ms · ${"a".repeat(80)}`,
    );
  });

  it("disables configuration before loading", () => {
    const html = renderToStaticMarkup(
      <RouterProvider>
        <TooltipProvider>
          <ModelPanel />
        </TooltipProvider>
      </RouterProvider>,
    );
    expect(html).toContain('aria-label="Model settings"');
    expect(html).not.toContain('aria-label="API address"');
    expect(html).toContain("Loading model settings");
  });
});
