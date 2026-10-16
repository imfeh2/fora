import { CircleAlertIcon } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/index";

export function ErrorCard({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <section className="flex min-h-0 flex-1 w-full overflow-auto bg-app p-6">
      <div className="m-auto w-full max-w-[520px] min-w-0">
        <Alert className="[overflow-wrap:anywhere]">
          <CircleAlertIcon
            className="row-span-2 h-5 w-4 text-danger"
            aria-hidden="true"
          />
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>
            <p className="whitespace-pre-wrap">{description}</p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button onClick={onAction}>{action}</Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    </section>
  );
}

export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (reset: () => void) => ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  reset = () => this.setState({ failed: false });

  render() {
    return this.state.failed
      ? this.props.fallback(this.reset)
      : this.props.children;
  }
}
