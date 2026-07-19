import type { ReactNode } from "react";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Text shown beside the switch; clicking it toggles too. */
  label?: ReactNode;
  /** Native tooltip / accessible name when there is no visible label. */
  title?: string;
  "aria-label"?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Tailwind `bg-*` class for the track when on. Defaults to the app accent. */
  onColor?: string;
}

/**
 * On/off switch styled as a sliding toggle. Renders a semantic
 * `role="switch"` button so keyboard (Space/Enter) and screen-reader behavior
 * work without extra wiring. Provide `label` for a visible caption, or
 * `aria-label`/`title` when the switch stands alone (e.g. in a dense row).
 */
export function Toggle({
  checked,
  onChange,
  label,
  title,
  "aria-label": ariaLabel,
  disabled = false,
  size = "md",
  onColor = "bg-orange-300",
}: ToggleProps) {
  const dims =
    size === "sm"
      ? { track: "h-4 w-7", knob: "h-3 w-3", on: "translate-x-3" }
      : { track: "h-5 w-9", knob: "h-4 w-4", on: "translate-x-4" };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative flex shrink-0 items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/40 before:absolute before:-inset-2 before:content-[''] ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      }`}
    >
      <span
        className={`relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors ${dims.track} ${
          checked ? onColor : "bg-neutral-600"
        }`}
      >
        <span
          className={`inline-block rounded-full bg-white shadow-sm transition-transform ${dims.knob} ${
            checked ? dims.on : "translate-x-0"
          }`}
        />
      </span>
      {label != null && <span className="text-text-bright">{label}</span>}
    </button>
  );
}
