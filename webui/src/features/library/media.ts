export type MediaKind = "image" | "video" | "audio";

const MEDIA_KINDS: Record<string, MediaKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  mp4: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
};

export function mediaKind(path: string): MediaKind | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return MEDIA_KINDS[name.slice(dot + 1).toLowerCase()] ?? null;
}
