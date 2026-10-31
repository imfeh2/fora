import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
  type ReactNode,
} from "react";

export type ContextMenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
};

type ContextMenuAreaProps = {
  label: string;
  actions: ContextMenuAction[];
  children: ReactNode;
} & Omit<
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>,
  "children"
>;

export const ContextMenuArea = forwardRef<
  ElementRef<typeof ContextMenuPrimitive.Trigger>,
  ContextMenuAreaProps
>(function ContextMenuArea(
  { label, actions, children, asChild = false, ...props },
  ref,
) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger ref={ref} asChild={asChild} {...props}>
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
});
