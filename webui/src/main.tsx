import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";

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
      <App />
    </React.StrictMode>,
  );
}

render();
