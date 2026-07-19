import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A small ⓘ affordance that reveals `children` as a tooltip — the same popup
 * pattern used elsewhere in Settings, packaged so it can sit beside a section
 * header. The icon is a real button so keyboard users can focus it to reveal
 * the text, and a tap toggles it (hover never fires on touch) with an
 * outside-tap dismiss.
 *
 * The popup opens below the icon by default, but flips above it when there
 * isn't room below (e.g. the last section on the page). Below sm it pins to
 * the viewport edges instead of the icon — a 320px anchored popup would run
 * off a phone screen.
 */
export function InfoTooltip({
  children,
  label = "More information",
}: {
  children: ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  // Below sm the popup is position:fixed, where top-full/bottom-full would
  // resolve against the viewport — so its vertical offset is measured from
  // the icon at open time instead.
  const [fixedPos, setFixedPos] = useState<React.CSSProperties>({});

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    // Flip up when the space below the icon can't comfortably fit the popup.
    const up = r ? window.innerHeight - r.bottom < 220 : false;
    setOpenUp(up);
    if (r && window.innerWidth < 640) {
      setFixedPos(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 });
    } else {
      setFixedPos({});
    }
    setOpen(true);
  };
  const hide = () => setOpen(false);

  // Outside-tap dismiss for the click-toggled (touch) path.
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) hide();
    };
    window.addEventListener("pointerdown", onOutside);
    return () => window.removeEventListener("pointerdown", onOutside);
  }, [open]);

  return (
    <span
      ref={rootRef}
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
        onClick={() => (open ? hide() : show())}
        className="relative cursor-help rounded-full font-normal leading-none text-text-dim transition-colors hover:text-text-bright focus:outline-none focus-visible:ring-1 focus-visible:ring-orange-300/40 before:absolute before:-inset-2 before:content-['']"
      >
        ⓘ
      </button>
      {open && (
        <span
          role="tooltip"
          style={fixedPos}
          className={`pointer-events-none fixed inset-x-4 sm:absolute sm:inset-x-auto sm:left-0 sm:w-80 z-20 rounded border border-panel-border bg-panel-bg px-3 py-2 text-left text-xs font-normal text-text-dim shadow-lg ${
            openUp ? "sm:bottom-full sm:mb-1" : "sm:top-full sm:mt-1"
          }`}
        >
          {children}
        </span>
      )}
    </span>
  );
}
