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

  // The serve API injects a `ProductInfo` entry into the header dict — drop it.
  const entries = Object.entries(meta).filter(([k]) => k !== "ProductInfo");

  return (
    <div className="p-2">
      <dl className="space-y-0.5 font-mono text-[10px]">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="shrink-0 text-text-dim">{k}</dt>
            <dd className="break-all text-text-bright">{formatVal(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
