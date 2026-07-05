"""SensorView supplemental API — TLE caching, image thumbnails, UI support data.

Runs as a standalone uvicorn app in dev (`uv run uvicorn api.main:app`) or as
a PyInstaller-bundled sidecar spawned by the Tauri shell. Accepts `--port`
and `--host` so the host can assign a free port at runtime.
"""

import argparse
import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# When frozen by PyInstaller the working directory is not the repo root, so we
# make sure the bundled `routers` package is importable.
if getattr(sys, "frozen", False):
    sys.path.insert(0, os.path.dirname(sys.executable))

from routers import tle, images, streams, horizons  # noqa: E402

app = FastAPI(
    title="SensorView API",
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tle.router, prefix="/api/tle", tags=["TLE"])
app.include_router(images.router, prefix="/api/images", tags=["Images"])
app.include_router(streams.router, prefix="/api/streams", tags=["Streams"])
app.include_router(horizons.router, prefix="/api/horizons", tags=["Horizons"])


@app.get("/api/health")
async def health():
    return {"status": "ok"}


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
