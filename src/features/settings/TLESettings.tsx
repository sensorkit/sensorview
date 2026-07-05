import { useCallback, useEffect, useState } from "react";
import { getTLEStatus, refreshTLECache } from "../../lib/api-client/tle";

interface CacheStatus {
  count: number;
  lastRefresh: string | null;
  cacheAgeHours: number | null;
}

export function TLESettings() {
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getTLEStatus());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshTLECache();
      await loadStatus();
    } catch { /* ignore */ }
    setRefreshing(false);
  };

  const ageLabel = status?.cacheAgeHours != null
    ? status.cacheAgeHours < 1
      ? `${Math.round(status.cacheAgeHours * 60)} min ago`
      : `${status.cacheAgeHours.toFixed(1)} hrs ago`
    : "never";

  return (
    <div className="space-y-4">
      {/* Cache status */}
      <div className="flex items-center gap-4 text-sm">
        <span className="text-text-dim">
          Cached: <span className="text-text-bright">{status?.count ?? "..."}</span> satellites
        </span>
        <span className="text-text-dim">
          Last refresh: <span className="text-text-bright">{ageLabel}</span>
        </span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-3 py-1 text-xs rounded border border-panel-border hover:bg-white/10 text-text-dim disabled:opacity-50"
        >
          {refreshing ? "Refreshing..." : "Refresh from Spacebook"}
        </button>
      </div>

      {/* TLE source list */}
      <div>
        <h3 className="text-xs font-semibold text-text-dim uppercase tracking-wide mb-2">
          Sources
        </h3>
        <div className="space-y-2">
          <SourceRow
            name="Spacebook"
            description="Free TLE catalog by COMSPOC"
            active
          />
          <SourceRow
            name="Space-Track"
            description="USSPACECOM catalog (requires login)"
            active={false}
            comingSoon
          />
          <SourceRow
            name="Local file"
            description="Upload .tle or .3le file"
            active={false}
            comingSoon
          />
          <SourceRow
            name="Custom URL"
            description="Fetch TLEs from a custom endpoint"
            active={false}
            comingSoon
          />
        </div>
      </div>
    </div>
  );
}

function SourceRow({
  name,
  description,
  active,
  comingSoon,
}: {
  name: string;
  description: string;
  active: boolean;
  comingSoon?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded border border-panel-border bg-black/20">
      <div
        className={`w-2 h-2 rounded-full ${active ? "bg-green-500" : "bg-neutral-600"}`}
      />
      <div className="flex-1 min-w-0">
        <span className="text-sm text-text-bright">{name}</span>
        <span className="text-xs text-text-dim ml-2">{description}</span>
      </div>
      {comingSoon && (
        <span className="text-xs text-text-dim italic">coming soon</span>
      )}
    </div>
  );
}
