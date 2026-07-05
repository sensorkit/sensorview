"""TLE caching layer backed by SQLite via aiosqlite."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiosqlite

DB_PATH = os.environ.get("TLE_CACHE_DB", str(Path(__file__).parent.parent / "tle_cache.db"))
SEED_PATH = Path(__file__).parent.parent / "data" / "seed_tles.txt"


class TLECacheService:
    """SQLite-backed TLE cache with seed data fallback."""

    def __init__(self, db_path: str | None = None):
        self.db_path = db_path or DB_PATH
        self._db: aiosqlite.Connection | None = None

    async def initialize(self):
        """Create the database and tables if they don't exist."""
        self._db = await aiosqlite.connect(self.db_path)
        self._db.row_factory = aiosqlite.Row

        await self._db.execute("""
            CREATE TABLE IF NOT EXISTS tles (
                norad_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                line1 TEXT NOT NULL,
                line2 TEXT NOT NULL,
                object_type TEXT DEFAULT 'UNKNOWN',
                orbit_regime TEXT DEFAULT 'OTHER',
                updated_at TEXT NOT NULL
            )
        """)
        await self._db.execute("""
            CREATE TABLE IF NOT EXISTS cache_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        await self._db.commit()

        # Load seed data if cache is empty
        count = await self._count()
        if count == 0:
            await self._load_seed()

    async def _count(self) -> int:
        assert self._db
        async with self._db.execute("SELECT COUNT(*) FROM tles") as cursor:
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def _load_seed(self):
        """Load seed TLE file for offline/demo use."""
        if not SEED_PATH.exists():
            return

        lines = SEED_PATH.read_text().strip().split("\n")
        records: list[dict[str, str]] = []
        i = 0
        while i < len(lines):
            if i + 1 >= len(lines):
                break
            line1 = lines[i].strip()
            line2 = lines[i + 1].strip()
            if line1.startswith("1 ") and line2.startswith("2 "):
                norad_id = line1[2:7].strip()
                records.append({
                    "norad_id": norad_id,
                    "name": f"SAT {norad_id}",
                    "line1": line1,
                    "line2": line2,
                })
                i += 2
            else:
                i += 1

        if records:
            await self.bulk_upsert(records)

    async def bulk_upsert(self, tles: list[dict[str, Any]]) -> int:
        """Insert or update TLE records and update cache metadata."""
        assert self._db
        now = datetime.now(timezone.utc).isoformat()

        for tle in tles:
            orbit = classify_orbit_from_tle(tle.get("line2", ""))
            await self._db.execute(
                """
                INSERT INTO tles (norad_id, name, line1, line2, orbit_regime, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(norad_id) DO UPDATE SET
                    name = excluded.name,
                    line1 = excluded.line1,
                    line2 = excluded.line2,
                    orbit_regime = excluded.orbit_regime,
                    updated_at = excluded.updated_at
                """,
                (
                    tle["norad_id"],
                    tle.get("name", f"SAT {tle['norad_id']}"),
                    tle["line1"],
                    tle["line2"],
                    orbit,
                    now,
                ),
            )

        await self._db.execute(
            """
            INSERT INTO cache_meta (key, value)
            VALUES ('last_refresh', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (now,),
        )
        await self._db.commit()
        return len(tles)

    async def search(
        self,
        search: str | None = None,
        limit: int = 5000,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        assert self._db
        if search:
            query = """
                SELECT norad_id, name, line1, line2, object_type, orbit_regime
                FROM tles
                WHERE norad_id LIKE ? OR name LIKE ?
                ORDER BY norad_id
                LIMIT ? OFFSET ?
            """
            pattern = f"%{search}%"
            params = (pattern, pattern, limit, offset)
        else:
            query = """
                SELECT norad_id, name, line1, line2, object_type, orbit_regime
                FROM tles
                ORDER BY norad_id
                LIMIT ? OFFSET ?
            """
            params = (limit, offset)

        results = []
        async with self._db.execute(query, params) as cursor:
            async for row in cursor:
                results.append({
                    "noradId": row["norad_id"],
                    "name": row["name"],
                    "line1": row["line1"],
                    "line2": row["line2"],
                    "objectType": row["object_type"],
                    "orbitRegime": row["orbit_regime"],
                })
        return results

    async def get_by_norad_id(self, norad_id: str) -> dict[str, Any] | None:
        assert self._db
        async with self._db.execute(
            "SELECT * FROM tles WHERE norad_id = ?", (norad_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            return {
                "noradId": row["norad_id"],
                "name": row["name"],
                "line1": row["line1"],
                "line2": row["line2"],
                "objectType": row["object_type"],
                "orbitRegime": row["orbit_regime"],
            }

    async def get_status(self) -> dict[str, Any]:
        assert self._db
        count = await self._count()

        last_refresh = None
        cache_age_hours = None
        async with self._db.execute(
            "SELECT value FROM cache_meta WHERE key = 'last_refresh'"
        ) as cursor:
            row = await cursor.fetchone()
            if row:
                last_refresh = row["value"]
                dt = datetime.fromisoformat(last_refresh)
                cache_age_hours = (datetime.now(timezone.utc) - dt).total_seconds() / 3600

        return {
            "count": count,
            "lastRefresh": last_refresh,
            "cacheAgeHours": round(cache_age_hours, 2) if cache_age_hours else None,
        }


def classify_orbit_from_tle(line2: str) -> str:
    """Rough orbit classification from TLE mean motion (revs/day)."""
    try:
        # Mean motion is in columns 53-63 of line 2
        mean_motion = float(line2[52:63].strip())
        if mean_motion > 11.25:  # Period < ~128 min
            return "LEO"
        elif mean_motion > 2.0:  # Period < 720 min
            return "MEO"
        elif 0.99 < mean_motion < 1.01:  # ~1 rev/day = GEO
            return "GEO"
        elif mean_motion < 2.0:
            return "HEO"
        else:
            return "OTHER"
    except (ValueError, IndexError):
        return "OTHER"
