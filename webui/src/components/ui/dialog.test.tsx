import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfirmDialog,
  dialogFocusTarget,
  Modal,
  PromptDialog,
} from "@/components/ui/dialog";
import { Button, Input } from "@/components/ui/index";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(cleanup);

function FormDialog({ submit }: { submit: () => void }) {
  return (
    <TooltipProvider>
      <Modal
        open
        onOpenChange={() => {}}
        title="Edit provider"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        footer={
          <Button type="submit" variant="primary">
            Save
          </Button>
        }
      >
        <Input aria-label="Name" />
      </Modal>
    </TooltipProvider>
  );
}

describe("Modal", () => {
  it("puts the panel and its footer inside one form", () => {
    render(<FormDialog submit={() => {}} />);
    const panel = screen.getByRole("dialog");
    expect(panel.tagName).toBe("FORM");
    expect(screen.getByRole("button", { name: "Save" }).closest("form")).toBe(
      panel,
    );
  });

  it("submits once when the footer action is clicked", () => {
    const submit = vi.fn();
    render(<FormDialog submit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("dialogFocusTarget", () => {
  it("falls back to the first enabled action instead of the last one", () => {
    const cancel = { disabled: false };
    const danger = { disabled: false };
    expect(dialogFocusTarget([], [cancel, danger])).toBe(cancel);
    expect(dialogFocusTarget([], [{ disabled: true }, danger])).toBe(danger);
    expect(dialogFocusTarget([], [])).toBeNull();
  });

  it("prefers the first enabled field over any action", () => {
    const field = { disabled: false };
    const cancel = { disabled: false };
    expect(dialogFocusTarget([{ disabled: true }, field], [cancel])).toBe(
      field,
    );
  });
});

describe("ConfirmDialog", () => {
  it("renders the cancel action first and the danger action last", () => {
    render(
      <TooltipProvider>
        <ConfirmDialog
          open
          onOpenChange={() => {}}
          title="Delete Sora?"
          description="The Member is removed."
          confirmLabel="Delete Agent"
          onConfirm={() => {}}
        />
      </TooltipProvider>,
    );
    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((button) => button.textContent);
    expect(labels.indexOf("Cancel")).toBeLessThan(
      labels.indexOf("Delete Agent"),
    );
  });
});

describe("PromptDialog", () => {
  it("submits its value through the dialog form", () => {
    const submit = vi.fn();
    render(
      <TooltipProvider>
        <PromptDialog
          open
          onOpenChange={() => {}}
          title="Rename Member"
          label="Name"
          initial="Sora"
          submitLabel="Rename"
          onSubmit={submit}
        />
      </TooltipProvider>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.tagName).toBe("FORM");
    fireEvent.submit(panel);
    expect(submit).toHaveBeenCalledWith("Sora");
  });
});
