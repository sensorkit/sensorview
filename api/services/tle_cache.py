"""TLE caching layer backed by SQLite via aiosqlite.

Multi-source: every TLE row is tagged with the source it came from
('spacebook' | 'spacetrack' | 'local' | 'url'), and reads merge the
per-source sets by the user's configured priority order — when a satellite
has element sets in more than one enabled source, the highest-priority
source wins. Source config (order, enabled flags, custom URL) and
Space-Track credentials live in cache_meta; credentials are stored in
plaintext, the same security level as other client-side persisted secrets
in SensorView (see stores/streams.ts for the precedent).
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

DB_PATH = os.environ.get("TLE_CACHE_DB", str(Path(__file__).parent.parent / "tle_cache.db"))
SEED_PATH = Path(__file__).parent.parent / "data" / "seed_tles.txt"

SOURCE_IDS = ["spacebook", "spacetrack", "local", "url"]

DEFAULT_CONFIG: dict[str, Any] = {
    "order": list(SOURCE_IDS),
    "enabled": {"spacebook": True, "spacetrack": False, "local": False, "url": False},
    "customUrl": "",
}

_CREATE_TLES = """
    CREATE TABLE IF NOT EXISTS tles (
        source TEXT NOT NULL,
        norad_id TEXT NOT NULL,
        name TEXT NOT NULL,
        line1 TEXT NOT NULL,
        line2 TEXT NOT NULL,
        object_type TEXT DEFAULT 'UNKNOWN',
        orbit_regime TEXT DEFAULT 'OTHER',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, norad_id)
    )
"""

_CREATE_META = """
    CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
"""


class TLECacheService:
    """SQLite-backed multi-source TLE cache with seed data fallback."""

    def __init__(self, db_path: str | None = None):
        self.db_path = db_path or DB_PATH
        self._db: aiosqlite.Connection | None = None

    async def initialize(self):
        """Create the database and tables, migrating pre-source schemas."""
        self._db = await aiosqlite.connect(self.db_path)
        self._db.row_factory = aiosqlite.Row

        await self._db.execute(_CREATE_META)
        await self._migrate_legacy()
        await self._db.execute(_CREATE_TLES)
        await self._db.commit()

        # Load seed data if the cache is empty. Seeded rows stand in for the
        # default source until its first real refresh (which replaces them),
        # and deliberately do NOT set last_refresh so staleness checks still
        # see a never-refreshed cache.
        if await self._count_all() == 0:
            await self._load_seed()

    async def _migrate_legacy(self):
        """Rebuild the single-source table (PK norad_id, no source column)."""
        assert self._db
        async with self._db.execute("PRAGMA table_info(tles)") as cursor:
            cols = [row["name"] async for row in cursor]
        if not cols or "source" in cols:
            return

        await self._db.execute("ALTER TABLE tles RENAME TO tles_legacy")
        await self._db.execute(_CREATE_TLES)
        await self._db.execute("""
            INSERT OR IGNORE INTO tles
                (source, norad_id, name, line1, line2, object_type, orbit_regime, updated_at)
            SELECT 'spacebook', norad_id, name, line1, line2, object_type, orbit_regime, updated_at
            FROM tles_legacy
        """)
        await self._db.execute("DROP TABLE tles_legacy")
        await self._db.execute(
            "UPDATE OR REPLACE cache_meta SET key = 'last_refresh:spacebook' WHERE key = 'last_refresh'"
        )

    async def _count_all(self) -> int:
        assert self._db
        async with self._db.execute("SELECT COUNT(*) FROM tles") as cursor:
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def _load_seed(self):
        """Load seed TLE file (2LE) for offline/demo use."""
        if not SEED_PATH.exists():
            return
        from services.tle_parser import parse_tle_text

        records, _fmt = parse_tle_text(SEED_PATH.read_text())
        if records:
            await self.replace_source("spacebook", records, mark_refreshed=False)

    # === Source config ========================================================

    async def get_config(self) -> dict[str, Any]:
        raw = await self.get_meta("source_config")
        cfg = json.loads(raw) if raw else {}
        order = [s for s in cfg.get("order", []) if s in SOURCE_IDS]
        order += [s for s in DEFAULT_CONFIG["order"] if s not in order]
        enabled = {
            **DEFAULT_CONFIG["enabled"],
            **{k: bool(v) for k, v in cfg.get("enabled", {}).items() if k in SOURCE_IDS},
        }
        return {"order": order, "enabled": enabled, "customUrl": cfg.get("customUrl", "") or ""}

    async def set_config(self, patch: dict[str, Any]) -> dict[str, Any]:
        cfg = await self.get_config()
        if patch.get("order") is not None:
            order = [s for s in patch["order"] if s in SOURCE_IDS]
            order += [s for s in cfg["order"] if s not in order]
            cfg["order"] = order
        if patch.get("enabled") is not None:
            for k, v in patch["enabled"].items():
                if k in SOURCE_IDS:
                    cfg["enabled"][k] = bool(v)
        if patch.get("customUrl") is not None:
            cfg["customUrl"] = str(patch["customUrl"]).strip()
        await self.set_meta("source_config", json.dumps(cfg))
        return cfg

    # === Metadata =============================================================

    async def get_meta(self, key: str) -> str | None:
        assert self._db
        async with self._db.execute(
            "SELECT value FROM cache_meta WHERE key = ?", (key,)
        ) as cursor:
            row = await cursor.fetchone()
            return row["value"] if row else None

    async def set_meta(self, key: str, value: str):
        assert self._db
        await self._db.execute(
            """
            INSERT INTO cache_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )
        await self._db.commit()

    async def delete_meta(self, key: str):
        assert self._db
        await self._db.execute("DELETE FROM cache_meta WHERE key = ?", (key,))
        await self._db.commit()

    # === Writes ===============================================================

    async def replace_source(
        self,
        source: str,
        tles: list[dict[str, Any]],
        *,
        mark_refreshed: bool = True,
    ) -> int:
        """Replace a source's rows with a fresh set (a source's upload/fetch is
        its whole current catalog, so stale satellites drop out)."""
        assert self._db
        now = datetime.now(timezone.utc).isoformat()

        await self._db.execute("DELETE FROM tles WHERE source = ?", (source,))
        for tle in tles:
            orbit = classify_orbit_from_tle(tle.get("line2", ""))
            await self._db.execute(
                """
                INSERT INTO tles (source, norad_id, name, line1, line2, orbit_regime, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source, norad_id) DO UPDATE SET
                    name = excluded.name,
                    line1 = excluded.line1,
                    line2 = excluded.line2,
                    orbit_regime = excluded.orbit_regime,
                    updated_at = excluded.updated_at
                """,
                (
                    source,
                    tle["norad_id"],
                    tle.get("name") or f"SAT {tle['norad_id']}",
                    tle["line1"],
                    tle["line2"],
                    orbit,
                    now,
                ),
            )

        if mark_refreshed:
            await self._db.execute(
                """
                INSERT INTO cache_meta (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (f"last_refresh:{source}", now),
            )
        await self._db.commit()
        return len(tles)

    async def clear_source(self, source: str):
        assert self._db
        await self._db.execute("DELETE FROM tles WHERE source = ?", (source,))
        await self._db.execute(
            "DELETE FROM cache_meta WHERE key = ?", (f"last_refresh:{source}",)
        )
        await self._db.commit()

    # === Merged reads =========================================================

    async def _enabled_sources(self, cfg: dict[str, Any] | None = None) -> list[str]:
        cfg = cfg or await self.get_config()
        return [s for s in cfg["order"] if cfg["enabled"].get(s)]

    async def search(
        self,
        search: str | None = None,
        limit: int = 5000,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        assert self._db
        cfg = await self.get_config()
        enabled = await self._enabled_sources(cfg)
        if not enabled:
            return []

        placeholders = ",".join("?" for _ in enabled)
        query = f"""
            SELECT source, norad_id, name, line1, line2, object_type, orbit_regime
            FROM (
                SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY norad_id ORDER BY {_rank_case(cfg["order"])}
                ) AS rn
                FROM tles WHERE source IN ({placeholders})
            )
            WHERE rn = 1
        """
        params: list[Any] = [*enabled]
        if search:
            query += " AND (norad_id LIKE ? OR name LIKE ?)"
            pattern = f"%{search}%"
            params += [pattern, pattern]
        query += " ORDER BY norad_id LIMIT ? OFFSET ?"
        params += [limit, offset]

        results = []
        async with self._db.execute(query, params) as cursor:
            async for row in cursor:
                results.append(_record(row))
        return results

    async def get_by_norad_id(self, norad_id: str) -> dict[str, Any] | None:
        assert self._db
        cfg = await self.get_config()
        enabled = await self._enabled_sources(cfg)
        if not enabled:
            return None

        placeholders = ",".join("?" for _ in enabled)
        async with self._db.execute(
            f"""
            SELECT source, norad_id, name, line1, line2, object_type, orbit_regime
            FROM tles
            WHERE norad_id = ? AND source IN ({placeholders})
            ORDER BY {_rank_case(cfg["order"])}
            LIMIT 1
            """,
            (norad_id, *enabled),
        ) as cursor:
            row = await cursor.fetchone()
            return _record(row) if row else None

    # === Status ===============================================================

    async def get_status(self) -> dict[str, Any]:
        """Merged-catalog status: distinct satellites across enabled sources,
        most recent refresh among them. Shape unchanged from the
        single-source era for existing consumers."""
        assert self._db
        cfg = await self.get_config()
        enabled = await self._enabled_sources(cfg)

        count = 0
        if enabled:
            placeholders = ",".join("?" for _ in enabled)
            async with self._db.execute(
                f"SELECT COUNT(DISTINCT norad_id) FROM tles WHERE source IN ({placeholders})",
                enabled,
            ) as cursor:
                row = await cursor.fetchone()
                count = row[0] if row else 0

        last_refresh = None
        for source in enabled:
            value = await self.get_meta(f"last_refresh:{source}")
            if value and (last_refresh is None or value > last_refresh):
                last_refresh = value

        return {
            "count": count,
            "lastRefresh": last_refresh,
            "cacheAgeHours": _age_hours(last_refresh),
        }

    async def get_sources_status(self) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Per-source rows in priority order, plus the config they came from."""
        assert self._db
        cfg = await self.get_config()

        counts: dict[str, int] = {}
        async with self._db.execute(
            "SELECT source, COUNT(*) AS n FROM tles GROUP BY source"
        ) as cursor:
            async for row in cursor:
                counts[row["source"]] = row["n"]

        rows = []
        for source in cfg["order"]:
            last_refresh = await self.get_meta(f"last_refresh:{source}")
            rows.append({
                "id": source,
                "enabled": bool(cfg["enabled"].get(source)),
                "count": counts.get(source, 0),
                "lastRefresh": last_refresh,
                "cacheAgeHours": _age_hours(last_refresh),
            })
        return rows, cfg


def _record(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "noradId": row["norad_id"],
        "name": row["name"],
        "line1": row["line1"],
        "line2": row["line2"],
        "objectType": row["object_type"],
        "orbitRegime": row["orbit_regime"],
        "source": row["source"],
    }


def _rank_case(order: list[str]) -> str:
    """SQL expression ranking rows by source priority. Source ids come from
    the fixed SOURCE_IDS vocabulary, never user input, so inlining is safe."""
    whens = " ".join(f"WHEN '{s}' THEN {i}" for i, s in enumerate(order))
    return f"CASE source {whens} ELSE 99 END"


def _age_hours(iso_timestamp: str | None) -> float | None:
    if not iso_timestamp:
        return None
    dt = datetime.fromisoformat(iso_timestamp)
    return round((datetime.now(timezone.utc) - dt).total_seconds() / 3600, 2)


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
