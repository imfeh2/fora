import {
  BookText,
  ChartNoAxesCombined,
  MessagesSquare,
  Plus,
  Settings,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { OrganizationProvider, useResource } from "@/app/organization";
import {
  navIdOf,
  pageKeyOf,
  type Route,
  RouterProvider,
  useNavigate,
  useRouter,
} from "@/app/router";
import {
  Nav,
  NavItem,
  NavSubItem,
  PageTransition,
  Shell,
  Sidebar,
  SidebarBrand,
  useNarrowViewport,
} from "@/components/layout/shell";
import { AccessError, LoadError } from "@/components/ui/access-error";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ErrorFace } from "@/components/ui/error-face";
import {
  Button,
  dismissToast,
  IconButton,
  Skeleton,
  StateDot,
  Toaster,
  toast,
  UnreadMark,
} from "@/components/ui/index";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CreateDiscussionDialog } from "@/features/discussions/create";
import { DiscussionsPage } from "@/features/discussions/list";
import { ThreadPage } from "@/features/discussions/thread";
import { LibraryPage } from "@/features/library/list";
import { MembersPage } from "@/features/members/list";
import { SettingsPage } from "@/features/settings/page";
import {
  SettingsSaveProvider,
  useSettingsSaving,
} from "@/features/settings/saver";
import { UsagePage } from "@/features/usage";
import { BackendError, backend } from "@/lib/backend";
import "@/styles/App.css";

type ApplicationResource = "organization" | "discussions";

function View({
  route,
  tokenLimit,
  usageEntrySignal,
  focusDiscussionId,
  onComposerFocused,
  onDiscussionCreated,
}: {
  route: Route;
  tokenLimit: number | null;
  usageEntrySignal: number;
  focusDiscussionId: number | null;
  onComposerFocused: () => void;
  onDiscussionCreated: (id: number) => void;
}) {
  switch (route.name) {
    case "discussions":
      return <DiscussionsPage onCreated={onDiscussionCreated} />;
    case "discussion":
      return (
        <ThreadPage
          id={route.id}
          focusComposer={route.id === focusDiscussionId}
          onComposerFocused={onComposerFocused}
        />
      );
    case "members":
      return <MembersPage tokenLimit={tokenLimit} />;
    case "usage":
      return <UsagePage entrySignal={usageEntrySignal} />;
    case "library":
      return <LibraryPage path={route.path} />;
    case "settings":
      return <SettingsPage section={route.section} />;
  }
}

const CONNECTION_TOAST = "connection";
const REGION_READ_OPERATIONS = new Set([
  "agent.history.read",
  "agent.history.text",
  "agent.history.image",
  "usage.query",
  "usage.read",
]);
const COMPOSER_OPERATIONS = new Set([
  "discussion.send",
  "upload.create",
  "upload.status",
  "upload.cancel",
]);

function reconnect() {
  void backend.reconnect().catch(reportReconnectFailure);
}

function reportBackendFailure(error: BackendError) {
  const uncertain = error.code === "unconfirmed";
  const disconnected = backend.disconnected && !uncertain;
  toast({
    id: disconnected ? CONNECTION_TOAST : undefined,
    tone: "danger",
    title: uncertain
      ? "Check operation result"
      : disconnected
        ? "Connection lost"
        : "Request failed",
    description: error.message,
    duration: disconnected || uncertain ? null : undefined,
    closable: !disconnected,
    action: disconnected
      ? { label: "Reconnect", onClick: reconnect }
      : undefined,
  });
}

function reportReconnectFailure(error: unknown) {
  if (error instanceof BackendError && error.transport) return;
  reportBackendFailure(
    error instanceof BackendError
      ? error
      : new BackendError(
          "request_failed",
          error instanceof Error ? error.message : String(error),
        ),
  );
}

function Chrome({
  application,
}: {
  application: ReturnType<typeof useApplication>;
}) {
  const { organization, discussions, failure, retry, reconnecting, loading } =
    application;
  const members = organization.data?.members;
  const list = discussions.data;
  const { route } = useRouter();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [usageEntrySignal, setUsageEntrySignal] = useState(0);
  const [focusDiscussionId, setFocusDiscussionId] = useState<number | null>(
    null,
  );
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const desktopNavigation = useRef<HTMLDivElement>(null);
  const afterDrawer = useRef<(() => void) | null>(null);
  const narrow = useNarrowViewport();
  const onComposerFocused = useCallback(() => setFocusDiscussionId(null), []);
  const onDiscussionCreated = useCallback(
    (id: number) => {
      setFocusDiscussionId(id);
      navigate({ name: "discussion", id });
    },
    [navigate],
  );
  const restoreNavigationFocus = useCallback(
    () =>
      window.innerWidth <= 640
        ? menuTrigger.current
        : (desktopNavigation.current?.querySelector<HTMLElement>(
            '[aria-current="page"]',
          ) ?? null),
    [],
  );
  const drawerClosed = useCallback(() => {
    const next = afterDrawer.current;
    afterDrawer.current = null;
    next?.();
  }, []);
  const closeThen = (action: () => void) => {
    if (drawerOpen && narrow) {
      afterDrawer.current = action;
      setDrawerOpen(false);
    } else action();
  };
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);
  const settingsSaving = useSettingsSaving();
  const active = navIdOf(route);
  const unlisted =
    route.name === "discussion" && !list?.some((item) => item.id === route.id);
  const running = new Set(
    members
      ?.filter(
        (member) => member.type === "agent" && member.state === "running",
      )
      .map((member) => member.id),
  );
  const regionError =
    route.name === "discussion" && organization.data === null
      ? organization.error
      : null;

  const selectRoute = (next: Route) => {
    if (!settingsSaving)
      closeThen(() => {
        if (next.name === "usage") setUsageEntrySignal((value) => value + 1);
        navigate(next);
      });
  };

  if (failure && !application.connected)
    return (
      <div className="flex h-full min-h-0 flex-col bg-app">
        <AccessError
          error={failure}
          reconnect={() => void retry()}
          waiting={reconnecting || loading}
        />
      </div>
    );

  return (
    <Shell
      navigation={{
        open: drawerOpen,
        onOpenChange: setDrawerOpen,
        onClosed: drawerClosed,
        trigger: menuTrigger,
        desktop: desktopNavigation,
        restoreFocus: restoreNavigationFocus,
      }}
      sidebar={
        <Sidebar
          inert={settingsSaving}
          footer={
            <Nav label="Settings">
              <NavItem
                icon={<Settings size={16} />}
                label="Settings"
                active={active === "settings"}
                onSelect={() =>
                  selectRoute({
                    name: "settings",
                    section:
                      route.name === "settings" ? route.section : "model",
                  })
                }
              />
            </Nav>
          }
        >
          <SidebarBrand />
          <Nav label="Sections">
            <NavItem
              icon={<MessagesSquare size={16} />}
              label="Discussions"
              active={route.name === "discussions" || unlisted}
              trailing={
                <IconButton
                  size="sm"
                  label="New Discussion"
                  touchTarget
                  disabled={!organization.data || backend.disconnected}
                  onClick={() => {
                    if (!settingsSaving) closeThen(() => setCreating(true));
                  }}
                >
                  <Plus size={15} />
                </IconButton>
              }
              onSelect={() => selectRoute({ name: "discussions" })}
            >
              {list === null && !discussions.error && !failure ? (
                <li
                  aria-busy="true"
                  aria-label="Loading Discussions"
                  className="pl-10 pr-2"
                >
                  {["75%", "55%", "85%"].map((width) => (
                    <div key={width} className="flex h-[26px] items-center">
                      <Skeleton style={{ width }} />
                    </div>
                  ))}
                </li>
              ) : null}
              {discussions.error && !failure && route.name !== "discussions" ? (
                <li className="px-4 py-2 text-xs">
                  <p>{discussions.error.message}</p>
                  <Button
                    size="sm"
                    disabled={discussions.refreshing}
                    onClick={() =>
                      void application.retryResource("discussions")
                    }
                  >
                    Retry Discussions
                  </Button>
                </li>
              ) : null}
              {list?.map((item) => (
                <NavSubItem
                  key={item.id}
                  label={item.topic}
                  active={route.name === "discussion" && route.id === item.id}
                  badge={
                    <UnreadMark
                      key={`${item.mentions}-${item.unread}`}
                      mentions={item.mentions}
                      unread={item.unread}
                    />
                  }
                  indicator={
                    item.member_ids.some((id) => running.has(id)) ? (
                      <StateDot state="running" />
                    ) : undefined
                  }
                  onSelect={() =>
                    selectRoute({ name: "discussion", id: item.id })
                  }
                />
              ))}
            </NavItem>
            <NavItem
              icon={<Users size={16} />}
              label="Members"
              active={active === "members"}
              onSelect={() => selectRoute({ name: "members" })}
            />
            <NavItem
              icon={<ChartNoAxesCombined size={16} />}
              label="Usage"
              active={active === "usage"}
              onSelect={() => selectRoute({ name: "usage" })}
            />
            <NavItem
              icon={<BookText size={16} />}
              label="Library"
              active={active === "library"}
              onSelect={() => selectRoute({ name: "library" })}
            />
          </Nav>
        </Sidebar>
      }
    >
      {organization.error &&
      !failure &&
      route.name !== "members" &&
      !regionError ? (
        <div className="px-8">
          <LoadError
            error={organization.error}
            retry={() => void application.retryResource("organization")}
          />
        </div>
      ) : null}
      <PageTransition id={pageKeyOf(route)}>
        <div
          hidden={Boolean(regionError)}
          className={
            regionError ? "hidden" : "flex min-h-0 min-w-0 flex-1 flex-col"
          }
        >
          <View
            route={route}
            tokenLimit={organization.data?.token_limit ?? null}
            usageEntrySignal={usageEntrySignal}
            focusDiscussionId={focusDiscussionId}
            onComposerFocused={onComposerFocused}
            onDiscussionCreated={onDiscussionCreated}
          />
        </div>
        {regionError && !failure ? (
          <AccessError
            error={regionError}
            loadingData
            reconnect={() => void application.retryResource("organization")}
            waiting={organization.refreshing}
          />
        ) : null}
      </PageTransition>
      <CreateDiscussionDialog
        open={creating}
        onOpenChange={setCreating}
        restoreFocus={restoreNavigationFocus}
        onCreated={onDiscussionCreated}
      />
    </Shell>
  );
}

export function useApplication() {
  const organizationRead = useCallback(() => backend.organization(), []);
  const discussionsRead = useCallback(() => backend.discussions(), []);
  const {
    resource: organization,
    refresh: refreshOrganization,
    invalidate: invalidateOrganization,
  } = useResource(organizationRead);
  const {
    resource: discussions,
    refresh: refreshDiscussions,
    invalidate: invalidateDiscussions,
  } = useResource(discussionsRead);
  const [failure, setFailure] = useState<BackendError | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [indexError, setIndexError] = useState<BackendError | null>(null);
  const booted = useRef(false);
  const live = useRef(false);
  const generation = useRef(0);
  const timers = useRef<
    Partial<Record<ApplicationResource, ReturnType<typeof setTimeout>>>
  >({});
  const pending = useRef<Partial<Record<ApplicationResource, Promise<void>>>>(
    {},
  );
  const joined = useRef<Promise<void> | null>(null);
  const automaticRecovery = useRef(false);
  const loading = organization.refreshing || discussions.refreshing;

  const refreshResource = useCallback(
    (resource: ApplicationResource, changed = false) => {
      const timer = timers.current[resource];
      if (timer !== undefined) clearTimeout(timer);
      delete timers.current[resource];
      const operation =
        resource === "organization"
          ? refreshOrganization(changed)
          : refreshDiscussions(changed);
      pending.current[resource] = operation;
      void operation.finally(() => {
        if (pending.current[resource] === operation)
          delete pending.current[resource];
      });
      return operation;
    },
    [refreshOrganization, refreshDiscussions],
  );

  const refreshOrganizationResource = useCallback(
    (changed = false) => refreshResource("organization", changed),
    [refreshResource],
  );
  const refreshDiscussionsResource = useCallback(
    (changed = false) => refreshResource("discussions", changed),
    [refreshResource],
  );

  const refresh = useCallback(() => {
    if (joined.current) return joined.current;
    const operation = Promise.all([
      refreshResource("organization"),
      refreshResource("discussions"),
    ])
      .then(() => {})
      .finally(() => {
        if (joined.current === operation) joined.current = null;
      });
    joined.current = operation;
    return operation;
  }, [refreshResource]);

  const retry = useCallback((): Promise<void> => {
    if (backend.disconnected)
      return backend.reconnect().catch(reportReconnectFailure);
    return refresh();
  }, [refresh]);

  const retryResource = useCallback(
    (resource: ApplicationResource) => {
      if (backend.disconnected) return retry();
      if (resource === "organization") setIndexError(null);
      return refreshResource(resource);
    },
    [refreshResource, retry],
  );

  useEffect(() => {
    live.current = true;
    const invalidate = () => {
      generation.current += 1;
      pending.current = {};
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
      timers.current = {};
      joined.current = null;
      invalidateOrganization(false);
      invalidateDiscussions(false);
    };
    const recover = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine)
        return false;
      automaticRecovery.current = false;
      const operation = backend.reconnect(true);
      if (!automaticRecovery.current) return false;
      void operation.catch(reportReconnectFailure);
      return true;
    };
    const offFailure = backend.onFailure((error) => {
      if (
        error.code === "timeout" &&
        error.operation !== null &&
        (REGION_READ_OPERATIONS.has(error.operation) ||
          error.operation === "organization.get" ||
          error.operation === "discussion.list" ||
          error.operation === "usage.advance")
      )
        return;
      if (
        error.code === "unconfirmed" &&
        error.operation !== null &&
        COMPOSER_OPERATIONS.has(error.operation)
      )
        return;
      if (
        backend.disconnected &&
        error.transport &&
        error.code !== "unconfirmed"
      )
        return;
      if (backend.disconnected) setReconnecting(false);
      if (booted.current) reportBackendFailure(error);
      else if (backend.disconnected) setFailure(error);
    });
    const offEvent = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        invalidate();
        const recovered = recover();
        if (!recovered) {
          setReconnecting(false);
          if (event.error instanceof BackendError) {
            setFailure(event.error);
            if (booted.current) reportBackendFailure(event.error);
          }
        }
        return;
      }
      if (event.type === "connection.reconnecting") {
        automaticRecovery.current = true;
        setReconnecting(true);
        return;
      }
      if (event.type === "connection.restored") {
        booted.current = true;
        dismissToast(CONNECTION_TOAST);
        setReconnecting(false);
        setFailure(null);
        setIndexError(null);
        invalidateOrganization(true);
        invalidateDiscussions(true);
        void refresh();
        return;
      }
      if (backend.disconnected) return;
      const resources: ApplicationResource[] = [];
      if (
        event.type === "organization.changed" ||
        event.type === "settings.updated" ||
        event.type.startsWith("member.") ||
        event.type === "usage.updated" ||
        event.type === "usage.index_updated" ||
        event.type === "turn.started" ||
        event.type === "turn.finished"
      )
        resources.push("organization");
      if (
        event.type === "message.created" ||
        event.type === "discussion.read_updated" ||
        event.type === "discussion.created" ||
        event.type === "discussion.updated"
      )
        resources.push("discussions");
      for (const resource of resources) {
        if (pending.current[resource] || event.type === "turn.finished")
          void refreshResource(resource, true);
        else if (timers.current[resource] === undefined)
          timers.current[resource] = setTimeout(() => {
            delete timers.current[resource];
            void refreshResource(resource, true);
          }, 150);
      }
    });
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    const epoch = generation.current;
    backend.connect().then(
      () => {
        if (live.current && epoch === generation.current) {
          booted.current = true;
          setFailure(null);
          invalidateOrganization(true);
          invalidateDiscussions(true);
          void refresh();
        }
      },
      (error: unknown) => {
        if (live.current && epoch === generation.current)
          setFailure(
            error instanceof BackendError
              ? error
              : new BackendError(
                  "startup_failed",
                  error instanceof Error ? error.message : String(error),
                ),
          );
      },
    );
    return () => {
      live.current = false;
      invalidate();
      offEvent();
      offFailure();
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recover);
      dismissToast(CONNECTION_TOAST);
    };
  }, [refresh, refreshResource, invalidateOrganization, invalidateDiscussions]);

  useEffect(() => {
    if (
      !organization.data?.usage_version ||
      organization.data.usage_version.index.ready ||
      organization.error ||
      indexError ||
      backend.disconnected
    )
      return;
    let active = true;
    const epoch = generation.current;
    void backend.usageAdvance().then(
      () => {
        if (active && live.current && epoch === generation.current)
          void refreshResource("organization", true);
      },
      (error: unknown) => {
        if (active && live.current && epoch === generation.current)
          setIndexError(
            error instanceof BackendError
              ? error
              : new BackendError(
                  "request_failed",
                  error instanceof Error ? error.message : String(error),
                ),
          );
      },
    );
    return () => {
      active = false;
    };
  }, [organization.data, organization.error, indexError, refreshResource]);

  return {
    organization:
      indexError && organization.status === "ready"
        ? { ...organization, error: organization.error ?? indexError }
        : organization,
    discussions,
    failure,
    reconnecting,
    connected: booted.current,
    loading,
    refresh,
    retry,
    retryResource,
    refreshOrganization: refreshOrganizationResource,
    refreshDiscussions: refreshDiscussionsResource,
  };
}

export default function App() {
  const application = useApplication();
  return (
    <ErrorBoundary
      fallback={() => (
        <div className="flex h-full min-h-0 flex-col bg-app">
          <ErrorFace
            title="Something went wrong"
            description="Fora could not display this window. Reload to start again."
            action={{ label: "Reload", run: () => window.location.reload() }}
          />
        </div>
      )}
    >
      <TooltipProvider>
        <RouterProvider>
          <OrganizationProvider
            value={{
              members: application.organization.data?.members ?? null,
              humanId: application.organization.data?.human_id ?? null,
              discussions: application.discussions.data,
              refresh: application.refresh,
              connectionError: application.failure,
              organizationError: application.organization.error,
              discussionsError: application.discussions.error,
              retry: application.retryResource,
            }}
          >
            <SettingsSaveProvider>
              <Chrome application={application} />
            </SettingsSaveProvider>
          </OrganizationProvider>
        </RouterProvider>
        <Toaster />
      </TooltipProvider>
    </ErrorBoundary>
  );
}
