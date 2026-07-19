import { useEffect, useState } from "react";

/**
 * Reactive matchMedia — re-renders when the query flips. Used to switch
 * layouts that are driven by inline pixel styles (which Tailwind responsive
 * classes can't override) between desktop and compact variants.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** True below Tailwind's `lg` breakpoint — the app's compact/desktop boundary. */
export function useCompactLayout(): boolean {
  return useMediaQuery("(max-width: 1023px)");
}
