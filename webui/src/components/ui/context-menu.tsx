import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";

export type ContextMenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
};

export function ContextMenuArea({
  label,
  actions,
  children,
  className,
  asChild = false,
}: {
  label: string;
  actions: ContextMenuAction[];
  children: ReactNode;
  className?: string;
  asChild?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger className={className} asChild={asChild}>
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          className="z-(--layer-menu) min-w-42 max-w-60 p-1 rounded-sm bg-surface-raised shadow-popover text-fg text-sm"
          aria-label={label}
          sideOffset={2}
          collisionPadding={4}
        >
          {actions.map((action) => (
            <ContextMenuPrimitive.Item
              key={action.id}
              className="flex items-center gap-2 min-w-0 h-7 narrow:min-h-11 touch:min-h-11 py-0 px-2 rounded-xs text-left cursor-default outline-none select-none data-[highlighted]:bg-surface-hover"
              onSelect={() => action.onSelect()}
            >
              {action.icon ? (
                <span
                  className="flex shrink-0 text-fg-muted"
                  aria-hidden="true"
                >
                  {action.icon}
                </span>
              ) : null}
              <span className="truncate" title={action.label}>
                {action.label}
              </span>
            </ContextMenuPrimitive.Item>
          ))}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
