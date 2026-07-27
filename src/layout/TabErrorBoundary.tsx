import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Contains a render crash to the tab that caused it.
 *
 * Without a boundary, one bad keyword takes down the whole window: React
 * unmounts the entire tree, so a null azimuth on the Devices tab leaves the
 * operator staring at a bare window with no nav strip and no way back. Device
 * telemetry is wire data from SensorKit and reaches the UI through unchecked
 * casts, so "a field is null when the type says it isn't" is a permanent
 * hazard, not a bug we fix once.
 *
 * Reset is keyed on `resetKey` (the route path) — navigating to another tab and
 * back re-mounts the subtree, so a crash caused by a transient value clears
 * itself once the value recovers.
 */
interface Props {
  children: ReactNode;
  resetKey: string;
}

interface State {
  error: Error | null;
}

export class TabErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack in the console — it is the only place that
    // records which component threw once the fallback replaces the subtree.
    console.error("Tab crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-full w-full overflow-auto p-6 flex items-start justify-center">
        <div className="max-w-xl w-full rounded border border-panel-border bg-panel-bg p-5">
          <h2 className="text-text-bright text-sm font-semibold mb-2">
            This tab hit an error
          </h2>
          <p className="text-text-dim text-xs mb-4 leading-relaxed">
            The rest of SensorView is still running — switch tabs and come back,
            or retry below. If it persists, the detail here is what to report.
          </p>
          <pre className="text-red-300 text-[11px] font-mono whitespace-pre-wrap break-words bg-sky-dark/60 border border-panel-border rounded p-3 mb-4">
            {error.message || String(error)}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="text-xs px-3 py-1.5 rounded border border-panel-border text-text-bright hover:border-brass transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}
