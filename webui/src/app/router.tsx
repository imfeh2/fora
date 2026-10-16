import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
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
  | { name: "document"; path: string }
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
  document: "library",
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

export function RouterProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: "discussions" }]);

  const currentRoute = useRef(stack[stack.length - 1]);
  currentRoute.current = stack[stack.length - 1];
  const navigationBlocker = useRef<NavigationBlocker | null>(null);
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

  const navigate = useCallback((next: Route) => {
    const top = currentRoute.current;
    if (top.name === next.name && sameParams(top, next)) return;
    const proceed = () => {
      currentRoute.current = next;
      setStack((current) => [...current, next].slice(-24));
    };
    if (navigationBlocker.current?.(next, proceed)) return;
    proceed();
  }, []);

  const value = useMemo<Router>(
    () => ({
      route: stack[stack.length - 1],
      navigate,
      registerNavigationBlocker,
    }),
    [stack, navigate, registerNavigationBlocker],
  );

  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  );
}

function paramOf(route: Route): string | number | null {
  if ("id" in route) return route.id;
  if ("path" in route) return route.path ?? null;
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
