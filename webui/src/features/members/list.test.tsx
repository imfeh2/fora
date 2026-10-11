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
  it("uses the same ID pattern for either member type and after renaming", () => {
    const avatar = renderToStaticMarkup(<Avatar memberId={human.id} />);
    expect(render(human)).toContain(avatar);
    expect(render({ ...human, name: "Renamed", type: "agent" })).toContain(
      avatar,
    );
    expect(render({ ...human, id: 2 })).not.toContain(avatar);
  });

  it("links an agent to its page by name alone", () => {
    const html = render(agent("idle"));
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const nameAction = buttons.find((button) => button.includes(">Helper<"));
    expect(nameAction).toBeDefined();
    expect(nameAction?.replace(/<[^>]*>/g, "")).toBe("Helper");
  });

  it("offers a human name action and Rename", () => {
    const html = render(human);
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.join("")).toContain(">You<");
    expect(buttons.join("")).toContain("Rename");
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
