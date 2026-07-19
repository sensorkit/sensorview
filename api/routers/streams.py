"""Stream registration endpoints — proxy SensorView's stream CRUD into the
local MediaMTX control API.

SensorView's frontend POSTs a (stream_id, url, protocol) tuple here when a
URL-kind stream is added or first rendered; we translate that into a
MediaMTX path config and return the local HLS URL the renderer should play.

MediaMTX's `sourceOnDemand` mode keeps the upstream RTSP connection idle
until an HLS client actually requests the stream, so registered-but-not-
playing paths cost effectively nothing.
"""
from __future__ import annotations

import logging
from typing import AsyncIterator
from urllib.parse import quote, urlparse, urlunparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter()

# MediaMTX is spawned on the same machine; the control API is a server-to-
# server call and always lives on loopback. The HLS/WebRTC ports, by contrast,
# are what the *client* connects to, so the URLs we return are built from the
# host the client used to reach us (see `_client_mtx_base`) rather than hard-
# coding loopback: local Electron reaches the sidecar on 127.0.0.1 and so still
# gets 127.0.0.1, while a browser arriving via a LAN IP / reverse proxy gets
# that host and can actually load the stream off-box.
MTX_CONTROL_BASE = "http://127.0.0.1:9997"
MTX_HLS_PORT = 8888
MTX_WEBRTC_PORT = 8889

# Path config defaults applied to every URL-kind stream we register.
ON_DEMAND_DEFAULTS = {
    "sourceOnDemand": True,
    "sourceOnDemandStartTimeout": "10s",
    "sourceOnDemandCloseAfter": "10s",
}


class UrlStreamPayload(BaseModel):
    """Frontend payload describing one URL-kind stream to register."""
    id: str = Field(..., description="SensorView stream id; used as the MediaMTX path name.")
    url: str = Field(..., description="Upstream URL (rtsp://, http://*.m3u8, etc.).")
    protocol: str = Field(..., description="rtsp | hls | mjpeg | webrtc")
    username: str | None = Field(None, description="Optional Basic-auth username.")
    password: str | None = Field(None, description="Optional Basic-auth password.")


class UrlStreamResponse(BaseModel):
    """What the frontend needs to play the stream locally."""
    id: str
    hls_url: str
    whep_url: str


class StreamStatus(BaseModel):
    state: str
    error: str | None = None


def _client_mtx_base(request: Request, port: int) -> str:
    """Base URL for a client-facing MediaMTX port, on the host the client used.

    `request.url.hostname` is the Host the caller reached the sidecar on, so
    local Electron (127.0.0.1) yields 127.0.0.1 exactly as before; a LAN or
    proxied client gets its own host instead of an unreachable loopback.
    """
    host = request.url.hostname or "127.0.0.1"
    return f"http://{host}:{port}"


def _hls_url_for(stream_id: str, request: Request) -> str:
    return f"{_client_mtx_base(request, MTX_HLS_PORT)}/{stream_id}/index.m3u8"


def _whep_url_for(stream_id: str, request: Request) -> str:
    return f"{_client_mtx_base(request, MTX_WEBRTC_PORT)}/{stream_id}/whep"


def _embed_credentials(url: str, username: str | None, password: str | None) -> str:
    """Return *url* with Basic-auth credentials embedded into its netloc.

    No-op when *username* is empty. Pre-existing credentials in the URL are
    overwritten — last-write-wins semantics; the dedicated form fields are
    treated as authoritative over inline creds the user might have pasted
    into the URL bar.
    """
    if not username:
        return url
    parsed = urlparse(url)
    creds = quote(username, safe="")
    if password:
        creds += ":" + quote(password, safe="")
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    netloc = f"{creds}@{host}" if host else creds
    return urlunparse(parsed._replace(netloc=netloc))


@router.post("/url", response_model=UrlStreamResponse)
async def register_url_stream(payload: UrlStreamPayload, request: Request):
    """Register or replace a path in MediaMTX for a URL-kind stream.

    Idempotent: calling with the same id repeatedly just overwrites the path
    config (used on every tile mount so MediaMTX's view stays in sync with
    what SensorView thinks it has).
    """
    if payload.protocol not in ("rtsp", "hls", "webrtc"):
        # MJPEG plays directly via <img> in the renderer; no MediaMTX path needed.
        raise HTTPException(
            400,
            f"protocol {payload.protocol!r} is not proxied through MediaMTX",
        )

    source_url = _embed_credentials(payload.url, payload.username, payload.password)
    path_config = {"source": source_url, **ON_DEMAND_DEFAULTS}

    async with httpx.AsyncClient(timeout=5.0) as client:
        # `replace` creates if absent or overwrites if present — exactly what
        # we want for idempotent registration.
        url = f"{MTX_CONTROL_BASE}/v3/config/paths/replace/{payload.id}"
        try:
            resp = await client.post(url, json=path_config)
        except httpx.RequestError as e:
            logger.exception("MediaMTX unreachable")
            raise HTTPException(502, f"MediaMTX unreachable: {e}") from e
        if resp.status_code not in (200, 201):
            logger.error("MediaMTX rejected path config: %s %s", resp.status_code, resp.text)
            raise HTTPException(
                502,
                f"MediaMTX rejected path config (HTTP {resp.status_code}): {resp.text}",
            )

    return UrlStreamResponse(
        id=payload.id,
        hls_url=_hls_url_for(payload.id, request),
        whep_url=_whep_url_for(payload.id, request),
    )


@router.delete("/url/{stream_id}")
async def unregister_url_stream(stream_id: str):
    """Remove a path from MediaMTX. Best-effort — 404 from MediaMTX is OK."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        url = f"{MTX_CONTROL_BASE}/v3/config/paths/delete/{stream_id}"
        try:
            resp = await client.delete(url)
        except httpx.RequestError as e:
            logger.exception("MediaMTX unreachable")
            raise HTTPException(502, f"MediaMTX unreachable: {e}") from e
    if resp.status_code not in (200, 404):
        logger.error("MediaMTX delete failed: %s %s", resp.status_code, resp.text)
        raise HTTPException(
            502,
            f"MediaMTX delete failed (HTTP {resp.status_code}): {resp.text}",
        )
    return {"ok": True}


@router.get("/url/{stream_id}/status", response_model=StreamStatus)
async def get_stream_status(stream_id: str):
    """Live state of a registered path: ready (upstream connected) or not."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        url = f"{MTX_CONTROL_BASE}/v3/paths/get/{stream_id}"
        try:
            resp = await client.get(url)
        except httpx.RequestError as e:
            return StreamStatus(state="error", error=str(e))
    if resp.status_code == 404:
        return StreamStatus(state="offline")
    if resp.status_code != 200:
        return StreamStatus(state="error", error=f"HTTP {resp.status_code}")
    data = resp.json()
    ready = bool(data.get("ready"))
    return StreamStatus(state="live" if ready else "offline")


# ---------- MJPEG proxy ----------------------------------------------------
#
# MJPEG cameras commonly use HTTP Digest auth (notably AXIS), which the
# browser's <img src> element can't speak — embedded user:pass@ in the URL
# only does Basic. Rather than asking users to weaken their cameras' auth,
# we proxy the multipart/x-mixed-replace stream through the sidecar with
# whatever auth scheme the upstream wants. The renderer points <img src>
# at our local proxy URL; auth stays server-side.

class MjpegRegisterPayload(BaseModel):
    """Frontend payload describing one MJPEG source to proxy."""
    id: str = Field(..., description="SensorView stream id; used as the proxy path key.")
    url: str = Field(..., description="Upstream MJPEG URL (http://host/path/video.cgi).")
    username: str | None = Field(None, description="Optional auth username.")
    password: str | None = Field(None, description="Optional auth password.")


class MjpegRegisterResponse(BaseModel):
    """Local URL the renderer should set as its <img src>."""
    id: str
    proxy_url: str


# In-memory registry. Cleared on sidecar restart; renderer is responsible
# for re-registering on tile mount, mirroring how RTSP registration works.
_mjpeg_registry: dict[str, MjpegRegisterPayload] = {}


@router.post("/mjpeg", response_model=MjpegRegisterResponse)
async def register_mjpeg_stream(payload: MjpegRegisterPayload):
    """Idempotently register an MJPEG source for sidecar proxying."""
    _mjpeg_registry[payload.id] = payload
    return MjpegRegisterResponse(
        id=payload.id,
        proxy_url=f"/api/streams/mjpeg/{quote(payload.id, safe='')}/stream",
    )


@router.delete("/mjpeg/{stream_id}")
async def unregister_mjpeg_stream(stream_id: str):
    """Drop a registered MJPEG entry. Best-effort; missing id returns ok."""
    _mjpeg_registry.pop(stream_id, None)
    return {"ok": True}


async def _probe_auth(
    url: str, username: str, password: str
) -> httpx.Auth:
    """Probe the upstream's WWW-Authenticate header to pick the right scheme.

    Modern IP cameras commonly want Digest; older firmware (e.g. AXIS 214
    PTZ from 2005) wants Basic; some accept either. httpx's auth classes
    each speak only one scheme, so we look at the challenge before picking.

    Falls back to Basic on probe failure — older gear is the more likely
    home of probe-resistant configs, and Basic is what they typically
    expect.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # `client.stream` opens the connection and reads headers without
            # pulling the body — exits via context manager before any video
            # bytes flow.
            async with client.stream("GET", url) as resp:
                if resp.status_code != 401:
                    return httpx.BasicAuth(username, password)
                challenge = resp.headers.get("www-authenticate", "").strip().lower()
                if challenge.startswith("digest"):
                    return httpx.DigestAuth(username, password)
                return httpx.BasicAuth(username, password)
    except httpx.RequestError:
        return httpx.BasicAuth(username, password)


@router.get("/mjpeg/{stream_id}/stream")
async def proxy_mjpeg_stream(stream_id: str):
    """Open an authenticated request to the upstream camera and forward its
    multipart/x-mixed-replace response to the renderer untouched.

    Lifecycle: the AsyncClient and upstream Response are kept alive for the
    duration of the streaming response and torn down when the body generator
    finishes (renderer disconnects, source unmounts, error).
    """
    entry = _mjpeg_registry.get(stream_id)
    if entry is None:
        raise HTTPException(404, f"mjpeg stream {stream_id!r} not registered")

    auth: httpx.Auth | None = None
    if entry.username:
        auth = await _probe_auth(entry.url, entry.username, entry.password or "")

    # No timeout — MJPEG is a long-lived response and the browser will close
    # the connection when the tile unmounts.
    client = httpx.AsyncClient(auth=auth, timeout=None)

    try:
        request = client.build_request("GET", entry.url)
        upstream = await client.send(request, stream=True)
    except httpx.RequestError as e:
        await client.aclose()
        raise HTTPException(502, f"upstream unreachable: {e}") from e

    if upstream.status_code != 200:
        status = upstream.status_code
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(502, f"upstream returned HTTP {status}")

    # Forward the upstream's content-type so the browser sees the right
    # multipart boundary string (varies per camera firmware).
    content_type = upstream.headers.get(
        "content-type", "multipart/x-mixed-replace"
    )

    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(body(), media_type=content_type)
