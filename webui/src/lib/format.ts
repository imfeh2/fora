export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size.toLocaleString("en-US")} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function documentName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1];
}

export function documentFolder(path: string): string | null {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : null;
}

export function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const seconds = Math.round((Date.now() - parsed.getTime()) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86_400],
    ["week", 604_800],
    ["month", 2_629_800],
    ["year", 31_557_600],
  ];
  const format = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0];
  for (const unit of units) {
    if (Math.abs(seconds) >= unit[1]) chosen = unit;
  }
  return format.format(-Math.round(seconds / chosen[1]), chosen[0]);
}
