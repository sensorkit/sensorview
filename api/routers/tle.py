"""TLE endpoints — multi-source fetch, priority merge, cache management.

Sources: spacebook (no auth), spacetrack (stored credentials), local
(uploaded .tle/.3le file), url (user-supplied endpoint, 2LE or 3LE
auto-detected). The catalog endpoints serve the merged view; per-source
management lives under /sources.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services.spacebook import SpacebookClient
from services.spacetrack import SpaceTrackAuthError, SpaceTrackClient, SpaceTrackError
from services.tle_cache import SOURCE_IDS, TLECacheService
from services.sv_parser import StateVectorParseError, parse_sv_text
from services.tle_parser import parse_tle_text

logger = logging.getLogger(__name__)

router = APIRouter()

_cache = TLECacheService()
_spacebook = SpacebookClient()
_spacetrack = SpaceTrackClient()

STALE_HOURS = 12
# Sources that can be re-fetched on demand ('local'/'localsv' only change on
# upload).
REMOTE_SOURCES = ("spacebook", "spacetrack", "url")
URL_FETCH_TIMEOUT = 120.0


class RefreshError(Exception):
    """A source refresh failed for a reason worth showing the user."""


class SourceConfigPatch(BaseModel):
    order: Optional[list[str]] = None
    enabled: Optional[dict[str, bool]] = None


class SpaceTrackCreds(BaseModel):
    username: str
    password: str


class LocalUpload(BaseModel):
    filename: str
    content: str


class CustomUrlBody(BaseModel):
    url: str


@router.on_event("startup")
async def startup():
    await _cache.initialize()
    # Auto-refresh stale enabled sources in the background
    asyncio.create_task(_auto_refresh())


async def _auto_refresh():
    """Refresh enabled remote sources that have never been fetched or are stale."""
    try:
        rows, cfg = await _cache.get_sources_status()
        for row in rows:
            source = row["id"]
            if source not in REMOTE_SOURCES or not row["enabled"]:
                continue
            if source == "spacetrack" and not await _cache.get_meta("spacetrack_identity"):
                continue
            if source == "url" and not cfg["customUrl"]:
                continue
            if row["lastRefresh"] is not None and (row["cacheAgeHours"] or 0) < STALE_HOURS:
                continue
            logger.info("Auto-refreshing TLE source %s (age=%s)", source, row["cacheAgeHours"])
            try:
                count = await _refresh_source(source)
                logger.info("Auto-refresh of %s complete: %d TLEs loaded", source, count)
            except Exception as e:
                logger.warning("Auto-refresh of %s failed: %s", source, e)
    except Exception:
        logger.exception("Auto-refresh failed")


async def _refresh_source(source: str) -> int:
    """Re-fetch one remote source and replace its cached rows."""
    if source == "spacebook":
        tles, status_code = await _spacebook.fetch_all_tles()
        if status_code != 200:
            raise RefreshError(f"Spacebook returned {status_code}")
        return await _cache.replace_source("spacebook", tles)

    if source == "spacetrack":
        identity = await _cache.get_meta("spacetrack_identity")
        password = await _cache.get_meta("spacetrack_password")
        if not identity or not password:
            raise RefreshError("Not signed in to Space-Track")
        text = await _spacetrack.fetch_catalog(identity, password)
        records, _fmt = parse_tle_text(text)
        if not records:
            raise RefreshError("Space-Track returned no TLEs")
        return await _cache.replace_source("spacetrack", records)

    if source == "url":
        cfg = await _cache.get_config()
        if not cfg["customUrl"]:
            raise RefreshError("No custom URL configured")
        return await _fetch_custom_url(cfg["customUrl"])

    raise RefreshError(f"Source '{source}' cannot be refreshed")


async def _fetch_custom_url(url: str) -> int:
    try:
        async with httpx.AsyncClient(
            timeout=URL_FETCH_TIMEOUT, follow_redirects=True
        ) as client:
            resp = await client.get(url)
    except httpx.RequestError as e:
        raise RefreshError(f"URL unreachable: {e}") from e
    if resp.status_code != 200:
        raise RefreshError(f"URL returned HTTP {resp.status_code}")

    records, fmt = parse_tle_text(resp.text)
    if not records:
        raise RefreshError("No TLEs found at URL — expected 2LE or 3LE text")
    count = await _cache.replace_source("url", records)
    await _cache.set_meta("url_meta", json.dumps({"format": fmt}))
    return count


async def _sources_response() -> dict[str, Any]:
    rows, cfg = await _cache.get_sources_status()
    username = await _cache.get_meta("spacetrack_identity")
    local_meta = json.loads(await _cache.get_meta("local_meta") or "{}")
    localsv_meta = json.loads(await _cache.get_meta("localsv_meta") or "{}")
    url_meta = json.loads(await _cache.get_meta("url_meta") or "{}")
    for row in rows:
        if row["id"] == "spacetrack":
            row["username"] = username
        elif row["id"] == "local":
            row["filename"] = local_meta.get("filename")
            row["format"] = local_meta.get("format")
        elif row["id"] == "localsv":
            row["filename"] = localsv_meta.get("filename")
            row["format"] = localsv_meta.get("format")
            # Oldest epoch in the uploaded set — the UI ages this to warn that
            # a state vector has drifted too far to trust.
            row["oldestEpoch"] = localsv_meta.get("oldestEpoch")
        elif row["id"] == "url":
            row["url"] = cfg["customUrl"] or None
            row["format"] = url_meta.get("format")
    return {"sources": rows}


# === Source management ========================================================


@router.get("/sources")
async def get_sources():
    """Per-source status in priority order."""
    return await _sources_response()


@router.put("/sources/config")
async def update_sources_config(patch: SourceConfigPatch):
    """Update priority order and/or enabled flags."""
    bad = [s for s in (patch.order or []) if s not in SOURCE_IDS]
    bad += [s for s in (patch.enabled or {}) if s not in SOURCE_IDS]
    if bad:
        raise HTTPException(status_code=422, detail=f"Unknown source ids: {bad}")
    await _cache.set_config(patch.model_dump(exclude_none=True))
    return await _sources_response()


@router.post("/sources/spacetrack/login")
async def spacetrack_login(creds: SpaceTrackCreds):
    """Validate Space-Track credentials, store them, and enable the source."""
    try:
        await _spacetrack.verify_login(creds.username, creds.password)
    except SpaceTrackAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except SpaceTrackError as e:
        raise HTTPException(status_code=502, detail=str(e))
    await _cache.set_meta("spacetrack_identity", creds.username)
    await _cache.set_meta("spacetrack_password", creds.password)
    await _cache.set_config({"enabled": {"spacetrack": True}})
    return await _sources_response()


@router.delete("/sources/spacetrack/login")
async def spacetrack_logout():
    """Clear stored Space-Track credentials and drop that source's TLEs."""
    await _cache.delete_meta("spacetrack_identity")
    await _cache.delete_meta("spacetrack_password")
    await _cache.clear_source("spacetrack")
    return await _sources_response()


@router.post("/sources/local")
async def upload_local_file(body: LocalUpload):
    """Parse an uploaded .tle/.3le file and replace the local source's rows."""
    records, fmt = parse_tle_text(body.content)
    if not records:
        raise HTTPException(
            status_code=422,
            detail="No TLEs found in file — expected 2LE or 3LE format",
        )
    count = await _cache.replace_source("local", records)
    await _cache.set_meta("local_meta", json.dumps({"filename": body.filename, "format": fmt}))
    await _cache.set_config({"enabled": {"local": True}})
    return {"count": count, "format": fmt, **await _sources_response()}


@router.post("/sources/local-sv")
async def upload_local_sv_file(body: LocalUpload):
    """Parse an uploaded .sv document and replace the local-SV source's rows."""
    try:
        records = parse_sv_text(body.content)
    except StateVectorParseError as err:
        # The parser's messages name the offending field and entry, so they go
        # straight to the upload dialog rather than a generic failure.
        raise HTTPException(status_code=422, detail=str(err)) from err

    count = await _cache.replace_sv_source("localsv", records)
    await _cache.set_meta(
        "localsv_meta",
        json.dumps({
            "filename": body.filename,
            "format": "sv",
            "oldestEpoch": min(r["epoch"] for r in records),
        }),
    )
    await _cache.set_config({"enabled": {"localsv": True}})
    return {"count": count, "format": "sv", **await _sources_response()}


@router.post("/sources/url/fetch")
async def fetch_custom_url(body: CustomUrlBody):
    """Store the custom URL, fetch it, and enable the source on success."""
    url = body.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="URL must start with http:// or https://")
    await _cache.set_config({"customUrl": url})
    try:
        count = await _fetch_custom_url(url)
    except RefreshError as e:
        raise HTTPException(status_code=502, detail=str(e))
    await _cache.set_config({"enabled": {"url": True}})
    return {"count": count, **await _sources_response()}


# === Merged catalog ===========================================================


@router.get("/catalog")
async def get_catalog(
    search: Optional[str] = Query(None, description="Search by name or NORAD ID"),
    limit: int = Query(5000, ge=1, le=50000),
    offset: int = Query(0, ge=0),
):
    """Return the merged TLE catalog, optionally filtered by search term."""
    records = await _cache.search(search=search, limit=limit, offset=offset)
    return records


@router.get("/satellite/{norad_id}")
async def get_satellite(
    norad_id: str,
    kind: str = Query("tle", description='Element-set kind: "tle" or "sv"'),
):
    """Return the highest-priority element set for a satellite by NORAD ID.

    A NORAD id can carry both a TLE and a state vector, so `kind` selects
    between them; it defaults to "tle" for callers that predate SV support.
    """
    if kind not in ("tle", "sv"):
        raise HTTPException(status_code=422, detail=f'Unknown kind "{kind}"')
    record = await _cache.get_by_norad_id(norad_id, kind)
    if record is None:
        raise HTTPException(
            status_code=404, detail=f"No {kind.upper()} for satellite {norad_id}"
        )
    return record


@router.post("/refresh")
async def refresh_cache(
    source: Optional[str] = Query(None, description="Refresh just this source"),
):
    """Re-fetch remote sources — one if given, else every enabled, configured one."""
    rows, cfg = await _cache.get_sources_status()
    if source:
        if source not in REMOTE_SOURCES:
            raise HTTPException(
                status_code=422,
                detail=f"Source must be one of {', '.join(REMOTE_SOURCES)}",
            )
        targets = [source]
    else:
        targets = []
        for row in rows:
            s = row["id"]
            if s not in REMOTE_SOURCES or not row["enabled"]:
                continue
            if s == "spacetrack" and not await _cache.get_meta("spacetrack_identity"):
                continue
            if s == "url" and not cfg["customUrl"]:
                continue
            targets.append(s)

    results: dict[str, Any] = {}
    for s in targets:
        try:
            results[s] = {"count": await _refresh_source(s)}
        except (RefreshError, SpaceTrackError) as e:
            results[s] = {"error": str(e)}
        except Exception as e:
            logger.exception("Refresh of %s failed", s)
            results[s] = {"error": str(e)}

    status = await _cache.get_status()
    return {"count": status["count"], "results": results}


@router.get("/status")
async def cache_status():
    """Return merged cache metadata: count, age, last refresh."""
    return await _cache.get_status()
