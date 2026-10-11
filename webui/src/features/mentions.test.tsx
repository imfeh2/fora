import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  candidatesFor,
  completeMention,
  matchMembers,
  mentionQuery,
  renderMentions,
} from "@/features/mentions";
import type { Member, MessageMention } from "@/lib/backend";

const members: Member[] = [
  { id: 1, type: "human", name: "You", state: "idle" },
  { id: 2, type: "agent", name: "Main", state: "idle" },
  { id: 3, type: "agent", name: "Mainframe", state: "idle" },
  { id: 4, type: "agent", name: "Data Team", state: "idle" },
];

describe("mentionQuery", () => {
  it("finds the mention the caret is sitting in", () => {
    expect(mentionQuery("hello @Ma", 9)).toEqual({ start: 6, query: "Ma" });
  });

  it("treats an empty mention as a query so the full list shows", () => {
    expect(mentionQuery("hello @", 7)).toEqual({ start: 6, query: "" });
  });

  it("ignores an at sign glued to the end of a word", () => {
    expect(mentionQuery("mail@Ma", 7)).toBeNull();
  });

  it("does not reach across a line break", () => {
    expect(mentionQuery("@Main\nlater", 11)).toBeNull();
  });

  it("does not reach past an earlier mention", () => {
    expect(mentionQuery("@Main @Da", 9)).toEqual({ start: 6, query: "Da" });
  });

  it("gives up once the query is longer than any name may be", () => {
    const long = `@${"x".repeat(80)}`;
    expect(mentionQuery(long, long.length)).toBeNull();
  });
});

describe("matchMembers", () => {
  it("matches case insensitively and puts the shortest name first", () => {
    expect(matchMembers(members, "ma").map((m) => m.name)).toEqual([
      "Main",
      "Mainframe",
    ]);
  });

  it("matches names containing a space", () => {
    expect(matchMembers(members, "data t").map((m) => m.name)).toEqual([
      "Data Team",
    ]);
  });

  it("returns everyone for an empty query", () => {
    expect(matchMembers(members, "")).toHaveLength(4);
  });

  it("returns nothing when no name starts with the query", () => {
    expect(matchMembers(members, "zzz")).toEqual([]);
  });
});

describe("completeMention", () => {
  it("replaces the partial mention and leaves the caret after it", () => {
    const text = "hello @Ma there";
    const mention = mentionQuery(text, 9);
    if (!mention) throw new Error("expected a mention");
    const result = completeMention(text, mention, 9, "Mainframe");
    expect(result.text).toBe("hello @Mainframe  there");
    expect(result.caret).toBe(17);
  });

  it("completes a name that contains a space", () => {
    const text = "@Data t";
    const mention = mentionQuery(text, 7);
    if (!mention) throw new Error("expected a mention");
    const result = completeMention(text, mention, 7, "Data Team");
    expect(result.text).toBe("@Data Team ");
  });
});

describe("mentionQuery boundaries", () => {
  it("returns nothing when the caret sits at the very start", () => {
    expect(mentionQuery("@Main", 0)).toBeNull();
  });

  it("does not fabricate a query from a clamped index", () => {
    expect(mentionQuery("@", 0)).toBeNull();
  });
});

describe("candidatesFor", () => {
  const here = new Set([1, 2]);

  it("a bare mention offers only the people who can be notified", () => {
    const groups = candidatesFor(members, here, "");
    expect(groups.inDiscussion.map((m) => m.name)).toEqual(["You", "Main"]);
    expect(groups.elsewhere).toEqual([]);
    expect(groups.hasAll).toBe(true);
  });

  it.each(["", "a", "al", "all", "ALL", " Al "])(
    "offers everyone for prefix %s",
    (query) => expect(candidatesFor(members, here, query).hasAll).toBe(true),
  );

  it.each(["allo", "allison", "ma", "zzz"])(
    "does not offer everyone for %s",
    (query) => expect(candidatesFor(members, here, query).hasAll).toBe(false),
  );

  it("requires a discussion member for the everyone candidate", () => {
    expect(candidatesFor(members, new Set(), "").hasAll).toBe(false);
    expect(candidatesFor(members, new Set(), "all").hasAll).toBe(false);
  });

  it("offers one everyone entry and keeps longer names", () => {
    const people: Member[] = [
      ...members,
      { id: 5, type: "agent", name: "ALL", state: "paused" },
      { id: 6, type: "agent", name: "All Hands", state: "idle" },
      { id: 7, type: "agent", name: "Allison", state: "idle" },
      { id: 8, type: "agent", name: "all", state: "idle" },
    ];
    const groups = candidatesFor(people, new Set([1, 5, 6]), "all");
    expect(groups.hasAll).toBe(true);
    expect(groups.inDiscussion.map((m) => m.name)).toEqual(["All Hands"]);
    expect(groups.elsewhere.map((m) => m.name)).toEqual(["Allison"]);
  });

  it("a keyword searches the whole organization", () => {
    const groups = candidatesFor(members, here, "ma");
    expect(groups.inDiscussion.map((m) => m.name)).toEqual(["Main"]);
    expect(groups.elsewhere.map((m) => m.name)).toEqual(["Mainframe"]);
  });

  it("keeps discussion members ahead of everyone else", () => {
    const groups = candidatesFor(members, here, "");
    expect(groups.inDiscussion.length).toBeGreaterThan(0);
    expect(groups.elsewhere.length).toBe(0);
  });

  it("finds nobody when the keyword matches no one", () => {
    const groups = candidatesFor(members, here, "zzz");
    expect(groups.inDiscussion).toEqual([]);
    expect(groups.elsewhere).toEqual([]);
  });
});

describe("renderMentions", () => {
  function render(body: string, mentions: MessageMention[], people = members) {
    return renderToStaticMarkup(renderMentions(body, mentions, people));
  }

  it.each([
    ["@Main hello", 0, "<mark>@Main</mark> hello"],
    ["hi @Main there", 3, "hi <mark>@Main</mark> there"],
    ["hi @Main", 3, "hi <mark>@Main</mark>"],
  ])("marks the recorded span in %s", (body, position, expected) => {
    expect(render(body, [{ member_id: 2, position, length: 5 }])).toBe(
      expected,
    );
  });

  it("renders one recorded everyone span for multiple recipients", () => {
    expect(
      render("😀 @ALL @all", [
        { member_id: 2, position: 2, length: 4 },
        { member_id: 3, position: 2, length: 4 },
        { member_id: 4, position: 2, length: 4 },
      ]),
    ).toBe("😀 <mark>@ALL</mark> @all");
  });

  it("keeps distinct recorded positions and repeated text", () => {
    expect(
      render("@Main @all @You @all", [
        { member_id: 2, position: 0, length: 5 },
        { member_id: 3, position: 6, length: 4 },
        { member_id: 4, position: 6, length: 4 },
        { member_id: 1, position: 11, length: 4 },
      ]),
    ).toBe("<mark>@Main</mark> <mark>@all</mark> <mark>@You</mark> @all");
  });

  it("renders the longest valid span at the same position", () => {
    expect(
      render("@All Hands", [
        { member_id: 2, position: 0, length: 4 },
        { member_id: 3, position: 0, length: 10 },
      ]),
    ).toBe("<mark>@All Hands</mark>");
  });

  it("marks adjacent spans without dropping text", () => {
    expect(
      render("@Main@You", [
        { member_id: 2, position: 0, length: 5 },
        { member_id: 1, position: 5, length: 4 },
      ]),
    ).toBe("<mark>@Main</mark><mark>@You</mark>");
  });

  it("leaves unrecorded mentions and surrounding text intact", () => {
    expect(
      render("mail@Main @Nobody @You @Main", [
        { member_id: 1, position: 18, length: 4 },
      ]),
    ).toBe("mail@Main @Nobody <mark>@You</mark> @Main");
  });

  it("renders an empty mention list as plain text", () => {
    expect(renderMentions("@Main and @You", [], members)).toEqual([
      "@Main and @You",
    ]);
    expect(renderMentions("", [], members)).toEqual([""]);
  });

  it.each([
    [-1, 5],
    [20, 5],
    [3, 6],
    [3, 0],
    [3, -1],
    [3.5, 4],
    [3, 4.5],
    [Number.NaN, 5],
    [3, Number.POSITIVE_INFINITY],
  ])("ignores malformed position %s and length %s", (position, length) => {
    expect(render("hi @Main", [{ member_id: 2, position, length }])).toBe(
      "hi @Main",
    );
  });

  it("does not let an invalid span hide a valid one", () => {
    expect(
      render("hi @Main", [
        { member_id: 1, position: 0, length: 100 },
        { member_id: 2, position: 3, length: 5 },
      ]),
    ).toBe("hi <mark>@Main</mark>");
  });

  it("sorts spans without changing the records and ignores overlaps", () => {
    const mentions = [
      { member_id: 1, position: 6, length: 4 },
      { member_id: 2, position: 0, length: 5 },
      { member_id: 2, position: 0, length: 5 },
      { member_id: 3, position: 3, length: 5 },
    ];
    const original = mentions.map((mention) => ({ ...mention }));
    expect(render("@Main @You", mentions)).toBe(
      "<mark>@Main</mark> <mark>@You</mark>",
    );
    expect(mentions).toEqual(original);
  });

  it("keeps the recorded text when a member is renamed or removed", () => {
    const mentions = [{ member_id: 2, position: 0, length: 5 }];
    expect(
      render("@Main", mentions, [{ ...members[1], name: "Renamed" }]),
    ).toBe("<mark>@Main</mark>");
    expect(render("@Main", mentions, [])).toBe("<mark>@Main</mark>");
  });

  it("uses kernel code-point offsets before and inside spans", () => {
    expect(
      render("😀 hi @A😀 and @You!", [
        { member_id: 2, position: 5, length: 3 },
        { member_id: 1, position: 13, length: 4 },
      ]),
    ).toBe("😀 hi <mark>@A😀</mark> and <mark>@You</mark>!");
  });

  it("escapes text inside and outside recorded spans", () => {
    expect(
      render("<b>@Main</b>", [{ member_id: 2, position: 3, length: 5 }]),
    ).toBe("&lt;b&gt;<mark>@Main</mark>&lt;/b&gt;");
  });
});
