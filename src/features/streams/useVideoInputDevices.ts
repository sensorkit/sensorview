import { useEffect, useState } from "react";

/**
 * Enumerate video input devices the browser can see. Returns the latest list
 * of `videoinput` MediaDeviceInfo entries, refreshed automatically when the
 * OS reports a `devicechange` (USB camera plug/unplug, virtual cams added).
 *
 * Labels and deviceIds are blank until the user has granted camera permission
 * at least once for this origin — caller code that needs labels should call
 * `requestCameraPermission()` first to unblock them.
 */
export function useVideoInputDevices(): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setDevices(all.filter((d) => d.kind === "videoinput"));
      } catch {
        if (!cancelled) setDevices([]);
      }
    };

    refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  return devices;
}

/**
 * One-time `getUserMedia` call to elevate the page from "video inputs known
 * but unlabelled" to "video inputs labelled and addressable by deviceId".
 * The MediaStream is stopped immediately — we just want the permission grant.
 */
export async function requestCameraPermission(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}
