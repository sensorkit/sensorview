import { useEffect, useState } from "react";
import { spaceTrackLogin, type TLESourceStatus } from "../../lib/api-client/tle";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the refreshed source list after a successful sign-in. */
  onSuccess: (sources: TLESourceStatus[]) => void;
}

/**
 * Collects Space-Track.org credentials. The API sidecar validates them by
 * logging in, then stores them for catalog refreshes.
 */
export function SpaceTrackLoginModal({ open, onClose, onSuccess }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUsername("");
    setPassword("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!username.trim() || !password) {
      setError("Username and password are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const sources = await spaceTrackLogin(username.trim(), password);
      onSuccess(sources);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-panel-bg border border-panel-border rounded-lg p-5 w-[400px] max-w-[90vw] space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-text-bright">
            Sign in to Space-Track
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-dim hover:text-text-bright text-base"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <Field label="Username">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            autoFocus
            placeholder="you@example.com"
            className="w-full bg-black/40 border border-panel-border rounded px-2 py-1 text-sm text-text-bright outline-none focus:border-orange-300/60"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            autoComplete="off"
            className="w-full bg-black/40 border border-panel-border rounded px-2 py-1 text-sm text-text-bright outline-none focus:border-orange-300/60"
          />
        </Field>

        <p className="text-[11px] text-text-dim">
          Credentials are stored by the local SensorView API service and sent
          only to space-track.org. Accounts are free at{" "}
          <span className="text-text-bright">space-track.org</span>.
        </p>

        {error && <div className="text-[11px] text-red-300">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-[11px] uppercase tracking-wide rounded border border-panel-border bg-white/5 text-text-dim hover:bg-white/10 hover:text-text-bright"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1 text-[11px] uppercase tracking-wide rounded border border-orange-300/60 bg-orange-300/15 text-orange-200 hover:bg-orange-300/25 disabled:opacity-50"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-text-dim uppercase tracking-wide">{label}</div>
      {children}
    </div>
  );
}
