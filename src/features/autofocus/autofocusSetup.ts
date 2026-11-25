import type { ControllerDetails } from "../../lib/sensorkit-client/types";
import type { StateMap } from "../../stores/sensorkit";
import {
  DEFAULT_AUTOFOCUS_DRAFT,
  type AutofocusDraft,
} from "../../stores/autofocus";
import { controllerDetailsOf } from "../../lib/sensorkit-client/entities";
import { focusProvider, recordOf, type AutofocusTask } from "./focusSweepData";

export function draftForAutofocusTask(task: AutofocusTask): AutofocusDraft {
  return {
    ...DEFAULT_AUTOFOCUS_DRAFT,
    instrument: task.instrument,
    step: String(task.step),
    count: String(task.count),
    exposure: String(task.integration_time_seconds),
    useReported: task.center == null,
    center: task.center == null ? "" : String(task.center),
    filter: task.filter_name ?? "",
    binning: task.binning
      ? task.binning.x === task.binning.y
        ? String(task.binning.x)
        : `${task.binning.x}x${task.binning.y}`
      : "",
    gain: task.gain == null ? "" : String(task.gain),
    readout: task.readout_mode == null ? "" : String(task.readout_mode),
  };
}

/** Subscribe only to metadata, liveness, execution, and focus positions used by the dialog. */
export function focusDialogState(
  state: StateMap,
  controller: string,
): StateMap {
  const selected: StateMap = {};
  const pick = (id: string, properties: string[]) => {
    const entity: Record<string, unknown> = {};
    for (const prop of properties) {
      if (prop in (state[id] ?? {})) entity[prop] = state[id]![prop];
    }
    selected[id] = { ...selected[id], ...entity };
  };
  pick(controller, [
    "EntityInfo",
    "EntityLease",
    "ControllerState",
    "FocusAnalysisSource",
  ]);
  const provider = focusProvider(state, controller);
  if (provider) pick(provider, ["EntityInfo", "EntityLease"]);
  for (const instrument of controllerFocusDetails(state, controller)
    ?.instruments ?? []) {
    for (const device of instrument.devices)
      pick(device, ["EntityInfo", "EntityLease", "FocusPosition"]);
  }
  return selected;
}

export function focusDialogStateEqual(a: StateMap, b: StateMap): boolean {
  const ids = Object.keys(a);
  return (
    ids.length === Object.keys(b).length &&
    ids.every((id) => {
      const entity = b[id];
      const props = Object.keys(a[id]!);
      return (
        entity !== undefined &&
        props.length === Object.keys(entity).length &&
        props.every((prop) => Object.is(a[id]![prop], entity[prop]))
      );
    })
  );
}

export function controllerFocusDetails(
  state: StateMap,
  controller: string,
): ControllerDetails | null {
  return controllerDetailsOf(state[controller]);
}

export function instrumentFocuser(
  state: StateMap,
  controller: string,
  instrument: string,
): { id: string | null; position: number | null; reason: string | null } {
  const chain = controllerFocusDetails(state, controller)?.instruments.find(
    (i) => i.name === instrument,
  );
  if (!chain)
    return {
      id: null,
      position: null,
      reason: "Choose a controller instrument.",
    };
  const focusers = chain.devices.filter((id) => {
    const details = recordOf(recordOf(state[id]?.["EntityInfo"])?.details);
    return (
      Array.isArray(details?.supported_commands) &&
      details.supported_commands.includes("ChangeFocusPosition")
    );
  });
  if (focusers.length !== 1)
    return {
      id: null,
      position: null,
      reason: focusers.length
        ? "The instrument has more than one focuser."
        : "The instrument has no published focuser.",
    };
  const id = focusers[0]!;
  const value = recordOf(state[id]?.["FocusPosition"])?.position;
  const position =
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    id,
    position,
    reason: !("EntityLease" in (state[id] ?? {}))
      ? "The focuser is offline."
      : position === null
        ? "The focuser has not reported a finite position."
        : null,
  };
}

/** Explain the first unmet execution prerequisite. The dialog remains inspectable. */
export function autofocusBlocker(
  state: StateMap,
  controller: string,
  instrument: string,
  connected: boolean,
): string | null {
  if (!connected) return "SensorKit connection is unavailable.";
  const entity = state[controller];
  if (!entity || !("EntityLease" in entity)) return "Controller is offline.";
  const details = controllerFocusDetails(state, controller);
  if (!details?.supported_tasks.includes("AutoFocus"))
    return "Controller does not support AutoFocus.";
  const controllerState = recordOf(entity["ControllerState"]);
  if (!controllerState) return "Controller state is unavailable.";
  if (recordOf(controllerState.enable_state)?.enabled !== true)
    return "Controller is disabled.";
  if (recordOf(controllerState.execution_state)?.executing === true)
    return "A controller task is already running.";
  const provider = focusProvider(state, controller);
  if (!provider) return "No focus analysis provider is configured.";
  const source = state[provider];
  if (!source || !("EntityLease" in source))
    return `Analysis provider ${provider} is offline.`;
  const keywords = recordOf(
    recordOf(source["EntityInfo"])?.details,
  )?.published_keywords;
  if (
    !Array.isArray(keywords) ||
    !["FocusAnalysis", "FocusSweepAnalysis"].every((k) => keywords.includes(k))
  ) {
    return `Analysis provider ${provider} does not advertise focus measurements and sweep analysis.`;
  }
  return instrumentFocuser(state, controller, instrument).reason;
}

export function buildAutofocusTask(draft: AutofocusDraft): AutofocusTask {
  const number = (value: string, label: string): number => {
    if (value.trim() === "" || !Number.isFinite(Number(value)))
      throw new Error(`${label} must be a finite number.`);
    return Number(value);
  };
  const step = number(draft.step, "Step");
  const count = number(draft.count, "Samples");
  const exposure = number(draft.exposure, "Exposure");
  if (!draft.instrument) throw new Error("Choose an instrument.");
  if (step <= 0) throw new Error("Step must be positive.");
  if (!Number.isInteger(count) || count < 5)
    throw new Error("Use at least five sample positions for SENPAI fitting.");
  if (exposure <= 0) throw new Error("Exposure must be positive.");
  const task: AutofocusTask = {
    task_type: "autofocus",
    instrument: draft.instrument,
    step,
    count,
    integration_time_seconds: exposure,
  };
  if (!draft.useReported) task.center = number(draft.center, "Center");
  if (draft.gain !== "") task.gain = number(draft.gain, "Gain");
  if (draft.filter !== "") task.filter_name = draft.filter;
  if (draft.readout !== "") {
    task.readout_mode = number(draft.readout, "Readout mode");
    if (!Number.isInteger(task.readout_mode) || task.readout_mode < 0)
      throw new Error("Readout mode must be a nonnegative integer.");
  }
  if (draft.binning !== "") {
    const parts = draft.binning.split("x");
    const x = number(parts[0]!, "Binning");
    const y = parts.length === 1 ? x : number(parts[1]!, "Binning");
    if (
      parts.length > 2 ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 1 ||
      y < 1
    )
      throw new Error("Binning must use positive integers.");
    task.binning = { x, y };
  }
  return task;
}
