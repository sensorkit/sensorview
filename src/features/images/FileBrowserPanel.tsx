import { memo, useEffect, useMemo, useRef, useState } from "react";

/** One file row, already labelled and formatted by ImagesPage. */
export interface BrowserRow {
  productId: string;
  /** Primary text: a chosen header keyword's value, or the filename. */
  label: string;
  /** Dim second line — register time and size. */
  detail: string;
}

export interface BrowserGroup {
  controllerId: string;
  rows: BrowserRow[];
  /** Products known for this controller before search/filter. */
  total: number;
  /** Matching rows dropped by the display cap (0 when everything is shown). */
  capped: number;
}

interface Props {
  groups: BrowserGroup[];
  selected: { controllerId: string; productId: string } | null;
  onSelect: (controllerId: string, productId: string) => void;
}

/**
 * Left-hand file browser. Groups are the `controller_id` values discovered
 * from the REST listing and the live firehose (the top-level folders under the
 * serve root); each is a collapsible section listing its files.
 *
 * Rows carry a header-derived label rather than the raw product id, because
 * the ids are UUIDs — see ImagesPage's `labelKeyword`. Memoized: the Images
 * tab re-renders on every firehose flush, and this list can run to thousands
 * of rows.
 */
export const FileBrowserPanel = memo(function FileBrowserPanel({
  groups,
  selected,
  onSelect,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  /** Every rendered row, in visual order. Collapsed groups are skipped so
   *  arrow-key navigation matches what's actually on screen. */
  const visible = useMemo(() => {
    const out: { controllerId: string; productId: string }[] = [];
    for (const g of groups) {
      if (collapsed[g.controllerId]) continue;
      for (const r of g.rows) out.push({ controllerId: g.controllerId, productId: r.productId });
    }
    return out;
  }, [groups, collapsed]);

  // Up/Down step through the list once something is open. Bound on the
  // document rather than the list, because focus is usually on the viewer (or
  // nowhere) after a click — the buttons themselves never keep it for long.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // Never steal the arrows from a field the user is editing — the search
      // box, the filter panel's number inputs, the keyword picker.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (!selected) return;

      const i = visible.findIndex(
        (v) => v.controllerId === selected.controllerId && v.productId === selected.productId,
      );
      // Open file filtered out of the list (or past the display cap): leave the
      // arrows alone rather than jumping somewhere the user didn't ask for.
      if (i === -1) return;

      const next = e.key === "ArrowDown" ? i + 1 : i - 1;
      if (next < 0 || next >= visible.length) return;
      e.preventDefault();
      onSelect(visible[next]!.controllerId, visible[next]!.productId);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, selected, onSelect]);

  // Keep the open row on screen when the selection moves by keyboard (or when
  // auto-follow opens a new arrival). `nearest` won't scroll if it's visible.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (groups.length === 0) {
    return null;
  }

  const toggle = (g: string) => setCollapsed((c) => ({ ...c, [g]: !c[g] }));

  return (
    <div className="py-1 text-xs select-none">
      {groups.map((group) => {
        const { controllerId: g, rows } = group;
        const isCollapsed = collapsed[g];
        return (
          <div key={g}>
            <button
              onClick={() => toggle(g)}
              className="flex w-full items-center gap-1 px-2 py-1 pointer-coarse:py-2.5 text-left text-text-dim hover:text-text-bright"
            >
              <span className="inline-block w-3 text-[8px] text-text-dim/70">
                {isCollapsed ? "▶" : "▼"}
              </span>
              <span className="truncate uppercase tracking-wide">{g}</span>
              {/* Matched, not rendered: the display cap is reported at the end
                  of the list, and counting rendered rows here would read as a
                  filter narrowing the group when nothing is filtered. */}
              <span className="ml-auto text-[10px] text-text-dim/60">
                {rows.length + group.capped === group.total
                  ? group.total
                  : `${rows.length + group.capped} / ${group.total}`}
              </span>
            </button>
            {!isCollapsed && (
              <>
                <ul>
                  {rows.map((row) => {
                    const isSel =
                      selected?.controllerId === g && selected?.productId === row.productId;
                    return (
                      <li key={row.productId}>
                        <button
                          ref={isSel ? selectedRef : undefined}
                          onClick={() => onSelect(g, row.productId)}
                          title={row.productId}
                          className={`block w-full py-0.5 pointer-coarse:py-2 pl-6 pr-2 text-left transition-colors ${
                            isSel
                              ? "bg-blue-500/20 text-blue-200"
                              : "text-text-dim hover:bg-white/5 hover:text-text-bright"
                          }`}
                        >
                          <span className="block truncate font-mono text-[11px]">{row.label}</span>
                          {row.detail !== "" && (
                            <span
                              className={`block truncate font-mono text-[9.5px] ${
                                isSel ? "text-blue-300/70" : "text-text-dim/60"
                              }`}
                            >
                              {row.detail}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {rows.length === 0 && (
                  <p className="px-6 py-1 text-[10.5px] text-text-dim/70">No matching files</p>
                )}
                {group.capped > 0 && (
                  <p className="px-6 py-1 text-[10.5px] text-text-dim/70">
                    +{group.capped} more match — narrow the search to see them
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
});
