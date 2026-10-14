import type { Root, RootContent, Text } from "mdast";
import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";
import type { MessageMention } from "@/lib/backend";

const textContainers = new Set([
  "paragraph",
  "listItem",
  "blockquote",
  "heading",
  "tableCell",
]);
const excludedContainers = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "math",
  "inlineMath",
]);

type Span = { start: number; end: number };

export function mentionSpans(
  source: string,
  mentions: MessageMention[],
): Span[] {
  const offsets = [0];
  for (const character of source)
    offsets.push(offsets[offsets.length - 1] + character.length);
  const spans: Span[] = [];
  for (const { position, length } of mentions) {
    if (
      !Number.isInteger(position) ||
      !Number.isInteger(length) ||
      position < 0 ||
      length <= 0 ||
      position + length >= offsets.length
    )
      continue;
    spans.push({ start: offsets[position], end: offsets[position + length] });
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  return spans.filter(
    (span, index) =>
      index === 0 ||
      span.start !== spans[index - 1].start ||
      span.end !== spans[index - 1].end,
  );
}

export function remarkLiteralHtml() {
  return (tree: Root, file: { value?: unknown }) => {
    const walk = (node: Root | RootContent) => {
      if (!("children" in node)) return;
      const parent: { children: RootContent[] } = node;
      for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index];
        if (
          child.type === "html" ||
          child.type === "math" ||
          child.type === "inlineMath"
        ) {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const value =
            typeof file.value === "string" &&
            start !== undefined &&
            end !== undefined
              ? file.value.slice(start, end)
              : child.value;
          const text: Text = {
            type: "text",
            value,
            position: child.position,
            data: {
              hName: "span",
              hProperties: { className: ["whitespace-pre-wrap"] },
            },
          };
          parent.children[index] = text;
        } else walk(child);
      }
    };
    walk(tree);
  };
}

type Extensions = NonNullable<Parameters<typeof parse>[0]>["extensions"];
type SourceUnit = Span & { value: string };

function sourceUnits(source: string, extensions: Extensions): SourceUnit[] {
  const units: SourceUnit[] = [];
  const events = postprocess(
    parse({ extensions })
      .document()
      .write(preprocess()(source, undefined, true)),
  );
  for (const [phase, token, context] of events) {
    if (phase !== "enter") continue;
    const start = token.start.offset;
    const end = token.end.offset;
    if (token.type === "characterReference" || token.type === "lineEnding") {
      units.push({
        start,
        end,
        value: decodeString(context.sliceSerialize(token)),
      });
    } else if (token.type === "data" || token.type === "characterEscapeValue") {
      let offset = start;
      for (const value of context.sliceSerialize(token)) {
        units.push({ start: offset, end: offset + value.length, value });
        offset += value.length;
      }
    }
  }
  return units;
}

export function remarkMentions(
  this: { data: () => object },
  options: { source: string; mentions: MessageMention[] },
) {
  const spans = mentionSpans(options.source, options.mentions);
  const { micromarkExtensions: extensions } = this.data() as {
    micromarkExtensions?: Extensions;
  };
  const units = spans.length ? sourceUnits(options.source, extensions) : [];
  return (tree: Root) => {
    if (!spans.length) return;
    const walk = (node: Root | RootContent, eligible = false) => {
      if (excludedContainers.has(node.type) || !("children" in node)) return;
      const allowed = eligible || textContainers.has(node.type);
      const parent: { children: RootContent[] } = node;
      const children: RootContent[] = [];
      for (const child of parent.children) {
        if (child.type !== "text" || !allowed) {
          walk(child, allowed);
          children.push(child);
          continue;
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined) {
          children.push(child);
          continue;
        }
        const matches = spans.filter(
          (span) => span.end > start && span.start < end,
        );
        if (!matches.length) {
          children.push(child);
          continue;
        }
        let length = 0;
        const positions = units
          .filter((unit) => unit.start >= start && unit.end <= end)
          .map((unit) => {
            const from = length;
            length += unit.value.length;
            return { ...unit, from, to: length };
          });
        if (positions.map((unit) => unit.value).join("") !== child.value)
          throw new Error("Markdown text and source positions disagree");
        let cursor = 0;
        for (const span of matches) {
          const matching = positions.filter(
            (unit) => unit.end > span.start && unit.start < span.end,
          );
          if (!matching.length) continue;
          const from = matching[0].from;
          const to = matching[matching.length - 1].to;
          if (from < cursor || to <= from || to > child.value.length) continue;
          if (from > cursor)
            children.push({
              type: "text",
              value: child.value.slice(cursor, from),
            });
          children.push({
            type: "text",
            value: child.value.slice(from, to),
            data: { hName: "mark" },
          });
          cursor = to;
        }
        if (cursor < child.value.length)
          children.push({ type: "text", value: child.value.slice(cursor) });
      }
      parent.children = children;
    };
    walk(tree);
  };
}
