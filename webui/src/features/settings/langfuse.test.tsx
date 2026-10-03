import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LangfusePanel, langfuseUpdate } from "@/features/settings/langfuse";

const stored = {
  enabled: true,
  base_url: " https://example.invalid/ ",
  keys_set: true,
  environment: "development",
};

describe("Langfuse settings", () => {
  it("omits blank credentials and response-only fields", () => {
    expect(langfuseUpdate(stored, "  ", "")).toEqual({
      enabled: true,
      base_url: "https://example.invalid/",
    });
  });

  it("only replaces credentials that were entered", () => {
    expect(langfuseUpdate(stored, " test-public ", " test-secret ")).toEqual({
      enabled: true,
      base_url: "https://example.invalid/",
      public_key: "test-public",
      secret_key: "test-secret",
    });
    expect(langfuseUpdate(stored, "", "replacement")).not.toHaveProperty(
      "public_key",
    );
  });

  it("shows form placeholders while settings are pending", () => {
    const html = renderToStaticMarkup(<LangfusePanel />);
    expect(html).toContain('aria-label="Loading Langfuse settings"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Restart Fora");
  });
});
