import { useState } from "react";
import { useSensorKitStore } from "../../stores/sensorkit";
import type { EntityListing, EntityType } from "../../lib/sensorkit-client/types";
import { WeatherCard } from "./WeatherCard";

// Section ordering for the entity list. Programs first because they're the
// highest level of intent; generic last because it's the catch-all.
const ENTITY_GROUPS: { type: EntityType; label: string }[] = [
  { type: "program", label: "Programs" },
  { type: "controller", label: "Controllers" },
  { type: "device", label: "Devices" },
  { type: "generic", label: "Generic" },
];

export function StatusPage() {
  // Connection state is rendered by the SK LIVE pill in AppLayout — no need
  // to repeat it here. We only surface lastError, since the pill goes red
  // on error but doesn't tell you *why*.
  const connection = useSensorKitStore((s) => s.connection);
  const lastError = useSensorKitStore((s) => s.lastError);
  const entities = useSensorKitStore((s) => s.entities);
  const state = useSensorKitStore((s) => s.state);

  // Find the agent's entity name by scanning state for AgentState. The agent
  // doesn't publish EntityInfo, so it isn't in `entities`/grouped sections —
  // we surface it as its own row up top so its kv is still inspectable.
  let agentEntityName: string | null = null;
  for (const [name, entityState] of Object.entries(state)) {
    if ((entityState as Record<string, unknown>)["AgentState"]) {
      agentEntityName = name;
      break;
    }
  }
  const agentRowEntity: EntityListing | null = agentEntityName
    ? {
        name: agentEntityName,
        // EntityType doesn't include "agent" — the agent isn't a registered
        // entity type. "generic" is the closest semantic fit and the row
        // doesn't render entity_type anyway.
        entity_type: "generic",
        online: true,
        details: null,
        archetype: null,
      }
    : null;

  // When SensorKit isn't reachable, collapse the page to a single line —
  // the entity list and lastError surfacing are noise without a live feed.
  if (connection !== "open") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-6xl mx-auto p-4 text-text-dim text-sm">
          Waiting for SensorKit connection…
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-4 space-y-6 text-text-dim text-sm">
        {/* Weather card replaces the page header; the tab name itself
            (visible in the top nav) is sufficient context. Card collapses
            (returns null) when no entity publishes BasicWeather, in which
            case the entity list slides up cleanly. */}
        <WeatherCard />

        {lastError && (
          <section>
            <div className="text-red-400 text-xs">{lastError}</div>
          </section>
        )}

        {agentRowEntity && (
              <section>
                <h2 className="text-text-bright text-sm mb-2">Agent</h2>
                <div className="space-y-1">
                  <EntityRow
                    entity={agentRowEntity}
                    entityState={state[agentRowEntity.name]}
                  />
                </div>
              </section>
            )}

            {entities.length === 0 ? (
              <div className="text-xs text-text-dim">No entities yet.</div>
            ) : (
              ENTITY_GROUPS.map(({ type, label }) => {
                const items = entities
                  .filter((e) => e.entity_type === type)
                  .sort((a, b) => a.name.localeCompare(b.name));
                if (items.length === 0) return null;
                return (
                  <section key={type}>
                    <h2 className="text-text-bright text-sm mb-2">
                      {label} ({items.length})
                    </h2>
                    <div className="space-y-1">
                      {items.map((e) => (
                        <EntityRow
                          key={e.name}
                          entity={e}
                          entityState={state[e.name]}
                        />
                      ))}
                    </div>
                  </section>
                );
              })
            )}
      </div>
    </div>
  );
}

function EntityRow({
  entity,
  entityState,
}: {
  entity: EntityListing;
  entityState: Record<string, unknown> | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = entity.details && Object.keys(entity.details).length > 0;
  const hasState = entityState ? Object.keys(entityState).length > 0 : false;
  const expandable = hasDetails || hasState;

  return (
    <div className="border-b border-panel-border/50 last:border-b-0">
      <button
        type="button"
        onClick={() => expandable && setExpanded((v) => !v)}
        disabled={!expandable}
        className={`w-full flex items-center gap-2 text-xs font-mono py-1 text-left ${
          expandable ? "cursor-pointer hover:bg-white/[0.02]" : "cursor-default"
        }`}
      >
        <span className="text-text-dim w-3 text-center">
          {expandable ? (expanded ? "▾" : "▸") : " "}
        </span>
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            entity.online ? "bg-green-400" : "bg-gray-500"
          }`}
        />
        <span className="text-text-bright w-40 truncate">{entity.name}</span>
        <span className="text-text-dim">{entity.archetype ?? ""}</span>
      </button>

      {expanded && (
        <div className="ml-5 mb-2 space-y-2">
          {hasDetails && (
            <Block label="details" value={entity.details!} />
          )}
          {hasState && entityState && (
            <Block label="state" value={entityState} />
          )}
        </div>
      )}
    </div>
  );
}

function Block({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-dim mb-0.5">
        {label}
      </div>
      <pre className="text-[11px] font-mono bg-black/30 border border-panel-border rounded p-2 overflow-auto max-h-[40vh] whitespace-pre text-text-bright">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
