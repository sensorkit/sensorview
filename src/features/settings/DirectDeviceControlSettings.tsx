import { useFeatureFlags } from "../../stores/featureFlags";
import { Toggle } from "./Toggle";
import { InfoTooltip } from "./InfoTooltip";

export function DirectDeviceControlSettings() {
  const enabled = useFeatureFlags((s) => s.directDeviceControl);
  const setEnabled = useFeatureFlags((s) => s.setDirectDeviceControl);

  return (
    <div className="flex items-center gap-2 text-sm">
      <Toggle
        checked={enabled}
        onChange={setEnabled}
        label={<span className="font-semibold">Direct device control</span>}
      />
      <InfoTooltip label="About direct device control">
        <span className="block">
          Adds per-device action buttons (Init, Open/Close, Stop, etc.) on each
          card in the Devices page. These commands go straight to the device and
          bypass the controller's orchestrated init sequence — useful for daytime
          testing when you want to exercise the mount without opening the dome.
        </span>
        <span className="mt-2 block">
          Leave disabled for normal operations. Use the controller's Init button
          to bring up the full sensor in the correct order.
        </span>
      </InfoTooltip>
    </div>
  );
}
