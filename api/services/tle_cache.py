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

# Order is the default merge priority, and the order rows appear in Settings.
# Remote/fetched sources first, then the local uploads grouped together.
SOURCE_IDS = ["spacebook", "spacetrack", "url", "local", "localsv"]

# Sources whose rows are state vectors rather than TLEs. They live in their own
# table (see _CREATE_SVS) and merge independently, so an object can appear once
# as a TLE and once as an SV.
SV_SOURCE_IDS = {"localsv"}

DEFAULT_CONFIG: dict[str, Any] = {
    "order": list(SOURCE_IDS),
    "enabled": {
        "spacebook": True,
        "spacetrack": False,
        "url": False,
        "local": False,
        "localsv": False,
    },
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

# State vectors get their own table rather than nullable columns on `tles`:
# the shapes share only an id and a name, and keeping them apart means no
# migration of existing cached TLEs and no risk to that table's NOT NULLs.
# Positions are km and velocities km/s, matching the uploaded documents and
# SensorView's display units; the conversion to SensorKit's metres happens at
# the command boundary.
_CREATE_SVS = """
    CREATE TABLE IF NOT EXISTS state_vectors (
        source TEXT NOT NULL,
        norad_id TEXT NOT NULL,
        name TEXT NOT NULL,
        epoch TEXT NOT NULL,
        frame TEXT NOT NULL,
        rx REAL NOT NULL, ry REAL NOT NULL, rz REAL NOT NULL,
        vx REAL NOT NULL, vy REAL NOT NULL, vz REAL NOT NULL,
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
        await self._db.execute(_CREATE_SVS)
        await self._db.commit()
        await self._migrate_source_order()

        # Load seed data if the cache is empty. Seeded rows stand in for the
        # default source until its first real refresh (which replaces them),
        # and deliberately do NOT set last_refresh so staleness checks still
        # see a never-refreshed cache.
        if await self._count_all() == 0:
            await self._load_seed()

    # Source orders that were only ever a shipped default, never a user's
    # choice. An install still sitting on one of these gets the current
    # default; anything else is a deliberate drag-to-reorder and is left alone.
    _SUPERSEDED_DEFAULT_ORDERS = (
        ["spacebook", "spacetrack", "local", "url"],
        ["spacebook", "spacetrack", "local", "url", "localsv"],
    )

    async def _migrate_source_order(self):
        """Adopt a new default priority order, but only for untouched installs."""
        raw = await self.get_meta("source_config")
        if not raw:
            return  # no stored config — get_config already yields the default
        try:
            cfg = json.loads(raw)
        except json.JSONDecodeError:
            return
        order = cfg.get("order")
        if order not in self._SUPERSEDED_DEFAULT_ORDERS:
            return
        cfg["order"] = list(DEFAULT_CONFIG["order"])
        await self.set_meta("source_config", json.dumps(cfg))

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

    async def replace_sv_source(
        self,
        source: str,
        records: list[dict[str, Any]],
        *,
        mark_refreshed: bool = True,
    ) -> int:
        """State-vector counterpart of replace_source. Records come from
        services.sv_parser, which has already validated and classified them."""
        assert self._db
        now = datetime.now(timezone.utc).isoformat()

        await self._db.execute("DELETE FROM state_vectors WHERE source = ?", (source,))
        for sv in records:
            await self._db.execute(
                """
                INSERT INTO state_vectors (
                    source, norad_id, name, epoch, frame,
                    rx, ry, rz, vx, vy, vz, orbit_regime, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source, norad_id) DO UPDATE SET
                    name = excluded.name,
                    epoch = excluded.epoch,
                    frame = excluded.frame,
                    rx = excluded.rx, ry = excluded.ry, rz = excluded.rz,
                    vx = excluded.vx, vy = excluded.vy, vz = excluded.vz,
                    orbit_regime = excluded.orbit_regime,
                    updated_at = excluded.updated_at
                """,
                (
                    source,
                    sv["norad_id"],
                    sv.get("name") or f"SAT {sv['norad_id']}",
                    sv["epoch"],
                    sv["frame"],
                    sv["rx"], sv["ry"], sv["rz"],
                    sv["vx"], sv["vy"], sv["vz"],
                    sv.get("orbit_regime", "OTHER"),
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
        return len(records)

    async def clear_source(self, source: str):
        assert self._db
        await self._db.execute("DELETE FROM tles WHERE source = ?", (source,))
        await self._db.execute("DELETE FROM state_vectors WHERE source = ?", (source,))
        await self._db.execute(
            "DELETE FROM cache_meta WHERE key = ?", (f"last_refresh:{source}",)
        )
        await self._db.commit()

    # === Merged reads =========================================================

    async def _enabled_sources(self, cfg: dict[str, Any] | None = None) -> list[str]:
        cfg = cfg or await self.get_config()
        return [s for s in cfg["order"] if cfg["enabled"].get(s)]

    async def _name_pool(
        self,
        norad_ids: list[str],
        sources: list[str],
        cfg: dict[str, Any],
    ) -> dict[str, str]:
        """Best real name per NORAD id, across every enabled source.

        The priority merge picks one row per object for its *elements*, but the
        winner may carry no name — Spacebook, the shipped default, publishes
        bare 2LE with no line0, so the backend synthesizes "SAT <id>" for all
        31k of its records. Meanwhile a lower-priority source like Space-Track
        may know the object as "MOLNIYA 2-10". Naming and element selection are
        independent choices, so resolve them independently: elements from the
        highest-priority source that has the object, name from the
        highest-priority source that has a *real* one.

        Rows whose name is exactly the synthesized placeholder are excluded, so
        only genuine names enter the pool.
        """
        assert self._db
        if not norad_ids or not sources:
            return {}

        rank = _rank_case(cfg["order"])
        src_placeholders = ",".join("?" for _ in sources)
        pool: dict[str, str] = {}

        # Chunked to stay well under SQLite's bound-parameter ceiling; the
        # catalog ships up to a few thousand rows per call.
        CHUNK = 400
        for start in range(0, len(norad_ids), CHUNK):
            chunk = norad_ids[start : start + CHUNK]
            id_placeholders = ",".join("?" for _ in chunk)
            # Both tables contribute: an uploaded set could carry real names
            # even though the current state-vector documents do not.
            sql = f"""
                SELECT norad_id, name FROM (
                    SELECT norad_id, name, ROW_NUMBER() OVER (
                        PARTITION BY norad_id ORDER BY {rank}
                    ) AS rn
                    FROM (
                        SELECT source, norad_id, name FROM tles
                        WHERE source IN ({src_placeholders})
                          AND norad_id IN ({id_placeholders})
                          AND name <> ('SAT ' || norad_id)
                        UNION ALL
                        SELECT source, norad_id, name FROM state_vectors
                        WHERE source IN ({src_placeholders})
                          AND norad_id IN ({id_placeholders})
                          AND name <> ('SAT ' || norad_id)
                    )
                )
                WHERE rn = 1
            """
            params = [*sources, *chunk, *sources, *chunk]
            async with self._db.execute(sql, params) as cursor:
                async for row in cursor:
                    pool[row["norad_id"]] = row["name"]
        return pool

    async def _apply_name_fallback(
        self,
        records: list[dict[str, Any]],
        sources: list[str],
        cfg: dict[str, Any],
    ) -> None:
        """Fill in placeholder names in place, leaving real ones untouched."""
        needs = [r["noradId"] for r in records if r["name"] == f"SAT {r['noradId']}"]
        if not needs:
            return
        pool = await self._name_pool(needs, sources, cfg)
        for record in records:
            better = pool.get(record["noradId"])
            if better and record["name"] == f"SAT {record['noradId']}":
                record["name"] = better

    @staticmethod
    def _split_by_kind(sources: list[str]) -> tuple[list[str], list[str]]:
        """Partition enabled sources into (TLE-backed, SV-backed)."""
        return (
            [s for s in sources if s not in SV_SOURCE_IDS],
            [s for s in sources if s in SV_SOURCE_IDS],
        )

    async def search(
        self,
        search: str | None = None,
        limit: int = 5000,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Merged catalog across enabled sources.

        TLE and state-vector sources merge independently, so one object can
        return two rows — "TLE · 41838" and "SV · 41838". Within a kind the
        highest-priority source still wins, as before.

        `limit`/`offset` page the TLE portion only; state-vector rows are
        always returned in full. They are hand-uploaded and few, while the TLE
        catalog runs to tens of thousands and every caller caps it (the
        SkyView asks for 2000). Paging the union by norad_id would silently
        drop a just-uploaded SV with a high id — you would upload a file and
        not find it in the list. Making the two sets independent keeps that
        guarantee and keeps paging meaningful, at the cost of returning
        slightly more than `limit` rows when state vectors are loaded.
        """
        assert self._db
        cfg = await self.get_config()
        tle_sources, sv_sources = self._split_by_kind(await self._enabled_sources(cfg))
        if not tle_sources and not sv_sources:
            return []

        pattern = f"%{search}%" if search else None

        def merged(table: str, columns: str, sources: list[str]) -> tuple[str, list[Any]]:
            placeholders = ",".join("?" for _ in sources)
            sql = f"""
                SELECT {columns}
                FROM (
                    SELECT *, ROW_NUMBER() OVER (
                        PARTITION BY norad_id ORDER BY {_rank_case(cfg["order"])}
                    ) AS rn
                    FROM {table} WHERE source IN ({placeholders})
                )
                WHERE rn = 1
            """
            params: list[Any] = [*sources]
            if pattern:
                sql += " AND (norad_id LIKE ? OR name LIKE ?)"
                params += [pattern, pattern]
            # Over-fetch by the offset so the caller's page is reachable after
            # the Python-side slice.
            sql += " ORDER BY norad_id LIMIT ?"
            params.append(limit + offset)
            return sql, params

        # Every state vector, unpaged — see the docstring.
        sv_rows: list[dict[str, Any]] = []
        if sv_sources:
            sql, params = merged(
                "state_vectors",
                "source, norad_id, name, epoch, frame, rx, ry, rz, vx, vy, vz, orbit_regime",
                sv_sources,
            )
            async with self._db.execute(sql, params) as cursor:
                async for row in cursor:
                    sv_rows.append(_sv_record(row))

        tle_rows: list[dict[str, Any]] = []
        if tle_sources:
            sql, params = merged(
                "tles",
                "source, norad_id, name, line1, line2, object_type, orbit_regime",
                tle_sources,
            )
            async with self._db.execute(sql, params) as cursor:
                async for row in cursor:
                    tle_rows.append(_record(row))
            tle_rows = tle_rows[offset : offset + limit]

        # Re-sort the union so an object's TLE row sits adjacent to its SV row.
        results = sv_rows + tle_rows
        results.sort(key=lambda r: (r["noradId"], r["kind"]))
        await self._apply_name_fallback(results, tle_sources + sv_sources, cfg)
        return results

    async def get_by_norad_id(
        self, norad_id: str, kind: str = "tle"
    ) -> dict[str, Any] | None:
        """Highest-priority row for an object of the given element-set kind.

        A NORAD id alone is no longer unique — the same object can hold both a
        TLE and a state vector — so callers say which they want. Defaults to
        "tle", preserving the behaviour of every existing caller.
        """
        assert self._db
        cfg = await self.get_config()
        tle_sources, sv_sources = self._split_by_kind(await self._enabled_sources(cfg))

        if kind == "sv":
            table = "state_vectors"
            columns = "source, norad_id, name, epoch, frame, rx, ry, rz, vx, vy, vz, orbit_regime"
            sources, to_record = sv_sources, _sv_record
        else:
            table = "tles"
            columns = "source, norad_id, name, line1, line2, object_type, orbit_regime"
            sources, to_record = tle_sources, _record

        if not sources:
            return None

        placeholders = ",".join("?" for _ in sources)
        async with self._db.execute(
            f"""
            SELECT {columns}
            FROM {table}
            WHERE norad_id = ? AND source IN ({placeholders})
            ORDER BY {_rank_case(cfg["order"])}
            LIMIT 1
            """,
            (norad_id, *sources),
        ) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            record = to_record(row)
        await self._apply_name_fallback(
            [record], tle_sources + sv_sources, cfg
        )
        return record

    # === Status ===============================================================

    async def get_status(self) -> dict[str, Any]:
        """Merged-catalog status: distinct satellites across enabled sources,
        most recent refresh among them. Shape unchanged from the
        single-source era for existing consumers."""
        assert self._db
        cfg = await self.get_config()
        enabled = await self._enabled_sources(cfg)

        # Counted per kind and summed: an object with both a TLE and an SV is
        # two catalog rows, so it counts twice — matching what the list shows.
        tle_sources, sv_sources = self._split_by_kind(enabled)
        count = 0
        for table, sources in (("tles", tle_sources), ("state_vectors", sv_sources)):
            if not sources:
                continue
            placeholders = ",".join("?" for _ in sources)
            async with self._db.execute(
                f"SELECT COUNT(DISTINCT norad_id) FROM {table} WHERE source IN ({placeholders})",
                sources,
            ) as cursor:
                row = await cursor.fetchone()
                count += row[0] if row else 0

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
        for table in ("tles", "state_vectors"):
            async with self._db.execute(
                f"SELECT source, COUNT(*) AS n FROM {table} GROUP BY source"
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
        "kind": "tle",
        "noradId": row["norad_id"],
        "name": row["name"],
        "line1": row["line1"],
        "line2": row["line2"],
        "objectType": row["object_type"],
        "orbitRegime": row["orbit_regime"],
        "source": row["source"],
    }


def _sv_record(row: aiosqlite.Row) -> dict[str, Any]:
    """State-vector row in the same envelope as _record, so the catalog is one
    list. Position km, velocity km/s; `epoch` is what the UI ages for staleness."""
    return {
        "kind": "sv",
        "noradId": row["norad_id"],
        "name": row["name"],
        "epoch": row["epoch"],
        "frame": row["frame"],
        "r": {"x": row["rx"], "y": row["ry"], "z": row["rz"]},
        "v": {"x": row["vx"], "y": row["vy"], "z": row["vz"]},
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
