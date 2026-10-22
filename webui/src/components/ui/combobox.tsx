import * as Popover from "@radix-ui/react-popover";
import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button, IconButton, Input, Spinner } from "@/components/ui/index";

export function filterOptions(options: string[], value: string): string[] {
  const query = value.trim().toLowerCase();
  return options.filter((option) => option.toLowerCase().includes(query));
}

export function optionIndexAfterKey(
  key: string,
  active: number,
  count: number,
): number {
  if (!count) return -1;
  if (key === "ArrowDown") return (active + 1) % count;
  if (key === "ArrowUp") return active <= 0 ? count - 1 : active - 1;
  return active;
}

export type ComboboxProps = {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  chooseLabel: string;
  disabled?: boolean;
  loading?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onLoad?: () => void;
  loadLabel?: string;
};

export function Combobox({
  id,
  label,
  value,
  options,
  onChange,
  chooseLabel,
  disabled = false,
  loading = false,
  invalid = false,
  describedBy,
  onLoad,
  loadLabel = "Load options",
}: ComboboxProps) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const filtered = filterOptions(options, value);
  const activeIndex = active < filtered.length ? active : -1;
  const expanded = open && !disabled;

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setActive(-1);
    }
  }, [disabled]);

  useEffect(() => {
    if (expanded && activeIndex >= 0) {
      list.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [expanded, activeIndex]);

  const changeOpen = (next: boolean) => {
    if (disabled) return;
    setOpen(next);
    if (next && !open) {
      setActive(-1);
      onLoad?.();
    }
  };

  const select = (option: string) => {
    onChange(option);
    setOpen(false);
    setActive(-1);
    input.current?.focus();
  };

  return (
    <Popover.Root open={expanded} onOpenChange={changeOpen}>
      <Popover.Anchor asChild>
        <div
          className="relative flex min-w-0 [&>input]:pr-[38px] [&>button]:absolute [&>button]:right-1 [&>button]:top-1/2 [&>button]:-translate-y-1/2"
          ref={anchor}
        >
          <Input
            ref={input}
            id={id}
            role="combobox"
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            aria-activedescendant={
              expanded && activeIndex >= 0
                ? `${listId}-${activeIndex}`
                : undefined
            }
            autoComplete="off"
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            value={value}
            onChange={(event) => {
              setActive(-1);
              onChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                changeOpen(true);
                setActive(
                  optionIndexAfterKey(
                    event.key,
                    expanded ? activeIndex : -1,
                    filtered.length,
                  ),
                );
              } else if (expanded && event.key === "Enter") {
                event.preventDefault();
                if (activeIndex >= 0) select(filtered[activeIndex]);
              } else if (expanded && event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === "Tab") {
                setOpen(false);
              }
            }}
          />
          <IconButton
            label={chooseLabel}
            size="sm"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            onClick={() => changeOpen(!expanded)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                changeOpen(true);
                setActive(optionIndexAfterKey(event.key, -1, filtered.length));
                input.current?.focus();
              }
            }}
          >
            <ChevronDown size={16} />
          </IconButton>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="relative top-auto z-(--layer-menu) min-w-0 w-(--radix-popover-trigger-width) max-w-(--radix-popover-content-available-width) max-h-[min(320px,var(--radix-popover-content-available-height))] overflow-auto p-1 rounded-sm bg-surface-raised shadow-popover origin-(--radix-popover-content-transform-origin) animate-pop-in"
          role="presentation"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (anchor.current?.contains(event.target as Node))
              event.preventDefault();
          }}
          onEscapeKeyDown={() => input.current?.focus()}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              setOpen(false);
              input.current?.focus();
            }
          }}
        >
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-busy={loading}
          >
            {filtered.map((option, index) => (
              <button
                type="button"
                role="option"
                className={clsx(
                  "flex items-center gap-2 w-full h-auto min-h-7 py-0 px-2 border-0 rounded-xs text-fg text-sm text-left whitespace-normal wrap-anywhere cursor-pointer transition-[background-color,color] duration-(--duration-fast) ease-linear hover:enabled:bg-surface-hover focus-visible:bg-surface-hover disabled:text-fg-disabled disabled:cursor-not-allowed",
                  index === activeIndex ? "bg-surface-hover" : "bg-transparent",
                )}
                key={option}
                id={`${listId}-${index}`}
                tabIndex={-1}
                aria-selected={option === value}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => select(option)}
              >
                {option}
              </button>
            ))}
          </div>
          {onLoad ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => {
                input.current?.focus();
                onLoad();
              }}
            >
              {loading ? <Spinner label={loadLabel} /> : null}
              {loadLabel}
            </Button>
          ) : loading ? (
            <Spinner label={loadLabel} />
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
