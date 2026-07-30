import { Fragment } from "react";
import { fitsCardEntries } from "../../lib/sensorkit-client/fitsHeaders";
import type { ProductMetadata } from "../../lib/sensorkit-client/types";

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

interface Props {
  meta: ProductMetadata | null;
}

/** Right-hand panel showing the FITS header of the open product. */
export function HeaderPanel({ meta }: Props) {
  if (!meta) {
    return null;
  }

  const entries = fitsCardEntries(meta);

  return (
    <div className="p-2">
      {/* Two aligned columns (DS9-style): keys sized to the widest keyword,
          values left-aligned in a shared column and wrapping within it. */}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono text-[10px]">
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-text-dim">{k}</dt>
            <dd className="min-w-0 break-all text-text-bright">{formatVal(v)}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
