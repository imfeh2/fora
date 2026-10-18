export function libraryPathFromHref(href: string): string | null {
  if (href.startsWith("#") || href.startsWith("//")) return null;
  if (/%(?![0-9A-Fa-f]{2})/.test(href)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  if (decoded.startsWith("//")) return null;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decoded)) return null;
  const rest = decoded.replace(/^\.?\//, "");
  const segments = rest.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const path = segments.filter((segment) => segment.length > 0).join("/");
  return path.length > 0 ? path : null;
}
