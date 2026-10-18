// Stitches raster map tiles around the destination into one square canvas
// that the WebGL renderer uses as a texture.

import { worldPx, EARTH_CIRC } from './geo.js';

const SOURCES = [
  {
    name: 'CARTO Voyager',
    url: (z, x, y, retina) =>
      `https://${'abcd'[(x + y) % 4]}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}${retina ? '@2x' : ''}.png`,
    retina: true,
    maxZoom: 19,
  },
  {
    name: 'OpenStreetMap',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    retina: false,
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
export function buildBasemap(center, radius, maxTex, onProgress, signal) {
  const size = Math.min(4096, maxTex);
  const tileSize = size >= 4096 ? 512 : 256;
  const lat = center.lat;
  // pixels per metre at zoom z for this tile size
  const ppm = (z) => (tileSize * Math.pow(2, z)) / (EARTH_CIRC * Math.cos((lat * Math.PI) / 180));
  let z = Math.floor(Math.log2(size / (2 * radius * ppm(0))));
  z = Math.max(1, Math.min(SOURCES[0].maxZoom, z));

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e9e6df';
  ctx.fillRect(0, 0, size, size);

  const [cx, cy] = worldPx(center.lat, center.lng, z, tileSize);
  const ox = cx - size / 2;
  const oy = cy - size / 2;
  const n = Math.pow(2, z);
  const tiles = [];
  for (let ty = Math.floor(oy / tileSize); ty <= Math.floor((oy + size) / tileSize); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(ox / tileSize); tx <= Math.floor((ox + size) / tileSize); tx++) {
      tiles.push({ tx, ty, d: Math.hypot(tx * tileSize + tileSize / 2 - cx, ty * tileSize + tileSize / 2 - cy) });
    }
  }
  tiles.sort((a, b) => a.d - b.d); // centre first

  const uv = (la, ln) => {
    const [wx, wy] = worldPx(la, ln, z, tileSize);
    return [(wx - ox) / size, (wy - oy) / size];
  };

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
      // 256px sources at retina layout: fetch one zoom deeper would be
      // ideal, but simply upscaling keeps tile counts low for a fallback.
      try {
        const img = await loadImage(src.url(z, wx, t.ty, tileSize === 512 && src.retina));
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
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length && !signal?.aborted) {
        await loadTile(queue.shift());
        onProgress?.();
      }
    });
    await Promise.all(workers);
    return { loaded, total: tiles.length, source: SOURCES[sourceIdx].name };
  })();

  return { canvas, size, z, tileSize, ox, oy, uv, done, attribution: () => SOURCES[sourceIdx].name };
}
