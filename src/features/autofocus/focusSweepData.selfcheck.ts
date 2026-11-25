// Run with esbuild --bundle --platform=node --format=esm, then Node.
import assert from "node:assert/strict";
import {
  buildAutofocusTask,
  autofocusBlocker,
  focusDialogState,
  focusDialogStateEqual,
  draftForAutofocusTask,
} from "./autofocusSetup";
import {
  focusAnalysis,
  ingestFocusRecords,
  latestFocusSweep,
  sweepKey,
  sweepOutcome,
  type FocusSample,
  type FocusSweepAnalysis,
  type FocusSweeps,
} from "./focusSweepData";
import type { StateMap } from "../../stores/sensorkit";
import type { SKRecord } from "../../lib/sensorkit-client/types";
import { DEFAULT_AUTOFOCUS_DRAFT } from "../../stores/autofocus";
import {
  autofocusSubmission,
  abortAutofocus,
  runAutofocus,
} from "./autofocusActions";
import { useAutofocusStore } from "../../stores/autofocus";
import { useSensorKitStore } from "../../stores/sensorkit";
import { useBackends } from "../../stores/backends";

const controller = "Observatory",
  instrument = "Science Camera",
  provider = "SENPAI",
  id = "0192c3f4-5678-7abc-8def-0123456789ab";
const state: StateMap = {
  [controller]: {
    EntityLease: {},
    FocusAnalysisSource: { entity: provider },
    EntityInfo: {
      entity_type: "controller",
      details: {
        published_keywords: [],
        supported_tasks: ["AutoFocus"],
        controlled_devices: ["Camera", "Focuser"],
        instruments: [{ name: instrument, devices: ["Camera", "Focuser"] }],
      },
    },
    ControllerState: {
      enable_state: { enabled: true },
      execution_state: { executing: false, execution: null },
    },
  },
  [provider]: {
    EntityLease: {},
    EntityInfo: {
      details: { published_keywords: ["FocusAnalysis", "FocusSweepAnalysis"] },
    },
  },
  Focuser: {
    EntityLease: {},
    EntityInfo: { details: { supported_commands: ["ChangeFocusPosition"] } },
    FocusPosition: { position: 12400 },
  },
};
const draft = { ...DEFAULT_AUTOFOCUS_DRAFT, instrument, step: "200" };
const task = buildAutofocusTask(draft);
const pendingDraft = draftForAutofocusTask({
  ...task,
  instrument: "Second camera",
  step: 100,
  count: 9,
  binning: { x: 2, y: 3 },
});
assert.equal(pendingDraft.instrument, "Second camera");
assert.equal(pendingDraft.step, "100");
assert.equal(pendingDraft.count, "9");
assert.equal(pendingDraft.binning, "2x3");
const dialogState = focusDialogState(state, controller);
assert.ok(
  focusDialogStateEqual(
    dialogState,
    focusDialogState(
      {
        ...state,
        UnrelatedMount: { Pointing: { az: 20 } },
        Focuser: { ...state.Focuser, Temperature: { value: 10 } },
      },
      controller,
    ),
  ),
);
assert.equal(
  focusDialogStateEqual(
    dialogState,
    focusDialogState(
      {
        ...state,
        Focuser: { ...state.Focuser, FocusPosition: { position: 12500 } },
      },
      controller,
    ),
  ),
  false,
);
const record = (
  prop: string,
  payload: unknown,
  source = provider,
  seconds = 0,
): SKRecord => [
  "stream",
  `2026-11-25T12:00:${String(seconds).padStart(2, "0")}Z`,
  { path: [source], prop },
  payload,
];
const sample = (index: number, sweepId = id): FocusSample => ({
  controller_id: controller,
  instrument,
  image_id: `frame-${index}`,
  exposure: { start: "2026-11-25T12:00:00Z", duration: 2 },
  reported_position: 11800 + index * 200,
  sweep: {
    sweep_id: sweepId,
    sample_index: index,
    sample_count: 7,
    commanded_position: 11800 + index * 200,
  },
  median_fwhm_pixels: [5.8, 4.4, 3.3, 2.8, 3.0, 4.1, 5.5][index]!,
  measurement_count: 1,
  valid: true,
  reason: null,
});
const analysis: FocusSweepAnalysis = {
  controller_id: controller,
  instrument,
  sweep_id: id,
  outcome: "success",
  position: 12436,
  disposition: "equals",
  rms_residual_pixels: 0.08,
  reason: null,
  samples: Array.from({ length: 7 }, (_, i) => sample(i)),
};
const execution = (running: boolean, error: boolean | string = false) => ({
  executing: running,
  aborting: false,
  finished: running
    ? null
    : { timestamp: "2026-11-25T12:00:09Z", aborted: false, error },
  execution: {
    task_id: id,
    controller_id: controller,
    task,
    context: {},
    submitted_context: { sensorview_focus_request: "request-1" },
  },
});
const key = sweepKey(provider, controller, instrument, id);

assert.equal(autofocusBlocker(state, controller, instrument, true), null);
assert.match(
  autofocusBlocker(state, controller, instrument, false)!,
  /connection/,
);
assert.match(
  autofocusBlocker({ ...state, [provider]: {} }, controller, instrument, true)!,
  /offline/,
);
assert.match(
  autofocusBlocker(
    { ...state, Focuser: { ...state.Focuser, FocusPosition: {} } },
    controller,
    instrument,
    true,
  )!,
  /position/,
);
assert.match(
  autofocusBlocker(
    {
      ...state,
      [controller]: { ...state[controller], FocusAnalysisSource: undefined },
    },
    controller,
    instrument,
    true,
  )!,
  /configured/,
);
assert.throws(() => buildAutofocusTask({ ...draft, count: "4" }), /five/);
assert.throws(
  () => buildAutofocusTask({ ...draft, step: "Infinity" }),
  /finite/,
);
assert.throws(
  () => buildAutofocusTask({ ...draft, center: "", useReported: false }),
  /Center/,
);
assert.equal(task.center, undefined);
assert.equal(task.filter_name, undefined);
assert.deepEqual(
  buildAutofocusTask({ ...draft, binning: "2", readout: "0" }).binning,
  { x: 2, y: 2 },
);
assert.deepEqual(buildAutofocusTask({ ...draft, binning: "2x3" }).binning, {
  x: 2,
  y: 3,
});

// A single telemetry flush can carry several samples on the same subject.
let sweeps = ingestFocusRecords(
  {},
  [
    record("FocusAnalysis", sample(2)),
    record("FocusAnalysis", sample(0)),
    record("FocusAnalysis", sample(1)),
  ],
  state,
);
assert.equal(Object.keys(sweeps[key]!.samples).length, 3);
const same = ingestFocusRecords(
  sweeps,
  [
    record("FocusAnalysis", sample(0)),
    record("FocusAnalysis", sample(3), "OtherProvider"),
  ],
  state,
);
assert.equal(same, sweeps);
assert.equal(
  focusAnalysis({
    ...analysis,
    samples: [{ ...sample(0), instrument: "Other" }],
  }),
  null,
);
assert.equal(
  ingestFocusRecords(
    {},
    [
      record("FocusAnalysis", {
        ...sample(0),
        sweep: { ...sample(0).sweep, sample_index: 7 },
      }),
    ],
    state,
  )[key],
  undefined,
);

// Analysis carries the complete sample set for a viewer joining after capture.
sweeps = ingestFocusRecords(
  sweeps,
  [record("FocusSweepAnalysis", analysis, provider, 7)],
  state,
);
assert.equal(Object.keys(sweeps[key]!.samples).length, 7);
assert.equal(sweepOutcome(sweeps[key]!), "Task outcome unavailable");
assert.equal(
  ingestFocusRecords(
    sweeps,
    [
      record(
        "FocusAnalysis",
        { ...sample(0), median_fwhm_pixels: 99 },
        provider,
        8,
      ),
    ],
    state,
  ),
  sweeps,
);
sweeps = ingestFocusRecords(
  sweeps,
  [
    record(
      "ControllerState",
      { execution_state: execution(true) },
      controller,
      8,
    ),
  ],
  state,
);
assert.equal(sweepOutcome(sweeps[key]!), "Applying focus");
sweeps = ingestFocusRecords(
  sweeps,
  [
    record(
      "$EVENT$",
      {
        event_model: "TaskExecutionState",
        ...execution(false, "Final focus move failed"),
      },
      controller,
      9,
    ),
  ],
  state,
);
assert.equal(sweepOutcome(sweeps[key]!), "Failed");
const stale = ingestFocusRecords(
  sweeps,
  [
    record(
      "ControllerState",
      { execution_state: execution(true) },
      controller,
      10,
    ),
  ],
  state,
);
assert.equal(stale[key]!.execution!.finished!.error, "Final focus move failed");
assert.equal(
  latestFocusSweep(sweeps, "OtherProvider", controller, instrument),
  null,
);
const recovered = ingestFocusRecords(
  {},
  [
    record(
      "ControllerState",
      {
        execution_state: {
          ...execution(false),
          execution: {
            ...execution(false).execution,
            context: { FocusSweepAnalysis: analysis },
          },
        },
      },
      controller,
      9,
    ),
  ],
  state,
);
assert.equal(Object.keys(recovered[key]!.samples).length, 7);
assert.equal(sweepOutcome(recovered[key]!), "Succeeded");

// Invalid measurements remain visible, including failed fits and boundary estimates.
const invalid = {
  ...sample(3),
  valid: false,
  median_fwhm_pixels: null,
  measurement_count: 0,
  reason: "No usable sources",
};
const failure = {
  ...analysis,
  outcome: "failure",
  position: null,
  disposition: null,
  reason: "Too few usable positions",
  samples: [invalid],
};
const failed = ingestFocusRecords(
  {},
  [record("FocusSweepAnalysis", failure)],
  state,
);
assert.equal(failed[key]!.samples[3]!.reason, "No usable sources");
assert.equal(failed[key]!.analysis!.outcome, "failure");
const boundary = ingestFocusRecords(
  {},
  [
    record("FocusSweepAnalysis", {
      ...analysis,
      disposition: "greater_than",
      position: 13000,
    }),
  ],
  state,
);
assert.equal(boundary[key]!.analysis!.disposition, "greater_than");

// Retention stays bounded without dropping a running sweep to unrelated history.
let history: FocusSweeps = ingestFocusRecords(
  {},
  [record("ControllerState", { execution_state: execution(true) }, controller)],
  state,
);
for (let n = 0; n < 40; n++)
  history = ingestFocusRecords(
    history,
    [record("FocusAnalysis", sample(0, `other-${n}`), provider, 20)],
    state,
  );
assert.equal(Object.keys(history).length, 32);
assert.ok(history[key]?.execution?.executing);

const submission = autofocusSubmission(
  task,
  controller,
  "SensorView / manual",
  "request-1",
);
assert.deepEqual(submission.context!.Program, { id: "SensorView_manual" });
assert.match(
  (submission.context!.FileNameTemplate as { template: string }).template,
  /FocusSweep.sample_index/,
);
assert.equal(submission.expiry_time, undefined);

// Exercise real request helpers against the external HTTP seam.
useSensorKitStore.setState({ state, connection: "open" });
useAutofocusStore.getState().reset();
useAutofocusStore
  .getState()
  .ingest(
    [record("FocusAnalysisSource", { entity: provider }, controller)],
    state,
  );
assert.equal(useAutofocusStore.getState().providers[controller], provider);
useBackends.setState({
  sensorKit: "http://test.invalid",
  programName: "manual",
});
const originalFetch = globalThis.fetch;
let resolveExecution: ((response: Response) => void) | undefined;
let sent: Record<string, unknown> | null = null;
const urls: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  urls.push(url);
  if (url.endsWith("/execute")) {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Promise<Response>((resolve) => {
      resolveExecution = resolve;
    });
  }
  return new Response(
    JSON.stringify(url.includes("snapshot") ? [] : { status: "ok" }),
    { headers: { "content-type": "application/json" } },
  );
};
try {
  const pending = runAutofocus(controller, draft);
  assert.deepEqual(
    useAutofocusStore.getState().requests[controller]!.task,
    task,
  );
  assert.equal(
    useAutofocusStore.getState().requests[controller]!.pending,
    true,
  );
  await assert.rejects(runAutofocus(controller, draft), /already pending/);
  const requestId = useAutofocusStore.getState().requests[controller]!.id;
  const running = execution(true);
  running.execution.submitted_context.sensorview_focus_request = requestId;
  const liveState = {
    ...state,
    [controller]: {
      ...state[controller],
      ControllerState: {
        enable_state: { enabled: true },
        execution_state: running,
      },
    },
  };
  useSensorKitStore.setState({ state: liveState });
  useAutofocusStore
    .getState()
    .ingest(
      [
        record(
          "ControllerState",
          liveState[controller].ControllerState,
          controller,
        ),
      ],
      liveState,
    );
  assert.equal(useAutofocusStore.getState().requests[controller]!.taskId, id);
  await assert.rejects(
    abortAutofocus(controller, "a-different-task"),
    /no longer confirmed/,
  );
  await abortAutofocus(controller, id);
  assert.match(urls.at(-1)!, new RegExp(`task_id=${id}`));
  assert.ok(sent);
  const aborted = {
    ...running,
    executing: false,
    finished: {
      timestamp: "2026-11-25T12:00:09Z",
      aborted: true,
      error: false,
    },
  };
  useAutofocusStore
    .getState()
    .ingest(
      [record("ControllerState", { execution_state: aborted }, controller, 9)],
      liveState,
    );
  resolveExecution!(new Response("Aborted", { status: 409 }));
  await pending;
  assert.equal(
    useAutofocusStore.getState().requests[controller]!.pending,
    false,
  );
  assert.equal(useAutofocusStore.getState().requests[controller]!.error, null);
  assert.ok(useAutofocusStore.getState().sweeps[key]);

  // Rejected requests release the pending state, with a visible error.
  useSensorKitStore.setState({ state });
  globalThis.fetch = async (input) =>
    String(input).endsWith("/execute")
      ? new Response("Rejected", { status: 409 })
      : new Response("[]", { headers: { "content-type": "application/json" } });
  await runAutofocus(controller, draft);
  assert.match(
    useAutofocusStore.getState().requests[controller]!.error!,
    /409/,
  );
  assert.equal(
    useAutofocusStore.getState().requests[controller]!.pending,
    false,
  );

  // HTTP rejection can precede the first execution record. A later matching
  // completion replaces that transport error with the controller outcome.
  const rejectedId = useAutofocusStore.getState().requests[controller]!.id;
  const delayedFinish = execution(false);
  delayedFinish.execution.submitted_context.sensorview_focus_request =
    rejectedId;
  useAutofocusStore
    .getState()
    .ingest(
      [
        record(
          "ControllerState",
          { execution_state: delayedFinish },
          controller,
          10,
        ),
      ],
      state,
    );
  assert.equal(useAutofocusStore.getState().requests[controller]!.error, null);

  // A stale completion-refresh snapshot must never overwrite main live state.
  globalThis.fetch = async (input) =>
    String(input).includes("snapshot")
      ? new Response(
          JSON.stringify([
            record("ControllerState", { execution_state: running }, controller),
          ]),
        )
      : new Response("Rejected", { status: 409 });
  const liveBeforeRefresh = useSensorKitStore.getState().state;
  await runAutofocus(controller, draft);
  assert.equal(useSensorKitStore.getState().state, liveBeforeRefresh);
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "Autofocus checks passed: telemetry batches, matching, replay, outcomes, validation, submission, and targeted abort.",
);
