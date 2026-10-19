# Time Warp Map

A static web app that warps a map around a destination according to travel time.

1. Pick a destination (search or click the map).
2. Pick a mode: walk, drive or train.
3. Pick an acceptable travel time (5 min – 12 h; longer budgets cover inter-city trips).
4. Choose a view:
   - **Time = distance** – every place is moved along its bearing so its distance from the destination is proportional to its travel time. Rings are exact isochrones.
   - **Time = size** – places reachable quickly are magnified (up to 3×), places beyond the budget shrink (down to ⅓× at twice the budget).
   - **Geographic** – the normal map, shaded by travel time.

Hover for the travel time at any point; scroll to zoom, drag to pan, double-click to reset. The URL hash (`#lat,lng,mode,minutes,view`) is shareable.

## Data

| Mode  | Source |
|-------|--------|
| Walk  | OSRM foot profile (routing.openstreetmap.de), falling back to Valhalla, then a heuristic |
| Drive | OSRM car profile (routing.openstreetmap.de / router.project-osrm.org), falling back to Valhalla, then a heuristic |
| Train | **Experimental (this branch):** Transitous (api.transitous.org) `one-to-all` with `arriveBy=true`, rail + tram modes, arriving 09:00 next weekday — real GTFS timetables give every stop's time to the destination; falls back to the OSM model below. **OSM model:** Rail, metro and light-rail **lines** from OpenStreetMap route relations (Overpass). Stops within 300 m merge into interchange stations; a reverse Dijkstra from the destination over (line, stop) and station nodes charges ride time by line type, dwell per stop, half-headway waits and a 3 min transfer. Walking legs to/from stations use real OSRM foot routes: a crow-fly first pass picks the vertices inside (or near) the budget envelope and the stations they could plausibly use; those pairs are sampled into ≤40 batched table requests, and unsampled pairs use the nearest sample's detour ratio. Falls back to a station-location-only model where no line data exists |

Road times are sampled on a 24 × 9 polar grid and used to correct a heuristic model on the 128 × 56 render mesh. Train times are **estimates**: lines and connectivity are real, but speeds and frequencies are guessed per line type (or taken from the OSM `interval` tag) since there is no free, keyless timetable API.

Basemap tiles: OpenStreetMap standard tiles (© OpenStreetMap contributors), no API key. Geocoding: Nominatim. None of the services used need an API key.

## How it works

- `js/warp.js` – polar mesh around the destination and the two warps (with times made monotone along each ray so the mesh never folds).
- `js/renderer.js` – WebGL2: the stitched tile image is a texture on the mesh; vertex positions morph between geographic, distance and size layouts; the fragment shader draws the time tint, contours and the budget line.
- `js/basemap.js` – stitches tiles into one texture.
- `js/travel.js` – travel-time providers and models.
- `js/transit.js` – OSM rail-line network and Dijkstra routing for train mode; Overpass failover across public instances.
- `js/cache.js` – memory + IndexedDB cache (7-day expiry) for rail data and routing responses.
- `js/main.js` – UI.

No build step. Run locally with any static server, e.g. `npx http-server .`. Deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

When changing JS/CSS, bump the `?v=` query in `index.html` and the `import` lines in `js/` so browsers pick up the new files.
