"""Shared state-vector document parser.

Accepts a JSON document holding either a single state vector object or an
array of them. The field vocabulary follows the common flat state-vector
schema used across SDA data providers: `epoch`, `xpos`/`ypos`/`zpos`,
`xvel`/`yvel`/`zvel`, `referenceFrame`, and a `satNo`/`idOnOrbit` identifier.
The parser is deliberately provider-agnostic — it keys off field names only
and carries no provider-specific metadata through.

Positions are kilometres and velocities kilometres per second, matching both
the source documents and SensorView's own display units. The conversion to
SensorKit's metres / metres-per-second happens at the command boundary, not
here, so there is exactly one place that scales.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any

# Standard gravitational parameter of Earth, km^3/s^2. Used only to derive an
# orbit regime bucket, so the low-precision value is fine.
_MU_EARTH = 398600.4418

# Reference frames SensorKit understands (astro/common.py ReferenceFrame).
# Stored lowercase, which is exactly the wire form SK expects.
_KNOWN_FRAMES = {"altaz", "cirf", "gcrf", "icrf", "itrf", "teme"}

# Plausible geocentric radius range in km — from just below the Earth's
# surface out past cislunar. A document in metres lands far outside this, so
# the check turns a silent 1000x pointing error into a loud rejection.
_MIN_RADIUS_KM = 6_000.0
_MAX_RADIUS_KM = 2_000_000.0


class StateVectorParseError(ValueError):
    """Raised when a document isn't usable as a state-vector set."""


def parse_sv_text(text: str) -> list[dict[str, Any]]:
    """Parse a state-vector document into records.

    Accepts a bare object or an array of objects. Each record:
    {"norad_id", "name", "epoch", "frame", "rx", "ry", "rz", "vx", "vy", "vz",
     "orbit_regime"} — `name` falls back to "SAT <norad_id>", matching the TLE
    parser, so the UI's placeholder-name rule renders these as "SV · <id>".

    Raises StateVectorParseError with a message meant for the upload dialog.
    """
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as err:
        raise StateVectorParseError(f"Not valid JSON: {err.msg} (line {err.lineno})") from err

    if isinstance(doc, dict):
        entries = [doc]
    elif isinstance(doc, list):
        entries = doc
    else:
        raise StateVectorParseError(
            "Expected a state-vector object or an array of them, "
            f"got {type(doc).__name__}"
        )

    if not entries:
        raise StateVectorParseError("Document contains no state vectors")

    records: list[dict[str, Any]] = []
    for index, entry in enumerate(entries):
        records.append(_parse_entry(entry, index, len(entries)))
    return records


def _parse_entry(entry: Any, index: int, total: int) -> dict[str, Any]:
    # Only label errors with an index when there's more than one to disambiguate.
    where = "" if total == 1 else f" (entry {index + 1} of {total})"

    if not isinstance(entry, dict):
        raise StateVectorParseError(f"Expected an object{where}, got {type(entry).__name__}")

    norad_id = _norad_id(entry, where)
    epoch = _epoch(entry, where)
    r = tuple(_number(entry, key, where) for key in ("xpos", "ypos", "zpos"))
    v = tuple(_number(entry, key, where) for key in ("xvel", "yvel", "zvel"))

    radius = math.sqrt(sum(c * c for c in r))
    if not _MIN_RADIUS_KM <= radius <= _MAX_RADIUS_KM:
        raise StateVectorParseError(
            f"Position magnitude {radius:,.0f} is outside the plausible range for "
            f"kilometres{where} — positions must be km and velocities km/s"
        )

    return {
        "norad_id": norad_id,
        "name": f"SAT {norad_id}",
        "epoch": epoch,
        "frame": _frame(entry, where),
        "rx": r[0], "ry": r[1], "rz": r[2],
        "vx": v[0], "vy": v[1], "vz": v[2],
        "orbit_regime": classify_orbit_from_sv(r, v),
    }


def _norad_id(entry: dict[str, Any], where: str) -> str:
    """Object identity. `satNo` is numeric, `idOnOrbit` its string twin."""
    for key in ("satNo", "idOnOrbit"):
        raw = entry.get(key)
        if raw is None:
            continue
        text = str(raw).strip()
        if text:
            return text
    raise StateVectorParseError(f"No satNo or idOnOrbit to identify the object{where}")


def _epoch(entry: dict[str, Any], where: str) -> str:
    raw = entry.get("epoch")
    if raw is None:
        raise StateVectorParseError(f"Missing epoch{where}")
    text = str(raw).strip()
    # fromisoformat only learned to accept a trailing "Z" in 3.11; normalising
    # keeps the parser working on older interpreters too.
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as err:
        raise StateVectorParseError(f"Unparseable epoch {text!r}{where}") from err
    if parsed.tzinfo is None:
        # Naive epochs are treated as UTC — every source in this schema is.
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _frame(entry: dict[str, Any], where: str) -> str:
    raw = entry.get("referenceFrame")
    if raw is None:
        # Geocentric is the only sane default for an Earth-satellite state
        # vector, and it is what the schema's producers emit.
        return "gcrf"
    frame = str(raw).strip().lower()
    if frame not in _KNOWN_FRAMES:
        raise StateVectorParseError(
            f"Unsupported reference frame {raw!r}{where} — "
            f"expected one of {', '.join(sorted(_KNOWN_FRAMES)).upper()}"
        )
    return frame


def _number(entry: dict[str, Any], key: str, where: str) -> float:
    raw = entry.get(key)
    if raw is None:
        raise StateVectorParseError(f"Missing {key}{where}")
    try:
        value = float(raw)
    except (TypeError, ValueError) as err:
        raise StateVectorParseError(f"{key} is not a number: {raw!r}{where}") from err
    if not math.isfinite(value):
        raise StateVectorParseError(f"{key} is not finite: {raw!r}{where}")
    return value


def classify_orbit_from_sv(
    r: tuple[float, float, float],
    v: tuple[float, float, float],
) -> str:
    """Orbit regime from position/velocity, in km and km/s.

    Derives mean motion via the vis-viva semi-major axis so the buckets reuse
    classify_orbit_from_tle's thresholds — an SV and a TLE for the same object
    should agree, or the catalog's regime filter would show one row and hide
    the other.

    Agreement is close but not perfect: a TLE carries *mean* elements while a
    state vector yields *osculating* ones, so an object sitting within ~1e-4
    of a threshold can fall on either side. Measured at 315/316 against real
    catalog TLEs spanning all four regimes; the lone disagreement was a
    satellite 3e-5 above the GEO boundary. Not worth correcting for — the
    consequence is one row of a knife-edge pair hiding under a regime filter.
    """
    try:
        radius = math.sqrt(sum(c * c for c in r))
        speed_sq = sum(c * c for c in v)
        # vis-viva: v^2 = mu (2/r - 1/a)
        inv_a = 2.0 / radius - speed_sq / _MU_EARTH
        if inv_a <= 0:
            return "OTHER"  # escape trajectory — no closed orbit to classify
        semi_major = 1.0 / inv_a
        period_s = 2.0 * math.pi * math.sqrt(semi_major**3 / _MU_EARTH)
        mean_motion = 86_400.0 / period_s
    except (ValueError, ZeroDivisionError):
        return "OTHER"

    if mean_motion > 11.25:
        return "LEO"
    if mean_motion > 2.0:
        return "MEO"
    if 0.99 < mean_motion < 1.01:
        return "GEO"
    if mean_motion < 2.0:
        return "HEO"
    return "OTHER"
