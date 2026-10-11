import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoadError } from "@/components/ui/access-error";
import {
  Button,
  Chip,
  Field,
  FieldSkeleton,
  Input,
  LoadingSkeleton,
  Spinner,
  toast,
} from "@/components/ui/index";
import {
  reportLoadFailure,
  useReportSettingsSave,
} from "@/features/settings/saver";
import { BackendError, backend } from "@/lib/backend";

export function langfuseUpdate(
  values: Record<string, unknown>,
  publicKey: string,
  secretKey: string,
) {
  const next: Record<string, unknown> = {
    enabled: values.enabled === true,
    base_url: String(values.base_url ?? "").trim(),
  };
  if (publicKey.trim()) next.public_key = publicKey.trim();
  if (secretKey.trim()) next.secret_key = secretKey.trim();
  return next;
}

export function LangfusePanel() {
  const id = useId();
  const first = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadError, setLoadError] = useState<BackendError | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  useReportSettingsSave("langfuse", saving);

  const editing = useRef(values);
  editing.current = values;
  const saved = useRef(values);
  const generation = useRef(0);
  const savingRef = useRef(false);
  const load = useCallback(async () => {
    if (savingRef.current) return;
    const current = ++generation.current;
    setBusy(true);
    setLoadFailed(false);
    setLoadError(null);
    try {
      const updated = await backend.settings("observability");
      if (current !== generation.current) return;
      if (editing.current === saved.current) {
        saved.current = updated;
        setValues(updated);
      }
      setLoadFailed(false);
    } catch (failure) {
      if (current === generation.current) {
        setLoadFailed(true);
        setLoadError(reportLoadFailure(failure));
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const off = backend.onEvent((event) => {
      if (event.type === "connection.restored") void load();
    });
    return () => {
      generation.current++;
      off();
    };
  }, [load]);

  const save = async () => {
    if (!values || busy) return;
    generation.current++;
    savingRef.current = true;
    setBusy(true);
    setSaving(true);
    try {
      const updated = await backend.updateSettings(
        "observability",
        langfuseUpdate(values, publicKey, secretKey),
      );
      saved.current = updated;
      setValues(updated);
      setLoadFailed(false);
      setLoadError(null);
      setPublicKey("");
      setSecretKey("");
    } catch (failure) {
      if (failure instanceof BackendError && failure.transport)
        backend.reportFailure(failure);
      else
        toast({
          tone: "danger",
          title: "Could not save",
          description:
            failure instanceof Error ? failure.message : String(failure),
        });
    } finally {
      generation.current++;
      savingRef.current = false;
      setBusy(false);
      setSaving(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) first.current?.focus();
      });
    }
  };

  const recovery =
    loadError && !(loadError.transport && backend.disconnected) ? (
      <LoadError error={loadError} retry={() => void load()} />
    ) : null;
  if (values === null)
    return loadFailed ? (
      recovery
    ) : (
      <div className="max-w-[560px]">
        <LoadingSkeleton label="Loading Langfuse settings">
          {["enabled", "url", "public", "secret"].map((field) => (
            <FieldSkeleton key={field} />
          ))}
        </LoadingSkeleton>
      </div>
    );

  const enabled = values?.enabled === true;
  const configured = values?.keys_set === true;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {recovery}
      <fieldset
        className="m-0 flex min-w-0 max-w-[560px] flex-col gap-4 border-0 p-0"
        disabled={busy || !values}
      >
        <label
          className="flex cursor-pointer items-center gap-2"
          htmlFor={`${id}-enabled`}
        >
          <Input
            ref={first}
            id={`${id}-enabled`}
            type="checkbox"
            checked={enabled}
            onChange={(event) =>
              setValues({ ...values, enabled: event.target.checked })
            }
          />
          Enabled
        </label>
        <Field label="Base URL" htmlFor={`${id}-url`}>
          <Input
            id={`${id}-url`}
            type="url"
            pattern="https?://.+"
            required={enabled}
            placeholder="https://cloud.langfuse.com"
            value={String(values?.base_url ?? "")}
            onChange={(event) =>
              setValues({ ...values, base_url: event.target.value })
            }
          />
        </Field>
        <Field label="Public key" htmlFor={`${id}-public`}>
          <Input
            id={`${id}-public`}
            type="password"
            autoComplete="off"
            required={enabled && !configured}
            placeholder={configured ? "Unchanged" : ""}
            pattern=".*\S.*"
            value={publicKey}
            onChange={(event) => setPublicKey(event.target.value)}
          />
        </Field>
        <Field
          label="Secret key"
          htmlFor={`${id}-secret`}
          hint={configured ? "Leave blank to keep the stored keys." : undefined}
        >
          <Input
            id={`${id}-secret`}
            type="password"
            autoComplete="off"
            required={enabled && !configured}
            placeholder={configured ? "Unchanged" : ""}
            pattern=".*\S.*"
            value={secretKey}
            onChange={(event) => setSecretKey(event.target.value)}
          />
        </Field>
        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" variant="primary">
            {saving ? <Spinner label="Saving Langfuse settings" /> : null}
            Save
          </Button>
          {configured ? <Chip tone="success">Keys stored</Chip> : null}
        </div>
      </fieldset>
    </form>
  );
}
