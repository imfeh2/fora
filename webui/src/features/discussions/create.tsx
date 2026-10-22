import { useEffect, useId, useRef, useState } from "react";
import { useOrganization } from "@/app/organization";
import { DialogActions, Modal } from "@/components/ui/dialog";
import { Button, Field, Input, toast } from "@/components/ui/index";
import { MemberPicker } from "@/features/discussions/members";
import { backend } from "@/lib/backend";

export function CreateDiscussionDialog({
  open,
  onOpenChange,
  onCreated,
  restoreFocus,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: number) => void;
  restoreFocus?: () => HTMLElement | null;
  onClosed?: () => void;
}) {
  const { members, humanId } = useOrganization();
  const [topic, setTopic] = useState("");
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const topicId = useId();
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(false);
  const session = useRef({
    active: open,
    busy: false,
    created: null as number | null,
  });

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (open) {
      session.current = { active: true, busy: false, created: null };
      setTopic("");
      setChosen([]);
      setBusy(false);
    } else session.current.active = false;
  }, [open]);

  const changeOpen = (next: boolean) => {
    if (!next) session.current.active = false;
    onOpenChange(next);
  };

  const closed = () => {
    const id = session.current.created;
    session.current.created = null;
    onClosed?.();
    if (id !== null) onCreated(id);
  };

  if (members === null || humanId === null) return null;

  const others = members.filter((member) => member.id !== humanId);
  const ready =
    !backend.disconnected && topic.trim().length > 0 && chosen.length > 0;

  const create = async () => {
    const operation = session.current;
    if (!ready || !operation.active || operation.busy) return;
    operation.busy = true;
    input.current?.focus();
    setBusy(true);
    try {
      const created = await backend.createDiscussion(topic.trim(), chosen);
      if (!live.current || session.current !== operation || !operation.active)
        return;
      operation.created = created.id;
      changeOpen(false);
    } catch (failure) {
      if (!live.current || session.current !== operation || !operation.active)
        return;
      toast({
        tone: "danger",
        title: "Could not create Discussion",
        description:
          failure instanceof Error ? failure.message : String(failure),
      });
      input.current?.focus();
    } finally {
      operation.busy = false;
      if (live.current && session.current === operation) setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={changeOpen}
      title="New Discussion"
      variant="form"
      restoreFocus={restoreFocus}
      onClosed={closed}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      footer={
        <DialogActions
          cancel={<Button onClick={() => changeOpen(false)}>Cancel</Button>}
        >
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            Create Discussion
          </Button>
        </DialogActions>
      }
    >
      <Field label="Topic" htmlFor={topicId}>
        <Input
          ref={input}
          id={topicId}
          readOnly={busy}
          value={topic}
          onChange={(event) => {
            if (!session.current.busy) setTopic(event.target.value);
          }}
        />
      </Field>
      <MemberPicker
        members={others}
        selected={chosen}
        onChange={setChosen}
        disabled={busy || backend.disconnected}
      />
    </Modal>
  );
}
