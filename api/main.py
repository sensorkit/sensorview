"""SensorView supplemental API — TLE caching, image thumbnails, UI support data.

Runs as a standalone uvicorn app in dev (`uv run uvicorn api.main:app`) or as
a PyInstaller-bundled sidecar spawned by the Tauri shell. Accepts `--port`
and `--host` so the host can assign a free port at runtime.
"""

import argparse
import logging
import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# When frozen by PyInstaller the working directory is not the repo root, so we
# make sure the bundled `routers` package is importable.
if getattr(sys, "frozen", False):
    sys.path.insert(0, os.path.dirname(sys.executable))

from routers import tle, images, streams, horizons, sk_proxy  # noqa: E402

logger = logging.getLogger("sensorview.api")

app = FastAPI(
    title="SensorView API",
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

class _ScopedCORSMiddleware(CORSMiddleware):
    """Wildcard CORS for /api only — NOT for /sk.

    /api is called cross-origin by the desktop app (renderer origin ≠ sidecar)
    and the dev server, so it needs permissive CORS. The /sk proxy is the
    opposite: it is only ever called SAME-origin (by the SPA this sidecar
    itself serves) and it streams live SensorKit telemetry and forwards
    hardware-control calls — so it must not carry Access-Control-Allow-Origin,
    or any web page the operator visits could read the firehose and drive the
    hardware cross-origin.
    """

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope.get("type") == "http" and (path == "/sk" or path.startswith("/sk/")):
            await self.app(scope, receive, send)
            return
        await super().__call__(scope, receive, send)


app.add_middleware(
    _ScopedCORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tle.router, prefix="/api/tle", tags=["TLE"])
app.include_router(images.router, prefix="/api/images", tags=["Images"])
app.include_router(streams.router, prefix="/api/streams", tags=["Streams"])
app.include_router(horizons.router, prefix="/api/horizons", tags=["Horizons"])
# Forward /sk/* to the SensorKit web API — only used when a browser is served
# the app from this sidecar (LAN/remote). Registered before the SPA mount so it
# isn't swallowed by the catch-all static handler.
app.include_router(sk_proxy.router, prefix="/sk", tags=["SensorKit proxy"])


@app.get("/api/health")
async def health():
    return {"status": "ok"}


def _mount_spa(application: FastAPI) -> None:
    """Serve the built SPA (dist/) so a browser can load SensorView from the
    sidecar itself — the piece that lets a phone reach it over the network.

    Mounted at "/" LAST, so it only handles paths the /api and /sk routers
    didn't. Guarded on the directory existing: the packaged desktop app loads
    its UI from disk (file://) and ships no co-located dist/, so this is simply
    skipped there — the mount, like the /sk proxy, is dormant on desktop.
    """
    dist_dir = os.environ.get("SV_API_DIST_DIR") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "dist"
    )
    if os.path.isdir(dist_dir):
        application.mount("/", StaticFiles(directory=dist_dir, html=True), name="spa")
        logger.info("Serving SPA from %s", dist_dir)
    else:
        logger.info("No dist/ at %s — SPA serving disabled (desktop/file:// mode)", dist_dir)


_mount_spa(app)


def main() -> None:
    parser = argparse.ArgumentParser(description="SensorView API")
    parser.add_argument("--host", default=os.environ.get("SV_API_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("SV_API_PORT", "8001")),
    )
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("SV_API_CACHE_DIR"),
        help="Writable directory for the TLE SQLite cache. "
        "Overrides TLE_CACHE_DB if set.",
    )
    args = parser.parse_args()

    if args.cache_dir:
        os.environ["TLE_CACHE_DB"] = os.path.join(args.cache_dir, "tle_cache.db")

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
