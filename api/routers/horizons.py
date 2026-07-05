"""JPL Horizons proxy — object lookup + Observer-Table ephemeris.

The browser cannot call https://ssd.jpl.nasa.gov/api/horizons.api directly: the
service sends no CORS headers. This router proxies the two calls SensorView's
Horizons targeting feature needs, parses Horizons' text output into clean JSON,
and applies a small TTL cache so we don't hammer JPL (it publishes no documented
rate limit, so we self-throttle).

Endpoints:
  GET /api/horizons/lookup?q=<name>            resolve / disambiguate an object
  GET /api/horizons/ephemeris?command=&lon=…   sampled RA/Dec (ICRF) over a window

Both speak to EPHEM_TYPE=OBSERVER with QUANTITIES='1,3,9,20' (astrometric RA/Dec,
sky-motion rates, magnitude, range), ANG_FORMAT=DEG, CSV_FORMAT=YES so the rows
between $$SOE/$$EOE are trivially splittable.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import UTC, datetime
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)

router = APIRouter()

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
USER_AGENT = "SensorView/0.1 (JPL Horizons proxy)"
TIMEOUT = 30.0

# QUANTITIES: 1=astrometric RA/Dec (ICRF/J2000), 3=RA/Dec sky-motion rates
# (dRA*cosD, d(DEC)/dt in arcsec/hr), 9=visual mag + surface brightness,
# 20=observer range (AU) + range-rate.
QUANTITIES = "1,3,9,20"

# Small in-memory TTL cache. Lookups change rarely; ephemerides are time-relative
# so cache only briefly to coalesce duplicate clicks.
_LOOKUP_TTL = 3600.0
_EPHEM_TTL = 60.0
_cache: dict[str, tuple[float, Any]] = {}


def _cache_get(key: str) -> Optional[Any]:
    hit = _cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def _cache_put(key: str, value: Any, ttl: float) -> None:
    _cache[key] = (time.monotonic() + ttl, value)


async def _horizons_get(params: dict[str, str]) -> str:
    """Issue a Horizons request and return the raw text result."""
    q = {"format": "text", **params}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            resp = await client.get(HORIZONS_URL, params=q)
    except httpx.RequestError as e:
        raise HTTPException(502, f"Horizons unreachable: {e}") from e
    if resp.status_code != 200:
        # Horizons returns a short error body for bad queries.
        raise HTTPException(502, f"Horizons HTTP {resp.status_code}: {resp.text[:300]}")
    return resp.text


def _quote(value: str) -> str:
    """Wrap a Horizons parameter value in the single quotes the API expects."""
    return "'" + value.strip().strip("'") + "'"


# === Lookup parsing ===========================================================

# Name appears as "Target body name:" once an ephemeris is generated; in a bare
# OBJ_DATA header it sits in the banner instead — small bodies on the
# "JPL/HORIZONS <name> <timestamp>" line, major bodies on the "Revised: <date>
# <name> <id>" line.
_NAME_EPHEM_RE = re.compile(r"Target body name:\s*(.+?)\s*(?:\{|$)", re.MULTILINE)
_NAME_SMALL_RE = re.compile(
    r"^JPL/HORIZONS\s+(.+?)\s+\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}", re.MULTILINE
)
_NAME_MAJOR_RE = re.compile(r"^\s*Revised:.*?\d{4}\s{2,}(.+?)\s{2,}", re.MULTILINE)
_MAJOR_ROW_RE = re.compile(r"^\s*(-?\d+)\s+(.+?)\s*$")


def _extract_name(text: str) -> Optional[str]:
    for rx in (_NAME_EPHEM_RE, _NAME_SMALL_RE, _NAME_MAJOR_RE):
        m = rx.search(text)
        if m:
            return m.group(1).strip()
    return None


def _parse_major_matches(text: str) -> list[dict[str, str]]:
    """Parse a 'Multiple major-bodies match' table into candidates."""
    out: list[dict[str, str]] = []
    lines = text.splitlines()
    started = False
    for line in lines:
        if re.match(r"\s*ID#", line):
            started = True
            continue
        if not started:
            continue
        if set(line.strip()) <= {"-", " "} and line.strip():
            continue  # dashed separator
        if not line.strip():
            if out:
                break  # blank line after rows ends the table
            continue
        m = _MAJOR_ROW_RE.match(line)
        if not m:
            continue
        ident, rest = m.group(1), m.group(2)
        # Name is the first column of `rest` (up to 2+ spaces).
        name = re.split(r"\s{2,}", rest.strip())[0].strip()
        out.append({"command": ident, "name": name, "kind": "major"})
    return out


def _parse_small_matches(text: str) -> list[dict[str, str]]:
    """Best-effort parse of a 'Matching small-bodies' list into candidates."""
    out: list[dict[str, str]] = []
    lines = text.splitlines()
    started = False
    for line in lines:
        if "Matching small-bodies" in line or re.search(r"Record #|Primary Desig", line):
            started = True
            continue
        if not started:
            continue
        if set(line.strip()) <= {"-", " "} and line.strip():
            continue
        if not line.strip():
            if out:
                break
            continue
        # Rows look like:  "<rec#>  <epoch>  <desig>  <Name (year)>"
        toks = line.split()
        if not toks or not re.match(r"^-?\d", toks[0]):
            continue
        name = re.split(r"\s{2,}", line.strip())[-1].strip()
        # Prefer a numeric designation token for re-query; else the first name word.
        desig = next((t for t in toks if re.match(r"^\d+$", t)), None)
        display = f"{desig} {name}".strip() if desig else (name or toks[0])
        cmd = f"{desig};" if desig else f"{name.split()[0]};"
        out.append({"command": cmd, "name": display, "kind": "small"})
    return out[:40]


def _small_variants(q: str) -> list[str]:
    """Small-body COMMAND forms to try, in order. Horizons rejects 'name';' when
    the name has a number+word ('433 Eros;' → DES search → no match), so we also
    try the bare numeric token ('433;') and the bare name token ('Eros;')."""
    q = q.strip()
    out = [f"{q};"]
    toks = q.split()
    num = next((t for t in toks if re.fullmatch(r"\d+", t)), None)
    if num and f"{num};" not in out:
        out.append(f"{num};")
    alpha = next((t for t in toks if re.fullmatch(r"[A-Za-z][\w/+-]*", t)), None)
    if alpha and f"{alpha};" not in out:
        out.append(f"{alpha};")
    # Prefix/wildcard fallback so a partial name ("Melp" → 18 Melpomene) still
    # finds candidates. Only for plain alphabetic queries; Horizons does this
    # via a trailing '*' on the small-body name search.
    if re.fullmatch(r"[A-Za-z][A-Za-z ]*", q):
        wc = f"{q}*;"
        if wc not in out:
            out.append(wc)
    return out[:4]


def _is_single_resolve(text: str) -> bool:
    return (
        _extract_name(text) is not None
        and "Matching small-bodies" not in text
        and "Multiple major-bodies" not in text
        and "No matches found" not in text
        and "Cannot interpret" not in text
    )


@router.get("/lookup")
async def lookup(q: str = Query(..., min_length=1, description="Object name, designation, or id")):
    """Resolve an object. Returns a single match or a candidate list to choose from."""
    key = f"lookup:{q.strip().lower()}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    async def query(command: str) -> str:
        return await _horizons_get(
            {"COMMAND": _quote(command), "OBJ_DATA": "YES", "MAKE_EPHEM": "NO"}
        )

    first = await query(q)
    text, used_command = first, q.strip()
    name = _extract_name(first) if _is_single_resolve(first) else None
    small_list_text: Optional[str] = None

    # Not a clean major-body resolve (and not an ambiguous major-body list) —
    # try small-body token + wildcard variants.
    if name is None and ";" not in q and "Multiple major-bodies match" not in first:
        for variant in _small_variants(q):
            rt = await query(variant)
            if _is_single_resolve(rt):
                text, used_command, name = rt, variant, _extract_name(rt)
                break
            if small_list_text is None and "Matching small-bodies" in rt and _parse_small_matches(rt):
                small_list_text = rt

    result: dict[str, Any]
    if name:
        # Drop a trailing center reference some major-body headers carry
        # (e.g. "Cert-2 … (spacecraft) / Sun" → "Cert-2 … (spacecraft)").
        name = re.split(r"\s+/\s+", name)[0].strip()
        is_small = "Rec #" in text or used_command.endswith(";")
        cmd = used_command
        if is_small and not cmd.endswith(";"):
            cmd += ";"  # lock to the small-body record for the ephemeris call
        # Only the actual Sun (id 10 / name "Sun"), not anything merely
        # containing the word — otherwise the safety guard fires spuriously.
        is_sun = q.strip().lower() in {"10", "sun"} or bool(re.match(r"(?i)^\s*sun\b", name))
        result = {
            "resolved": True,
            "name": name,
            "command": cmd,
            "kind": "small" if is_small else "major",
            "isSun": is_sun,
        }
    elif "Multiple major-bodies match" in first:
        result = {"resolved": False, "candidates": _parse_major_matches(first), "raw": None}
    elif small_list_text is not None:
        result = {"resolved": False, "candidates": _parse_small_matches(small_list_text), "raw": None}
    elif "Matching small-bodies" in first:
        result = {"resolved": False, "candidates": _parse_small_matches(first), "raw": None}
    else:
        result = {"resolved": False, "candidates": [], "raw": None}

    _cache_put(key, result, _LOOKUP_TTL)
    return result


# === Ephemeris parsing ========================================================

_DATE_FORMATS = ("%Y-%b-%d %H:%M:%S.%f", "%Y-%b-%d %H:%M:%S", "%Y-%b-%d %H:%M")


def _parse_date(s: str) -> datetime:
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s.strip(), fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    raise ValueError(f"unparseable Horizons date: {s!r}")


def _to_jd(dt: datetime) -> float:
    # UTC Julian Day — matches SensorKit's obstime.jd convention.
    return dt.timestamp() / 86400.0 + 2440587.5


def _to_float(s: str) -> Optional[float]:
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def _parse_ephemeris(text: str) -> list[dict[str, Any]]:
    """Parse the CSV rows between $$SOE/$$EOE into sample dicts."""
    block = re.search(r"\$\$SOE\s*(.*?)\s*\$\$EOE", text, re.DOTALL)
    if not block:
        return []
    samples: list[dict[str, Any]] = []
    for line in block.group(1).splitlines():
        line = line.strip()
        if not line:
            continue
        fields = [f.strip() for f in line.split(",")]
        # RA is the first parseable float after the date + presence-flag columns.
        idx = next((i for i in range(1, len(fields)) if _to_float(fields[i]) is not None), None)
        if idx is None or idx + 3 >= len(fields):
            continue
        try:
            dt = _parse_date(fields[0])
        except ValueError:
            continue
        sample = {
            "jd": _to_jd(dt),
            "utc": dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "ra": _to_float(fields[idx]),
            "dec": _to_float(fields[idx + 1]),
            "raRateArcsecHr": _to_float(fields[idx + 2]),
            "decRateArcsecHr": _to_float(fields[idx + 3]),
            "magnitude": _to_float(fields[idx + 4]) if idx + 4 < len(fields) else None,
            "rangeAu": _to_float(fields[idx + 6]) if idx + 6 < len(fields) else None,
        }
        if sample["ra"] is None or sample["dec"] is None:
            continue
        samples.append(sample)
    return samples


@router.get("/ephemeris")
async def ephemeris(
    command: str = Query(..., description="Resolved Horizons COMMAND (e.g. 499, '433;')"),
    lon: float = Query(..., description="Observer East longitude, degrees"),
    lat: float = Query(..., description="Observer latitude, degrees"),
    alt_km: float = Query(0.0, description="Observer altitude, kilometers"),
    start: str = Query(..., description="Start time, 'YYYY-MM-DD HH:MM:SS' UTC"),
    stop: str = Query(..., description="Stop time, 'YYYY-MM-DD HH:MM:SS' UTC"),
    intervals: int = Query(60, ge=1, le=2000, description="Number of equal sub-intervals"),
):
    """Return a sampled Observer-Table ephemeris (RA/Dec ICRF + rates) for the object."""
    key = f"ephem:{command}|{lon:.5f},{lat:.5f},{alt_km:.4f}|{start}|{stop}|{intervals}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    text = await _horizons_get(
        {
            "COMMAND": _quote(command),
            "EPHEM_TYPE": "OBSERVER",
            "CENTER": "'coord@399'",
            "COORD_TYPE": "GEODETIC",
            "SITE_COORD": _quote(f"{lon},{lat},{alt_km}"),
            "START_TIME": _quote(start),
            "STOP_TIME": _quote(stop),
            "STEP_SIZE": str(intervals),  # bare integer = number of intervals
            "QUANTITIES": _quote(QUANTITIES),
            "ANG_FORMAT": "DEG",
            "CSV_FORMAT": "YES",
            "OBJ_DATA": "NO",
            "MAKE_EPHEM": "YES",
        }
    )

    if "$$SOE" not in text:
        # Ambiguous command, or no ephemeris produced — surface a useful error.
        if "Multiple major-bodies match" in text:
            raise HTTPException(422, "Ambiguous object; resolve via /lookup first")
        snippet = text[:300].strip()
        raise HTTPException(422, f"No ephemeris generated: {snippet}")

    samples = _parse_ephemeris(text)
    if not samples:
        raise HTTPException(502, "Could not parse Horizons ephemeris output")

    result = {"name": _extract_name(text), "command": command.strip(), "samples": samples}
    _cache_put(key, result, _EPHEM_TTL)
    return result
