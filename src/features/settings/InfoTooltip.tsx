import { useRef, useState, type ReactNode } from "react";

/**
 * A small ⓘ affordance that reveals `children` as a hover/focus tooltip — the
 * same popup pattern used elsewhere in Settings, packaged so it can sit beside
 * a section header. The icon is a real button so keyboard users can focus it
 * to reveal the text.
 *
 * The popup opens below the icon by default, but flips above it when there
 * isn't room below (e.g. the last section on the page) so it never gets clipped
 * by the viewport.
 */
export function InfoTooltip({
  children,
  label = "More information",
}: {
  children: ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    // Flip up when the space below the icon can't comfortably fit the popup.
    if (r) setOpenUp(window.innerHeight - r.bottom < 220);
    setOpen(true);
  };
  const hide = () => setOpen(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className="cursor-help rounded-full font-normal leading-none text-text-dim transition-colors hover:text-text-bright focus:outline-none focus-visible:ring-1 focus-visible:ring-orange-300/40"
      >
        ⓘ
      </button>
      {open && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute left-0 z-20 w-80 rounded border border-panel-border bg-panel-bg px-3 py-2 text-left text-xs font-normal text-text-dim shadow-lg ${
            openUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {children}
        </span>
      )}
    </span>
  );
}
