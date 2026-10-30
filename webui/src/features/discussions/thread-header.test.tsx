import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadHeader } from "@/features/discussions/thread-header";

const actions = [
  { id: "members", label: "Members", onSelect: () => {} },
  { id: "archive", label: "Archive", onSelect: () => {} },
];

describe("thread header", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders only the title and the two icon buttons", () => {
    const { container } = render(
      <ThreadHeader title="A discussion" actions={actions} />,
    );
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    expect(header?.children).toHaveLength(2);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("A discussion");
    expect(heading.getAttribute("title")).toBe("A discussion");

    expect(
      screen.getByRole("button", { name: "Search this discussion" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Discussion actions" }),
    ).toBeTruthy();
    expect(header?.textContent).toBe("A discussion");
  });

  it("shows a skeleton title without icon buttons while loading", () => {
    const { container } = render(<ThreadHeader title={null} />);
    const header = container.querySelector("header");
    expect(header?.querySelector("h1")).toBeNull();
    expect(header?.querySelectorAll("button")).toHaveLength(0);
  });
});
