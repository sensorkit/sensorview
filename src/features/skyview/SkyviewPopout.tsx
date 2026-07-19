import { AtlasContainer } from "./AtlasContainer";

/**
 * Standalone SkyView for the pop-out window. Renders only the atlas with no
 * app chrome — the user already has the main window for navigation. Each
 * popout opens its own SSE stream and holds independent view state.
 */
export function SkyviewPopout() {
  return (
    <div className="w-full h-dvh bg-black">
      <AtlasContainer />
    </div>
  );
}
