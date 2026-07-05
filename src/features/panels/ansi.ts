/**
 * Minimal ANSI SGR parser for the log panel. Docker log lines arrive with color
 * escape sequences (`ESC[36m` … `ESC[0m`) because SensorKit's logger forces
 * color on. We turn the subset it emits — foreground colors, bold, dim, reset —
 * into styled segments so the panel renders like a terminal instead of printing
 * the raw codes. Each line is parsed independently (the logger resets per line).
 */
export interface AnsiSegment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

// SGR foreground codes → colors tuned for the dark panel background. Pure black
// is bumped to gray so it stays visible.
const FG: Record<number, string> = {
  30: "#6b7280",
  31: "#f87171",
  32: "#4ade80",
  33: "#fbbf24",
  34: "#60a5fa",
  35: "#c084fc",
  36: "#22d3ee",
  37: "#d1d5db",
  90: "#6b7280",
  91: "#fca5a5",
  92: "#86efac",
  93: "#fde047",
  94: "#93c5fd",
  95: "#d8b4fe",
  96: "#67e8f9",
  97: "#f9fafb",
};

// Require the ESC (0x1b) byte so we don't mangle literal text that happens to
// contain "[0m"-style fragments (timings, array indices, etc.).
const SGR = /\u001b\[([0-9;]*)m/g;

export function parseAnsi(line: string): AnsiSegment[] {
  SGR.lastIndex = 0;
  const segments: AnsiSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let dim = false;
  let last = 0;

  const push = (text: string) => {
    if (text) segments.push({ text, color, bold: bold || undefined, dim: dim || undefined });
  };

  let m: RegExpExecArray | null;
  while ((m = SGR.exec(line)) !== null) {
    push(line.slice(last, m.index));
    last = SGR.lastIndex;
    const params = m[1] ?? "";
    const codes = params === "" ? [0] : params.split(";").map((n) => parseInt(n, 10));
    for (const code of codes) {
      if (code === 0) {
        color = undefined;
        bold = false;
        dim = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 2) {
        dim = true;
      } else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 39) {
        color = undefined;
      } else if (FG[code]) {
        color = FG[code];
      }
    }
  }
  push(line.slice(last));
  return segments;
}
