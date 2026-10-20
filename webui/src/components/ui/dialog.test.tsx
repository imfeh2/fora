import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "@/components/ui/dialog";
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
