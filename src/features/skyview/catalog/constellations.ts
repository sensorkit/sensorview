/** A constellation with its stick-figure line segments */
export interface Constellation {
  id: string;
  name: string;
  /** Each line segment: [ra1, dec1, ra2, dec2] in degrees */
  lines: [number, number, number, number][];
}

let cachedConstellations: Constellation[] | null = null;

/**
 * Load constellation line data from the static JSON file.
 */
export async function loadConstellations(): Promise<Constellation[]> {
  if (cachedConstellations) return cachedConstellations;

  const response = await fetch(`${import.meta.env.BASE_URL}data/constellations.json`);
  cachedConstellations = await response.json();
  return cachedConstellations!;
}
