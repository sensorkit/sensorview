"""Spacebook API client — fetches TLE data from Spacebook by COMSPOC.

Spacebook provides free TLE data without authentication at:
    https://spacebook.com/api/entity/tle

Returns two-line format: alternating line1/line2 pairs.
NORAD ID is extracted from line1[2:7].

This integration pattern is based on the SensorKit Otto module's fetch_tles().
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

SPACEBOOK_URL = os.environ.get("SPACEBOOK_URL", "https://spacebook.com/api/entity/tle")
SPACEBOOK_TIMEOUT = int(os.environ.get("SPACEBOOK_TIMEOUT", "60"))


class SpacebookClient:
    """Client for the Spacebook TLE API."""

    def __init__(self, url: Optional[str] = None, timeout: Optional[int] = None):
        self.url = url or SPACEBOOK_URL
        self.timeout = timeout or SPACEBOOK_TIMEOUT

    async def fetch_all_tles(self) -> Tuple[List[Dict[str, Any]], int]:
        """Fetch the full TLE catalog from Spacebook.

        Returns:
            Tuple of (tle_records, http_status_code).
            Each record: {"norad_id": str, "name": str, "line1": str, "line2": str}
        """
        tles: List[Dict[str, Any]] = []

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(self.url)

                if response.status_code != 200:
                    logger.error("Spacebook TLE fetch failed: %d", response.status_code)
                    return tles, response.status_code

                lines = response.text.strip().split("\n")

                i = 0
                while i < len(lines):
                    if i + 1 >= len(lines):
                        break

                    line1 = lines[i].strip()
                    line2 = lines[i + 1].strip()

                    # Validate TLE format
                    if not (line1.startswith("1 ") and line2.startswith("2 ")):
                        i += 1
                        continue

                    # Extract NORAD ID from line 1 (columns 3-7)
                    norad_id = line1[2:7].strip()

                    # Spacebook format doesn't include line0 (satellite name)
                    # Generate a placeholder name from NORAD ID
                    name = f"SAT {norad_id}"

                    tles.append({
                        "norad_id": norad_id,
                        "name": name,
                        "line1": line1,
                        "line2": line2,
                    })

                    i += 2

                logger.info("Fetched %d TLEs from Spacebook", len(tles))
                return tles, 200

        except httpx.TimeoutException:
            logger.error("Spacebook request timed out")
            return tles, 408
        except Exception as e:
            logger.exception("Error fetching TLEs from Spacebook: %s", e)
            return tles, 500

    async def fetch_tles_for_objects(
        self,
        norad_ids: List[str],
    ) -> Tuple[Dict[str, Dict[str, str]], int]:
        """Fetch TLEs for specific NORAD IDs (filters from full catalog)."""
        all_tles, status = await self.fetch_all_tles()
        if status != 200:
            return {}, status

        id_set = set(norad_ids)
        result: Dict[str, Dict[str, str]] = {}

        for tle in all_tles:
            if tle["norad_id"] in id_set:
                result[tle["norad_id"]] = {
                    "line0": f"0 {tle['norad_id']}",
                    "line1": tle["line1"],
                    "line2": tle["line2"],
                }
                if len(result) == len(id_set):
                    break

        missing = id_set - set(result.keys())
        if missing:
            logger.warning("Could not find TLEs for %d satellites: %s", len(missing), sorted(missing))

        return result, 200
