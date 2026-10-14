import { clsx } from "clsx";
import {
  Archive,
  ArchiveRestore,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrganization, useResource } from "@/app/organization";
import { useNavigate } from "@/app/router";
import {
  type Column,
  Page,
  PageBody,
  PageHeader,
  RowLink,
  Table,
  Toolbar,
  useNarrowViewport,
} from "@/components/layout/shell";
import { LoadError } from "@/components/ui/access-error";
import {
  Badge,
  Button,
  Chip,
  CountPill,
  Dot,
  dismissToast,
  IconButton,
  LoadingSkeleton,
  SearchField,
  Skeleton,
  StatusText,
  toast,
} from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { StatePanel } from "@/components/ui/state-panel";
import { CreateDiscussionDialog } from "@/features/discussions/create";
import {
  BackendError,
  backend,
  type DiscussionSummary,
  type FoundMessage,
  type Member,
} from "@/lib/backend";
import { plural } from "@/lib/format";

type Segment = { id: string; text: string; match: boolean };

function segments(text: string, query: string): Segment[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ id: "s0", text, match: false }];
  const found: Segment[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  let count = 0;
  let at = haystack.indexOf(needle, from);
  while (at >= 0) {
    if (at > from)
      found.push({
        id: `s${count++}`,
        text: text.slice(from, at),
        match: false,
      });
    found.push({
      id: `s${count++}`,
      text: text.slice(at, at + needle.length),
      match: true,
    });
    from = at + needle.length;
    at = haystack.indexOf(needle, from);
  }
  if (from < text.length)
    found.push({ id: `s${count++}`, text: text.slice(from), match: false });
  return found;
}

const LIST_COLUMNS: Column[] = [
  { key: "topic", label: "Discussion" },
  { key: "members", label: "Members", hideBelow: "md" },
  { key: "unread", label: "Unread", align: "end", width: "96px" },
  { key: "status", label: "Status", width: "168px" },
  { key: "actions", label: "", width: "56px" },
];

const RESULT_COLUMNS: Column[] = [
  { key: "message", label: "Message" },
  { key: "sender", label: "Sender", width: "180px", hideBelow: "sm" },
  { key: "discussion", label: "Discussion", width: "220px" },
];

export function DiscussionsPage({
  onCreated,
}: {
  onCreated?: (id: number) => void;
} = {}) {
  const {
    members,
    humanId,
    discussions,
    organizationError,
    discussionsError,
    connectionError,
    retry,
  } = useOrganization();
  const navigate = useNavigate();
  const readArchived = useCallback(() => backend.discussions(true), []);
  const {
    resource: archiveResource,
    refresh: refreshArchived,
    invalidate: invalidateArchived,
  } = useResource(readArchived);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{
    query: string;
    items: FoundMessage[];
  } | null>(null);
  const results = search?.query === query.trim() ? search.items : null;
  const [archived, setArchived] = useState(false);
  const list = archived ? archiveResource.data : discussions;
  const [creating, setCreating] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState<number | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const load = useCallback(
    (changed = false) => {
      clearTimer();
      const operation = refreshArchived(changed);
      pending.current = operation;
      void operation.finally(() => {
        if (pending.current === operation) pending.current = null;
      });
      return operation;
    },
    [clearTimer, refreshArchived],
  );

  useEffect(() => {
    let enabled = archived && !backend.disconnected;
    invalidateArchived(enabled);
    const off = backend.onEvent((event) => {
      if (event.type === "connection.closed") {
        enabled = false;
        clearTimer();
        pending.current = null;
        invalidateArchived(
          false,
          event.error instanceof BackendError ? event.error : undefined,
        );
        return;
      }
      if (event.type === "connection.restored") {
        setConnectionRevision((value) => value + 1);
        enabled = archived;
        invalidateArchived(enabled);
        if (enabled) void load();
        return;
      }
      if (
        enabled &&
        (event.type === "message.created" ||
          event.type === "discussion.read_updated" ||
          event.type === "mention.acked" ||
          event.type === "mention.revoked" ||
          event.type === "discussion.created" ||
          event.type === "discussion.updated")
      ) {
        if (pending.current) void load(true);
        else if (timer.current === null)
          timer.current = setTimeout(() => {
            timer.current = null;
            void load(true);
          }, 150);
      }
    });
    if (enabled) void load();
    return () => {
      enabled = false;
      clearTimer();
      pending.current = null;
      off();
      invalidateArchived(false);
    };
  }, [archived, clearTimer, load, invalidateArchived]);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setSearch(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void backend
        .searchMessages(text)
        .then((found) => {
          if (live) setSearch({ query: text, items: found });
        })
        .catch(backend.reportFailure);
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, connectionRevision]);

  const byId = useMemo(
    () => new Map(members?.map((member) => [member.id, member] as const)),
    [members],
  );

  const topicOf = (id: number) =>
    list?.find((item) => item.id === id)?.topic ?? `Discussion ${id}`;

  const searching = query.trim().length > 0;
  const narrow = useNarrowViewport();

  const archive = async (item: DiscussionSummary) => {
    if (archiveBusy !== null || members === null || backend.disconnected)
      return;
    setArchiveBusy(item.id);
    try {
      await backend.archiveDiscussion(item.id, !item.archived);
      dismissToast(`discussion-archive:${item.id}`);
      if (archived) await load(true);
      else await retry("discussions");
    } catch (failure) {
      if (failure instanceof BackendError && failure.transport)
        backend.reportFailure(failure);
      else
        toast({
          id: `discussion-archive:${item.id}`,
          tone: "danger",
          title: item.archived
            ? "Could not unarchive Discussion"
            : "Could not archive Discussion",
          description:
            failure instanceof Error ? failure.message : String(failure),
          duration: null,
        });
    } finally {
      setArchiveBusy(null);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Discussions"
        actions={
          <Button
            variant="primary"
            disabled={
              members === null || humanId === null || backend.disconnected
            }
            onClick={() => setCreating(true)}
          >
            <Plus size={16} />
            New Discussion
          </Button>
        }
      />
      <Toolbar>
        <SearchField
          icon={<Search size={15} />}
          value={query}
          placeholder="Search messages"
          aria-label="Search messages"
          onChange={(event) => setQuery(event.target.value)}
        />
        <IconButton
          label="Show archived"
          pressed={archived}
          onClick={() => setArchived((current) => !current)}
        >
          <Archive size={15} />
        </IconButton>
      </Toolbar>
      <PageBody>
        {archived &&
        archiveResource.error &&
        !(archiveResource.error.transport && backend.disconnected) ? (
          <LoadError error={archiveResource.error} retry={() => void load()} />
        ) : null}
        {!archived && discussionsError && !connectionError ? (
          <LoadError
            error={discussionsError}
            retry={() => void retry("discussions")}
          />
        ) : null}
        {(searching ? results !== null : list !== null) ? (
          <CountPill>
            {results
              ? plural(results.length, "result")
              : plural(list?.length ?? 0, "Discussion")}
          </CountPill>
        ) : null}

        {searching ? (
          results === null ? null : results.length === 0 ? (
            <StatePanel
              icons={[MessageCircle, Search, MessagesSquare]}
              title="No messages match"
              description="Try a different search or clear it to see your Discussions."
              action={{
                label: "Clear search",
                icon: <X size={16} />,
                onClick: () => setQuery(""),
              }}
            />
          ) : narrow ? (
            <div
              className="flex min-w-0 max-w-full flex-col gap-3"
              role="feed"
              aria-label="Search results"
            >
              {results.map((result) => (
                <div
                  key={`${result.discussion_id}-${result.id}`}
                  className="relative flex min-w-0 max-w-full flex-col gap-2 p-3 border border-line rounded-md bg-surface hover:bg-surface-hover/50"
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 [&>span]:min-w-0 [&>span]:max-w-full [&>span]:h-auto [&>span]:min-h-5 [&>span]:whitespace-normal [&>span]:wrap-anywhere">
                    <Chip>{topicOf(result.discussion_id)}</Chip>
                    <span className="text-xs text-fg-muted">
                      {result.sender_name}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="min-w-0 max-w-full min-h-11 p-0 border-0 rounded-xs bg-transparent text-left font-normal text-fg-muted whitespace-normal wrap-anywhere cursor-pointer [&_mark]:bg-blue-500/30 [&_mark]:rounded-xs [&_mark]:text-fg [&_mark]:font-medium"
                    onClick={() =>
                      navigate({
                        name: "discussion",
                        id: result.discussion_id,
                      })
                    }
                  >
                    {segments(result.body, query).map((part) =>
                      part.match ? (
                        <mark key={part.id}>{part.text}</mark>
                      ) : (
                        <span key={part.id}>{part.text}</span>
                      ),
                    )}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <Table columns={RESULT_COLUMNS} label="Search results">
              {results.map((result) => (
                <tr key={`${result.discussion_id}-${result.id}`}>
                  <td>
                    <RowLink
                      primary={
                        <span className="block truncate font-normal text-fg-muted [&_mark]:bg-blue-500/30 [&_mark]:rounded-xs [&_mark]:text-fg [&_mark]:font-medium">
                          {segments(result.body, query).map((part) =>
                            part.match ? (
                              <mark key={part.id}>{part.text}</mark>
                            ) : (
                              <span key={part.id}>{part.text}</span>
                            ),
                          )}
                        </span>
                      }
                      onSelect={() =>
                        navigate({
                          name: "discussion",
                          id: result.discussion_id,
                        })
                      }
                    />
                  </td>
                  <td data-hide-below="sm" className="text-fg-muted">
                    {result.sender_name}
                  </td>
                  <td>
                    <Chip>{topicOf(result.discussion_id)}</Chip>
                  </td>
                </tr>
              ))}
            </Table>
          )
        ) : list === null ? (
          connectionError ||
          (archived ? archiveResource.error : discussionsError) ? null : (
            <LoadingSkeleton label="Loading Discussions">
              {narrow ? (
                <div className="flex min-w-0 max-w-full flex-col gap-3">
                  {["75%", "55%", "85%"].map((width) => (
                    <div
                      key={width}
                      className="flex min-w-0 max-w-full flex-col gap-2 p-3 border border-line rounded-md bg-surface"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Skeleton className="size-7 flex-none" />
                        <div className="flex min-w-0 flex-1 items-center min-h-11">
                          <Skeleton style={{ width }} className="h-5" />
                        </div>
                        <Skeleton className="size-11 flex-none" />
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <Skeleton className="h-5 w-28 max-w-full" />
                        <Skeleton className="h-5 w-20 max-w-full" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Table columns={LIST_COLUMNS} label="Discussions">
                  {["75%", "55%", "85%"].map((width) => (
                    <tr key={width}>
                      <td>
                        <Skeleton style={{ width }} className="h-7" />
                      </td>
                      <td data-hide-below="md">
                        <Skeleton className="w-24" />
                      </td>
                      <td>
                        <Skeleton className="w-8" />
                      </td>
                      <td>
                        <Skeleton className="w-20" />
                      </td>
                      <td>
                        <Skeleton className="size-6" />
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </LoadingSkeleton>
          )
        ) : list.length === 0 ? (
          <StatePanel
            icons={[MessageCircle, MessagesSquare, MessageSquare]}
            title="No Discussions yet"
            description="Create a Discussion to bring Members together."
            action={
              members !== null && humanId !== null && !backend.disconnected
                ? {
                    label: "New Discussion",
                    icon: <Plus size={16} />,
                    onClick: () => setCreating(true),
                  }
                : undefined
            }
          />
        ) : narrow ? (
          <div
            className="flex min-w-0 max-w-full flex-col gap-3"
            role="feed"
            aria-label="Discussions"
          >
            {list.map((item) => (
              <DiscussionCard
                key={item.id}
                item={item}
                byId={byId}
                onOpen={() => navigate({ name: "discussion", id: item.id })}
                archiveBusy={archiveBusy === item.id}
                onArchive={() => void archive(item)}
              />
            ))}
          </div>
        ) : (
          <Table columns={LIST_COLUMNS} label="Discussions">
            {list.map((item) => (
              <DiscussionRow
                key={item.id}
                item={item}
                byId={byId}
                membersPending={
                  members === null && !organizationError && !connectionError
                }
                onOpen={() => navigate({ name: "discussion", id: item.id })}
                archiveBusy={
                  archiveBusy === item.id ||
                  members === null ||
                  backend.disconnected
                }
                onArchive={() => void archive(item)}
              />
            ))}
          </Table>
        )}
      </PageBody>

      <CreateDiscussionDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={onCreated ?? ((id) => navigate({ name: "discussion", id }))}
      />
    </Page>
  );
}

export function DiscussionCard({
  item,
  byId,
  onOpen,
  onArchive,
  archiveBusy = false,
}: {
  item: DiscussionSummary;
  byId: Map<number, Member> | null;
  onOpen: () => void;
  onArchive: () => void;
  archiveBusy?: boolean;
}) {
  const people = item.member_ids
    .map((id) => byId?.get(id))
    .filter((member): member is Member => member !== undefined);
  const shown = people.slice(0, 3);
  const rest = people.length - shown.length;

  return (
    <div
      data-highlight={item.unread > 0}
      className={clsx(
        "relative flex min-w-0 max-w-full flex-col gap-2 p-3 border border-line rounded-md bg-surface transition-[background-color] duration-(--duration-fast) hover:bg-surface-hover/50",
        item.unread > 0 && "border-blue-500/40 bg-surface-raised",
      )}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            className="flex size-7 flex-none items-center justify-center rounded-sm border border-line bg-gray-800 text-fg-muted"
            aria-hidden="true"
          >
            <MessageSquare size={15} />
          </span>
          <button
            type="button"
            className="flex-1 min-w-0 max-w-full min-h-11 p-0 border-0 rounded-xs bg-transparent text-fg text-left font-semibold whitespace-normal wrap-anywhere cursor-pointer"
            onClick={onOpen}
          >
            {item.topic}
          </button>
        </div>
        <div className="relative z-10 flex items-center gap-1.5 flex-none">
          {item.unread > 0 ? <Badge tone="unread">{item.unread}</Badge> : null}
          <OverflowMenu
            label={`Actions for ${item.topic}`}
            actions={[
              {
                id: "archive",
                label: item.archived ? "Unarchive" : "Archive",
                icon: item.archived ? (
                  <ArchiveRestore size={15} />
                ) : (
                  <Archive size={15} />
                ),
                disabled: archiveBusy,
                onSelect: onArchive,
              },
            ]}
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 max-w-full flex-wrap gap-1 [&>span]:min-w-0 [&>span]:max-w-full [&>span]:h-auto [&>span]:min-h-5 [&>span]:whitespace-normal [&>span]:wrap-anywhere">
          {byId === null ? <Skeleton className="h-5 w-28" /> : null}
          {shown.map((member) => (
            <Chip
              key={member.id}
              tone={member.type === "agent" ? "blue" : "neutral"}
            >
              {member.name}
            </Chip>
          ))}
          {rest > 0 ? <Chip>+{rest}</Chip> : null}
        </div>
        <div className="min-w-0 max-w-full [&>span]:max-w-full [&>span]:whitespace-normal [&>span]:wrap-anywhere">
          {item.archived ? (
            <StatusText dot={<Dot tone="grey" />}>
              <span className="text-fg-muted">Archived</span>
            </StatusText>
          ) : item.unread > 0 ? (
            <StatusText dot={<Dot tone="blue" />}>
              {plural(item.unread, "new message")}
            </StatusText>
          ) : (
            <StatusText dot={<Dot tone="green" />}>{null}</StatusText>
          )}
        </div>
      </div>
    </div>
  );
}

export function DiscussionRow({
  item,
  byId,
  onOpen,
  onArchive,
  archiveBusy = false,
  membersPending = false,
}: {
  item: DiscussionSummary;
  byId: Map<number, Member> | null;
  onOpen: () => void;
  onArchive: () => void;
  archiveBusy?: boolean;
  membersPending?: boolean;
}) {
  const people = item.member_ids
    .map((id) => byId?.get(id))
    .filter((member): member is Member => member !== undefined);
  const shown = people.slice(0, 3);
  const rest = people.length - shown.length;

  return (
    <tr data-highlight={item.unread > 0}>
      <td>
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex size-7 flex-none items-center justify-center rounded-sm border border-line bg-gray-800 text-fg-muted"
            aria-hidden="true"
          >
            <MessageSquare size={15} />
          </span>
          <RowLink primary={item.topic} onSelect={onOpen} />
        </div>
      </td>
      <td data-hide-below="md">
        <div className="flex flex-wrap gap-1">
          {membersPending ? <Skeleton className="w-24" /> : null}
          {shown.map((member) => (
            <Chip
              key={member.id}
              tone={member.type === "agent" ? "blue" : "neutral"}
            >
              {member.name}
            </Chip>
          ))}
          {rest > 0 ? <Chip>+{rest}</Chip> : null}
        </div>
      </td>
      <td data-align="end" className="tabular-nums whitespace-nowrap">
        {item.unread > 0 ? (
          <Badge tone="unread">{item.unread}</Badge>
        ) : (
          <span className="text-fg-muted">—</span>
        )}
      </td>
      <td>
        {item.archived ? (
          <StatusText dot={<Dot tone="grey" />}>
            <span className="text-fg-muted">Archived</span>
          </StatusText>
        ) : item.unread > 0 ? (
          <StatusText dot={<Dot tone="blue" />}>
            {plural(item.unread, "new message")}
          </StatusText>
        ) : (
          <StatusText dot={<Dot tone="green" />}>{null}</StatusText>
        )}
      </td>
      <td className="relative z-1 w-12 text-right">
        <OverflowMenu
          label={`Actions for ${item.topic}`}
          actions={[
            {
              id: "archive",
              label: item.archived ? "Unarchive" : "Archive",
              icon: item.archived ? (
                <ArchiveRestore size={15} />
              ) : (
                <Archive size={15} />
              ),
              disabled: archiveBusy,
              onSelect: onArchive,
            },
          ]}
        />
      </td>
    </tr>
  );
}
