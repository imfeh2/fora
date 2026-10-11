import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Avatar,
  AvatarStack,
  autoGrowHeight,
  Button,
  Field,
  IconButton,
  identiconFor,
  Select,
  Textarea,
} from "@/components/ui/index";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";

describe("identiconFor", () => {
  it.each([
    [1, 30095, "yellow-200"],
    [2, 17759, "yellow-200"],
    [7, 20573, "green-200"],
    [100, 28702, "blue-100"],
    [4294967297, 29703, "green-200"],
    [Number.MAX_SAFE_INTEGER, 13944, "green-200"],
  ] as const)("keeps the fixed pattern for member %s", (id, bits, hue) => {
    const icon = identiconFor(id);
    const cells = [];
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if ((bits >>> (row * 3 + column)) & 1) {
          cells.push({ x: column + 1, y: row + 1 });
          if (column < 2) cells.push({ x: 5 - column, y: row + 1 });
        }
      }
    }
    expect(icon).toEqual({ cells, color: `var(--color-${hue})` });
    expect(identiconFor(id)).toEqual(icon);
  });

  it("mirrors cells inside a one-cell border with no duplicate cells", () => {
    for (let id = 1; id <= 100; id += 1) {
      const { cells } = identiconFor(id);
      expect(new Set(cells.map(({ x, y }) => `${x},${y}`)).size).toBe(
        cells.length,
      );
      for (const { x, y } of cells) {
        expect(x).toBeGreaterThanOrEqual(1);
        expect(x).toBeLessThanOrEqual(5);
        expect(y).toBeGreaterThanOrEqual(1);
        expect(y).toBeLessThanOrEqual(5);
        expect(cells).toContainEqual({ x: 6 - x, y });
      }
    }
  });

  it("varies common IDs without truncating the seed to 32 bits", () => {
    const icons = Array.from({ length: 100 }, (_, index) =>
      identiconFor(index + 1),
    );
    expect(new Set(icons.map((icon) => JSON.stringify(icon))).size).toBe(100);
    expect(new Set(icons.map((icon) => icon.color)).size).toBe(5);
    expect(icons.every((icon) => icon.cells.length > 0)).toBe(true);
    expect(identiconFor(1)).not.toEqual(identiconFor(4294967297));
  });
});

describe("Avatar", () => {
  it.each([
    ["xs", "size-[18px]"],
    ["sm", "size-[22px]"],
    ["md", "size-[26px]"],
    ["lg", "size-10"],
  ] as const)("keeps the %s size and a decorative SVG", (size, sizeClass) => {
    const html = renderToStaticMarkup(<Avatar memberId={1} size={size} />);
    expect(html).toContain(sizeClass);
    expect(html).toMatch(/^<span[^>]*aria-hidden="true"><svg/);
    expect(html).toContain('viewBox="0 0 7 7"');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain("<title");
    expect(html).not.toContain("<image");
    expect(html).not.toContain("aria-label");
  });
});

describe("Button", () => {
  it("keeps its classes and label when used as a tooltip trigger", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Tooltip label="x">
          <Button variant="ghost" aria-label="Members">
            y
          </Button>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(html).toMatch(/<button[^>]*class="[^"]*inline-flex/);
    expect(html).toContain('aria-label="Members"');
  });
});

describe("IconButton", () => {
  it("labels the button for assistive tech and a tooltip instead of a title", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <IconButton label="Show archived">x</IconButton>
      </TooltipProvider>,
    );
    expect(html).toContain('aria-label="Show archived"');
    expect(html).not.toContain("title=");
    expect(html).not.toContain("aria-pressed=");
  });

  it("exposes a pressed state", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <IconButton label="Show archived" pressed>
          x
        </IconButton>
      </TooltipProvider>,
    );
    expect(html).toContain('aria-pressed="true"');
  });
});

describe("AvatarStack", () => {
  const members = ["You", "Main", "Scout", "Data", "Ops", "QA", "PM"].map(
    (name, index) => ({ id: index + 1, name }),
  );

  it("shows up to the limit in input order and folds the rest into a count", () => {
    const html = renderToStaticMarkup(<AvatarStack members={members} />);
    let previous = -1;
    for (const member of members.slice(0, 5)) {
      const avatar = renderToStaticMarkup(
        <Avatar memberId={member.id} size="sm" />,
      );
      const position = html.indexOf(avatar);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(html.match(/<svg/g)).toHaveLength(5);
    expect(html).toContain("+2");
    expect(html).toContain('aria-label="You, Main, Scout, Data, Ops, QA, PM"');
    expect(html.match(/aria-label=/g)).toHaveLength(1);
    expect(html).toContain("[&amp;&gt;span+span]:-ml-[6px]");
  });

  it.each([0, 1, 5, 7])("preserves a maximum of %s", (max) => {
    const html = renderToStaticMarkup(
      <AvatarStack members={members} max={max} />,
    );
    expect(html.match(/<svg/g) ?? []).toHaveLength(max);
    if (max < members.length)
      expect(html).toContain(`+${members.length - max}`);
    else expect(html).not.toMatch(/>\+\d+</);
  });

  it("shows no count when everyone fits or the group is empty", () => {
    for (const group of [members.slice(0, 2), []]) {
      const html = renderToStaticMarkup(<AvatarStack members={group} />);
      expect(html.match(/<svg/g) ?? []).toHaveLength(group.length);
      expect(html).not.toMatch(/>\+\d+</);
    }
  });

  it("keeps identity on rename, distinguishes duplicate names and escapes labels", () => {
    const before = renderToStaticMarkup(<AvatarStack members={members} />);
    const renamed = renderToStaticMarkup(
      <AvatarStack
        members={members.map((member) => ({
          ...member,
          name: '<img src=x onerror="bad">',
        }))}
      />,
    );
    expect(renamed.match(/<svg.*?<\/svg>/g)).toEqual(
      before.match(/<svg.*?<\/svg>/g),
    );
    expect(renamed).not.toContain("<img");
    expect(renamed).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
    const icons = renamed.match(/<svg.*?<\/svg>/g);
    expect(new Set(icons).size).toBe(5);
  });
});

describe("Textarea auto grow", () => {
  it("follows the content height until the row ceiling", () => {
    expect(autoGrowHeight(56, 20, 16, 2, 8)).toBe(58);
    expect(autoGrowHeight(400, 20, 16, 2, 8)).toBe(178);
    expect(autoGrowHeight(400, 20, 16, 2)).toBe(402);
  });

  it("preserves the label and initial row count when auto growing", () => {
    const html = renderToStaticMarkup(
      <Textarea autoGrow rows={1} aria-label="Message" />,
    );
    expect(html).toMatch(/<textarea[^>]*rows="1"[^>]*aria-label="Message"/);
    expect(renderToStaticMarkup(<Textarea aria-label="Notes" />)).toMatch(
      /<textarea[^>]*aria-label="Notes"/,
    );
  });
});

describe("Select", () => {
  it("preserves the accessible name, options and selected value", () => {
    const html = renderToStaticMarkup(
      <Select aria-label="Read Turn" defaultValue="3">
        <option value="latest">Latest</option>
        <option value="3">Turn 3</option>
      </Select>,
    );
    expect(html).toContain('aria-label="Read Turn"');
    expect(html).toContain('<option value="latest">Latest</option>');
    expect(html).toMatch(/<option value="3" selected="">Turn 3<\/option>/);
  });
});

describe("Field", () => {
  it("links a label to its control and keeps the hint after it", () => {
    const html = renderToStaticMarkup(
      <Field label="Name" htmlFor="name" hint="Required">
        <input id="name" />
      </Field>,
    );
    expect(html).toMatch(
      /<label[^>]*for="name">Name<\/label><input id="name"\/><p[^>]*>Required<\/p>/,
    );
  });

  it("renders unassociated group text as a span", () => {
    const html = renderToStaticMarkup(
      <Field label="Provider">
        <fieldset aria-label="Provider">Options</fieldset>
      </Field>,
    );
    expect(html).toMatch(
      /<span[^>]*>Provider<\/span><fieldset aria-label="Provider">Options<\/fieldset>/,
    );
    expect(html).not.toContain("<label");
  });
});

describe("composer textarea variant", () => {
  it("limits borderless styling to the explicit composer variant", () => {
    const standard = renderToStaticMarkup(<Textarea aria-label="Notes" />);
    const composer = renderToStaticMarkup(
      <Textarea variant="composer" aria-label="Message" />,
    );
    expect(standard).toContain("border-line-interactive");
    expect(standard).toContain("min-h-18");
    expect(composer).not.toContain("border-line-interactive");
    expect(composer).toContain("leading-[22px]");
    expect(composer).not.toContain('variant="composer"');
  });
});
