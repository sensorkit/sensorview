"""Shared TLE text parser — accepts two-line (2LE) and three-line (3LE) sets.

3LE name lines come in both flavors: bare ("ISS (ZARYA)") and prefixed
("0 ISS (ZARYA)"). Lines starting with '#' are treated as comments so a
commented header on a 2LE file doesn't get mistaken for a satellite name.
"""
from __future__ import annotations

from typing import Any


def parse_tle_text(text: str) -> tuple[list[dict[str, Any]], str]:
    """Parse a TLE document, auto-detecting 2LE vs 3LE.

    Returns (records, detected_format) where detected_format is "2le" or
    "3le". Each record: {"norad_id", "name", "line1", "line2"} — name falls
    back to "SAT <norad_id>" when the document carries no name lines.
    """
    lines = text.strip().splitlines()
    records: list[dict[str, Any]] = []
    named = 0
    pending_name: str | None = None

    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if (
            _is_line1(line)
            and i + 1 < len(lines)
            and _is_line2(lines[i + 1].strip())
        ):
            line2 = lines[i + 1].strip()
            norad_id = line[2:7].strip()
            if pending_name:
                named += 1
            records.append({
                "norad_id": norad_id,
                "name": pending_name or f"SAT {norad_id}",
                "line1": line,
                "line2": line2,
            })
            pending_name = None
            i += 2
            continue

        if line and not line.startswith("#") and not _is_line1(line) and not _is_line2(line):
            pending_name = line[2:].strip() if line.startswith("0 ") else line
        i += 1

    fmt = "3le" if records and named >= max(1, len(records) // 2) else "2le"
    return records, fmt


def _is_line1(s: str) -> bool:
    return s.startswith("1 ") and len(s) >= 7


def _is_line2(s: str) -> bool:
    return s.startswith("2 ") and len(s) >= 7
