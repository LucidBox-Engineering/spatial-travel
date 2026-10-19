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
| Train | Rail/metro stations from OpenStreetMap (Overpass) + a station-to-station speed model (walk or feeder bus to a station, wait, ride, walk to the destination) |

Road times are sampled on a 24 × 9 polar grid and used to correct a heuristic model on the 128 × 56 render mesh. Train times are **estimates**: there is no free, keyless timetable API, so the model knows where stations are but not which lines connect them.

Basemap tiles: OpenStreetMap standard tiles (© OpenStreetMap contributors), no API key. Geocoding: Nominatim. None of the services used need an API key.

## How it works

- `js/warp.js` – polar mesh around the destination and the two warps (with times made monotone along each ray so the mesh never folds).
- `js/renderer.js` – WebGL2: the stitched tile image is a texture on the mesh; vertex positions morph between geographic, distance and size layouts; the fragment shader draws the time tint, contours and the budget line.
- `js/basemap.js` – stitches tiles into one texture.
- `js/travel.js` – travel-time providers and models.
- `js/main.js` – UI.

No build step. Run locally with any static server, e.g. `npx http-server .`. Deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

When changing JS/CSS, bump the `?v=` query in `index.html` and the `import` lines in `js/` so browsers pick up the new files.
