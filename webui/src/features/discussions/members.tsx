import { Bot, User, Users } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useOrganization } from "@/app/organization";
import { DialogActions, Modal } from "@/components/ui/dialog";
import {
  Avatar,
  Button,
  Chip,
  Input,
  LoadingSkeleton,
  Skeleton,
  toast,
} from "@/components/ui/index";
import { StatePanel } from "@/components/ui/state-panel";
import { backend, type Member } from "@/lib/backend";

export function MemberPicker({
  members,
  selected,
  onChange,
  disabled = false,
}: {
  members: Member[];
  selected: number[];
  onChange: (selected: number[]) => void;
  disabled?: boolean;
}) {
  const id = useId();

  return (
    <fieldset
      className="m-0 flex flex-col gap-2 border-0 p-0"
      disabled={disabled}
    >
      <legend className="p-0 text-xs font-medium text-fg-muted">Members</legend>
      <ul className="flex max-h-[220px] flex-col overflow-y-auto rounded-sm border border-line bg-surface">
        {members.length === 0 ? (
          <li>
            <StatePanel
              compact
              icons={[User, Users, Bot]}
              title="No other Members"
            />
          </li>
        ) : null}
        {members.map((member) => (
          <li key={member.id}>
            <label
              className="flex items-center gap-2 px-3 py-2 cursor-pointer transition-[background-color] duration-(--duration-fast) ease-linear hover:bg-surface-hover"
              htmlFor={`${id}-${member.id}`}
            >
              <Input
                id={`${id}-${member.id}`}
                type="checkbox"
                checked={selected.includes(member.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, member.id]
                      : selected.filter((id) => id !== member.id),
                  )
                }
              />
              <Avatar memberId={member.id} size="sm" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {member.name}
              </span>
              <Chip tone={member.type === "agent" ? "blue" : "neutral"}>
                {member.type === "agent" ? "Agent" : "Human"}
              </Chip>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

export function DiscussionMembersDialog({
  discussionId,
  memberIds,
  onClose,
  onSaved,
}: {
  discussionId: number;
  memberIds: number[];
  onClose: () => void;
  onSaved: (memberIds: number[]) => void | Promise<void>;
}) {
  const { members } = useOrganization();
  const [selected, setSelected] = useState(memberIds);
  const [busy, setBusy] = useState(false);
  const saved = useRef(memberIds);
  const request = useRef(0);

  if (members === null) return null;

  const apply = async (next: number[]) => {
    if (busy || backend.disconnected) return;
    setSelected(next);
    const current = ++request.current;
    setBusy(true);
    try {
      const updated = await backend.setDiscussionMembers(discussionId, next);
      if (current !== request.current) return;
      saved.current = updated.member_ids;
      setSelected(updated.member_ids);
      await onSaved(updated.member_ids);
    } catch (failure) {
      if (current !== request.current) return;
      setSelected(saved.current);
      toast({
        tone: "danger",
        title: "Could not save members",
        description:
          failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      if (current === request.current) setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Discussion members"
      variant="form"
      footer={
        <DialogActions>
          <Button disabled={busy} onClick={onClose}>
            Close
          </Button>
        </DialogActions>
      }
    >
      {members !== null ? (
        <MemberPicker
          members={members}
          selected={selected}
          onChange={(next) => void apply(next)}
          disabled={busy || backend.disconnected}
        />
      ) : (
        <LoadingSkeleton label="Loading Members">
          <Skeleton className="h-20 w-full rounded-sm" />
        </LoadingSkeleton>
      )}
    </Modal>
  );
}
