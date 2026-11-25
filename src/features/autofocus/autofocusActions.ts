import {
  abortControllerTask,
  executeControllerTask,
  type TaskSubmission,
} from "../../lib/sensorkit-client/commands";
import { fetchSnapshot } from "../../lib/sensorkit-client/http";
import { uuid } from "../../lib/uuid";
import { useAutofocusStore, type AutofocusDraft } from "../../stores/autofocus";
import { useBackends } from "../../stores/backends";
import { useSensorKitStore } from "../../stores/sensorkit";
import { autofocusBlocker, buildAutofocusTask } from "./autofocusSetup";
import { focusExecution, recordOf, type AutofocusTask } from "./focusSweepData";

export function autofocusSubmission(
  task: AutofocusTask,
  controller: string,
  program: string,
  requestId: string,
): TaskSubmission<AutofocusTask> {
  const programId =
    program.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") ||
    "sensorview";
  return {
    task,
    context: {
      Program: { id: programId },
      program_name: programId,
      controller_name: controller,
      sensorview_focus_request: requestId,
      FileNameTemplate: {
        template:
          "{Task.id}_{Instrument.name.encode().hex()}_focus{FocusSweep.sample_index:03d}.fits",
      },
    },
  };
}

async function refreshController(controller: string, host: string) {
  try {
    const records = await fetchSnapshot(controller);
    if (useBackends.getState().sensorKit !== host) return;
    // A completion snapshot must not replace newer live state or refill a disconnected cache.
    const kit = useSensorKitStore.getState();
    const provider = useAutofocusStore.getState().providers[controller];
    const state =
      kit.connection === "open" || !provider
        ? kit.state
        : {
            ...kit.state,
            [controller]: { FocusAnalysisSource: { entity: provider } },
          };
    useAutofocusStore.getState().ingest(records, state);
  } catch {
    // Reconnection will supply the controller state if this request lost its connection.
  }
}

/** Keep the request alive independently of the dialog and its React lifetime. */
export async function runAutofocus(
  controller: string,
  draft: AutofocusDraft,
): Promise<void> {
  const kit = useSensorKitStore.getState();
  const store = useAutofocusStore.getState();
  if (store.requests[controller]?.pending)
    throw new Error("An autofocus request is already pending.");
  const blocker = autofocusBlocker(
    kit.state,
    controller,
    draft.instrument,
    kit.connection === "open",
  );
  if (blocker) throw new Error(blocker);
  const task = buildAutofocusTask(draft);
  const id = uuid();
  const host = useBackends.getState().sensorKit;
  const submission = autofocusSubmission(
    task,
    controller,
    useBackends.getState().programName,
    id,
  );
  store.setRequest(controller, {
    id,
    instrument: draft.instrument,
    taskId: null,
    pending: true,
    error: null,
    task,
  });
  try {
    const response = recordOf(
      await executeControllerTask(controller, submission),
    );
    const current = useAutofocusStore.getState().requests[controller];
    if (useBackends.getState().sensorKit === host && current?.id === id) {
      useAutofocusStore.getState().setRequest(controller, {
        ...current,
        pending: false,
        taskId:
          typeof response?.task_id === "string"
            ? response.task_id
            : current.taskId,
      });
    }
  } catch (error) {
    const focus = useAutofocusStore.getState();
    const current = focus.requests[controller];
    if (useBackends.getState().sensorKit === host && current?.id === id) {
      const confirmed = Object.values(focus.sweeps).some((sweep) => {
        const execution = sweep.execution?.execution;
        return (
          sweep.controller === controller &&
          !!execution &&
          (execution?.submitted_context ?? execution?.context)?.[
            "sensorview_focus_request"
          ] === id
        );
      });
      focus.setRequest(controller, {
        ...current,
        pending: false,
        error: confirmed
          ? null
          : error instanceof Error
            ? error.message
            : String(error),
      });
    }
  } finally {
    if (useBackends.getState().sensorKit === host)
      await refreshController(controller, host);
  }
}

export async function abortAutofocus(
  controller: string,
  taskId: string,
): Promise<void> {
  const kit = useSensorKitStore.getState();
  const state = focusExecution(
    recordOf(kit.state[controller]?.["ControllerState"])?.execution_state,
  );
  if (
    kit.connection !== "open" ||
    !("EntityLease" in (kit.state[controller] ?? {})) ||
    !state?.executing ||
    state.execution.task_id !== taskId
  ) {
    throw new Error(
      "This autofocus task is no longer confirmed running on the controller.",
    );
  }
  await abortControllerTask(controller, taskId);
}
