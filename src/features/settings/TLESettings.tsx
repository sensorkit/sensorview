import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCustomTLEUrl,
  getTLESources,
  getTLEStatus,
  refreshTLESources,
  spaceTrackLogout,
  updateTLESourceConfig,
  uploadLocalTLEFile,
  type TLESourceId,
  type TLESourceStatus,
} from "../../lib/api-client/tle";
import { SpaceTrackLoginModal } from "./SpaceTrackLoginModal";
import { Toggle } from "./Toggle";

interface MergedStatus {
  count: number;
  lastRefresh: string | null;
  cacheAgeHours: number | null;
}

type BusyKey = TLESourceId | "all";

const SOURCE_LABELS: Record<TLESourceId, { name: string; description: string }> = {
  spacebook: { name: "Spacebook", description: "Free TLE catalog by COMSPOC" },
  spacetrack: { name: "Space-Track", description: "USSPACECOM catalog (requires login)" },
  local: { name: "Local file", description: "Upload a .tle or .3le file" },
  url: { name: "Custom URL", description: "Fetch TLEs from a custom endpoint" },
};

/**
 * TLE source management: enable any combination of sources, drag rows to set
 * merge priority, and manage each source's specifics (Space-Track sign-in,
 * local file upload, custom URL). Drag uses pointer events, not HTML5 DnD —
 * the latter is broken in Electron.
 */
export function TLESettings() {
  const [sources, setSources] = useState<TLESourceStatus[] | null>(null);
  const [merged, setMerged] = useState<MergedStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Partial<Record<BusyKey, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<BusyKey, string | null>>>({});
  const [loginOpen, setLoginOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: TLESourceId; order: TLESourceId[] } | null>(null);
  const rowRefs = useRef(new Map<TLESourceId, HTMLDivElement>());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadAll = useCallback(async () => {
    try {
      const [src, status] = await Promise.all([getTLESources(), getTLEStatus()]);
      setSources(src);
      setMerged(status);
      setLoadError(null);
    } catch (err) {
      // Surface the failure instead of hanging on "Loading sources…" — most
      // often a version-skewed sidecar that predates the /sources endpoint.
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  /** Apply a source list returned by a mutation, then re-sync the merged count. */
  const syncFromSources = useCallback((next: TLESourceStatus[]) => {
    setSources(next);
    getTLEStatus().then(setMerged).catch(() => {});
  }, []);

  const run = useCallback(async (key: BusyKey, fn: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    setErrors((e) => ({ ...e, [key]: null }));
    try {
      await fn();
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [key]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }, []);

  // === Actions ===============================================================

  const toggle = (id: TLESourceId, next: boolean) => {
    setSources((cur) => cur?.map((s) => (s.id === id ? { ...s, enabled: next } : s)) ?? cur);
    updateTLESourceConfig({ enabled: { [id]: next } })
      .then(syncFromSources)
      .catch(() => loadAll());
  };

  const refreshOne = (id: TLESourceId) =>
    run(id, async () => {
      const res = await refreshTLESources(id);
      const err = res.results[id]?.error;
      await loadAll();
      if (err) throw new Error(err);
    });

  const refreshAll = () =>
    run("all", async () => {
      const res = await refreshTLESources();
      // Tolerate a response without a `results` map (e.g. an older sidecar).
      const failures = Object.entries(res?.results ?? {}).filter(([, r]) => r.error);
      setErrors((e) => {
        const next = { ...e };
        for (const [id, r] of failures) next[id as TLESourceId] = r.error ?? null;
        return next;
      });
      await loadAll();
    });

  const onFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    run("local", async () => {
      const text = await file.text();
      const res = await uploadLocalTLEFile(file.name, text);
      syncFromSources(res.sources);
    });
  };

  const signOut = () =>
    run("spacetrack", async () => {
      syncFromSources(await spaceTrackLogout());
    });

  const onLoginSuccess = (next: TLESourceStatus[]) => {
    syncFromSources(next);
    // Credentials verified — pull the catalog right away.
    run("spacetrack", async () => {
      const res = await refreshTLESources("spacetrack");
      const err = res.results["spacetrack"]?.error;
      await loadAll();
      if (err) throw new Error(err);
    });
  };

  const urlSource = sources?.find((s) => s.id === "url");
  const urlValue = urlDraft ?? urlSource?.url ?? "";

  const fetchUrl = () => {
    const url = urlValue.trim();
    if (!url) {
      setErrors((e) => ({ ...e, url: "Enter a URL first." }));
      return;
    }
    run("url", async () => {
      const res = await fetchCustomTLEUrl(url);
      syncFromSources(res.sources);
    });
  };

  // === Drag-to-reorder (pointer events) =====================================

  const displayOrder: TLESourceId[] = drag
    ? drag.order
    : (sources ?? []).map((s) => s.id);

  const computeOrder = (y: number, draggedId: TLESourceId, cur: TLESourceId[]) => {
    const others = cur.filter((id) => id !== draggedId);
    let insert = others.length;
    for (let i = 0; i < others.length; i++) {
      const el = rowRefs.current.get(others[i]!);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        insert = i;
        break;
      }
    }
    const next = [...others];
    next.splice(insert, 0, draggedId);
    return next;
  };

  const onHandleDown = (id: TLESourceId) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id, order: displayOrder });
  };

  const onHandleMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const next = computeOrder(e.clientY, drag.id, drag.order);
    if (next.some((id, i) => id !== drag.order[i])) setDrag({ ...drag, order: next });
  };

  const commitDrag = () => {
    if (!drag || !sources) {
      setDrag(null);
      return;
    }
    const current = sources.map((s) => s.id);
    const changed = drag.order.some((id, i) => id !== current[i]);
    if (changed) {
      const byId = new Map(sources.map((s) => [s.id, s]));
      setSources(drag.order.map((id) => byId.get(id)!));
      updateTLESourceConfig({ order: drag.order })
        .then(syncFromSources)
        .catch(() => loadAll());
    }
    setDrag(null);
  };

  // === Rendering =============================================================

  const bySource = new Map((sources ?? []).map((s) => [s.id, s]));

  return (
    <div className="space-y-4">
      {/* Merged catalog summary */}
      <div className="flex items-center gap-4 text-sm flex-wrap">
        <span className="text-text-dim">
          Active catalog:{" "}
          <span className="text-text-bright">
            {merged ? merged.count.toLocaleString() : "..."}
          </span>{" "}
          satellites
        </span>
        <span className="text-text-dim">
          Updated: <span className="text-text-bright">{formatAge(merged?.cacheAgeHours ?? null)}</span>
        </span>
        <button
          onClick={refreshAll}
          disabled={!!busy.all}
          className="px-3 py-1 pointer-coarse:py-2 text-xs rounded border border-panel-border hover:bg-white/10 text-text-dim disabled:opacity-50"
        >
          {busy.all ? "Refreshing..." : "Refresh sources"}
        </button>
      </div>
      {errors.all && <div className="text-[11px] text-red-300">{errors.all}</div>}

      {/* Source list */}
      <div className="space-y-2">
        {sources === null ? (
          loadError ? (
            <div className="text-xs text-red-300">
              Couldn't load sources: {loadError}{" "}
              <button
                onClick={loadAll}
                className="underline hover:text-text-bright"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="text-xs text-text-dim">Loading sources...</div>
          )
        ) : (
          displayOrder.map((id, index) => {
            const s = bySource.get(id);
            if (!s) return null;
            return (
              <SourceRow
                key={id}
                source={s}
                index={index}
                dragging={drag?.id === id}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(id, el);
                  else rowRefs.current.delete(id);
                }}
                handleProps={{
                  onPointerDown: onHandleDown(id),
                  onPointerMove: onHandleMove,
                  onPointerUp: commitDrag,
                  onPointerCancel: () => setDrag(null),
                }}
                busy={!!busy[id]}
                error={errors[id] ?? null}
                onToggle={(next) => toggle(id, next)}
                onRefresh={() => refreshOne(id)}
                onSignIn={() => setLoginOpen(true)}
                onSignOut={signOut}
                onChooseFile={() => fileInputRef.current?.click()}
                urlValue={urlValue}
                onUrlChange={setUrlDraft}
                onFetchUrl={fetchUrl}
              />
            );
          })
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".tle,.3le,.txt"
        onChange={onFileChosen}
        className="hidden"
      />

      <SpaceTrackLoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={onLoginSuccess}
      />
    </div>
  );
}

function SourceRow({
  source,
  index,
  dragging,
  rowRef,
  handleProps,
  busy,
  error,
  onToggle,
  onRefresh,
  onSignIn,
  onSignOut,
  onChooseFile,
  urlValue,
  onUrlChange,
  onFetchUrl,
}: {
  source: TLESourceStatus;
  index: number;
  dragging: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  handleProps: Pick<
    React.HTMLAttributes<HTMLDivElement>,
    "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
  >;
  busy: boolean;
  error: string | null;
  onToggle: (next: boolean) => void;
  onRefresh: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onChooseFile: () => void;
  urlValue: string;
  onUrlChange: (v: string) => void;
  onFetchUrl: () => void;
}) {
  const label = SOURCE_LABELS[source.id];

  return (
    <div
      ref={rowRef}
      className={
        "flex flex-wrap items-center gap-3 px-3 py-2 rounded border transition-colors " +
        (dragging
          ? "border-orange-300/60 bg-white/10"
          : "border-panel-border bg-black/20")
      }
    >
      <div
        {...handleProps}
        title="Drag to change priority"
        className="flex items-center gap-1 text-text-dim cursor-grab active:cursor-grabbing touch-none select-none py-1 pointer-coarse:p-2 pointer-coarse:-m-1"
      >
        <span className="text-[10px] w-3 text-right tabular-nums">{index + 1}</span>
        <GripDots />
      </div>
      <Toggle
        size="sm"
        checked={source.enabled}
        onChange={onToggle}
        onColor={source.count > 0 ? "bg-green-500" : "bg-amber-500"}
        title={source.enabled ? "Disable source" : "Enable source"}
        aria-label={source.enabled ? "Disable source" : "Enable source"}
      />

      <div className={`flex-1 min-w-40 ${source.enabled ? "" : "opacity-60"}`}>
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-text-bright whitespace-nowrap">{label.name}</span>
          <span className="text-xs text-text-dim truncate">{label.description}</span>
        </div>
        {source.id === "url" ? (
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <input
              type="text"
              value={urlValue}
              onChange={(e) => onUrlChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onFetchUrl();
              }}
              placeholder="https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle"
              className="flex-1 min-w-48 bg-black/40 border border-panel-border rounded px-2 py-0.5 font-mono text-[11px] text-text-bright outline-none focus:border-orange-300/60"
            />
            <RowButton onClick={onFetchUrl} disabled={busy}>
              {busy ? "Fetching..." : "Fetch"}
            </RowButton>
          </div>
        ) : null}
        {statusLine(source) && (
          <div className="text-[11px] text-text-dim mt-0.5">{statusLine(source)}</div>
        )}
        {error && <div className="text-[11px] text-red-300 mt-0.5">{error}</div>}
      </div>

      <div className="flex w-full justify-end gap-1.5 sm:w-auto sm:shrink-0 items-center">
        {source.id === "spacebook" && (
          <RowButton onClick={onRefresh} disabled={busy}>
            {busy ? "Refreshing..." : "Refresh"}
          </RowButton>
        )}
        {source.id === "spacetrack" &&
          (source.username ? (
            <>
              <RowButton onClick={onRefresh} disabled={busy}>
                {busy ? "Refreshing..." : "Refresh"}
              </RowButton>
              <RowButton onClick={onSignOut} disabled={busy}>
                Sign out
              </RowButton>
            </>
          ) : (
            <RowButton onClick={onSignIn} disabled={busy}>
              Sign in...
            </RowButton>
          ))}
        {source.id === "local" && (
          <RowButton onClick={onChooseFile} disabled={busy}>
            {busy ? "Loading..." : source.filename ? "Replace..." : "Choose file..."}
          </RowButton>
        )}
      </div>
    </div>
  );
}

function statusLine(s: TLESourceStatus): string {
  const sats = s.count > 0 ? `${s.count.toLocaleString()} sats` : null;
  switch (s.id) {
    case "spacebook":
      if (!sats) return "no data yet";
      return s.cacheAgeHours == null
        ? `${sats} · seed data, not yet refreshed`
        : `${sats} · refreshed ${formatAge(s.cacheAgeHours)}`;
    case "spacetrack":
      if (!s.username) return "not signed in";
      return (
        `signed in as ${s.username}` +
        (sats ? ` · ${sats} · refreshed ${formatAge(s.cacheAgeHours)}` : " · no data yet")
      );
    case "local":
      if (!s.filename) return "no file loaded";
      return (
        `${s.filename} · ${sats ?? "0 sats"}` +
        (s.format ? ` · ${s.format.toUpperCase()}` : "") +
        ` · loaded ${formatAge(s.cacheAgeHours)}`
      );
    case "url":
      if (!sats) return "";
      return (
        `${sats}` +
        (s.format ? ` · ${s.format.toUpperCase()}` : "") +
        ` · fetched ${formatAge(s.cacheAgeHours)}`
      );
  }
}

function formatAge(hours: number | null): string {
  if (hours == null) return "never";
  if (hours < 1) return `${Math.round(hours * 60)} min ago`;
  if (hours < 48) return `${hours.toFixed(1)} hrs ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function RowButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-2 py-0.5 pointer-coarse:px-3 pointer-coarse:py-1.5 text-[11px] rounded border border-panel-border hover:bg-white/10 text-text-dim hover:text-text-bright disabled:opacity-50 whitespace-nowrap"
    >
      {children}
    </button>
  );
}

function GripDots() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" className="fill-current opacity-70">
      <circle cx="3" cy="4" r="1.3" />
      <circle cx="7" cy="4" r="1.3" />
      <circle cx="3" cy="8" r="1.3" />
      <circle cx="7" cy="8" r="1.3" />
      <circle cx="3" cy="12" r="1.3" />
      <circle cx="7" cy="12" r="1.3" />
    </svg>
  );
}
