import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ThreadHeader,
  type ThreadSearchControls,
} from "@/features/discussions/thread-header";

function renderHeader(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const menu = [
  { id: "members", label: "Members", onSelect: () => {} },
  { id: "archive", label: "Archive", onSelect: () => {} },
];

function searchControls(
  overrides: Partial<ThreadSearchControls> = {},
): ThreadSearchControls {
  return {
    open: false,
    query: "",
    count: 0,
    position: 0,
    inputRef: { current: null },
    buttonRef: { current: null },
    onToggle: () => {},
    onChange: () => {},
    onCommit: () => {},
    onStep: () => {},
    ...overrides,
  };
}

describe("thread header", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders only the title and the two icon buttons", () => {
    const { container } = render(
      <ThreadHeader
        title="A discussion"
        menu={menu}
        search={searchControls()}
      />,
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
    expect(screen.queryByPlaceholderText("在这条讨论里搜")).toBeNull();
  });

  it("shows a skeleton title without icon buttons while loading", () => {
    const { container } = render(<ThreadHeader title={null} />);
    const header = container.querySelector("header");
    expect(header?.querySelector("h1")).toBeNull();
    expect(header?.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows the match counter and steps with enter when search is open", () => {
    const onStep = vi.fn();
    renderHeader(
      <ThreadHeader
        title="A discussion"
        menu={menu}
        search={searchControls({
          open: true,
          query: "测试",
          count: 2,
          position: 0,
          onStep,
        })}
      />,
    );

    const input = screen.getByPlaceholderText("在这条讨论里搜");
    expect((input as HTMLInputElement).value).toBe("测试");
    expect(screen.getByText("第 1 / 2 条")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onStep).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onStep).toHaveBeenLastCalledWith(-1);

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(onStep).toHaveBeenLastCalledWith(1);
  });

  it("reports no match and disables both arrows", () => {
    renderHeader(
      <ThreadHeader
        title="A discussion"
        menu={menu}
        search={searchControls({ open: true, query: "zzz" })}
      />,
    );

    expect(screen.getByText("没有匹配")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Previous match",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Next match" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("toggles search from the icon button", () => {
    const onToggle = vi.fn();
    render(
      <ThreadHeader
        title="A discussion"
        menu={menu}
        search={searchControls({ onToggle })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Search this discussion" }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
