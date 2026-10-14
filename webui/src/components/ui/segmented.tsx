export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="inline-flex flex-none m-0 p-[2px] border border-line-interactive rounded-sm bg-app shadow-button">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="h-[26px] py-0 px-3 border-0 rounded-xs bg-transparent text-fg-muted text-xs font-medium cursor-pointer transition-[background-color,color] duration-(--duration-fast) ease-linear hover:text-fg aria-pressed:bg-surface-selected aria-pressed:text-fg"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
