import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ErrorFace } from "@/components/ui/error-face";

function installDesktopInteractionGuards() {
  document.addEventListener("dragstart", (event) => event.preventDefault());
  document.addEventListener("contextmenu", (event) => {
    const target = event.target;
    const isEditable =
      target instanceof Element &&
      target.closest('input, textarea, [contenteditable="true"]') !== null;
    if (!isEditable) {
      event.preventDefault();
    }
  });
}

function render() {
  installDesktopInteractionGuards();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary
        fallback={() => (
          <div className="flex h-full min-h-0 flex-col bg-app">
            <ErrorFace
              title="Something went wrong"
              description="Fora could not display this window. Reload to start again."
              action={{ label: "Reload", run: () => window.location.reload() }}
            />
          </div>
        )}
      >
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

render();
