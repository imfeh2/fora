import { CircleAlertIcon } from "lucide-react";
import { useId } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, Spinner } from "@/components/ui/index";

type ErrorFaceAction = {
  label: string;
  run: () => void;
  pending?: boolean;
  pendingLabel?: string;
  spinnerLabel?: string;
};

export function ErrorFace({
  title,
  description,
  note,
  action,
}: {
  title: string;
  description: string;
  note?: string;
  action?: ErrorFaceAction;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const busy = action?.pending === true;
  return (
    <section className="flex min-h-0 flex-1 w-full overflow-auto bg-app p-6">
      <div className="m-auto w-full max-w-[520px] min-w-0">
        <Alert
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="[overflow-wrap:anywhere]"
        >
          <CircleAlertIcon
            className="row-span-2 h-5 w-4 text-danger"
            aria-hidden="true"
          />
          <AlertTitle id={titleId}>{title}</AlertTitle>
          <AlertDescription id={descriptionId}>
            <p className="whitespace-pre-wrap">{description}</p>
            {note ? <p>{note}</p> : null}
            {action ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button onClick={action.run} disabled={busy}>
                  {busy && action.spinnerLabel ? (
                    <Spinner label={action.spinnerLabel} />
                  ) : null}
                  {busy && action.pendingLabel
                    ? action.pendingLabel
                    : action.label}
                </Button>
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      </div>
    </section>
  );
}
