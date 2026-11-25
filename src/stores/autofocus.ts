import { create } from "zustand";
import type { SKRecord } from "../lib/sensorkit-client/types";
import type { StateMap } from "./sensorkit";
import {
  ingestFocusRecords,
  recordOf,
  type FocusSweeps,
  type AutofocusTask,
} from "../features/autofocus/focusSweepData";

export interface AutofocusDraft {
  instrument: string;
  step: string;
  count: string;
  exposure: string;
  center: string;
  useReported: boolean;
  filter: string;
  binning: string;
  gain: string;
  readout: string;
}

export const DEFAULT_AUTOFOCUS_DRAFT: AutofocusDraft = {
  instrument: "",
  step: "100",
  count: "7",
  exposure: "2",
  center: "",
  useReported: true,
  filter: "",
  binning: "",
  gain: "",
  readout: "",
};

export interface AutofocusRequest {
  id: string;
  instrument: string;
  taskId: string | null;
  pending: boolean;
  error: string | null;
  task?: AutofocusTask;
}

interface AutofocusStore {
  sweeps: FocusSweeps;
  requests: Record<string, AutofocusRequest>;
  providers: Record<string, string>;
  setRequest: (controller: string, request: AutofocusRequest) => void;
  ingest: (records: SKRecord[], state: StateMap) => void;
  reset: () => void;
}

/** Session state survives page navigation and SSE reconnects, but never a host change. */
export const useAutofocusStore = create<AutofocusStore>((set) => ({
  sweeps: {},
  requests: {},
  providers: {},
  setRequest: (controller, request) =>
    set((s) => ({ requests: { ...s.requests, [controller]: request } })),
  ingest: (records, state) =>
    set((s) => {
      const sweeps = ingestFocusRecords(s.sweeps, records, state);
      let providers = s.providers;
      for (const [, , subject, payload] of records) {
        if (subject.prop !== "FocusAnalysisSource") continue;
        const controller = subject.path.join("/");
        const source = recordOf(payload)?.entity;
        if (typeof source === "string" && providers[controller] !== source) {
          providers = { ...providers, [controller]: source };
        } else if (payload === null && controller in providers) {
          providers = { ...providers };
          delete providers[controller];
        }
      }
      let requests = s.requests;
      for (const sweep of Object.values(sweeps)) {
        const request = requests[sweep.controller];
        const execution = sweep.execution?.execution;
        const context = execution?.submitted_context ?? execution?.context;
        if (
          !request ||
          context?.["sensorview_focus_request"] !== request.id ||
          !execution
        )
          continue;
        if (
          request.taskId === execution.task_id &&
          (!request.pending || !sweep.execution?.finished) &&
          request.error === null
        )
          continue;
        requests = {
          ...requests,
          [sweep.controller]: {
            ...request,
            taskId: execution.task_id,
            pending: sweep.execution?.finished ? false : request.pending,
            error: null,
          },
        };
      }
      return sweeps === s.sweeps &&
        requests === s.requests &&
        providers === s.providers
        ? s
        : { sweeps, requests, providers };
    }),
  reset: () => set({ sweeps: {}, requests: {}, providers: {} }),
}));
