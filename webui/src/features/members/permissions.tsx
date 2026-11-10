import { Minus, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { ConfirmDialog, DialogActions, Modal } from "@/components/ui/dialog";
import {
  Button,
  Chip,
  IconButton,
  Input,
  Select,
  Spinner,
  toast,
} from "@/components/ui/index";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import {
  backend,
  type Member,
  type MemberPermissions,
  type PermissionAction,
  type PermissionEntry,
  type PermissionGrant,
} from "@/lib/backend";

const EVERYTHING = "*";

type Draft = {
  key: number;
  sign: "+" | "-";
  action: string;
  target: string;
  delegable: boolean;
};

export function targetParts(target: string): string[] {
  return target.split(/[\\/]+/).filter((part) => part.length > 0);
}

export function draftEntry(
  draft: Draft,
  catalog: PermissionAction[],
): PermissionEntry {
  const action = catalog.find((item) => item.name === draft.action);
  const node = [...(action?.node ?? []), ...targetParts(draft.target)];
  return draft.sign === "+"
    ? { sign: "+", node, delegable: draft.delegable }
    : { sign: "-", node };
}

function failed(title: string, failure: unknown) {
  toast({
    tone: "danger",
    title,
    description: failure instanceof Error ? failure.message : String(failure),
  });
}

let nextKey = 1;

function blankDraft(): Draft {
  return {
    key: nextKey++,
    sign: "+",
    action: "",
    target: "",
    delegable: false,
  };
}

export function PermissionsDialog({
  member,
  members,
  onClose,
}: {
  member: Member;
  members: Member[];
  onClose: () => void;
}) {
  const [state, setState] = useState<MemberPermissions | null>(null);
  const [catalog, setCatalog] = useState<PermissionAction[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>(() => [blankDraft()]);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<PermissionGrant | null>(null);

  const load = useCallback(async () => {
    try {
      const [permissions, actions] = await Promise.all([
        backend.permissions(member.id),
        backend.permissionCatalog(),
      ]);
      setState(permissions);
      setCatalog(actions);
    } catch (failure) {
      failed("Could not load permissions", failure);
    }
  }, [member.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      backend.onEvent((event) => {
        if (event.type === "permissions.updated") void load();
      }),
    [load],
  );

  const name = (id: number) =>
    members.find((item) => item.id === id)?.name ?? `Member ${id}`;

  const update = (key: number, change: Partial<Draft>) =>
    setDrafts((current) =>
      current.map((draft) =>
        draft.key === key ? { ...draft, ...change } : draft,
      ),
    );

  const grant = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await backend.grantPermissions(
        member.id,
        drafts.map((draft) => draftEntry(draft, catalog)),
      );
      setDrafts([blankDraft()]);
      await load();
    } catch (failure) {
      failed("Could not grant", failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open
        wide
        onOpenChange={(next) => !next && onClose()}
        title={`${member.name} permissions`}
        footer={
          state?.owner ? null : (
            <DialogActions
              cancel={
                <Button variant="ghost" onClick={onClose}>
                  Close
                </Button>
              }
            >
              <Button
                variant="primary"
                disabled={
                  busy ||
                  catalog.length === 0 ||
                  drafts.some((draft) => draft.action === "")
                }
                onClick={() => void grant()}
              >
                Grant
              </Button>
            </DialogActions>
          )
        }
      >
        {state === null ? (
          <Spinner label="Loading permissions" />
        ) : state.owner ? (
          <div className="flex items-center gap-2">
            <Chip tone="blue">Owner</Chip>
            <code className="font-mono text-sm">+ *</code>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <ul aria-label="Grants" className="flex flex-col gap-2">
              {state.grants.length === 0 ? (
                <li className="text-sm text-fg-muted">None</li>
              ) : (
                state.grants.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start gap-3 rounded-md border border-line px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {item.lines.map((line) => (
                        <code
                          key={line}
                          className="font-mono text-sm wrap-anywhere"
                        >
                          {line}
                        </code>
                      ))}
                    </div>
                    <span className="text-xs text-fg-muted">
                      {name(item.granted_by)}
                    </span>
                    <IconButton
                      size="sm"
                      label="Revoke"
                      onClick={() => setRevoking(item)}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </li>
                ))
              )}
            </ul>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">New grant</legend>
              {drafts.map((draft) => (
                <DraftRow
                  key={draft.key}
                  draft={draft}
                  catalog={catalog}
                  removable={drafts.length > 1}
                  onChange={(change) => update(draft.key, change)}
                  onRemove={() =>
                    setDrafts((current) =>
                      current.filter((item) => item.key !== draft.key),
                    )
                  }
                />
              ))}
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setDrafts((current) => [...current, blankDraft()])
                  }
                >
                  <Plus size={14} />
                  Entry
                </Button>
              </div>
            </fieldset>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => !next && setRevoking(null)}
        title="Revoke this grant?"
        description="Grants made from it end too."
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (revoking) await backend.revokePermissions(revoking.id);
          setRevoking(null);
          await load();
        }}
      />
    </>
  );
}

function DraftRow({
  draft,
  catalog,
  removable,
  onChange,
  onRemove,
}: {
  draft: Draft;
  catalog: PermissionAction[];
  removable: boolean;
  onChange: (change: Partial<Draft>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const action = catalog.find((item) => item.name === draft.action);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        label="Grant or exclude"
        value={draft.sign}
        options={[
          { value: "+", label: "+" },
          { value: "-", label: "−" },
        ]}
        onChange={(sign) => onChange({ sign })}
      />
      <div className="w-52 max-w-full">
        <Select
          aria-label="Action"
          value={draft.action}
          onChange={(event) =>
            onChange({ action: event.target.value, target: "" })
          }
        >
          <option value="" disabled>
            Action
          </option>
          <option value={EVERYTHING}>{EVERYTHING}</option>
          {catalog.map((item) => (
            <option key={item.name} value={item.name} title={item.description}>
              {item.name}
            </option>
          ))}
        </Select>
      </div>
      {action?.target ? (
        <Input
          aria-label="Target"
          className="min-w-40 flex-1"
          placeholder={action.target}
          value={draft.target}
          onChange={(event) => onChange({ target: event.target.value })}
        />
      ) : null}
      {draft.sign === "+" ? (
        <label
          htmlFor={id}
          className="flex items-center gap-2 text-xs text-fg-muted"
        >
          <Switch
            id={id}
            checked={draft.delegable}
            onCheckedChange={(delegable) => onChange({ delegable })}
          />
          Delegable
        </label>
      ) : null}
      {removable ? (
        <IconButton size="sm" label="Remove entry" onClick={onRemove}>
          <Minus size={14} />
        </IconButton>
      ) : null}
    </div>
  );
}
