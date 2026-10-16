import { ErrorFace } from "@/components/ui/error-face";
import { Button } from "@/components/ui/index";
import type { BackendError } from "@/lib/backend";

export function LoadError({
  error,
  retry,
}: {
  error: BackendError;
  retry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 py-3 text-sm"
    >
      <p className="min-w-0 flex-1 break-words text-danger">{error.message}</p>
      <Button size="sm" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}

export function AccessError({
  error,
  reconnect,
  waiting = false,
  loadingData = false,
}: {
  error: BackendError;
  reconnect?: () => void;
  waiting?: boolean;
  loadingData?: boolean;
}) {
  const startup = !loadingData && error.code === "startup_failed";
  const preparation = [
    "storage_read_failed",
    "storage_write_failed",
    "url_cleanup_failed",
    "invalid_connection",
  ].includes(error.code);
  const title = loadingData
    ? "Could not load Fora"
    : startup
      ? "Unable to start Fora"
      : error.code === "protocol_error"
        ? "Fora sent an invalid response"
        : preparation
          ? "Unable to prepare the connection"
          : "Could not connect to Fora";

  return (
    <ErrorFace
      title={title}
      description={error.message}
      note={startup ? "Close this window and start Fora again." : undefined}
      action={
        startup || !reconnect
          ? undefined
          : {
              label: loadingData ? "Retry" : "Reconnect",
              run: reconnect,
              pending: waiting,
              pendingLabel: loadingData ? "Loading…" : "Reconnecting…",
              spinnerLabel: loadingData ? "Loading" : "Reconnecting",
            }
      }
    />
  );
}
