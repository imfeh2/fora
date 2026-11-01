import { describe, expect, it } from "vitest";
import { agentUpdate } from "@/features/settings/agent";

const VALID: Record<string, string> = {
  context_window_tokens: "40000",
  context_window_ratio_percent: "50",
  memory_index_bytes: "32000",
  exchange_nudge_after: "6",
  idle_streak_after: "3",
  no_tool_turns_before_pause: "2",
  max_concurrent_turns: "4",
  token_limit: "0",
  request_limit: "0",
};

function withRatio(value: string): Record<string, string> {
  return { ...VALID, context_window_ratio_percent: value };
}

describe("agent settings threshold percent", () => {
  it("accepts the 50 and 95 bounds", () => {
    expect(agentUpdate(withRatio("50"))).toMatchObject({
      context_window_ratio_percent: 50,
    });
    expect(agentUpdate(withRatio("95"))).toMatchObject({
      context_window_ratio_percent: 95,
    });
  });

  it("rejects values outside the bounds", () => {
    expect(agentUpdate(withRatio("49"))).toBeNull();
    expect(agentUpdate(withRatio("96"))).toBeNull();
  });

  it("rejects a blank field and a fractional value", () => {
    expect(agentUpdate(withRatio(""))).toBeNull();
    expect(agentUpdate(withRatio("50.5"))).toBeNull();
  });
});
