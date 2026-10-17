import { describe, expect, it } from "vitest";
import { documentPath, routeFromPath, routePath } from "@/app/router";

describe("route paths", () => {
  it("encodes every library segment", () => {
    expect(documentPath("tasks/界面 说明/README.md")).toBe(
      "/library/tasks/%E7%95%8C%E9%9D%A2%20%E8%AF%B4%E6%98%8E/README.md",
    );
  });

  it("opens a nested library path", () => {
    const path = "tasks/界面 说明/README.md";
    expect(routeFromPath(documentPath(path))).toEqual({
      name: "library",
      path,
    });
  });

  it("round trips a library path", () => {
    const route = { name: "library", path: "notes/a.md" } as const;
    expect(routeFromPath(routePath(route))).toEqual(route);
  });

  it("maps the known paths", () => {
    expect(routeFromPath("/")).toEqual({ name: "discussions" });
    expect(routeFromPath("/discussions")).toEqual({ name: "discussions" });
    expect(routeFromPath("/discussions/12")).toEqual({
      name: "discussion",
      id: 12,
    });
    expect(routeFromPath("/members")).toEqual({ name: "members" });
    expect(routeFromPath("/usage")).toEqual({ name: "usage" });
    expect(routeFromPath("/library")).toEqual({ name: "library" });
    expect(routeFromPath("/settings/voice")).toEqual({
      name: "settings",
      section: "voice",
    });
    expect(routeFromPath("/settings/model")).toEqual({
      name: "settings",
      section: "models",
    });
  });

  it("rejects unknown and malformed paths", () => {
    expect(routeFromPath("/unknown")).toBeNull();
    expect(routeFromPath("/discussions/abc")).toBeNull();
    expect(routeFromPath("/discussions/12/extra")).toBeNull();
    expect(routeFromPath("/settings/nope")).toBeNull();
    expect(routeFromPath("/library/%E0%A4%A")).toBeNull();
    expect(routeFromPath("/library/a/../b")).toBeNull();
  });

  it("serializes each route", () => {
    expect(routePath({ name: "discussions" })).toBe("/discussions");
    expect(routePath({ name: "discussion", id: 7 })).toBe("/discussions/7");
    expect(routePath({ name: "members" })).toBe("/members");
    expect(routePath({ name: "usage" })).toBe("/usage");
    expect(routePath({ name: "library" })).toBe("/library");
    expect(routePath({ name: "settings", section: "agent" })).toBe(
      "/settings/agent",
    );
  });
});
