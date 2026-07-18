"""Space-Track.org client — authenticated GP catalog fetch.

Space-Track requires a (free) account and sets a session cookie on login, so
we POST credentials to /ajaxauth/login and issue the catalog GET on the same
httpx client. Bad credentials can come back as HTTP 200 with a small JSON
error body ('{"Login":"Failed"}'), so we sniff for that in addition to
401/403 statuses.

Catalog query: current GP elements for objects still on orbit
(decay_date/null-val) with an epoch in the last 30 days, in 3LE format so
satellite names ride along.
"""
from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger(__name__)

BASE_URL = os.environ.get("SPACETRACK_URL", "https://www.space-track.org")
LOGIN_PATH = "/ajaxauth/login"
CATALOG_PATH = (
    "/basicspacedata/query/class/gp/decay_date/null-val/"
    "epoch/%3Enow-30/orderby/norad_cat_id/format/3le"
)
LOGIN_TIMEOUT = 30.0
# Full catalog is ~5 MB of 3LE for ~30k objects; Space-Track can be slow.
CATALOG_TIMEOUT = 300.0


class SpaceTrackError(Exception):
    """Space-Track unreachable or returned an unexpected response."""


class SpaceTrackAuthError(SpaceTrackError):
    """Space-Track rejected the credentials."""


def _looks_like_login_failure(text: str) -> bool:
    head = text[:200]
    return '"Login"' in head and "Failed" in head


class SpaceTrackClient:
    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or BASE_URL).rstrip("/")

    async def _login(self, client: httpx.AsyncClient, identity: str, password: str) -> None:
        try:
            resp = await client.post(
                self.base_url + LOGIN_PATH,
                data={"identity": identity, "password": password},
            )
        except httpx.RequestError as e:
            raise SpaceTrackError(f"Space-Track unreachable: {e}") from e
        if resp.status_code in (401, 403) or _looks_like_login_failure(resp.text):
            raise SpaceTrackAuthError("Space-Track rejected the username or password")
        if resp.status_code != 200:
            raise SpaceTrackError(f"Space-Track login returned HTTP {resp.status_code}")

    async def verify_login(self, identity: str, password: str) -> None:
        """Log in and discard the session — used to validate credentials."""
        async with httpx.AsyncClient(timeout=LOGIN_TIMEOUT) as client:
            await self._login(client, identity, password)

    async def fetch_catalog(self, identity: str, password: str) -> str:
        """Return the current GP catalog as raw 3LE text."""
        async with httpx.AsyncClient(
            timeout=CATALOG_TIMEOUT, follow_redirects=True
        ) as client:
            await self._login(client, identity, password)
            try:
                resp = await client.get(self.base_url + CATALOG_PATH)
            except httpx.RequestError as e:
                raise SpaceTrackError(f"Space-Track unreachable: {e}") from e
            if resp.status_code != 200:
                raise SpaceTrackError(f"Space-Track query returned HTTP {resp.status_code}")
            if _looks_like_login_failure(resp.text):
                raise SpaceTrackAuthError("Space-Track session expired mid-query")
            logger.info("Fetched %d bytes of 3LE from Space-Track", len(resp.text))
            return resp.text
