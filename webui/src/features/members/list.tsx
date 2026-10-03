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
import { useMemo, useState } from "react";
import { useOrganization } from "@/app/organization";
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
import { ConfirmDialog, PromptDialog } from "@/components/ui/dialog";
import {
  Avatar,
  Button,
  Chip,
  CountPill,
  LoadingSkeleton,
  Meter,
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
import { plural } from "@/lib/format";

const COLUMNS: Column[] = [
  { key: "member", label: "Member" },
  { key: "kind", label: "Kind", width: "120px", hideBelow: "md" },
  { key: "spend", label: "Token spend", align: "end", width: "180px" },
  { key: "state", label: "State", width: "150px" },
  { key: "actions", label: "", width: "56px" },
];

type Filter = "all" | "agents" | "humans";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "agents", label: "Agents" },
  { value: "humans", label: "Humans" },
];

const COUNTED: Record<Filter, string> = {
  all: "Member",
  agents: "Agent",
  humans: "Human",
};

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

export function MembersPage({ tokenLimit }: { tokenLimit: number | null }) {
  const { members, refresh, organizationError, connectionError, retry } =
    useOrganization();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Member | null>(null);
  const [doomed, setDoomed] = useState<Member | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return members?.filter((member) => {
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
      <Toolbar>
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
      </Toolbar>
      <PageBody>
        {organizationError ? (
          <LoadError
            error={organizationError}
            retry={() => void retry("organization")}
          />
        ) : null}
        {shown ? (
          <CountPill>{plural(shown.length, COUNTED[filter])}</CountPill>
        ) : null}
        {shown === undefined ? (
          organizationError || connectionError ? null : (
            <LoadingSkeleton label="Loading Members">
              <Table columns={COLUMNS} label="Members">
                {[1, 2, 3, 4].map((row) => (
                  <tr key={row}>
                    <td>
                      <div className="flex items-center gap-3">
                        <Skeleton className="size-7 shrink-0 rounded-full" />
                        <Skeleton className="w-30 max-w-full" />
                      </div>
                    </td>
                    <td data-hide-below="md">
                      <Skeleton className="w-16" />
                    </td>
                    <td>
                      <Skeleton className="w-20" />
                    </td>
                    <td>
                      <Skeleton className="w-16" />
                    </td>
                    <td>
                      <Skeleton className="size-6" />
                    </td>
                  </tr>
                ))}
              </Table>
            </LoadingSkeleton>
          )
        ) : shown.length === 0 ? (
          <StatePanel
            icons={noAgents ? [User, Bot, Users] : [User, Search, Users]}
            title={noAgents ? "No Agents yet" : "No Members match"}
            description={
              noAgents
                ? "Create an Agent to join your organization."
                : "Try a different name or clear the filters to see all Members."
            }
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
                tokenLimit={tokenLimit}
                onOpen={() => navigate({ name: "member", id: member.id })}
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
          <Table columns={COLUMNS} label="Members">
            {shown.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                tokenLimit={tokenLimit}
                onOpen={() => navigate({ name: "member", id: member.id })}
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
          </Table>
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
        label="Name"
        initial={renaming?.name ?? ""}
        submitLabel="Rename"
        onSubmit={async (name) => {
          if (renaming) await backend.renameMember(renaming.id, name);
          setRenaming(null);
          await refresh();
        }}
      />
      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(next) => !next && setDoomed(null)}
        title={`Delete ${doomed?.name ?? ""}?`}
        description="Its Workspace and history are removed."
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
  tokenLimit,
  onOpen,
  onToggle,
  onRename,
  onDelete,
}: {
  member: Member;
  tokenLimit: number | null;
  onOpen: () => void;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const agent = member.type === "agent";
  const tokens = member.tokens ?? 0;

  return (
    <div className="relative flex flex-col gap-2.5 p-3 border border-line rounded-md bg-app transition-[background-color] duration-(--duration-fast) hover:bg-surface-hover/50">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar memberId={member.id} />
          <div className="flex min-w-0 flex-col gap-0.5">
            {agent ? (
              <RowLink primary={member.name} onSelect={onOpen} />
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
        <div>
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
              {member.pause_requested && member.state === "running"
                ? " · Pause requested"
                : ""}
            </StatusText>
          ) : (
            <span className="text-fg-muted">—</span>
          )}
        </div>

        {agent ? (
          <div className="flex flex-col items-end gap-1">
            <span className="tabular-nums text-fg-muted">
              {tokens.toLocaleString()}
              {tokenLimit !== null && tokenLimit > 0 ? (
                <span> / {tokenLimit.toLocaleString()}</span>
              ) : null}
            </span>
            {tokenLimit !== null && tokenLimit > 0 ? (
              <div className="w-20">
                <Meter
                  value={tokens}
                  max={tokenLimit}
                  label={`Token spend for ${member.name}`}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MemberRow({
  member,
  tokenLimit,
  onOpen,
  onToggle,
  onRename,
  onDelete,
}: {
  member: Member;
  tokenLimit: number | null;
  onOpen: () => void;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const agent = member.type === "agent";
  const tokens = member.tokens ?? 0;

  return (
    <tr>
      <td>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar memberId={member.id} />
          {agent ? (
            <RowLink primary={member.name} onSelect={onOpen} />
          ) : (
            <span className="min-w-0 truncate font-semibold">
              {member.name}
            </span>
          )}
        </div>
      </td>
      <td data-hide-below="md">
        <Chip tone={agent ? "blue" : "neutral"}>
          {agent ? <Bot size={12} /> : <User size={12} />}
          {agent ? "Agent" : "Human"}
        </Chip>
      </td>
      <td data-align="end">
        {agent ? (
          <div className="flex min-w-[110px] flex-col items-end gap-[5px]">
            <span className="tabular-nums whitespace-nowrap">
              {tokens.toLocaleString()}
              {tokenLimit !== null && tokenLimit > 0 ? (
                <span className="text-fg-muted">
                  {" "}
                  / {tokenLimit.toLocaleString()}
                </span>
              ) : null}
            </span>
            {tokenLimit === null ? (
              <span className="text-fg-muted">Token ceiling unavailable</span>
            ) : null}
            {tokenLimit !== null && tokenLimit > 0 ? (
              <div className="w-24">
                <Meter
                  value={tokens}
                  max={tokenLimit}
                  label={`Token spend for ${member.name}`}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <span className="text-fg-muted">—</span>
        )}
      </td>
      <td>
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
            {member.pause_requested && member.state === "running"
              ? " · Pause requested"
              : ""}
          </StatusText>
        ) : (
          <span className="text-fg-muted">—</span>
        )}
      </td>
      <td className="relative z-1 w-12 text-right">
        <OverflowMenu
          label={`Actions for ${member.name}`}
          actions={memberActions(member, {
            toggle: onToggle,
            rename: onRename,
            remove: onDelete,
          })}
        />
      </td>
    </tr>
  );
}
