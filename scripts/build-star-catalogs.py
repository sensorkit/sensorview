#!/usr/bin/env python3
"""Regenerate public/data/bsc5.json and public/data/hip.json.bin from Vizier.

Run this once when the catalog format changes; the outputs are committed
to the repo and consumed by SensorView's star renderer + catalog list.

Wire shape:
  BSC5 (V/50/catalog), filtered to Vmag < 5.5 to match current footprint:
      stars: [[hr_id, ra_deg, dec_deg, vmag, spectral_letter], ...]
      names: { propername: index }

  HIP (I/239/hip_main), full catalog (~118k entries):
      stars: [[hip_id, ra_deg, dec_deg, vmag, spectral_letter_or_null], ...]
      names: { propername: index }

The HIP file is gzip-compressed JSON, named with a `.bin` extension on
disk (not `.gz`) so static-file servers like Vite don't auto-set
`Content-Encoding: gzip` and trigger transparent browser decompression
before our manual DecompressionStream gets the bytes — see the loader
comment in src/features/skyview/catalog/stars.ts for context.

Both catalogs are sorted brightest-first; `names` map uses the existing
BSC5 names (238 entries) cross-referenced by RA/Dec to each new catalog.

Requires only stdlib — `urllib.request` against Vizier's TSV endpoint.
"""

import gzip
import json
import ssl
import sys
import urllib.request
from pathlib import Path

# Python on Windows (and some Linux builds) ships without a CA bundle, so
# urllib's default SSL context can't verify Vizier / WGSN certs. Prefer
# certifi's bundle when available; fall back to the system default. Run
# `pip install certifi` if you hit CERTIFICATE_VERIFY_FAILED here.
try:
    import certifi

    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = ssl.create_default_context()

ROOT = Path(__file__).resolve().parent.parent
EXISTING_BSC = ROOT / "public" / "data" / "bsc5.json"
BSC_OUT = ROOT / "public" / "data" / "bsc5.json"
HIP_OUT = ROOT / "public" / "data" / "hip.json.bin"

VIZIER = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv"
# IAU Catalog of Star Names — Eric Mamajek's mirror of the WGSN data. Each
# entry pairs a name with HIP id, HD id, and J2000 coords; we use HIP for
# direct cross-reference and RA/Dec to find the matching HR record.
WGSN_URL = "https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt"
TIMEOUT = 120


def fetch_table(query: str, expected_cols: int) -> list[list[str]]:
    """GET a Vizier TSV and return data rows (header stripped).

    Vizier's TSV format has historically been:
        # comment lines...
        <header row of column names>
        <units row>
        ----  ----  ----  ----     (separator of dashes)
        <data rows, one per object>

    We anchor on the dashed separator when present, but fall back to a
    column-count match for cases where the separator isn't emitted —
    real data rows have exactly `expected_cols` tab-separated fields.
    """
    url = f"{VIZIER}?{query}&-out.meta=&-out.form=tab-separated-values"
    print(f"  GET {url[:120]}{'…' if len(url) > 120 else ''}")
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "sensorview-catalog-builder/1.0",
            "Accept": "text/tab-separated-values, text/plain",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=_SSL_CTX) as r:
        body = r.read().decode("utf-8", errors="replace")

    # When Vizier's Postgres backend is unreachable, the server still returns
    # 200 but ships back a VOTable error envelope with #INFO Error= lines.
    # Detect that explicitly so the script fails loudly instead of parsing
    # zero data rows and silently producing a stub catalog.
    if "votable" in body[:200].lower() or "database is not currently reachable" in body:
        raise RuntimeError(
            "Vizier returned a backend-error envelope (database unreachable). "
            "This is upstream — try again later, or check status at "
            "https://cds.unistra.fr/"
        )

    rows: list[list[str]] = []
    past_dashes = False
    for raw in body.split("\n"):
        line = raw.rstrip("\r")
        if not line or line.startswith("#"):
            continue
        if set(line) <= {"-", "\t", " "}:
            past_dashes = True
            continue
        if not past_dashes:
            # Pre-separator: skip the column-name + units rows
            continue
        fields = line.split("\t")
        if len(fields) != expected_cols:
            continue
        rows.append(fields)

    # Fallback path: dashes line wasn't found at all (some Vizier
    # mirrors omit it). Re-scan and accept any line that has exactly
    # `expected_cols` tab fields and isn't a comment.
    if not rows:
        for raw in body.split("\n"):
            line = raw.rstrip("\r")
            if not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) != expected_cols:
                continue
            # Skip the header / units rows — both contain only ASCII
            # column-name / unit tokens, never the digit-leading numbers
            # we expect in real data rows. Heuristic: at least one field
            # parses as a float.
            if not any(_looks_numeric(f) for f in fields):
                continue
            rows.append(fields)

    if not rows:
        # Last resort: surface enough of the response to diagnose.
        preview = body[:600].replace("\t", "\\t")
        print(
            f"  (no rows parsed; body was {len(body)} bytes, preview:)\n{preview}",
            file=sys.stderr,
        )
    return rows


def _looks_numeric(s: str) -> bool:
    s = s.strip()
    if not s:
        return False
    try:
        float(s)
        return True
    except ValueError:
        return False


def parse_float(s: str) -> float | None:
    s = s.strip()
    if not s or s in ("---", "--"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_int(s: str) -> int | None:
    s = s.strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def spectral_letter(sp_raw: str) -> str | None:
    """Reduce a spectral type string to its leading O/B/A/F/G/K/M letter."""
    sp = sp_raw.strip()
    if not sp:
        return None
    for c in sp:
        if c in "OBAFGKM":
            return c
    return None


def fetch_wgsn() -> dict[str, tuple[int | None, float, float]]:
    """Return {name: (hip_id_or_None, ra_deg, dec_deg)} from IAU WGSN."""
    print(f"Fetching IAU WGSN star names…")
    print(f"  GET {WGSN_URL}")
    with urllib.request.urlopen(WGSN_URL, timeout=TIMEOUT, context=_SSL_CTX) as r:
        body = r.read().decode("utf-8", errors="replace")
    out: dict[str, tuple[int | None, float, float]] = {}
    for line in body.split("\n"):
        if not line or line.startswith("#") or line.startswith("$"):
            continue
        # Fields are space-separated and multi-column; the IAU file is fixed-
        # width-ish but irregular. The name in column 1 is single-token ASCII
        # (with no internal whitespace) so a split + positional indexing on
        # the back-aligned fields (HIP, HD, RA, Dec) works reliably.
        parts = line.split()
        if len(parts) < 14:
            continue
        # Last fields: ... HIP HD RA Dec Date Notes
        # Find the date token (yyyy-mm-dd format) to anchor the columns.
        try:
            date_idx = next(
                i
                for i, p in enumerate(parts)
                if len(p) == 10 and p[4] == "-" and p[7] == "-"
            )
        except StopIteration:
            continue
        try:
            dec = float(parts[date_idx - 1])
            ra = float(parts[date_idx - 2])
            hd_raw = parts[date_idx - 3]
            hip_raw = parts[date_idx - 4]
        except (ValueError, IndexError):
            continue
        try:
            hip = int(hip_raw)
        except ValueError:
            hip = None
        del hd_raw  # not used today
        name = parts[0]
        out[name] = (hip, ra, dec)
    return out


def main() -> int:
    # === Step 1: WGSN names + coords ===
    name_info = fetch_wgsn()
    print(f"  {len(name_info)} WGSN names")

    # === Step 2: BSC5 ===
    print("Fetching BSC5 (V/50/catalog), Vmag<5.5…")
    bsc_rows = fetch_table(
        "-source=V/50/catalog"
        "&-out=HR,_RAJ2000,_DEJ2000,Vmag,SpType"
        "&-out.max=999999"
        "&Vmag=<5.5",
        expected_cols=5,
    )
    bsc_stars: list[list] = []
    for r in bsc_rows:
        if len(r) < 5:
            continue
        hr = parse_int(r[0])
        ra = parse_float(r[1])
        dec = parse_float(r[2])
        mag = parse_float(r[3])
        sp = spectral_letter(r[4])
        if hr is None or ra is None or dec is None or mag is None:
            continue
        bsc_stars.append([hr, round(ra, 4), round(dec, 4), round(mag, 2), sp or ""])
    bsc_stars.sort(key=lambda s: s[3])  # brightest first
    print(f"  {len(bsc_stars)} BSC stars")

    # === Step 3: HIP main ===
    print("Fetching HIP (I/239/hip_main), full catalog…")
    hip_rows = fetch_table(
        "-source=I/239/hip_main"
        "&-out=HIP,_RAJ2000,_DEJ2000,Vmag,SpType"
        "&-out.max=999999",
        expected_cols=5,
    )
    hip_stars: list[list] = []
    for r in hip_rows:
        if len(r) < 5:
            continue
        hip = parse_int(r[0])
        ra = parse_float(r[1])
        dec = parse_float(r[2])
        mag = parse_float(r[3])
        sp = spectral_letter(r[4])
        if hip is None or ra is None or dec is None or mag is None:
            continue
        hip_stars.append([hip, round(ra, 4), round(dec, 4), round(mag, 2), sp])
    hip_stars.sort(key=lambda s: s[3])
    print(f"  {len(hip_stars)} HIP stars")

    # === Step 4: build names maps ===
    # HIP catalog: direct lookup by hip_id (cleanest — WGSN provides it).
    # BSC catalog: coord match (WGSN has no HR field, but its J2000 RA/Dec
    # match BSC5's to better than an arcsec for these well-studied stars).
    hip_index_by_id: dict[int, int] = {s[0]: i for i, s in enumerate(hip_stars)}

    def coord_key(ra: float, dec: float) -> tuple[int, int]:
        # 0.02° (~72 arcsec) — generous for J2000-vs-WGSN epoch differences
        # but tight enough that bright stars match one candidate at most.
        return (round(ra * 50), round(dec * 50))

    bsc_coord_index: dict[tuple[int, int], int] = {}
    for i, s in enumerate(bsc_stars):
        bsc_coord_index[coord_key(s[1], s[2])] = i

    bsc_names: dict[str, int] = {}
    hip_names: dict[str, int] = {}
    for name, (hip_id, ra, dec) in name_info.items():
        # BSC: coord match (only stars below mag 5.5 are in the catalog;
        # names of fainter stars won't match — that's fine).
        k = coord_key(ra, dec)
        if k in bsc_coord_index:
            bsc_names[name] = bsc_coord_index[k]
        # HIP: by id if available, else coord fallback.
        if hip_id is not None and hip_id in hip_index_by_id:
            hip_names[name] = hip_index_by_id[hip_id]

    print(f"  BSC names matched: {len(bsc_names)} / {len(name_info)}")
    print(f"  HIP names matched: {len(hip_names)} / {len(name_info)}")

    # === Step 5: write outputs ===
    # Guard against clobbering the committed catalogs with empty data.
    # If either fetch returned nothing, leave the existing files alone
    # and surface a non-zero exit so callers/CI notice. Use a generous
    # floor (1000) rather than just "> 0" so a partial response from
    # Vizier still bails out instead of silently shipping a stub.
    MIN_STARS = 1000
    if len(bsc_stars) < MIN_STARS or len(hip_stars) < MIN_STARS:
        print(
            f"Refusing to write catalogs — got {len(bsc_stars)} BSC and "
            f"{len(hip_stars)} HIP rows (need ≥ {MIN_STARS} each). "
            f"Existing files at {BSC_OUT.name} / {HIP_OUT.name} left untouched.",
            file=sys.stderr,
        )
        return 1

    bsc_payload = {"stars": bsc_stars, "names": bsc_names}
    hip_payload = {"stars": hip_stars, "names": hip_names}

    BSC_OUT.write_text(json.dumps(bsc_payload, separators=(",", ":")))
    print(f"Wrote {BSC_OUT} ({BSC_OUT.stat().st_size / 1024:.1f} KB)")

    with gzip.open(HIP_OUT, "wb", compresslevel=9) as f:
        f.write(json.dumps(hip_payload, separators=(",", ":")).encode("utf-8"))
    print(f"Wrote {HIP_OUT} ({HIP_OUT.stat().st_size / 1024 / 1024:.2f} MB gzipped)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
