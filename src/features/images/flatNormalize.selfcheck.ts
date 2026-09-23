// Self-check for safeFlat. No test runner is configured, so run it directly:
//   node_modules/.bin/esbuild src/features/images/flatNormalize.selfcheck.ts \
//     --bundle --platform=node --format=esm | node --input-type=module
import { safeFlat } from "./flatNormalize";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// Uniform flat -> every pixel normalizes to 1.0.
{
  const r = safeFlat([2, 2, 2, 2]);
  assert(Array.from(r).every((v) => close(v, 1)), "uniform flat -> all 1.0");
}

// Odd length: median of [1,2,3] = 2 -> [0.5, 1.0, 1.5].
{
  const r = safeFlat([1, 2, 3]);
  assert(close(r[0]!, 0.5) && close(r[1]!, 1) && close(r[2]!, 1.5), "odd-length median normalize");
}

// Even length: median averages the two middles. [1,2,3,4] -> median 2.5.
{
  const r = safeFlat([1, 2, 3, 4]);
  assert(close(r[0]!, 0.4) && close(r[3]!, 1.6), "even-length median normalize");
}

// Dead-pixel guard: sorted [1,100,100,100], median 100 -> 1/100 = 0.01 < 0.1 -> 1.0.
{
  const r = safeFlat([100, 100, 100, 1]);
  assert(close(r[3]!, 1.0), "dead pixel (0.01) clamped to 1.0");
  assert(close(r[0]!, 1.0), "median pixel -> 1.0");
}

// Degenerate median 0 is treated as 1 (no divide-by-zero); zeros hit the guard.
{
  const r = safeFlat([0, 0, 0, 5]);
  assert(close(r[0]!, 1.0) && close(r[3]!, 5), "zero median guarded, live pixel preserved");
}

console.log("flatNormalize self-check: ok");
