import { useFeatureFlags } from "../../stores/featureFlags";

export function DirectDeviceControlSettings() {
  const enabled = useFeatureFlags((s) => s.directDeviceControl);
  const setEnabled = useFeatureFlags((s) => s.setDirectDeviceControl);

  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="accent-accent"
        />
        <span className="text-text-bright">Enable direct device control</span>
      </label>

      <p className="text-xs text-text-dim">
        Adds per-device action buttons (Init, Open/Close, Stop, etc.) on each
        card in the Devices page. These commands go straight to the device and
        bypass the controller's orchestrated init sequence — useful for daytime
        testing when you want to exercise the mount without opening the dome.
      </p>
      <p className="text-xs text-text-dim">
        Leave disabled for normal operations. Use the controller's Init button
        to bring up the full sensor in the correct order.
      </p>
    </div>
  );
}
