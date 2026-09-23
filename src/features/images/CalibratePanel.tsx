import { Toggle } from "../settings/Toggle";

export interface CalibrateInfo {
  /** Calibration frame filename/id being applied. */
  filename: string;
  /** Humanized age of the calibration frame, e.g. "3h old". */
  age: string;
}

export interface CalibrateEntry {
  /** Row label, e.g. "Apply Dark" / "Apply Flat". */
  label: string;
  /** Native tooltip describing the operation. */
  title: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  /** The applied frame, when enabled and a match was found. */
  matched: CalibrateInfo | null;
  /** Status line shown when enabled but no frame is applied. */
  note: string | null;
}

interface Props {
  entries: CalibrateEntry[];
}

/**
 * "Calibrate" card for the Images tab. Each entry is a toggle that applies a
 * calibration to the frame currently in the viewer — dark subtraction, flat
 * division. No other input: the applicable frame is found by matching FITS
 * headers. The applied filename + age read in the Tasks-tab mono style.
 */
export function CalibratePanel({ entries }: Props) {
  return (
    <div className="p-2 space-y-2">
      <div className="text-[10px] text-text-dim uppercase tracking-wide">Calibrate</div>

      {entries.map((e) => (
        <div key={e.label} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-text-bright">{e.label}</span>
            <Toggle size="sm" checked={e.enabled} onChange={e.onToggle} title={e.title} />
          </div>

          {e.enabled &&
            (e.matched ? (
              <div className="pl-3 font-mono text-[11px] leading-tight text-text-dim">
                <div className="truncate" title={e.matched.filename}>
                  {e.matched.filename}
                </div>
                <div className="text-[10px] text-text-dim/70">{e.matched.age}</div>
              </div>
            ) : (
              e.note && <div className="pl-3 font-mono text-[11px] text-text-dim/70">{e.note}</div>
            ))}
        </div>
      ))}
    </div>
  );
}
