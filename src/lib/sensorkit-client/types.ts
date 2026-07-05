/**
 * Types for the SensorKit webapi (see /openapi.json on the running service).
 *
 * The webapi streams state as SKRecord tuples; REST endpoints return typed
 * entity summaries and payload shapes. Only the subset we actively consume
 * is modeled here — unknown payloads stay as `unknown`.
 */

export type EntityType = "controller" | "device" | "program" | "generic";

export interface EntityListing {
  entity_type: EntityType;
  name: string;
  online: boolean;
  details: Record<string, unknown> | null;
  archetype?: string | null;
  traits?: string[];
}

/** Addressable subject inside the backend — path tuple + property name. */
export interface Subject {
  path: string[];
  prop: string;
}

/** Wire format for both /data/snapshot and /data/subscribe (SSE). */
export type SKRecord = [
  kind: "state" | "event" | "stream" | "product",
  timestamp: string,
  subject: Subject,
  payload: unknown,
];

/** A FITS header served as a flat JSON object by the SK /metadata endpoint. */
export type ProductMetadata = Record<string, unknown>;

/**
 * Listing record for one data product. Returned by /controller/{id}/products
 * and carried as the payload of firehose `kind:"product"` records.
 */
export interface ProductInfo {
  controller_id: string;
  product_id: string;
  /** File creation time (ISO). */
  register_time: string;
  /** File size in bytes. */
  data_size: number;
}

/**
 * One data product (FITS file) as held in the store. `registerTime`/`dataSize`
 * come from the listing or firehose; the FITS `header` is fetched lazily from
 * /metadata when the product is opened.
 */
export interface ProductEntry {
  productId: string;
  registerTime?: string;
  dataSize?: number;
  header?: ProductMetadata;
}

// === Known payload shapes ===

export interface SitePosition {
  latitude_degrees: number;
  longitude_degrees: number;
  altitude_km: number;
}

export interface EnableState {
  event_model: string;
  event_id: string;
  enabled: boolean;
}

export interface OperatingState {
  event_model: string;
  event_id: string;
  current: string;
  previous: string | null;
  target: string | null;
}

/**
 * SK `TaskExecution` envelope. Since SK split `Task` into a user-defined
 * semantic task and an execution envelope, the controller mints the identity
 * (`task_id`, `controller_id`) and nests the semantic task under `task`;
 * client-supplied execution params (`context`, `expiry_time`) ride on the
 * envelope. Used by `ExecutionState.task` and `ProgramTaskingState`.
 */
export interface TaskExecution {
  /** The semantic task, discriminated by its `task_type`. */
  task: unknown;
  task_id: string;
  controller_id: string;
  context: unknown;
  expiry_time: string | null;
}

export interface ExecutionState {
  event_model: string;
  event_id: string;
  executing: boolean;
  aborting: boolean;
  finished: string | null;
  /** `TaskExecution` envelope while executing; `null` when idle. */
  execution: TaskExecution | null;
  context: unknown;
}

export interface ControllerState {
  enable_state: EnableState;
  operating_state: OperatingState;
  execution_state: ExecutionState;
}

export interface DeviceState {
  enable_state: EnableState;
}

export interface Capabilities {
  type: "controller" | "device" | "program";
  commands?: string[];
  tasks?: string[];
  devices?: Record<string, string | null>;
  device_type?: string;
}

export interface EntityLease {
  acquired_at: string;
  refreshed_at: string;
  record: { name: string; version: string };
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "error";

// === Agent state ===
//
// Published as the AgentState keyword by the SK auto-orchestration agent (see
// sensorkit/auto/agent.py). One agent per deployment, but the entity name is
// up to the deployer — look it up by keyword presence, not by entity name.

export interface AgentControllerInfo {
  control_enabled: boolean;
  elected_state: boolean;
  demand_override: string | null;
}

export interface AgentOperatingState {
  global_control_enabled: boolean;
  controllers: Record<string, AgentControllerInfo>;
}

export interface ScheduleWindow {
  mode: string;
  programs: string[];
}
export type ScheduleEntry = [start: string, end: string, ScheduleWindow];

export interface AgentSchedulerState {
  scheduling_enabled: boolean;
  excluded_programs: string[];
  schedule: Record<string, ScheduleEntry[]>;
}

export interface AgentState {
  operating_state: AgentOperatingState;
  scheduler_state: AgentSchedulerState;
}

// === Agent Capabilities ===
//
// Published as the `Capabilities` keyword on the agent entity (separate from
// the per-controller/device Capabilities above — discriminated by `type`).
// Marked deprecated in SK; we use it because nothing else exposes mode.state
// today. Replace once Erik exposes `state` directly on ScheduleIntent.

export interface ModeDefinition {
  name: string;
  description?: string;
  state: "operate" | "standby";
}

export interface ControllerConfig {
  modes: ModeDefinition[];
}

export interface AgentCapabilities {
  type: "agent";
  controllers: Record<string, ControllerConfig>;
}
