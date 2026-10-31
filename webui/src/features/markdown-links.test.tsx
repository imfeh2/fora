import { render } from "@testing-library/react";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { RouterProvider } from "@/app/router";
import { libraryPathFromHref, MarkdownContent } from "@/features/markdown";

function renderSource(source: string) {
  return render(<Markdown>{source}</Markdown>);
}

function renderMessage(source: string) {
  return render(
    <RouterProvider>
      <MarkdownContent source={source} identity="test-message" />
    </RouterProvider>,
  );
}

describe("library paths", () => {
  it("accepts root, relative, and dot paths", () => {
    expect(libraryPathFromHref("/tasks/x.png")).toBe("tasks/x.png");
    expect(libraryPathFromHref("tasks/x.png")).toBe("tasks/x.png");
    expect(libraryPathFromHref("./tasks/x.png")).toBe("tasks/x.png");
  });

  it("interprets every leading slash relative to the Library root", () => {
    expect(libraryPathFromHref("/root/.fora/library/tasks/x.png")).toBe(
      "root/.fora/library/tasks/x.png",
    );
    expect(libraryPathFromHref("/tasks/x.png")).toBe("tasks/x.png");
    expect(libraryPathFromHref("/etc/demo.png")).toBe("etc/demo.png");
    expect(libraryPathFromHref("./etc/demo.png")).toBe("etc/demo.png");
    expect(libraryPathFromHref("etc/demo.png")).toBe("etc/demo.png");
    expect(libraryPathFromHref(encodeURI("/tasks/图 片.png"))).toBe(
      "tasks/图 片.png",
    );
    expect(libraryPathFromHref("/root/.fora/library/../x.png")).toBeNull();
  });

  it.each(["C:/library/tasks/x.png", "D:\\library\\tasks\\x.png"])(
    "rejects a drive-qualified path %s",
    (href) => expect(libraryPathFromHref(href)).toBeNull(),
  );

  it("rejects external, fragment, and parent paths", () => {
    expect(libraryPathFromHref("https://example.com/x")).toBeNull();
    expect(libraryPathFromHref("//example.com/x")).toBeNull();
    expect(libraryPathFromHref("#section")).toBeNull();
    expect(libraryPathFromHref("../x.png")).toBeNull();
    expect(libraryPathFromHref("mailto:a@b")).toBeNull();
    expect(libraryPathFromHref("")).toBeNull();
  });
});

describe("message rendering", () => {
  it("renders a script link as its text without markers", () => {
    const { container } = renderMessage("[被拦](javascript:alert(1))");
    expect(container.textContent).toBe("被拦");
    expect(container.innerHTML).not.toContain("blocked");
    expect(container.innerHTML).not.toContain("Blocked URL");
  });

  it("renders a relative link without markers", () => {
    const { container } = renderMessage("[相对](tasks/interface/x.mp4)");
    expect(container.textContent).toBe("相对");
    expect(container.innerHTML).not.toContain("blocked");
    expect(container.innerHTML).not.toContain("Blocked URL");
  });
  it("renders a script image as its alt text without a link", () => {
    const { container } = renderMessage("![示意图](javascript:alert(1))");
    expect(container.textContent).toBe("示意图");
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript");
  });

  it("renders an empty script image as nothing", () => {
    const { container } = renderMessage("![](javascript:alert(1))");
    expect(container.textContent).toBe("");
    expect(container.innerHTML).not.toContain("javascript");
  });
});

describe("message links", () => {
  it("keeps the authored address for relative and root paths", () => {
    const { container } = renderSource(
      "[相对](tasks/interface/x.mp4)\n\n[根](/tasks/interface/x.mp4)",
    );
    const hrefs = [...container.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(hrefs).toEqual(["tasks/interface/x.mp4", "/tasks/interface/x.mp4"]);
  });

  it("shows only the link text for a script address, without markers", () => {
    const { container } = renderSource("[文字](javascript:alert(1))");
    expect(container.querySelector("a")?.getAttribute("href") ?? "").toBe("");
    expect(container.textContent).toBe("文字");
    expect(container.innerHTML).not.toContain("blocked");
  });

  it("keeps external and fragment links", () => {
    const { container } = renderSource(
      "[外](https://example.com/x)\n\n[内](#section)",
    );
    const hrefs = [...container.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(hrefs).toEqual(["https://example.com/x", "#section"]);
  });

  it("leaves code spans untouched", () => {
    const { container } = renderSource("`[被拦](javascript:alert(1))`");
    expect(container.querySelector("code")?.textContent).toBe(
      "[被拦](javascript:alert(1))",
    );
  });

  it("keeps authored text that looks like a marker", () => {
    const { container } = renderSource("原文里的 [blocked] 字样");
    expect(container.textContent).toBe("原文里的 [blocked] 字样");
  });
});
