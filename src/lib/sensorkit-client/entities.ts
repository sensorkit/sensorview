/** Live entity metadata. Cache parsed details by KV payload identity. */
import {
  entityTypeOf,
  useSensorKitSlice,
  type StateMap,
} from "../../stores/sensorkit";
import type {
  ControllerDetails,
  DeviceDetails,
  EntityType,
  InstrumentInfo,
} from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Use SensorKit's empty list default for omitted fields. */
function optionalStringArray(v: unknown): string[] | null {
  if (v === undefined) return [];
  return isStringArray(v) ? v : null;
}

function parseInstruments(v: unknown): InstrumentInfo[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const names = new Set<string>();
  const out: InstrumentInfo[] = [];
  for (const item of v) {
    if (!isRecord(item)) return null;
    const name = item["name"];
    if (typeof name !== "string" || name.length === 0 || names.has(name)) return null;
    const devices = optionalStringArray(item["devices"]);
    if (!devices) return null;
    names.add(name);
    out.push({ name, devices: [...new Set(devices)] });
  }
  return out;
}

function parseDeviceDetails(raw: Record<string, unknown>): DeviceDetails | null {
  const published_keywords = optionalStringArray(raw["published_keywords"]);
  const supported_commands = raw["supported_commands"];
  const rawArchetype = raw["archetype"];
  if (!published_keywords || !isStringArray(supported_commands)) return null;
  let archetype: string | null;
  if (rawArchetype === undefined || rawArchetype === null) archetype = null;
  else if (typeof rawArchetype === "string") archetype = rawArchetype;
  else return null;
  return { published_keywords, supported_commands, archetype };
}

function parseControllerDetails(raw: Record<string, unknown>): ControllerDetails | null {
  const published_keywords = optionalStringArray(raw["published_keywords"]);
  const controlled_devices = raw["controlled_devices"];
  const supported_tasks = raw["supported_tasks"];
  const instruments = parseInstruments(raw["instruments"]);
  if (
    !published_keywords ||
    !isStringArray(controlled_devices) ||
    !isStringArray(supported_tasks) ||
    !instruments
  ) {
    return null;
  }
  return { published_keywords, controlled_devices, supported_tasks, instruments };
}

/**
 * Accessor for one details shape. Returns null unless the entity's
 * `EntityInfo.entity_type` is `entityType` and its details validate. Cache is
 * keyed on the raw `details` payload; `null` caches a failed parse.
 */
function cachedParser<T>(
  entityType: EntityType,
  parse: (raw: Record<string, unknown>) => T | null,
) {
  const cache = new WeakMap<object, T | null>();
  return (entityState: Record<string, unknown> | undefined): T | null => {
    const info = entityState?.["EntityInfo"];
    if (!isRecord(info) || info["entity_type"] !== entityType) return null;
    const raw = info["details"];
    if (!isRecord(raw)) return null;
    let parsed = cache.get(raw);
    if (parsed === undefined) {
      parsed = parse(raw);
      cache.set(raw, parsed);
    }
    return parsed;
  };
}

/** Read validated details from a live device entity. */
export const deviceDetailsOf = cachedParser("device", parseDeviceDetails);

/** One device ID from a controller's inventory, with where it was listed. */
export interface ControllerDevice {
  /** Opaque device ID. A device entity with this name may not exist. */
  id: string;
  /** Listed in the controller's `controlled_devices`. */
  controlled: boolean;
  /** Names of the instrument chains listing this ID (in published order). */
  chains: string[];
}

/**
 * A controller's full device inventory: the deduplicated union of
 * `controlled_devices` and every instrument chain's devices, sorted by ID.
 */
export type ControllerDevices = ControllerDevice[];

interface ParsedController {
  details: ControllerDetails;
  devices: ControllerDevices;
}

function inventoryOf(details: ControllerDetails): ControllerDevices {
  const byId = new Map<string, ControllerDevice>();
  const entry = (id: string) => {
    let d = byId.get(id);
    if (!d) byId.set(id, (d = { id, controlled: false, chains: [] }));
    return d;
  };
  for (const id of details.controlled_devices) entry(id).controlled = true;
  for (const chain of details.instruments) {
    for (const id of chain.devices) entry(id).chains.push(chain.name);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const parsedControllerOf = cachedParser<ParsedController>("controller", (raw) => {
  const details = parseControllerDetails(raw);
  return details ? { details, devices: inventoryOf(details) } : null;
});

export interface ControllerRow {
  id: string;
  /** Holds an EntityLease right now. */
  online: boolean;
  /** Validated details; null when unpublished or malformed. */
  details: ControllerDetails | null;
  /** Inventory derived from `details`; empty when `details` is null. */
  devices: ControllerDevices;
}

const NO_DEVICES: ControllerDevices = [];

function computeControllers(state: StateMap): ControllerRow[] {
  const out: ControllerRow[] = [];
  for (const [id, ent] of Object.entries(state)) {
    // Type-only discovery: a controller stays listed even if its details
    // fail validation.
    if (entityTypeOf(ent) !== "controller") continue;
    const parsed = parsedControllerOf(ent);
    out.push({
      id,
      online: "EntityLease" in ent,
      details: parsed?.details ?? null,
      devices: parsed?.devices ?? NO_DEVICES,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function controllersEqual(a: ControllerRow[], b: ControllerRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.online !== y.online || x.details !== y.details) return false;
  }
  return true;
}

/** List controllers by ID. Update on membership, metadata, or online changes. */
export function useControllers(): ControllerRow[] {
  return useSensorKitSlice((s) => computeControllers(s.state), controllersEqual);
}
