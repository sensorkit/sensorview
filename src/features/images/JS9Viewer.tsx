import { useEffect, useRef, useState } from "react";
import { useJS9, type JS9Image } from "../../lib/js9/useJS9";

/** What the viewer should display: a dropped local file or a remote FITS URL. */
export type ImageSource =
  | { kind: "file"; file: File; name: string }
  | { kind: "url"; url: string; name: string };

const DISPLAY_ID = "SensorViewJS9";

/**
 * JS9 binds a display to the canvas it builds the first time it sees the div and
 * never rebinds, and it never removes a plain (non-grid) display from its
 * registry. So a display-per-React-mount leaks one display + canvases per tab
 * visit and goes blank on remount. Instead we build the display's DOM exactly
 * once, hold it in a detached holder (so JS9's one-time init scan never sees it),
 * and reparent that same DOM in and out of the page as the tab mounts/unmounts —
 * registering it explicitly with AddDivs after JS9 has finished initializing
 * (useJS9's `ready` waits for JS9.inited). One display for the app's life; no
 * scan race, no duplicate registration, nothing accumulates.
 */
interface PersistentNodes {
  holder: HTMLDivElement;
  menubar: HTMLDivElement;
  canvas: HTMLDivElement;
}

let persistent: PersistentNodes | null = null;
function persistentNodes(): PersistentNodes | null {
  if (persistent || typeof document === "undefined") return persistent;

  const holder = document.createElement("div");
  holder.style.display = "none";

  const menubar = document.createElement("div");
  menubar.className = "JS9Menubar";
  menubar.id = `${DISPLAY_ID}Menubar`;
  menubar.setAttribute("data-displays", DISPLAY_ID);

  const canvas = document.createElement("div");
  canvas.className = "JS9";
  canvas.id = DISPLAY_ID;
  canvas.setAttribute("data-width", "800");
  canvas.setAttribute("data-height", "600");

  holder.append(menubar, canvas);
  // The holder is never attached to the document, so JS9's one-time init scan
  // ($("div.JS9")) never sees these nodes. We register the display explicitly
  // with AddDivs once it's reparented into the page — no scan race, no duplicate.
  persistent = { holder, menubar, canvas };
  return persistent;
}

/** The image-level JS9 internals we reach into for cursor-anchored zoom + pan. */
interface JS9ImageGeom extends JS9Image {
  pos?: { x: number; y: number };
  rgb?: { sect?: { xcen: number; ycen: number; zoom: number } };
  display?: { width: number; height: number };
  raw?: { width: number; height: number };
  displayToImagePos?: (pos: { x: number; y: number }) => { x: number; y: number };
  setPan?: (x: number, y: number) => void;
}
type WheelEvt = { originalEvent: WheelEvent };

/**
 * Constrain the pan center so the visible region stays inside the image — no
 * dragging (or zooming) into empty space. When the image fully fits an axis
 * (at/below fit-zoom) the center is locked to the middle, so panning does
 * nothing there. Clamping in image coords means flip/rotation are already
 * accounted for by JS9's own section math.
 */
function clampPan(im: JS9ImageGeom): void {
  const sect = im?.rgb?.sect;
  if (!sect || !im.setPan || !im.display || !im.raw) return;
  const fix = (c: number, half: number, size: number) =>
    2 * half >= size ? size / 2 : Math.max(half, Math.min(size - half, c));
  const cx = fix(sect.xcen, im.display.width / (2 * sect.zoom), im.raw.width);
  const cy = fix(sect.ycen, im.display.height / (2 * sect.zoom), im.raw.height);
  if (cx !== sect.xcen || cy !== sect.ycen) im.setPan(cx, cy);
}

/**
 * Enable image interactions once JS9 is loaded:
 *  - scroll-wheel / two-finger zoom, anchored on the cursor (JS9's built-in
 *    zoom, like DS9, keeps the image centered). JS9's wheel handler is bound to
 *    the display div and already preventDefaults, so it only fires over the
 *    image and never scrolls the page — we just swap its zoom math.
 *  - panning (JS9's native right-drag) is clamped to the image bounds.
 * Mouse-button assignments are left at JS9's defaults (left = value/position,
 * middle = contrast/bias, right = pan).
 */
let interactionsConfigured = false;
function configureInteractions(): void {
  if (interactionsConfigured) return;
  const J = window.JS9 as
    | (NonNullable<typeof window.JS9> & {
        eventToDisplayPos?: (e: WheelEvt) => { x: number; y: number };
        MouseTouch?: { Actions?: Record<string, (im: JS9ImageGeom, evt: WheelEvt) => void> };
        MINZOOM?: number;
        MAXZOOM?: number;
      })
    | undefined;
  const actions = J?.MouseTouch?.Actions;
  if (!J?.globalOpts || !actions) return;

  J.globalOpts.mousetouchZoom = true;

  actions["wheel zoom"] = (im, evt) => {
    const sect = im?.rgb?.sect;
    if (!sect || !im.displayToImagePos || !im.setZoom || !im.setPan || !im.display || !im.raw) return;
    const oe = evt.originalEvent;
    // Normalize wheel delta across devices (pixels / lines / pages) to a bounded
    // step so a mouse notch and a trackpad swipe both feel sane.
    let dy = oe.deltaY;
    if (oe.deltaMode === 1) dy *= 16;
    else if (oe.deltaMode === 2) dy *= 100;
    if (!dy) return;
    const step = Math.max(-1, Math.min(1, dy / 100));
    // Floor zoom at fit, so you can't zoom out into empty space.
    const fit = Math.min(im.display.width / im.raw.width, im.display.height / im.raw.height);
    const min = Math.max(J.MINZOOM ?? 0.125, fit);
    const max = J.MAXZOOM ?? 32;
    const next = Math.min(max, Math.max(min, sect.zoom * Math.exp(-step * 0.25)));
    if (next === sect.zoom) return;

    // Keep the image point under the cursor fixed: zoom, then pan by how far that
    // point drifted. Working in image coords means displayToImagePos has already
    // accounted for any flip/rotation, so the shift needs no sign bookkeeping.
    const pos = J.eventToDisplayPos?.(evt) ?? im.pos;
    if (!pos) {
      im.setZoom(next);
      clampPan(im);
      return;
    }
    const before = im.displayToImagePos(pos);
    im.setZoom(next);
    const after = im.displayToImagePos(pos);
    im.setPan(sect.xcen + (before.x - after.x), sect.ycen + (before.y - after.y));
    clampPan(im);
  };

  // Wrap JS9's native pan so a drag can't push the image off into empty space.
  // Both setPans run synchronously in the same handler, so the screen only
  // paints the clamped result (no flicker).
  const origPan = actions["pan the image"];
  if (typeof origPan === "function") {
    actions["pan the image"] = function (im, evt) {
      origPan.call(this, im, evt);
      clampPan(im);
    };
  }

  interactionsConfigured = true;
}

/** Reformat JS9's "<value> <x> <y> (<sys>)" readout to "I=…, x=…, y=… (sys)". */
function formatValpos(raw: string): string {
  const m = raw.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\(.+\))$/);
  return m ? `I=${m[1]}, x=${m[2]}, y=${m[3]} ${m[4]}` : raw.trim();
}

interface Props {
  /** Image to load. Passing null closes the current image. */
  source: ImageSource | null;
  /** Applied to the viewer's outer column (menubar + scrollable canvas). */
  className?: string;
}

/**
 * Self-contained FITS viewer: a JS9 menubar across the top and the (scrollable)
 * canvas below with a value/position readout. JS9.Load fetches remote FITS
 * itself (SK serves with permissive CORS).
 */
export function JS9Viewer({ source, className }: Props) {
  const { ready, js9, error } = useJS9();
  const menubarHostRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const lastKeyRef = useRef<string | null>(null);
  const [valpos, setValpos] = useState("");

  // JS9 globals, set once it's loaded:
  //  - don't let JS9 hijack the window title with the image filename.
  //  - default every loaded frame to "zscale" limits (z1/z2) instead of raw
  //    data min/max, so faint sky frames come up auto-stretched and legible.
  useEffect(() => {
    if (!ready || !window.JS9) return;
    if (window.JS9.globalOpts) window.JS9.globalOpts.updateTitlebar = false;
    if (window.JS9.imageOpts) window.JS9.imageOpts.scaleclipping = "zscale";
    configureInteractions();
  }, [ready]);

  // Reparent the one persistent display (and its menubar) into the page on
  // mount, then register it; park it back in the detached holder on unmount. The
  // display object and its canvases survive untouched, so nothing is recreated
  // or leaked. `ready` means JS9's one-time init has finished, so AddDivs can't
  // race or duplicate that scan; it builds the display the first time and dedups
  // (no-op) on later remounts. AddDivs also binds the menubar plugin.
  useEffect(() => {
    const nodes = persistentNodes();
    if (!ready || !js9 || !nodes || !menubarHostRef.current || !canvasHostRef.current) return;

    // The pane, not the historical 800x600 default, dictates the display size —
    // on a phone the pane is far smaller and a fixed display could never be
    // seen whole. Measure before AddDivs so the first build is already right.
    const paneSize = (): { w: number; h: number } | null => {
      const host = scrollHostRef.current;
      if (!host) return null;
      // p-2 padding (8px/side) + the value/position readout line below.
      const w = Math.floor(host.clientWidth - 16);
      const h = Math.floor(host.clientHeight - 16 - 24);
      if (w < 100 || h < 100) return null;
      return { w: Math.max(200, w), h: Math.max(150, h) };
    };

    const firstBuild = !js9.displays?.some((d) => d.id === DISPLAY_ID);
    const initial = paneSize();
    if (firstBuild && initial) {
      nodes.canvas.setAttribute("data-width", String(initial.w));
      nodes.canvas.setAttribute("data-height", String(initial.h));
    }

    menubarHostRef.current.appendChild(nodes.menubar);
    canvasHostRef.current.appendChild(nodes.canvas);
    if (firstBuild) {
      try {
        js9.AddDivs?.(DISPLAY_ID);
      } catch {
        // already registered
      }
    }

    // Track the pane from then on (rotation, dock open/close, window resize).
    // Debounced — ResizeDisplay rebuilds canvases, so once per settle is plenty.
    let last = initial ?? { w: 0, h: 0 };
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = paneSize();
        if (!next || (next.w === last.w && next.h === last.h)) return;
        last = next;
        try {
          js9.ResizeDisplay?.(next.w, next.h, { display: DISPLAY_ID });
          js9.SetZoom?.("toFit", { display: DISPLAY_ID });
        } catch {
          // no image open / display parked — harmless
        }
      }, 150);
    });
    if (scrollHostRef.current) ro.observe(scrollHostRef.current);
    // Apply a measured size even when the display predates this mount (e.g.
    // remounting into a differently-sized pane after a tab switch).
    if (!firstBuild && initial) {
      try {
        js9.ResizeDisplay?.(initial.w, initial.h, { display: DISPLAY_ID });
        js9.SetZoom?.("toFit", { display: DISPLAY_ID });
      } catch {
        // nothing open yet
      }
    }

    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
      try {
        js9.CloseImage({ display: DISPLAY_ID, clear: false }); // free pixels while parked
      } catch {
        // nothing open
      }
      nodes.holder.append(nodes.menubar, nodes.canvas);
      lastKeyRef.current = null; // force a reload when the tab is reopened
    };
  }, [ready, js9]);

  // Load on source change. Close the current frame FIRST: JS9 dedups loads by
  // the URL's last path segment, which is "data" for every product endpoint, so
  // without the close it just re-displays the previous frame and never fetches
  // the new URL (the header — a separate fetch — updates, the image doesn't).
  // After closing, Load builds a brand-new image whose constructor applies
  // zscale before it paints. clear:false avoids a blank flash mid-switch.
  useEffect(() => {
    if (!ready || !js9) return;
    const key = source
      ? source.kind === "url"
        ? `url:${source.url}`
        : `file:${source.name}:${source.file.size}`
      : null;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    setValpos("");

    try {
      js9.CloseImage({ display: DISPLAY_ID, clear: false });
    } catch {
      // nothing open
    }
    if (!source) return;

    try {
      js9.Load(source.kind === "url" ? source.url : source.file, {
        display: DISPLAY_ID,
        zoom: "toFit",
        // JS9 invokes onload as fn(image). Operate on THAT image (not
        // display.image) so the correct frame is shown and fit even if a slower
        // earlier load is still in flight.
        onload(im: JS9Image) {
          try {
            im.displayImage?.("all"); // make this image current + paint it
          } catch {
            // ignore
          }
          try {
            im.setZoom?.("toFit");
          } catch {
            // ignore
          }
        },
      });
    } catch (err) {
      console.error("JS9.Load failed", err);
    }
  }, [ready, js9, source]);

  // Surface JS9's (hidden, off-screen) value/position readout below the frame.
  // JS9 keeps it updated on hover; we reformat and render it ourselves.
  useEffect(() => {
    const node = persistentNodes()?.canvas;
    if (!ready || !node) return;
    const read = () => {
      for (const el of Array.from(node.querySelectorAll(".JS9Message:not(.JS9Progress)"))) {
        const t = (el.textContent ?? "").trim();
        if (t && t.endsWith(")")) {
          setValpos(t);
          return;
        }
      }
    };
    const obs = new MutationObserver(read);
    obs.observe(node, { subtree: true, childList: true, characterData: true });
    return () => obs.disconnect();
  }, [ready]);

  return (
    <div className={className}>
      {error && (
        <div className="p-3 text-red-400 text-xs font-mono">JS9 failed to load: {error}</div>
      )}
      {/* JS9's menubar and canvas are reparented into these hosts imperatively;
          React never owns the .JS9 nodes, so it can't recreate (and leak) them. */}
      {/* overflow-x-auto: JS9's stock menubar is a fixed ~8-button row built
          for 600px+ displays — let it scroll sideways on narrow panes. */}
      <div ref={menubarHostRef} className="shrink-0 max-w-full overflow-x-auto" />
      <div
        ref={scrollHostRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col items-start overflow-auto p-2"
      >
        <div ref={canvasHostRef} />
        <div className="mt-1 font-mono text-[11px] text-green-400">{formatValpos(valpos)}</div>
      </div>
    </div>
  );
}
