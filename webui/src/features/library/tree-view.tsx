import { FileText } from "lucide-react";
import { useEffect, useRef } from "react";
import { type Column, RowLink, Table } from "@/components/layout/shell";
import { Chip } from "@/components/ui/index";
import { type MenuAction, OverflowMenu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { LibraryEntry } from "@/lib/backend";
import {
  documentFolder,
  documentName,
  formatBytes,
  formatTime,
  relativeTime,
} from "@/lib/format";

export function FileList({
  entries,
  query = "",
  onOpen,
  rowActions,
  revealPath,
  label = "Library documents",
}: {
  entries: LibraryEntry[];
  query?: string;
  onOpen: (path: string) => void;
  rowActions?: (entry: LibraryEntry) => MenuAction[];
  revealPath?: string;
  label?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const revealed = useRef<string | undefined>(undefined);
  const needle = query.trim().toLowerCase();
  const columns: Column[] = [
    { key: "file", label: "File" },
    ...(needle
      ? [{ key: "folder", label: "Folder", hideBelow: "md" as const }]
      : []),
    { key: "size", label: "Size", align: "end", width: "100px" },
    { key: "modified", label: "Modified", hideBelow: "sm", width: "160px" },
    ...(rowActions ? [{ key: "actions", label: "", width: "56px" }] : []),
  ];

  useEffect(() => {
    if (!revealPath || revealed.current === revealPath || needle) return;
    const row = Array.from(
      container.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [],
    ).find((item) => item.dataset.path === revealPath);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      revealed.current = revealPath;
    }
  }, [revealPath, needle, entries]);

  return (
    <div
      ref={container}
      className="min-w-0 [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-fg-muted [&_th]:py-1.5 [&_td]:py-0 [&_td]:h-11"
    >
      <Table columns={columns} label={label}>
        {entries.map((entry) => (
          <tr key={entry.path} data-path={entry.path} className="group">
            <td>
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className="flex flex-none text-fg-muted"
                  aria-hidden="true"
                >
                  <FileText size={16} />
                </span>
                <RowLink
                  primary={
                    <span className="min-w-0 text-sm font-normal text-fg whitespace-normal wrap-anywhere">
                      {documentName(entry.path)}
                    </span>
                  }
                  onSelect={() => onOpen(entry.path)}
                />
              </div>
            </td>
            {needle ? (
              <td data-hide-below="md">
                <Chip>{documentFolder(entry.path) ?? "Root"}</Chip>
              </td>
            ) : null}
            <td
              data-align="end"
              className="text-xs text-fg-muted tabular-nums whitespace-nowrap"
            >
              {formatBytes(entry.size)}
            </td>
            <td data-hide-below="sm" className="text-xs text-fg-muted">
              <Tooltip label={formatTime(entry.modified_at)} focusable>
                <time
                  className="relative whitespace-nowrap"
                  dateTime={entry.modified_at}
                >
                  {relativeTime(entry.modified_at)}
                </time>
              </Tooltip>
            </td>
            {rowActions ? (
              <td className="relative z-1 w-12 text-right">
                <span className="inline-flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
                  <OverflowMenu
                    label={`Actions for ${entry.path}`}
                    actions={rowActions(entry)}
                  />
                </span>
              </td>
            ) : null}
          </tr>
        ))}
      </Table>
    </div>
  );
}
