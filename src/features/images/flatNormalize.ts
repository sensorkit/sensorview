/**
 * Turn raw flat-frame pixels into a divisible "safe flat": normalize to a median
 * of 1.0 (so dividing an image by it preserves the image's flux scale), then
 * replace dead/vignetted pixels — those below 0.1 after normalization — with 1.0
 * so the division passes them through untouched instead of blowing up. Mirrors
 * SENPAI's apply_flat_field.
 */
export function safeFlat(data: ArrayLike<number>): Float32Array {
  const n = data.length;
  const out = new Float32Array(n);
  if (n === 0) return out;

  // Indices are all in-bounds (n > 0), so the reads can't be undefined.
  const sorted = Float64Array.from(data);
  sorted.sort();
  let median = n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  if (!Number.isFinite(median) || median === 0) median = 1;

  for (let i = 0; i < n; i++) {
    const v = data[i]! / median;
    out[i] = v < 0.1 ? 1.0 : v;
  }
  return out;
}
