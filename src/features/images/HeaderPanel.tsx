import { Fragment } from "react";
import type { ProductMetadata } from "../../lib/sensorkit-client/types";

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Pull the FITS cards out of SK's `/metadata` response.
 *
 * The response is a KeywordDict keyed by keyword *class* name. Since sensorkit
 * "Nest FITS cards under the `FITSHeader` keyword" the cards live in a
 * `FITSHeader` sub-object alongside `ProductInfo`; older builds spread the
 * cards flat at the top level instead. Accept either, so the panel keeps
 * working against whichever SK a site is running.
 */
function fitsCards(meta: ProductMetadata): [string, unknown][] {
  const nested = meta.FITSHeader;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return Object.entries(nested as Record<string, unknown>);
  }
  return Object.entries(meta).filter(([k]) => k !== "ProductInfo");
}

interface Props {
  meta: ProductMetadata | null;
}

/** Right-hand panel showing the FITS header of the open product. */
export function HeaderPanel({ meta }: Props) {
  if (!meta) {
    return null;
  }

  const entries = fitsCards(meta);

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
