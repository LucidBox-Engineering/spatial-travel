// Stitches raster map tiles around the destination into one square canvas
// that the WebGL renderer uses as a texture.

import { worldPx, EARTH_CIRC } from './geo.js?v=34';
import { buildVectorBasemap, THEMES } from './vectormap.js?v=34';

// OpenStreetMap's standard tiles: free, no API key, CORS-enabled. To stay
// within the OSM tile usage policy we fetch a modest number of 256px tiles
// (about one screenful) per destination.
const SOURCES = [
  {
    name: 'OpenStreetMap',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    maxZoom: 19,
  },
];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('tile failed: ' + src));
    img.src = src;
  });
}

// Returns { canvas, size, z, tileSize, ox, oy, uv(lat,lng), done: Promise }.
// `onProgress` is called (throttled by the caller) as tiles arrive.
// Square texture layout around `center` covering +-radius: Web Mercator zoom
// z with 256px tiles, origin (ox, oy) in world pixels, and lat/lng -> uv.
export function textureLayout(center, radius, maxTex) {
  const size = Math.min(2048, maxTex);
  const tileSize = 256;
  const lat = center.lat;
  // pixels per metre at zoom z for this tile size
  const ppm = (z) => (tileSize * Math.pow(2, z)) / (EARTH_CIRC * Math.cos((lat * Math.PI) / 180));
  let z = Math.floor(Math.log2(size / (2 * radius * ppm(0))));
  z = Math.max(1, Math.min(SOURCES[0].maxZoom, z));
  const [cx, cy] = worldPx(center.lat, center.lng, z, tileSize);
  const ox = cx - size / 2;
  const oy = cy - size / 2;
  const uv = (la, ln) => {
    const [wx, wy] = worldPx(la, ln, z, tileSize);
    return [(wx - ox) / size, (wy - oy) / size];
  };
  return { size, tileSize, z, cx, cy, ox, oy, uv };
}

// Layout for a sharper re-render of part of a base layout: `rect` is
// [u0, v0, u1, v1] in the base texture's uv (square), drawn into a texture
// of the same size at a higher zoom.
export function detailLayout(base, rect) {
  const span = rect[2] - rect[0];
  // floor: the detail texture must cover at least the requested span
  const k = Math.max(1, Math.min(6, Math.floor(Math.log2(1 / span))));
  const z = Math.min(19, base.z + k);
  const scale = Math.pow(2, z - base.z);
  const covered = 1 / scale; // base-uv span actually covered after rounding k
  const u0 = (rect[0] + rect[2]) / 2 - covered / 2;
  const v0 = (rect[1] + rect[3]) / 2 - covered / 2;
  const ox = (base.ox + u0 * base.size) * scale;
  const oy = (base.oy + v0 * base.size) * scale;
  return {
    size: base.size, tileSize: 256, z, ox, oy, cx: ox + base.size / 2, cy: oy + base.size / 2,
    rect: [u0, v0, u0 + covered, v0 + covered],
    uv: null,
  };
}

export function buildBasemap(center, radius, maxTex, onProgress, signal, theme = 'osm', layoutOverride = null) {
  const layout = layoutOverride || textureLayout(center, radius, maxTex);
  if (theme !== 'osm') return buildVectorBasemap(layout, THEMES[theme] || THEMES.peach, onProgress, signal);
  const { size, tileSize, z, cx, cy, ox, oy, uv } = layout;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e9e6df';
  ctx.fillRect(0, 0, size, size);

  const n = Math.pow(2, z);
  const tiles = [];
  for (let ty = Math.floor(oy / tileSize); ty <= Math.floor((oy + size) / tileSize); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(ox / tileSize); tx <= Math.floor((ox + size) / tileSize); tx++) {
      tiles.push({ tx, ty, d: Math.hypot(tx * tileSize + tileSize / 2 - cx, ty * tileSize + tileSize / 2 - cy) });
    }
  }
  tiles.sort((a, b) => a.d - b.d); // centre first

  let sourceIdx = 0;
  let failures = 0;
  let loaded = 0;
  const drawPlaceholder = (dx, dy) => {
    ctx.fillStyle = '#e4e1da';
    ctx.fillRect(dx, dy, tileSize, tileSize);
    ctx.strokeStyle = '#d3cfc6';
    ctx.strokeRect(dx + 0.5, dy + 0.5, tileSize - 1, tileSize - 1);
  };

  async function loadTile(t) {
    const wx = ((t.tx % n) + n) % n;
    const dx = t.tx * tileSize - ox;
    const dy = t.ty * tileSize - oy;
    for (let s = sourceIdx; s < SOURCES.length; s++) {
      const src = SOURCES[s];
      try {
        const img = await loadImage(src.url(z, wx, t.ty));
        if (signal?.aborted) return;
        ctx.drawImage(img, dx, dy, tileSize, tileSize);
        loaded++;
        return;
      } catch {
        if (s === sourceIdx && ++failures > 6 && loaded === 0) sourceIdx = Math.min(SOURCES.length - 1, s + 1);
      }
    }
    drawPlaceholder(dx, dy);
  }

  const done = (async () => {
    const queue = tiles.slice();
    let finished = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length && !signal?.aborted) {
        await loadTile(queue.shift());
        onProgress?.(++finished, tiles.length);
      }
    });
    await Promise.all(workers);
    return { loaded, total: tiles.length, source: SOURCES[sourceIdx].name };
  })();

  return { canvas, size, z, tileSize, ox, oy, uv, done, attribution: () => SOURCES[sourceIdx].name };
}
