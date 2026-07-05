# SensorView

Web UI for [SensorKit](../../gitlab/sensorkit) — a real-time sky atlas with satellite overlay, built with React, D3, and satellite.js.

## Architecture

```
┌──────────────────────────┐       ┌────────────────────────┐
│  Vite React App (:5173)  │──────▶│  SensorView API (:8001)│
│  SkyView canvas, stores  │ /api  │  FastAPI sidecar        │
│  satellite propagation   │  proxy│  TLE cache (SQLite)     │
└──────────────────────────┘       └────────────────────────┘
         │                                    │
         │ WebSocket (stub)                   │ HTTP
         ▼                                    ▼
  ┌──────────────┐                   ┌──────────────────┐
  │  SensorKit   │                   │  Spacebook API   │
  │  (live HW)   │                   │  (TLE source)    │
  └──────────────┘                   └──────────────────┘
```

The **Vite dev server** proxies `/api/*` requests to the sidecar API on port 8001 (configured in `vite.config.ts`). The SensorKit client (`src/lib/sensorkit-client/`) is currently stubbed — the UI runs in demo mode with mock pointing data.

## Prerequisites

- **Node.js** >= 18 and **npm**
- **Python** >= 3.11 and [**uv**](https://docs.astral.sh/uv/) (for the API)

## Running the sidecar API

The API provides TLE caching (backed by SQLite) and image thumbnail endpoints. It ships with seed TLE data so it works offline out of the box.

```bash
cd api

# Create a virtual environment and install dependencies
uv venv
source .venv/bin/activate
uv pip install -e .

# Start the API server
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

The API serves:
- `GET  /api/health` — health check
- `GET  /api/tle/catalog` — cached TLE catalog (supports `?search=`, `?limit=`, `?offset=`)
- `GET  /api/tle/satellite/{norad_id}` — single satellite TLE
- `POST /api/tle/refresh` — pull fresh TLEs from Spacebook
- `GET  /api/tle/status` — cache stats (count, age, last refresh)
- `GET  /api/images/thumbnail/{image_id}` — image thumbnails (not yet implemented)
- `GET  /api/docs` — interactive Swagger docs

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `TLE_CACHE_DB` | `api/tle_cache.db` | Path to the SQLite cache file |
| `SPACEBOOK_URL` | `https://spacebook.com/api/entity/tle` | Spacebook TLE endpoint |
| `SPACEBOOK_TIMEOUT` | `60` | Spacebook request timeout (seconds) |

## Running the UI

```bash
# Install dependencies
npm install

# Start the dev server (proxies /api to localhost:8001)
npm run dev
```

Open http://localhost:5173. The UI will work without the API running — satellite data just won't load.

### Build for production

```bash
npm run build    # outputs to dist/
npm run preview  # preview the production build locally
```

## Project structure

```
api/                        Python sidecar API
  main.py                     FastAPI app entry point
  routers/                    Route handlers (tle, images)
  services/                   Business logic (tle_cache, spacebook)
  data/seed_tles.txt          Seed TLE data for offline use
src/
  features/skyview/           Main sky atlas feature
    SkyView.tsx                 Canvas-based sky atlas component
    layers/                     Rendering layers (stars, constellations, satellites, etc.)
    hooks/                      React hooks (projection, satellite propagation, interaction)
    catalog/                    Static star/constellation data
    workers/                    Web Worker for satellite propagation
    ui/                         UI panels and overlays
  lib/
    sensorkit-client/           SensorKit HTTP + WebSocket client (stubbed)
    api-client/                 Sidecar API client (TLE fetching)
  stores/                     Zustand state stores
```

## Current status

This is early-stage. The SkyView atlas renders stars, constellations, and propagated satellite positions on a stereographic projection. The SensorKit integration is stubbed with mock pointing data — it will connect to live hardware once the SensorKit web API stabilizes.
