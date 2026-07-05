import { useEffect, useMemo, useState } from "react";
import {
  type StreamProtocol,
  type StreamSource,
  useStreamsStore,
} from "../../stores/streams";
import {
  requestCameraPermission,
  useVideoInputDevices,
} from "./useVideoInputDevices";

type Branch = "url" | "device";

interface Props {
  open: boolean;
  /** When set, the modal is in "edit" mode for this existing source. */
  editing: StreamSource | null;
  onClose: () => void;
}

/**
 * Add or edit a stream source. Two branches selected by a tab:
 * - URL: name + url + protocol (auto-detected from scheme, overridable).
 * - Device: name + dropdown over `videoinput` MediaDevices. Triggers a
 *   one-shot getUserMedia to populate labels if permission isn't granted.
 */
export function AddStreamModal({ open, editing, onClose }: Props) {
  const addSource = useStreamsStore((s) => s.addSource);
  const updateSource = useStreamsStore((s) => s.updateSource);

  const [branch, setBranch] = useState<Branch>("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [protocol, setProtocol] = useState<StreamProtocol>("hls");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal (re)opens or the editing target changes.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editing) {
      setBranch(editing.kind);
      setName(editing.name);
      if (editing.kind === "url") {
        setUrl(editing.url);
        setProtocol(editing.protocol);
        setUsername(editing.username ?? "");
        setPassword(editing.password ?? "");
      } else {
        setDeviceId(editing.deviceId);
      }
    } else {
      setBranch("url");
      setName("");
      setUrl("");
      setProtocol("hls");
      setUsername("");
      setPassword("");
      setDeviceId("");
    }
  }, [open, editing]);

  // Auto-detect protocol from URL scheme/extension when the user types.
  useEffect(() => {
    const detected = detectProtocol(url);
    if (detected) setProtocol(detected);
  }, [url]);

  if (!open) return null;

  const submit = () => {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (branch === "url") {
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        setError("URL is required.");
        return;
      }
      const trimmedUser = username.trim();
      const payload = {
        kind: "url" as const,
        name: trimmedName,
        url: trimmedUrl,
        protocol,
        // Persist creds only when actually set; absent fields keep the source
        // shape minimal for cameras that don't need auth.
        ...(trimmedUser ? { username: trimmedUser } : {}),
        ...(password ? { password } : {}),
      };
      if (editing) updateSource(editing.id, payload);
      else addSource(payload);
    } else {
      if (!deviceId) {
        setError("Choose a camera.");
        return;
      }
      const payload = {
        kind: "device" as const,
        name: trimmedName,
        deviceId,
      };
      if (editing) updateSource(editing.id, payload);
      else addSource(payload);
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-panel-bg border border-panel-border rounded-lg p-5 w-[440px] max-w-[90vw] space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-text-bright">
            {editing ? "Edit stream" : "Add stream"}
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

        {/* Branch tabs (locked to the editing target's kind when editing) */}
        <div className="flex gap-1">
          {(["url", "device"] as Branch[]).map((b) => {
            const active = branch === b;
            const disabled = editing != null && editing.kind !== b;
            return (
              <button
                key={b}
                type="button"
                disabled={disabled}
                onClick={() => setBranch(b)}
                className={
                  "px-3 py-1 text-[11px] uppercase tracking-wide rounded border transition-colors " +
                  (active
                    ? "bg-orange-300/15 text-orange-200 border-orange-300/60"
                    : "bg-white/5 text-text-dim border-panel-border hover:bg-white/10 hover:text-text-bright") +
                  (disabled ? " opacity-40 cursor-not-allowed" : " cursor-pointer")
                }
              >
                {b === "url" ? "Network" : "Device"}
              </button>
            );
          })}
        </div>

        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={branch === "url" ? "webcam1" : "webcam2"}
            className="w-full bg-black/40 border border-panel-border rounded px-2 py-1 text-sm text-text-bright outline-none focus:border-orange-300/60"
          />
        </Field>

        {branch === "url" ? (
          <>
            <Field label="URL">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://192.168.1.10:554/webcam"
                className="w-full bg-black/40 border border-panel-border rounded px-2 py-1 font-mono text-xs text-text-bright outline-none focus:border-orange-300/60"
              />
            </Field>
            <Field label="Protocol">
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as StreamProtocol)}
                className="w-full bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright outline-none focus:border-orange-300/60"
              >
                <option value="rtsp">RTSP (proxied via MediaMTX → HLS)</option>
                <option value="hls">HLS</option>
                <option value="mjpeg">MJPEG</option>
                <option value="webrtc">WebRTC / WHEP</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Username (optional)">
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  className="w-full bg-black/40 border border-panel-border rounded px-2 py-1 font-mono text-xs text-text-bright outline-none focus:border-orange-300/60"
                />
              </Field>
              <Field label="Password (optional)">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                  className="w-full bg-black/40 border border-panel-border rounded px-2 py-1 font-mono text-xs text-text-bright outline-none focus:border-orange-300/60"
                />
              </Field>
            </div>
          </>
        ) : (
          <DevicePicker deviceId={deviceId} setDeviceId={setDeviceId} />
        )}

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
            className="px-3 py-1 text-[11px] uppercase tracking-wide rounded border border-orange-300/60 bg-orange-300/15 text-orange-200 hover:bg-orange-300/25"
          >
            {editing ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DevicePicker({
  deviceId,
  setDeviceId,
}: {
  deviceId: string;
  setDeviceId: (id: string) => void;
}) {
  const devices = useVideoInputDevices();
  const [requesting, setRequesting] = useState(false);

  // If labels are empty across the board, we don't have permission yet.
  const needsPermission = useMemo(
    () => devices.length > 0 && devices.every((d) => !d.label),
    [devices],
  );

  const grant = async () => {
    setRequesting(true);
    await requestCameraPermission();
    setRequesting(false);
  };

  if (devices.length === 0) {
    return (
      <Field label="Camera">
        <div className="text-[11px] text-text-dim">No video inputs detected.</div>
      </Field>
    );
  }

  return (
    <Field label="Camera">
      {needsPermission ? (
        <div className="space-y-2">
          <div className="text-[11px] text-text-dim">
            {devices.length} camera{devices.length !== 1 ? "s" : ""} found, but
            their names are hidden until camera access is granted.
          </div>
          <button
            type="button"
            disabled={requesting}
            onClick={grant}
            className="px-3 py-1 text-[11px] uppercase tracking-wide rounded border border-orange-300/60 bg-orange-300/15 text-orange-200 hover:bg-orange-300/25 disabled:opacity-50"
          >
            {requesting ? "Requesting…" : "Grant camera access"}
          </button>
        </div>
      ) : (
        <select
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          className="w-full bg-black/40 border border-panel-border rounded px-2 py-1 text-xs text-text-bright outline-none focus:border-orange-300/60"
        >
          <option value="">Choose a camera…</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 12)}
            </option>
          ))}
        </select>
      )}
    </Field>
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

function detectProtocol(url: string): StreamProtocol | null {
  const u = url.trim().toLowerCase();
  if (!u) return null;
  if (u.startsWith("rtsp://") || u.startsWith("rtsps://")) return "rtsp";
  if (u.startsWith("webrtc://") || u.includes("/whep")) return "webrtc";
  if (u.includes(".m3u8")) return "hls";
  if (u.endsWith(".mjpg") || u.endsWith(".mjpeg") || u.includes("mjpeg") || u.includes("mjpg"))
    return "mjpeg";
  return null;
}
