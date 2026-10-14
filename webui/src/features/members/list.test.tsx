import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "@/components/ui/index";
import { MemberRow, memberActions } from "@/features/members/list";
import { agentStateLabel } from "@/features/members/state";
import type { Member } from "@/lib/backend";

const noop = { toggle: () => {}, rename: () => {}, remove: () => {} };

const human: Member = { id: 1, name: "You", type: "human", state: "idle" };

function agent(state: Member["state"]): Member {
  return { id: 2, name: "Helper", type: "agent", state, tokens: 1200 };
}

function render(member: Member, tokenLimit = 0) {
  return renderToStaticMarkup(
    <ul>
      <MemberRow
        member={member}
        tokenLimit={tokenLimit}
        onOpen={() => {}}
        onToggle={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />
    </ul>,
  );
}

describe("member actions", () => {
  it("gives an idle agent pause, rename and delete", () => {
    expect(
      memberActions(agent("idle"), noop).map((action) => [
        action.label,
        action.disabled ?? false,
      ]),
    ).toEqual([
      ["Pause", false],
      ["Rename", false],
      ["Delete", false],
    ]);
  });

  it("offers resume once paused", () => {
    expect(memberActions(agent("paused"), noop)[0].label).toBe("Resume");
  });

  it("disables delete while the agent runs", () => {
    const actions = memberActions(agent("running"), noop);
    expect(actions.find((action) => action.id === "delete")?.disabled).toBe(
      true,
    );
    expect(actions.find((action) => action.id === "toggle")?.label).toBe(
      "Pause",
    );
  });

  it("gives a human rename only", () => {
    expect(memberActions(human, noop).map((action) => action.label)).toEqual([
      "Rename",
    ]);
  });
});

describe("member row", () => {
  it("displays exact known totals and distinguishes unavailable totals from zero", () => {
    const metrics = {
      records: 2,
      input_tokens: "9007199254740993",
      output_tokens: "0",
      total_tokens: "9007199254740993",
      requests: "2",
      input_known: 1,
      output_known: 1,
      total_known: 1,
      requests_known: 2,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cache_read_known: 0,
      cache_write_known: 0,
      estimated_cost: null,
      cost_known: 0,
      last_active: null,
      model_count: 1,
    };
    const member = { ...agent("running"), usage_metrics: metrics };
    expect(render({ ...member, usage_index_ready: false })).toContain(
      "Indexing saved usage",
    );
    const known = render(member, 1000);
    expect(known).toContain("9,007,199,254,740,993");
    expect(known).toContain("Partial usage");
    const unknown = render(
      {
        ...member,
        tokens: null,
        usage_metrics: { ...metrics, total_tokens: null, total_known: 0 },
      },
      1000,
    );
    expect(unknown).toContain("Unavailable");
    expect(unknown).toContain("tokens / 1,000");
    const zero = render(
      {
        ...member,
        usage_metrics: { ...metrics, total_tokens: "0", total_known: 2 },
      },
      1000,
    );
    expect(zero).not.toContain("Unavailable");
    expect(zero).not.toContain("Partial usage");
    expect(zero).toContain("0 tokens / 1,000");
  });
  it("uses the same ID pattern for either member type and after renaming", () => {
    const avatar = renderToStaticMarkup(<Avatar memberId={human.id} />);
    expect(render(human)).toContain(avatar);
    expect(render({ ...human, name: "Renamed", type: "agent" })).toContain(
      avatar,
    );
    expect(render({ ...human, id: 2 })).not.toContain(avatar);
  });

  it("links an agent to its page by name alone", async () => {
    const packageName = "jsdom";
    const { JSDOM } = await import(packageName);
    const dom = new JSDOM(render(agent("idle")));
    try {
      const buttons = [...dom.window.document.querySelectorAll("button")];
      const nameAction = buttons.find(
        (button) => button.textContent === "Helper",
      );
      expect(nameAction).toBeDefined();
      expect(nameAction?.textContent).toBe("Helper");
    } finally {
      dom.window.close();
    }
  });

  it("offers Human rename controls and noninteractive name text", async () => {
    const packageName = "jsdom";
    const { JSDOM } = await import(packageName);
    const dom = new JSDOM(render(human));
    try {
      const buttons = [...dom.window.document.querySelectorAll("button")];
      expect(buttons.some((button) => button.textContent === "You")).toBe(
        false,
      );
      expect(buttons.some((button) => button.textContent === "Rename")).toBe(
        true,
      );
      const name = [...dom.window.document.querySelectorAll("span")].find(
        (element) => element.textContent === "You",
      );
      expect(name?.tabIndex).toBe(-1);
    } finally {
      dom.window.close();
    }
  });

  it("reports the backend state in the State column", () => {
    expect(render(agent("blocked"), 1000)).toContain("Blocked");
    expect(render(agent("error"), 2000)).toContain("Error");
  });

  it("offers Resume while the current activity completes", () => {
    const member = { ...agent("running"), pause_requested: true };
    expect(memberActions(member, noop)[0].label).toBe("Resume");
    expect(render(member)).toContain(
      "Pause requested · Current activity will finish",
    );
  });
});

describe("agentStateLabel", () => {
  it.each([
    ["running", "Running"],
    ["paused", "Paused"],
    ["blocked", "Blocked"],
    ["error", "Error"],
    ["idle", "Idle"],
  ] as const)("displays %s", (state, label) => {
    expect(agentStateLabel(agent(state))).toBe(label);
  });
});
