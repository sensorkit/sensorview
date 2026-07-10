import { useEffect, useRef } from "react";
import { HashRouter, Routes, Route, useNavigate } from "react-router-dom";
import { AppLayout } from "./layout/AppLayout";
import { AtlasContainer } from "./features/skyview/AtlasContainer";
import { DevicesPage } from "./features/devices/DevicesPage";
import { TasksPage } from "./features/tasks/TasksPage";
import { ImagesPage } from "./features/images/ImagesPage";
import { StatusPage } from "./features/status/StatusPage";
import { StreamsPage } from "./features/streams/StreamsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { SkyviewPopout } from "./features/skyview/SkyviewPopout";
import { DetachedTabWindow } from "./layout/DetachedTabWindow";
import { openSkyviewPopout } from "./lib/electron-bridge";
import { useSensorKit } from "./lib/sensorkit-client/useSensorKit";

export default function App() {
  // Bootstrapped here (not in AppLayout) so the popout window — which renders
  // SkyviewPopout outside AppLayout — also opens its own SSE stream. Electron
  // windows are separate processes; each one needs its own connection.
  useSensorKit();

  useEffect(() => {
    // Keyboard shortcut mirrors the Electron menu accelerator. Runs in all
    // contexts (browser + Electron) so dev + packaged behave the same.
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openSkyviewPopout();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <HashRouter>
      <CaptureBridge />
      <RecorderBridge />
      <Routes>
        <Route path="/popout/skyview" element={<SkyviewPopout />} />
        <Route path="/window/:tabId" element={<DetachedTabWindow />} />
        <Route element={<AppLayout />}>
          <Route index element={<AtlasContainer />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="images" element={<ImagesPage />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="streams" element={<StreamsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

/**
 * Bridges main-process capture requests to react-router navigation. On
 * `capture:goto` from the Electron main process, navigate to the requested
 * route, wait two animation frames + a short tick for layout/data settle,
 * then ack via `capture:ready`. Main waits on that ack before snapping the
 * window.
 */
function CaptureBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onCaptureGoto) return;
    return api.onCaptureGoto(({ route }) => {
      navigate(route);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => api.captureReady?.(), 50);
        });
      });
    });
  }, [navigate]);
  return null;
}

/**
 * Window-recording driver. Owns the MediaRecorder lifecycle in the renderer
 * and streams 1-second WebM chunks back to the Electron main process, which
 * appends them to a file. We use `getDisplayMedia` paired with main's
 * `setDisplayMediaRequestHandler` so the Electron handler auto-routes the
 * request to the SensorView window without a picker.
 */
function RecorderBridge() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingRef = useRef<Promise<unknown>[]>([]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onRecordStart || !api?.onRecordStop) return;

    const teardownStream = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      pendingRef.current = [];
    };

    const offStart = api.onRecordStart(async () => {
      if (recorderRef.current) return;
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
        streamRef.current = stream;

        // Prefer VP9 in WebM where available; fall back to whatever the
        // browser does support. MediaRecorder picks a sensible default if
        // mimeType is not specified.
        const candidates = [
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm",
        ];
        const mimeType =
          candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        recorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data.size === 0) return;
          const p = e.data
            .arrayBuffer()
            .then((buf) => api.sendRecordChunk?.(buf))
            .catch((err) => console.error("chunk send failed:", err));
          pendingRef.current.push(p);
        };

        recorder.onstop = async () => {
          // Drain any in-flight chunk sends so main has all the bytes
          // before it closes the file.
          await Promise.allSettled(pendingRef.current);
          api.sendRecordDone?.();
          teardownStream();
        };

        recorder.onerror = (e) => {
          api.sendRecordError?.(String((e as ErrorEvent).message ?? "recorder error"));
          teardownStream();
        };

        // If the user stops sharing via the OS UI, treat that as a stop.
        stream.getVideoTracks().forEach((track) => {
          track.addEventListener("ended", () => {
            if (recorderRef.current?.state === "recording") {
              recorderRef.current.stop();
            }
          });
        });

        recorder.start(1000);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "getDisplayMedia failed";
        api.sendRecordError?.(message);
        teardownStream();
      }
    });

    const offStop = api.onRecordStop(() => {
      const r = recorderRef.current;
      if (r && r.state === "recording") r.stop();
    });

    return () => {
      offStart();
      offStop();
      teardownStream();
    };
  }, []);

  return null;
}
