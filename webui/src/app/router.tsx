import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type SettingsSection =
  | "model"
  | "execution"
  | "agent"
  | "langfuse"
  | "voice";

export type Route =
  | { name: "discussions" }
  | { name: "discussion"; id: number }
  | { name: "members" }
  | { name: "usage" }
  | { name: "library"; path?: string }
  | { name: "settings"; section: SettingsSection };

export type NavId =
  | "discussions"
  | "members"
  | "usage"
  | "library"
  | "settings";

const NAV_OF: Record<Route["name"], NavId> = {
  discussions: "discussions",
  discussion: "discussions",
  members: "members",
  usage: "usage",
  library: "library",
  settings: "settings",
};

export function navIdOf(route: Route): NavId {
  return NAV_OF[route.name];
}

export function pageKeyOf(route: Route): string {
  if ("id" in route) return `${route.name}:${route.id}`;
  if ("path" in route && route.path) return `${route.name}:${route.path}`;
  return route.name;
}

export type NavigationBlocker = (next: Route, proceed: () => void) => boolean;

type Router = {
  route: Route;
  navigate: (next: Route) => void;
  registerNavigationBlocker: (blocker: NavigationBlocker) => () => void;
};

const RouterContext = createContext<Router | null>(null);

const LIST_PATH = "/discussions";

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "model",
  "execution",
  "agent",
  "langfuse",
  "voice",
];

function pathSegments(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent);
}

export function documentPath(path: string): string {
  const segments = pathSegments(path);
  return segments.length > 0 ? `/library/${segments.join("/")}` : "/library";
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "discussions":
      return LIST_PATH;
    case "discussion":
      return `/discussions/${route.id}`;
    case "members":
      return "/members";
    case "usage":
      return "/usage";
    case "library":
      return route.path ? documentPath(route.path) : "/library";
    case "settings":
      return `/settings/${route.section}`;
  }
}

function readSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(decodeURIComponent);
  } catch {
    return null;
  }
}

export function routeFromPath(pathname: string): Route | null {
  const segments = readSegments(pathname);
  if (segments === null) return null;
  if (segments.some((segment) => segment === "." || segment === ".."))
    return null;
  const head = segments[0];
  if (head === undefined) return { name: "discussions" };
  if (head === "discussions") {
    if (segments.length === 1) return { name: "discussions" };
    if (segments.length === 2 && /^\d+$/.test(segments[1]))
      return { name: "discussion", id: Number(segments[1]) };
    return null;
  }
  if (head === "members" && segments.length === 1) return { name: "members" };
  if (head === "usage" && segments.length === 1) return { name: "usage" };
  if (head === "library") {
    if (segments.length === 1) return { name: "library" };
    return { name: "library", path: segments.slice(1).join("/") };
  }
  if (head === "settings" && segments.length === 2) {
    const section = SETTINGS_SECTIONS.find((item) => item === segments[1]);
    return section ? { name: "settings", section } : null;
  }
  return null;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => {
    const initial = routeFromPath(location.pathname);
    if (initial === null) {
      history.replaceState(history.state, "", LIST_PATH);
      return { name: "discussions" };
    }
    const path = routePath(initial);
    if (`${location.pathname}${location.search}` !== path)
      history.replaceState(history.state, "", path);
    return initial;
  });

  const currentRoute = useRef(route);
  currentRoute.current = route;
  const navigationBlocker = useRef<NavigationBlocker | null>(null);
  const reverting = useRef(false);
  const registerNavigationBlocker = useCallback(
    (blocker: NavigationBlocker) => {
      navigationBlocker.current = blocker;
      return () => {
        if (navigationBlocker.current === blocker)
          navigationBlocker.current = null;
      };
    },
    [],
  );

  const apply = useCallback((next: Route) => {
    currentRoute.current = next;
    setRoute(next);
    const path = routePath(next);
    if (`${location.pathname}${location.search}` !== path)
      history.pushState(history.state, "", path);
  }, []);

  const settle = useCallback((next: Route) => {
    currentRoute.current = next;
    setRoute(next);
    const path = routePath(next);
    if (`${location.pathname}${location.search}` !== path)
      history.replaceState(history.state, "", path);
  }, []);

  const navigate = useCallback(
    (next: Route) => {
      const top = currentRoute.current;
      if (top.name === next.name && sameParams(top, next)) return;
      const proceed = () => apply(next);
      if (navigationBlocker.current?.(next, proceed)) return;
      proceed();
    },
    [apply],
  );

  useEffect(() => {
    const onPopState = () => {
      if (reverting.current) {
        reverting.current = false;
        return;
      }
      const next = routeFromPath(location.pathname);
      if (next === null) {
        history.replaceState(history.state, "", LIST_PATH);
        settle({ name: "discussions" });
        return;
      }
      const top = currentRoute.current;
      if (top.name === next.name && sameParams(top, next)) {
        settle(next);
        return;
      }
      const proceed = () => apply(next);
      if (navigationBlocker.current?.(next, proceed)) {
        reverting.current = true;
        history.go(1);
        return;
      }
      proceed();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [apply, settle]);

  const value = useMemo<Router>(
    () => ({ route, navigate, registerNavigationBlocker }),
    [route, navigate, registerNavigationBlocker],
  );

  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  );
}

function paramOf(route: Route): string | number | null {
  if ("id" in route) return route.id;
  if ("path" in route) return route.path ?? "";
  if ("section" in route) return route.section;
  return null;
}

function sameParams(a: Route, b: Route): boolean {
  return paramOf(a) === paramOf(b);
}

export function useRouter(): Router {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter used outside RouterProvider");
  return value;
}

export function useNavigate(): (next: Route) => void {
  return useRouter().navigate;
}
