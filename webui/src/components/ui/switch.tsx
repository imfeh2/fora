import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { clsx } from "clsx";
import type { ComponentProps } from "react";

const trackClass = clsx(
  "relative inline-flex h-[18px] w-8 flex-none cursor-pointer items-center rounded-full border border-gray-500 bg-surface-hover p-0.5",
  "transition-[background-color,border-color] duration-(--duration-base) ease-(--ease-standard)",
  "hover:border-[color-mix(in_srgb,var(--color-gray-500)_50%,var(--color-gray-400))]",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300",
  "data-checked:border-blue-500 data-checked:bg-blue-500",
  "data-checked:hover:border-[color-mix(in_srgb,var(--color-blue-500)_50%,var(--color-blue-300))] data-checked:hover:bg-[color-mix(in_srgb,var(--color-blue-500)_50%,var(--color-blue-300))]",
  "data-disabled:cursor-not-allowed data-disabled:opacity-45",
  "after:absolute after:-inset-x-[9px] after:-inset-y-[14px] after:content-['']",
);

const thumbClass = clsx(
  "block size-3 flex-none rounded-full bg-gray-400",
  "transition-transform duration-(--duration-base) ease-(--ease-standard)",
  "data-checked:translate-x-[14px] data-checked:bg-gray-100",
);

export function Switch({
  className,
  ...rest
}: Omit<ComponentProps<typeof BaseSwitch.Root>, "className"> & {
  className?: string;
}) {
  return (
    <BaseSwitch.Root
      nativeButton
      render={<button type="button" />}
      className={clsx(trackClass, className)}
      {...rest}
    >
      <BaseSwitch.Thumb className={thumbClass} />
    </BaseSwitch.Root>
  );
}
