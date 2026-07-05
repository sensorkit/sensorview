import { useCallback, useEffect, useRef, useState } from "react";
import { parseAnsi, type AnsiSegment } from "./ansi";
import { useUIPanelsStore } from "../../stores/uiPanels";

const MAX_LINES = 2000;
const FONT_MIN = 5;
const FONT_MAX = 16;

/**
 * Live-tails a Docker service's log. Services are discovered with `docker ps`
 * and tailed with `docker logs -f` in the Electron main process (see
 * electron/main.js) — both behave identically across Win/Mac/Linux. In the
 * browser build there is no local Docker, so we degrade to a notice. Closed via
 * its arrow tab (no header).
 */
export function ServiceLogPanel() {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  const isElectron = !!api?.isElectron;

  const [services, setServices] = useState<DockerService[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [lines, setLines] = useState<AnsiSegment[][]>([]);
  const [error, setError] = useState<string | null>(null);

  const fontSize = useUIPanelsStore((s) => s.logFontSize);
  const wrap = useUIPanelsStore((s) => s.logWrap);
  const setFontSize = useUIPanelsStore((s) => s.setLogFontSize);
  const toggleWrap = useUIPanelsStore((s) => s.toggleLogWrap);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Chunk handler reads the live selection through a ref to dodge stale closures.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const refresh = useCallback(async () => {
    if (!api?.isElectron) return;
    // A stale preload (main/preload weren't reloaded after an update) leaves the
    // bridge method undefined — surface that instead of silently showing nothing.
    if (typeof api.listDockerServices !== "function") {
      setError("Log bridge unavailable — restart the desktop app to load it.");
      return;
    }
    try {
      const res = await api.listDockerServices();
      if ("error" in res) {
        setError(res.error);
        setServices([]);
      } else {
        setError(null);
        setServices(res.services);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setServices([]);
    }
  }, [api]);

  // Initial service list.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Subscribe once to log chunks; filter to the active selection.
  useEffect(() => {
    if (!api?.isElectron) return;
    return api.onDockerLogChunk(({ container, text }) => {
      if (container !== selectedRef.current) return;
      const incoming = text
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map(parseAnsi);
      if (incoming.length === 0) return;
      setLines((prev) => {
        const next = prev.concat(incoming);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    });
  }, [api]);

  // Start/stop the tail when the selection changes.
  useEffect(() => {
    if (!api?.isElectron || !selected) return;
    if (typeof api.startDockerLog !== "function") return;
    setLines([]);
    stickRef.current = true;
    api.startDockerLog(selected).then((res) => {
      if (res && "error" in res) setError(res.error);
    });
    return () => {
      api.stopDockerLog(selected);
    };
  }, [api, selected]);

  // Stick to bottom unless the user has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  if (!isElectron) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-text-dim">
          Service logs are available in the SensorView desktop app.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-3 h-[44px] border-b border-panel-border">
        <button
          onClick={refresh}
          title="Refresh service list"
          aria-label="Refresh service list"
          className="shrink-0 px-1 text-text-dim hover:text-text-bright text-xs cursor-pointer"
        >
          ⟳
        </button>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="flex-1 min-w-0 bg-black/40 border border-panel-border rounded px-2 py-1 text-[11px] text-text-bright"
        >
          <option value="">Select a service…</option>
          {services.map((s) => (
            <option key={s.id} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="shrink-0 flex items-center gap-1 text-text-dim">
          <button
            onClick={() => setFontSize(Math.max(FONT_MIN, fontSize - 1))}
            disabled={fontSize <= FONT_MIN}
            title="Smaller text"
            aria-label="Smaller log text"
            className="px-1 hover:text-text-bright text-xs cursor-pointer disabled:opacity-30 disabled:cursor-default"
          >
            A−
          </button>
          <button
            onClick={() => setFontSize(Math.min(FONT_MAX, fontSize + 1))}
            disabled={fontSize >= FONT_MAX}
            title="Larger text"
            aria-label="Larger log text"
            className="px-1 hover:text-text-bright text-[15px] leading-none cursor-pointer disabled:opacity-30 disabled:cursor-default"
          >
            A+
          </button>
          <button
            onClick={toggleWrap}
            aria-pressed={!wrap}
            title={wrap ? "Disable word wrap" : "Enable word wrap"}
            aria-label="Toggle word wrap"
            className={`px-1 text-xs cursor-pointer hover:text-text-bright ${wrap ? "" : "text-brass"}`}
          >
            {wrap ? "⤶" : "↔"}
          </button>
        </div>
      </div>
      {error && (
        <div className="shrink-0 px-3 py-1.5 text-[10px] text-red-300 break-words border-b border-panel-border">
          {error}
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ fontSize: `${fontSize}px` }}
        className={`flex-1 min-h-0 overflow-auto bg-black/50 px-3 py-2 mono leading-[1.45] text-text-bright ${
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
        }`}
      >
        {lines.length === 0
          ? selected && <div className="text-text-dim">Waiting for log output…</div>
          : lines.map((segs, i) => (
              <div key={i}>
                {segs.map((s, j) => (
                  <span
                    key={j}
                    style={{
                      color: s.color,
                      fontWeight: s.bold ? 600 : undefined,
                      opacity: s.dim ? 0.65 : undefined,
                    }}
                  >
                    {s.text}
                  </span>
                ))}
              </div>
            ))}
      </div>
    </div>
  );
}
