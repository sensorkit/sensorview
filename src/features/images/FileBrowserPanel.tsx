import { useState } from "react";
import type { ProductEntry } from "../../lib/sensorkit-client/types";

type ProductsMap = Record<string, Record<string, ProductEntry>>;

/** Newest first: by file register time, falling back to the name. */
function sortKey(e: ProductEntry): string {
  return e.registerTime ?? e.productId;
}

interface Props {
  products: ProductsMap;
  selected: { controllerId: string; productId: string } | null;
  onSelect: (controllerId: string, productId: string) => void;
}

/**
 * Left-hand file browser. Groups are the `controller_id` values discovered from
 * product records in the store (the top-level folders under the serve root);
 * each is a collapsible section listing its files.
 */
export function FileBrowserPanel({ products, selected, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = Object.keys(products).sort();

  if (groups.length === 0) {
    return null;
  }

  const toggle = (g: string) => setCollapsed((c) => ({ ...c, [g]: !c[g] }));

  return (
    <div className="py-1 text-xs select-none">
      {groups.map((g) => {
        const files = Object.values(products[g] ?? {}).sort((a, b) =>
          sortKey(b).localeCompare(sortKey(a)),
        );
        const isCollapsed = collapsed[g];
        return (
          <div key={g}>
            <button
              onClick={() => toggle(g)}
              className="flex w-full items-center gap-1 px-2 py-1 text-left text-text-dim hover:text-text-bright"
            >
              <span className="inline-block w-3 text-[8px] text-text-dim/70">
                {isCollapsed ? "▶" : "▼"}
              </span>
              <span className="truncate uppercase tracking-wide">{g}</span>
              <span className="ml-auto text-[10px] text-text-dim/60">{files.length}</span>
            </button>
            {!isCollapsed && (
              <ul>
                {files.map((f) => {
                  const isSel =
                    selected?.controllerId === g && selected?.productId === f.productId;
                  return (
                    <li key={f.productId}>
                      <button
                        onClick={() => onSelect(g, f.productId)}
                        title={f.productId}
                        className={`block w-full truncate py-0.5 pl-6 pr-2 text-left font-mono text-[11px] transition-colors ${
                          isSel
                            ? "bg-blue-500/20 text-blue-200"
                            : "text-text-dim hover:bg-white/5 hover:text-text-bright"
                        }`}
                      >
                        {f.productId}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
