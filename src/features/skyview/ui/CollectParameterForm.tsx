import { useState } from "react";

interface CollectParams {
  integrationTime: number;
  frameCount: number;
  binning: number;
}

interface Props {
  satelliteId: string;
  onSubmit: (params: CollectParams) => void;
  onCancel: () => void;
}

/**
 * Form for configuring satellite observation parameters.
 * Eventually these fields will be schema-driven from SensorKit's CameraCapture model.
 */
export function CollectParameterForm({
  satelliteId,
  onSubmit,
  onCancel,
}: Props) {
  const [integration, setIntegration] = useState(5);
  const [frames, setFrames] = useState(3);
  const [binning, setBinning] = useState(1);

  return (
    <div className="bg-panel-bg/95 backdrop-blur-md rounded-xl border border-panel-border p-4">
      <h4 className="text-sm font-semibold text-text-bright mb-3">
        Collect Parameters
      </h4>
      <p className="text-xs text-text-dim mb-3">Target: {satelliteId}</p>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-text-dim block mb-1">
            Integration Time (s)
          </label>
          <input
            type="range"
            min={1}
            max={30}
            value={integration}
            onChange={(e) => setIntegration(Number(e.target.value))}
            className="w-full"
          />
          <span className="text-xs text-text-bright">{integration}s</span>
        </div>

        <div>
          <label className="text-xs text-text-dim block mb-1">
            Frame Count
          </label>
          <div className="flex gap-2">
            {[1, 3, 5, 10].map((n) => (
              <button
                key={n}
                onClick={() => setFrames(n)}
                className={`px-3 py-1 text-xs rounded ${
                  frames === n
                    ? "bg-blue-600/40 text-blue-300 border border-blue-500/40"
                    : "bg-black/30 text-text-dim border border-panel-border"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-text-dim block mb-1">Binning</label>
          <div className="flex gap-2">
            {[1, 2, 4].map((b) => (
              <button
                key={b}
                onClick={() => setBinning(b)}
                className={`px-3 py-1 text-xs rounded ${
                  binning === b
                    ? "bg-blue-600/40 text-blue-300 border border-blue-500/40"
                    : "bg-black/30 text-text-dim border border-panel-border"
                }`}
              >
                {b}x{b}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-2 mt-4">
        <button
          onClick={() =>
            onSubmit({
              integrationTime: integration,
              frameCount: frames,
              binning,
            })
          }
          className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 transition-colors"
        >
          Submit
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 text-text-dim hover:text-text-bright rounded-lg text-sm border border-panel-border hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
