import * as Popover from "@radix-ui/react-popover";
import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { optionIndexAfterKey } from "@/components/ui/combobox";
import { Button, Dot } from "@/components/ui/index";

export function SelectList({
  label,
  optionsLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  optionsLabel: string;
  options: {
    value: string;
    label: string;
    description?: string;
    current?: boolean;
  }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const option = options[selectedIndex];
  const activeIndex =
    active >= 0 && active < options.length ? active : selectedIndex;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    setActive(next ? selectedIndex : -1);
  };
  const choose = (next: string) => {
    onChange(next);
    changeOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const keyDown = (event: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
      setActive(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : open
              ? optionIndexAfterKey(event.key, activeIndex, options.length)
              : selectedIndex,
      );
    } else if (open && event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) choose(options[activeIndex].value);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      changeOpen(false);
      trigger.current?.focus({ preventScroll: true });
    } else if (event.key === "Tab") {
      changeOpen(false);
    }
  };
  useEffect(() => {
    if (open && activeIndex >= 0)
      list.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);
  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <div className="w-full [&>button]:w-full [&>button]:bg-app [&>button]:justify-start">
        <Popover.Trigger asChild>
          <Button
            ref={trigger}
            role="combobox"
            aria-label={label}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={
              open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
            }
            value={value}
            onKeyDown={keyDown}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {option?.label ?? "Select an option"}
            </span>
            {option?.current ? (
              <>
                <Dot tone="blue" />
                <span className="sr-only">In progress</span>
              </>
            ) : null}
            <ChevronDown className="size-4 text-fg-muted" />
          </Button>
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Content
          className="relative top-auto z-(--layer-menu) min-w-0 w-(--radix-popover-trigger-width) max-w-(--radix-popover-content-available-width) max-h-[min(320px,var(--radix-popover-content-available-height))] overflow-auto p-1 rounded-sm bg-surface-raised shadow-popover origin-(--radix-popover-content-transform-origin) animate-pop-in"
          role="presentation"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() =>
            trigger.current?.focus({ preventScroll: true })
          }
          onInteractOutside={(event) => {
            if (trigger.current?.contains(event.target as Node))
              event.preventDefault();
          }}
          onKeyDown={keyDown}
        >
          <div ref={list} id={listId} role="listbox" aria-label={optionsLabel}>
            {options.map((item, index) => (
              <button
                key={item.value}
                type="button"
                role="option"
                id={`${listId}-${index}`}
                data-value={item.value}
                tabIndex={-1}
                aria-selected={item.value === value}
                className={clsx(
                  "flex items-center gap-2 w-full h-auto min-h-7 py-0 px-2 border-0 rounded-xs text-fg text-sm text-left whitespace-normal wrap-anywhere cursor-pointer transition-[background-color,color] duration-(--duration-fast) ease-linear hover:enabled:bg-surface-hover focus-visible:bg-surface-hover",
                  item.value === value || index === activeIndex
                    ? "bg-surface-hover"
                    : "bg-transparent",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(item.value)}
              >
                {item.label}
                {item.description ? ` · ${item.description}` : ""}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
