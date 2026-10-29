import { clsx } from "clsx";
import {
  Bot,
  Pause,
  Play,
  Plus,
  Search,
  SquarePen,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useOrganization } from "@/app/organization";
import {
  Page,
  PageBody,
  PageHeader,
  useNarrowViewport,
} from "@/components/layout/shell";
import { LoadError } from "@/components/ui/access-error";
import { ConfirmDialog, PromptDialog } from "@/components/ui/dialog";
import {
  Avatar,
  Button,
  Chip,
  LoadingSkeleton,
  SearchField,
  Skeleton,
  StateDot,
  StatusText,
} from "@/components/ui/index";
import { type MenuAction, OverflowMenu } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/segmented";
import { StatePanel } from "@/components/ui/state-panel";
import { agentStateLabel, canResume } from "@/features/members/state";
import { AgentCreateDialog } from "@/features/settings/model";
import { backend, type Member } from "@/lib/backend";

type Filter = "all" | "agents" | "humans";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "agents", label: "Agents" },
  { value: "humans", label: "Humans" },
];

export function memberActions(
  member: Member,
  on: { toggle: () => void; rename: () => void; remove: () => void },
): MenuAction[] {
  const rename: MenuAction = {
    id: "rename",
    label: "Rename",
    icon: <SquarePen size={15} />,
    onSelect: on.rename,
  };
  if (member.type !== "agent") return [rename];
  const paused = canResume(member);
  return [
    {
      id: "toggle",
      label: paused ? "Resume" : "Pause",
      icon: paused ? <Play size={15} /> : <Pause size={15} />,
      onSelect: on.toggle,
    },
    rename,
    {
      id: "delete",
      label: "Delete",
      icon: <Trash2 size={15} />,
      tone: "danger",
      disabled: member.state === "running",
      onSelect: on.remove,
    },
  ];
}

export function MembersPage() {
  const { members, refresh, organizationError, connectionError, retry } =
    useOrganization();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Member | null>(null);
  const [doomed, setDoomed] = useState<Member | null>(null);

  const shown = useMemo(() => {
    if (members === null) return null;
    const needle = query.trim().toLowerCase();
    return members.filter((member) => {
      if (filter === "agents" && member.type !== "agent") return false;
      if (filter === "humans" && member.type !== "human") return false;
      return !needle || member.name.toLowerCase().includes(needle);
    });
  }, [members, query, filter]);
  const noAgents =
    filter === "agents" &&
    !query.trim() &&
    members !== null &&
    !members.some((member) => member.type === "agent");
  const narrow = useNarrowViewport();

  return (
    <Page>
      <PageHeader
        wrap
        title="Members"
        actions={
          <Button
            variant="primary"
            disabled={members === null || backend.disconnected}
            onClick={() => setCreating(true)}
          >
            <Plus size={16} />
            New Agent
          </Button>
        }
      />
      <div className="flex min-w-0 flex-wrap items-center gap-3 px-8 pb-4 max-[940px]:px-6 [@media(max-width:640px)]:px-3">
        <SearchField
          icon={<Search size={15} />}
          value={query}
          placeholder="Search Members"
          aria-label="Search Members"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Segmented
          label="Filter by kind"
          value={filter}
          options={FILTERS}
          onChange={setFilter}
        />
      </div>
      <PageBody>
        {organizationError && !connectionError ? (
          <LoadError
            error={organizationError}
            retry={() => void retry("organization")}
          />
        ) : null}
        {shown === null ? (
          organizationError || connectionError ? null : (
            <LoadingSkeleton label="Loading Members">
              <div className="flex flex-col rounded-md border border-line bg-surface divide-y divide-line">
                {[1, 2, 3, 4].map((row) => (
                  <div
                    key={row}
                    className="flex min-h-12 items-center gap-3 px-4 py-2"
                  >
                    <Skeleton className="size-[26px] shrink-0 rounded-sm" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <Skeleton className="w-30 max-w-full" />
                      <Skeleton className="w-20 max-w-full" />
                    </div>
                    <Skeleton className="h-7 w-20" />
                  </div>
                ))}
              </div>
            </LoadingSkeleton>
          )
        ) : shown.length === 0 ? (
          <StatePanel
            icons={noAgents ? [User, Bot, Users] : [User, Search, Users]}
            title={noAgents ? "No Agents yet" : "No Members match"}
            action={
              noAgents
                ? {
                    label: "New Agent",
                    icon: <Plus size={16} />,
                    onClick: () => setCreating(true),
                  }
                : {
                    label: "Clear filters",
                    icon: <X size={16} />,
                    onClick: () => {
                      setQuery("");
                      setFilter("all");
                    },
                  }
            }
          />
        ) : narrow ? (
          <div className="flex flex-col gap-3" role="feed" aria-label="Members">
            {shown.map((member) => (
              <MemberCard
                key={member.id}
                member={member}
                onToggle={async () => {
                  await (canResume(member)
                    ? backend.resumeAgent(member.id)
                    : backend.pauseAgent(member.id));
                  await refresh();
                }}
                onRename={() => setRenaming(member)}
                onDelete={() => setDoomed(member)}
              />
            ))}
          </div>
        ) : (
          <ul
            aria-label="Members"
            className="flex flex-col rounded-md border border-line bg-surface divide-y divide-line"
          >
            {shown.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                onToggle={async () => {
                  await (canResume(member)
                    ? backend.resumeAgent(member.id)
                    : backend.pauseAgent(member.id));
                  await refresh();
                }}
                onRename={() => setRenaming(member)}
                onDelete={() => setDoomed(member)}
              />
            ))}
          </ul>
        )}
      </PageBody>

      {creating ? (
        <AgentCreateDialog
          onClose={() => setCreating(false)}
          onCreated={refresh}
        />
      ) : null}
      <PromptDialog
        open={renaming !== null}
        onOpenChange={(next) => !next && setRenaming(null)}
        title="Rename Member"
        protectUnsaved
        label="Name"
        initial={renaming?.name ?? ""}
        submitLabel="Rename"
        onSubmit={async (name) => {
          if (renaming) await backend.renameMember(renaming.id, name);
          await refresh();
        }}
      />
      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(next) => !next && setDoomed(null)}
        title={`Delete ${doomed?.name ?? ""}?`}
        description="Its Workspace and history are removed. This cannot be undone."
        confirmLabel="Delete Agent"
        onConfirm={async () => {
          if (doomed) await backend.deleteAgent(doomed.id);
          setDoomed(null);
          await refresh();
        }}
      />
    </Page>
  );
}

export function MemberCard({
  member,
  onToggle,
  onRename,
  onDelete,
}: {
  member: Member;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const agent = member.type === "agent";

  return (
    <div className="relative flex flex-col gap-2.5 p-3 border border-line rounded-md bg-surface transition-[background-color] duration-(--duration-fast) hover:bg-surface-hover/50">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar memberId={member.id} />
          <div className="flex min-w-0 flex-col gap-0.5">
            {agent ? (
              <span className="min-w-0 max-w-full self-start text-left font-semibold wrap-anywhere">
                {member.name}
              </span>
            ) : (
              <span className="min-w-0 truncate font-semibold">
                {member.name}
              </span>
            )}
            <div className="flex items-center gap-1.5">
              <Chip tone={agent ? "blue" : "neutral"}>
                {agent ? <Bot size={12} /> : <User size={12} />}
                {agent ? "Agent" : "Human"}
              </Chip>
            </div>
          </div>
        </div>
        <div className="relative z-10 flex items-center gap-2 flex-none">
          <OverflowMenu
            label={`Actions for ${member.name}`}
            actions={memberActions(member, {
              toggle: onToggle,
              rename: onRename,
              remove: onDelete,
            })}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1 border-t border-line/50 text-xs">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {agent ? (
            <StatusText
              dot={
                <StateDot
                  state={member.state}
                  ping={member.state === "running"}
                />
              }
            >
              {agentStateLabel(member)}
            </StatusText>
          ) : (
            <span className="text-fg-muted">—</span>
          )}
          {agent && member.pause_requested && member.state === "running" ? (
            <span className="text-warning wrap-anywhere">Pause requested</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MemberRow({
  member,
  onToggle,
  onRename,
  onDelete,
}: {
  member: Member;
  onToggle: () => void | Promise<void>;
  onRename: () => void;
  onDelete: () => void;
}) {
  const agent = member.type === "agent";
  const paused = canResume(member);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const toggle = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await onToggle();
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <li className="relative flex min-w-0 min-h-12 flex-wrap items-center gap-3 px-4 py-2 hover:bg-surface-hover [@media(max-width:640px)]:grid [@media(max-width:640px)]:grid-cols-[auto_minmax(0,1fr)]">
      <Avatar memberId={member.id} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {agent ? (
          <span className="min-w-0 max-w-full self-start text-left font-semibold wrap-anywhere">
            {member.name}
          </span>
        ) : (
          <span className="min-w-0 font-semibold wrap-anywhere">
            {member.name}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Chip tone={agent ? "blue" : "neutral"}>
            {agent ? <Bot size={12} /> : <User size={12} />}
            {agent ? "Agent" : "Human"}
          </Chip>
          {agent ? (
            <StatusText
              dot={
                <StateDot
                  state={member.state}
                  ping={member.state === "running"}
                />
              }
            >
              {agentStateLabel(member)}
            </StatusText>
          ) : null}
          {agent && member.pause_requested && member.state === "running" ? (
            <span className="text-warning wrap-anywhere">Pause requested</span>
          ) : null}
        </div>
      </div>
      <div
        className={clsx(
          "relative z-1 ml-auto flex min-w-0 flex-wrap items-center gap-2 [@media(max-width:640px)]:col-span-2 [@media(max-width:640px)]:w-full [@media(max-width:640px)]:justify-end",
        )}
      >
        <Button
          size="sm"
          disabled={pending}
          onClick={agent ? () => void toggle() : onRename}
        >
          {agent ? (
            paused ? (
              <Play size={14} />
            ) : (
              <Pause size={14} />
            )
          ) : (
            <SquarePen size={14} />
          )}
          {agent ? (paused ? "Resume" : "Pause") : "Rename"}
        </Button>
        <OverflowMenu
          label={`Actions for ${member.name}`}
          actions={memberActions(member, {
            toggle: onToggle,
            rename: onRename,
            remove: onDelete,
          }).filter((action) => action.id !== "toggle")}
        />
      </div>
      {error ? (
        <p
          role="alert"
          className="relative z-1 w-full text-sm text-danger wrap-anywhere [@media(max-width:640px)]:col-span-2"
        >
          {error}
        </p>
      ) : null}
    </li>
  );
}
