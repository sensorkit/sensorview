/** Consistent satellite colors by orbit regime across all views. */
export const REGIME_COLORS: Record<string, string> = {
  LEO: "#44aa66",
  MEO: "#5577cc",
  GEO: "#cc7744",
  HEO: "#aa44aa",
  OTHER: "#888888",
};

export function regimeColor(regime: string | undefined): string {
  return REGIME_COLORS[regime ?? "OTHER"] ?? "#888888";
}
