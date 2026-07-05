import { useEffect, useState } from "react";

/**
 * JS9 is an unbundled global-script library. We serve the allinone bundle +
 * wasm blob out of /js9/ (see scripts/copy-js9.mjs) and load them dynamically
 * the first time a component asks for it. Subsequent components share the
 * same globals.
 */

declare global {
  interface Window {
    JS9?: JS9Global;
    JS9Prefs?: unknown;
  }
}

/** A JS9 image handle, as passed to a Load `onload` callback. */
export interface JS9Image {
  id?: string;
  displayImage?: (which?: string) => void;
  setZoom?: (value: string | number) => void;
}

/** Minimal subset of the JS9 API we touch. */
export interface JS9Global {
  Load: (input: File | string, opts?: Record<string, unknown>) => void;
  /** Close the current image in a display. `clear:false` skips wiping the
   *  canvas (avoids a blank flash when we immediately load a replacement). */
  CloseImage: (opts?: { display?: string; clear?: boolean }) => void;
  /** Register a display div (by element id) with JS9. We call this once the
   *  persistent div is in the page; safe to call again (it dedups). */
  AddDivs?: (which?: string | string[]) => void;
  /** Registered displays — read to avoid re-registering on remount. */
  displays?: Array<{ id: string }>;
  /** Flips true when JS9 finishes its one-time init (display scan + plugins).
   *  We wait for it before registering, so we never race that init. */
  inited?: boolean;
  globalOpts?: Record<string, unknown>;
  /** Per-image default options new frames inherit (scale, scaleclipping, …). */
  imageOpts?: Record<string, unknown>;
}

// Resolve against Vite's base so these work both in browser dev (base "/") and
// in the Electron build (base "./", loaded from a file:// origin). An absolute
// "/js9/…" would resolve to the filesystem root under file:// and 404.
const JS9_CSS_HREF = `${import.meta.env.BASE_URL}js9/js9-allinone.css`;
const JS9_JS_SRC = `${import.meta.env.BASE_URL}js9/js9-allinone.js`;

let loadPromise: Promise<JS9Global> | null = null;

/**
 * JS9 finishes its one-time init (display scan + plugin instantiation) on a
 * timer *after* its script executes, flipping `JS9.inited` true when done. We
 * resolve only then, so consumers can register displays without racing that
 * init. A bounded fallback avoids hanging if the flag never appears.
 */
function resolveWhenInited(resolve: (js9: JS9Global) => void): void {
  let tries = 0;
  const check = () => {
    const js9 = window.JS9;
    if (js9 && (js9.inited || tries++ > 300)) resolve(js9);
    else window.setTimeout(check, 16);
  };
  check();
}

function loadJS9(): Promise<JS9Global> {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<JS9Global>((resolve, reject) => {
    if (typeof window !== "undefined" && window.JS9) {
      resolveWhenInited(resolve);
      return;
    }

    // Stylesheet (idempotent — don't re-inject if already present)
    if (!document.querySelector(`link[href="${JS9_CSS_HREF}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = JS9_CSS_HREF;
      document.head.appendChild(link);
    }

    const onScriptReady = () => {
      if (window.JS9) resolveWhenInited(resolve);
      else reject(new Error("JS9 script loaded but window.JS9 is undefined"));
    };

    const existing = document.querySelector(
      `script[src="${JS9_JS_SRC}"]`,
    ) as HTMLScriptElement | null;
    if (existing) {
      if (window.JS9) resolveWhenInited(resolve);
      else {
        existing.addEventListener("load", onScriptReady);
        existing.addEventListener("error", () => reject(new Error("JS9 script load failed")));
      }
      return;
    }

    const script = document.createElement("script");
    script.src = JS9_JS_SRC;
    script.async = true;
    script.addEventListener("load", onScriptReady);
    script.addEventListener("error", () => reject(new Error("JS9 script load failed")));
    document.head.appendChild(script);
  });

  return loadPromise;
}

export interface JS9State {
  ready: boolean;
  error: string | null;
  js9: JS9Global | null;
}

export function useJS9(): JS9State {
  const [state, setState] = useState<JS9State>({
    ready: !!window.JS9,
    error: null,
    js9: window.JS9 ?? null,
  });

  useEffect(() => {
    let cancelled = false;
    loadJS9()
      .then((js9) => {
        if (!cancelled) setState({ ready: true, error: null, js9 });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            ready: false,
            error: err instanceof Error ? err.message : String(err),
            js9: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
