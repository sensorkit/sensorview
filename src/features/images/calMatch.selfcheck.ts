// Self-check for findDark / findFlat. No test runner is configured, so run it directly:
//   node_modules/.bin/esbuild src/features/images/calMatch.selfcheck.ts \
//     --bundle --platform=node --format=esm | node --input-type=module
import { findDark, findFlat, type CalCandidate } from "./calMatch";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// A light subject with the fields darks match on (no filter needed for darks).
const LIGHT = {
  IMAGETYP: "light",
  NAXIS1: "4096",
  NAXIS2: "4096",
  EXPTIME: "60.0",
  XBINNING: "1",
  YBINNING: "1",
  READOUTM: "0",
  "CCD-TEMP": "-10.0",
  FILTER: "R",
};

const frame = (
  type: string,
  over: Record<string, string>,
  id: string,
  t: string,
): CalCandidate => ({
  controllerId: "c",
  productId: id,
  registerTime: t,
  cards: { ...LIGHT, IMAGETYP: type, ...over },
});
const dark = (over: Record<string, string>, id: string, t: string) => frame("dark", over, id, t);
const flat = (over: Record<string, string>, id: string, t: string) => frame("flat", over, id, t);

// --- findDark ---

// Most recent valid dark wins.
{
  const r = findDark(LIGHT, "subj", [
    dark({ "CCD-TEMP": "-11" }, "old", "2026-08-01T00:00:00Z"),
    dark({ "CCD-TEMP": "-9" }, "new", "2026-08-20T00:00:00Z"),
  ]);
  assert(r.match?.productId === "new", "most recent valid dark should win");
}

// Gates reject wrong binning / exposure / size / non-dark / out-of-window temp.
{
  const r = findDark(LIGHT, "subj", [
    dark({ XBINNING: "2" }, "badbin", "2026-08-25T00:00:00Z"),
    dark({ EXPTIME: "30" }, "badexp", "2026-08-25T00:00:00Z"),
    dark({ NAXIS1: "2048" }, "badsize", "2026-08-25T00:00:00Z"),
    dark({ "CCD-TEMP": "-16" }, "badtemp", "2026-08-25T00:00:00Z"), // |−16−(−10)|=6 > 5
    flat({}, "aflat", "2026-08-25T00:00:00Z"),
    dark({ "CCD-TEMP": "-10.5" }, "good", "2026-08-10T00:00:00Z"),
  ]);
  assert(r.match?.productId === "good", `only the in-spec dark matches, got ${r.match?.productId}`);
}

// A non-light subject may still have a dark subtracted (restriction removed).
{
  const r = findDark({ ...LIGHT, IMAGETYP: "dark" }, "subj", [dark({}, "d", "2026-08-25T00:00:00Z")]);
  assert(r.match?.productId === "d", "a dark subject should still match a dark");
}

// "_processed" darks are excluded (SENPAI artifacts).
{
  const r = findDark(LIGHT, "subj", [
    dark({}, "sensorview_x_f000_processed.fits", "2026-08-25T00:00:00Z"),
    dark({}, "sensorview_x_f000.fits", "2026-08-10T00:00:00Z"),
  ]);
  assert(
    r.match?.productId === "sensorview_x_f000.fits",
    `_processed dark must be excluded, got ${r.match?.productId}`,
  );
}

// A frame can't subtract itself; missing a required card refuses.
{
  assert(findDark(LIGHT, "self", [dark({}, "self", "2026-08-25T00:00:00Z")]).match === null, "no self-match");
  const noTemp = { ...LIGHT } as Record<string, string>;
  delete noTemp["CCD-TEMP"];
  assert(findDark(noTemp, "subj", [dark({}, "d", "t")]).reason === "missing-fields", "missing temp refuses");
}

// --- findFlat ---

// Flat matches on filter, ignores exposure; most recent wins.
{
  const r = findFlat(LIGHT, "subj", [
    flat({ EXPTIME: "5" }, "flatA", "2026-08-01T00:00:00Z"), // different exposure is fine
    flat({ EXPTIME: "3" }, "flatB", "2026-08-20T00:00:00Z"),
  ]);
  assert(r.match?.productId === "flatB", `most recent flat wins regardless of exposure, got ${r.match?.productId}`);
}

// Wrong filter is rejected; a dark is not a flat.
{
  const r = findFlat(LIGHT, "subj", [
    flat({ FILTER: "V" }, "wrongfilter", "2026-08-25T00:00:00Z"),
    dark({}, "adark", "2026-08-25T00:00:00Z"),
  ]);
  assert(r.match === null && r.reason === "no-candidate", "flat needs matching filter and type");
}

// Subject with no filter can't match a flat.
{
  const noFilter = { ...LIGHT } as Record<string, string>;
  delete noFilter.FILTER;
  const r = findFlat(noFilter, "subj", [flat({}, "f", "t")]);
  assert(r.reason === "missing-fields", "flat needs the subject's filter");
}

console.log("calMatch self-check: ok");
