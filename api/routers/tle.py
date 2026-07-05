"""TLE endpoints — fetch, search, cache management."""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from services.tle_cache import TLECacheService
from services.spacebook import SpacebookClient

logger = logging.getLogger(__name__)

router = APIRouter()

_cache = TLECacheService()
_spacebook = SpacebookClient()

STALE_HOURS = 12


@router.on_event("startup")
async def startup():
    await _cache.initialize()
    # Auto-refresh in background if cache is seed-only or stale
    asyncio.create_task(_auto_refresh())


async def _auto_refresh():
    """Refresh from Spacebook if cache has never been refreshed or is stale."""
    try:
        status = await _cache.get_status()
        if status["lastRefresh"] is not None and (status["cacheAgeHours"] or 0) < STALE_HOURS:
            return
        logger.info("Auto-refreshing TLE cache from Spacebook (age=%s)", status["cacheAgeHours"])
        tles, code = await _spacebook.fetch_all_tles()
        if code == 200 and tles:
            count = await _cache.bulk_upsert(tles)
            logger.info("Auto-refresh complete: %d TLEs loaded", count)
        else:
            logger.warning("Auto-refresh failed: Spacebook returned %d", code)
    except Exception:
        logger.exception("Auto-refresh failed")


@router.get("/catalog")
async def get_catalog(
    search: Optional[str] = Query(None, description="Search by name or NORAD ID"),
    limit: int = Query(5000, ge=1, le=50000),
    offset: int = Query(0, ge=0),
):
    """Return cached TLE catalog, optionally filtered by search term."""
    records = await _cache.search(search=search, limit=limit, offset=offset)
    return records


@router.get("/satellite/{norad_id}")
async def get_satellite(norad_id: str):
    """Return TLE for a specific satellite by NORAD ID."""
    record = await _cache.get_by_norad_id(norad_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Satellite {norad_id} not found")
    return record


@router.post("/refresh")
async def refresh_cache():
    """Trigger a cache refresh from Spacebook."""
    try:
        tles, status_code = await _spacebook.fetch_all_tles()
        if status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Spacebook returned {status_code}",
            )
        count = await _cache.bulk_upsert(tles)
        return {"count": count, "source": "spacebook"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
async def cache_status():
    """Return cache metadata: count, age, last refresh."""
    return await _cache.get_status()
