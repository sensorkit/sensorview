"""Reverse-proxy ``/sk/*`` to the SensorKit web API.

Only exercised when SensorView is *served to a browser from this sidecar* (the
LAN / remote case). The frontend's ``skUrl()`` falls back to a same-origin
``/sk`` prefix when no explicit SensorKit base URL is set, so the sidecar
forwards those calls — REST and the long-lived ``/data/subscribe`` SSE
firehose — to the real SensorKit host. The desktop app sets a full SensorKit
base URL and talks to it directly, so this proxy is dormant there.

Kept deliberately dumb: one fixed upstream (``SV_SK_BASE``), streamed straight
through so SSE events arrive as they happen with no server-side buffering.
"""
from __future__ import annotations

import logging
import os
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger("sensorview.api.sk_proxy")

router = APIRouter()

# Where SensorKit's web API lives. Same host as the sidecar in the target
# deployment (both on PC1), hence loopback by default; override for split hosts.
SK_BASE = os.environ.get("SV_SK_BASE", "http://127.0.0.1:8000").rstrip("/")

# Connect promptly, but never time out reads — the firehose stays open for the
# life of the session.
_TIMEOUT = httpx.Timeout(None, connect=10.0)

# Hop-by-hop headers (RFC 7230 §6.1) must not be forwarded. We also drop
# accept-encoding on the way up (so the upstream sends plain bytes we can stream
# verbatim) and content-length/content-type/content-encoding on the way back
# (StreamingResponse sets its own; content-type rides `media_type`).
_STRIP_REQUEST = {
    "host", "content-length", "connection", "keep-alive", "transfer-encoding",
    "upgrade", "te", "trailer", "accept-encoding",
}
_STRIP_RESPONSE = {
    "content-length", "content-type", "content-encoding", "transfer-encoding",
    "connection", "keep-alive", "upgrade", "te", "trailer",
}


@router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def proxy_sk(path: str, request: Request) -> StreamingResponse:
    """Forward one request to SensorKit and stream the response back verbatim."""
    url = f"{SK_BASE}/{path}"
    if request.url.query:
        # Forward the raw query string so repeated keys survive — QueryParams
        # would collapse duplicates to the last value.
        url = f"{url}?{request.url.query}"
    headers = {
        k: v for k, v in request.headers.items() if k.lower() not in _STRIP_REQUEST
    }
    # Stream the request body straight through — never buffer a whole upload in
    # RAM. Only for methods that actually carry one; a bodyless GET/HEAD gets
    # content=None so httpx doesn't switch it to chunked transfer-encoding.
    has_body = "content-length" in request.headers or "transfer-encoding" in request.headers
    content = request.stream() if has_body else None

    client = httpx.AsyncClient(timeout=_TIMEOUT)
    try:
        upstream_req = client.build_request(
            request.method, url, headers=headers, content=content
        )
        upstream = await client.send(upstream_req, stream=True)
    except httpx.RequestError as e:
        await client.aclose()
        logger.warning("SensorKit unreachable at %s: %s", url, e)
        return StreamingResponse(
            iter([f"SensorKit unreachable: {e}".encode()]),
            status_code=502,
            media_type="text/plain",
        )
    except BaseException:
        # Client disconnect / cancellation before we hand the response to
        # StreamingResponse — close the client so the connection doesn't leak.
        await client.aclose()
        raise

    # Strip hop-by-hop/length headers AND any CORS headers SensorKit set on its
    # own response: /sk is same-origin, so it must carry no Access-Control-* —
    # otherwise upstream's wildcard CORS would leak straight through the proxy
    # and re-open the cross-origin hole we closed at the middleware.
    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in _STRIP_RESPONSE and not k.lower().startswith("access-control-")
    }
    content_type = upstream.headers.get("content-type")
    # Tell any proxy in front (Tailscale Serve, nginx, MACHINA) not to buffer
    # the event stream, so telemetry updates aren't delivered in laggy bursts.
    if content_type and content_type.startswith("text/event-stream"):
        resp_headers["X-Accel-Buffering"] = "no"
        resp_headers["Cache-Control"] = "no-cache"

    async def body_iter() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        body_iter(),
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=content_type,
    )
