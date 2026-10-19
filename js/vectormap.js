// prettymapp-style basemaps: OpenStreetMap vector tiles (OpenFreeMap,
// OpenMapTiles schema) drawn with flat poster palettes into the same square
// texture the warp uses. Drawing happens once per destination, so the warp
// and animation cost exactly what they do with raster tiles.
//
// Palettes are inspired by prettymapp (https://github.com/chrieke/prettymapp):
// pastel background, flat water and greenery, dark streets by class width and
// buildings in a small random-but-stable colour palette.

import Pbf from '../vendor/pbf/index.js';
import { VectorTile } from '../vendor/vector-tile/index.js';
import { cached, DAY } from './cache.js?v=27';

export const THEMES = {
  peach: {
    name: 'Peach',
    bg: '#F2F4CB', water: '#A8E1E6', green: '#8BB174', farm: '#E8EBB8', sand: '#F2E3BC',
    streets: '#2F3737', rail: '#2F3737', buildings: ['#FFC857', '#E9724C', '#C5283D'], edge: '#2F3737',
  },
  citrus: {
    name: 'Citrus',
    bg: '#F7F3E3', water: '#93C5C6', green: '#9BC53D', farm: '#EFEBD0', sand: '#F3E1B0',
    streets: '#3D3B30', rail: '#3D3B30', buildings: ['#F9C80E', '#F86624', '#EA3546'], edge: '#3D3B30',
  },
  flannel: {
    name: 'Flannel',
    bg: '#EFE8DF', water: '#9DB4C0', green: '#A3B18A', farm: '#E6DED2', sand: '#E9DCC5',
    streets: '#283D3B', rail: '#283D3B', buildings: ['#C44536', '#772E25', '#197278', '#283D3B'], edge: '#283D3B',
  },
  auburn: {
    name: 'Auburn',
    bg: '#F4E9D8', water: '#7FA7B5', green: '#B5B682', farm: '#EDE1CC', sand: '#EBD9B4',
    streets: '#540B0E', rail: '#540B0E', buildings: ['#9E2A2B', '#E09F3E', '#335C67', '#540B0E'], edge: '#540B0E',
  },
};

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const MAX_DATA_ZOOM = 14;

// Street widths in pixels at zoom 15 (scaled by 2^(z-15) for the texture).
const ROAD_WIDTH = {
  motorway: 5, trunk: 5, primary: 4.5, secondary: 4, tertiary: 3.5,
  minor: 2.6, service: 1.6, track: 1, path: 0.8, raceway: 1, busway: 2, bus_guideway: 1.5,
};
const ROAD_ORDER = ['path', 'track', 'service', 'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
const GREEN = new Set(['grass', 'wood', 'forest', 'park', 'meadow', 'scrub', 'wetland', 'garden', 'golf_course', 'pitch', 'cemetery', 'playground', 'recreation_ground', 'nature_reserve', 'national_park', 'village_green', 'allotments']);
const SAND = new Set(['sand', 'beach', 'bare_rock', 'scree']);
const FARM = new Set(['farmland', 'farm', 'orchard', 'vineyard']);

async function tileUrlTemplate(signal) {
  return cached('tilejson:openfreemap', DAY, async () => {
    const res = await fetch(TILEJSON, { signal });
    if (!res.ok) throw new Error(`TileJSON HTTP ${res.status}`);
    const json = await res.json();
    return json.tiles?.[0] || null;
  });
}

// Stable pseudo-random colour index per building (same across tile copies).
function hashIndex(feature, x0, y0, n) {
  let h = Number.isFinite(feature.id) ? feature.id : Math.round(x0 * 7.3 + y0 * 13.1);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) % n;
}

export function buildVectorBasemap(layout, theme, onProgress, signal) {
  const { size, z, ox, oy, uv } = layout;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, size, size);

  // Vector tiles are designed for 512px display, so one zoom below the
  // texture zoom gives native detail (and 4x fewer requests). Above the
  // data's max zoom, overzoom.
  const zd = Math.max(0, Math.min(MAX_DATA_ZOOM, z - 1));
  const S = 256 * Math.pow(2, z - zd); // texture px per vector tile
  const n = Math.pow(2, zd);
  const tiles = [];
  for (let ty = Math.floor(oy / S); ty <= Math.floor((oy + size) / S); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(ox / S); tx <= Math.floor((ox + size) / S); tx++) {
      tiles.push({ tx, ty, d: Math.hypot((tx + 0.5) * S - (ox + size / 2), (ty + 0.5) * S - (oy + size / 2)) });
    }
  }
  tiles.sort((a, b) => a.d - b.d);
  const widthScale = Math.pow(2, z - 15) * 1.15;
  const lw = (base) => Math.max(0.35, base * widthScale);

  const done = (async () => {
    let template;
    try {
      template = await tileUrlTemplate(signal);
    } catch (err) {
      console.warn('OpenFreeMap TileJSON failed:', err);
    }
    if (!template) return { loaded: 0, total: tiles.length, source: 'OpenFreeMap (unavailable)' };

    // Each tile is turned into cached Path2D groups as soon as it arrives;
    // the canvas is then redrawn from all groups in global layer order. That
    // lets the map appear progressively (centre first) instead of waiting
    // for every tile.
    const parts = [];
    const build = (t, vt) => {
      const p = { cover: new Map(), water: new Path2D(), waterways: new Map(), roads: new Map(), rail: null, buildings: theme.buildings.map(() => new Path2D()) };
      const each = (layerName, fn) => {
        const layer = vt.layers[layerName];
        if (!layer) return;
        const k = S / layer.extent;
        const dx = t.tx * S - ox;
        const dy = t.ty * S - oy;
        for (let i = 0; i < layer.length; i++) fn(layer.feature(i), k, dx, dy);
      };
      const add = (path, geom, k, dx, dy, close) => {
        for (const ring of geom) {
          for (let j = 0; j < ring.length; j++) {
            const x = ring[j].x * k + dx;
            const y = ring[j].y * k + dy;
            if (j) path.lineTo(x, y);
            else path.moveTo(x, y);
          }
          if (close) path.closePath();
        }
      };
      const group = (map, key) => {
        if (!map.has(key)) map.set(key, new Path2D());
        return map.get(key);
      };
      for (const name of ['landcover', 'landuse', 'park']) {
        each(name, (f, k, dx, dy) => {
          if (f.type !== 3) return;
          const pr = f.properties || {};
          const c = pr.class || pr.subclass;
          const colour = GREEN.has(c) || GREEN.has(pr.subclass) ? theme.green : SAND.has(c) ? theme.sand : FARM.has(c) ? theme.farm : c === 'ice' || c === 'glacier' ? '#FFFFFF' : null;
          if (colour) add(group(p.cover, colour), f.loadGeometry(), k, dx, dy, true);
        });
      }
      each('water', (f, k, dx, dy) => f.type === 3 && add(p.water, f.loadGeometry(), k, dx, dy, true));
      each('waterway', (f, k, dx, dy) => {
        if (f.type !== 2) return;
        const w = { river: 2.4, canal: 1.8, stream: 0.8, drain: 0.5, ditch: 0.5 }[f.properties?.class] || 0.6;
        add(group(p.waterways, w), f.loadGeometry(), k, dx, dy, false);
      });
      each('transportation', (f, k, dx, dy) => {
        if (f.type !== 2) return;
        const pr = f.properties || {};
        if (pr.class === 'rail') {
          p.rail ||= new Path2D();
          add(p.rail, f.loadGeometry(), k, dx, dy, false);
          return;
        }
        const cls = pr.class?.replace(/_construction$/, '');
        if (ROAD_WIDTH[cls]) add(group(p.roads, `${cls}|${pr.brunnel === 'tunnel' ? 't' : ''}`), f.loadGeometry(), k, dx, dy, false);
      });
      each('building', (f, k, dx, dy) => {
        if (f.type !== 3) return;
        const geom = f.loadGeometry();
        const p0 = geom[0]?.[0];
        if (!p0) return;
        add(p.buildings[hashIndex(f, p0.x * k + dx + ox, p0.y * k + dy + oy, p.buildings.length)], geom, k, dx, dy, true);
      });
      return p;
    };

    const drawAll = () => {
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, size, size);
      for (const p of parts) for (const [colour, path] of p.cover) (ctx.fillStyle = colour), ctx.fill(path);
      ctx.fillStyle = theme.water;
      for (const p of parts) ctx.fill(p.water);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = theme.water;
      for (const p of parts) for (const [w, path] of p.waterways) (ctx.lineWidth = lw(w)), ctx.stroke(path);
      const keys = new Set();
      for (const p of parts) for (const key of p.roads.keys()) keys.add(key);
      const order = [...keys].sort((a, b) => ROAD_ORDER.indexOf(a.split('|')[0]) - ROAD_ORDER.indexOf(b.split('|')[0]));
      ctx.strokeStyle = theme.streets;
      for (const key of order) {
        const [cls, tunnel] = key.split('|');
        ctx.globalAlpha = tunnel ? 0.35 : 1;
        ctx.lineWidth = lw(ROAD_WIDTH[cls]);
        for (const p of parts) if (p.roads.has(key)) ctx.stroke(p.roads.get(key));
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.rail;
      ctx.lineWidth = lw(1.2);
      ctx.setLineDash([lw(3), lw(2)]);
      for (const p of parts) if (p.rail) ctx.stroke(p.rail);
      ctx.setLineDash([]);
      theme.buildings.forEach((c, i) => {
        ctx.fillStyle = c;
        for (const p of parts) ctx.fill(p.buildings[i]);
      });
      if (z >= 16) {
        ctx.strokeStyle = theme.edge;
        ctx.lineWidth = 0.5;
        ctx.globalAlpha = 0.6;
        for (const p of parts) p.buildings.forEach((b) => ctx.stroke(b));
        ctx.globalAlpha = 1;
      }
    };

    let finished = 0;
    let lastDraw = 0;
    let drawMs = 0;
    const queue = tiles.slice();
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (queue.length && !signal?.aborted) {
          const t = queue.shift();
          const wx = ((t.tx % n) + n) % n;
          const url = template.replace('{z}', zd).replace('{x}', wx).replace('{y}', t.ty);
          try {
            const res = await fetch(url, { signal });
            if (res.ok) parts.push(build(t, new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())))));
          } catch (err) {
            if (signal?.aborted) return;
          }
          finished++;
          // Redraw at most every 300 ms (and after the first tile) so the
          // map fills in from the centre while the rest download.
          const now = performance.now();
          if (finished === 1 || now - lastDraw > 300) {
            drawAll();
            drawMs = performance.now() - now;
            lastDraw = performance.now();
          }
          onProgress?.(finished, tiles.length);
        }
      }),
    );
    if (signal?.aborted) return { loaded: 0, total: tiles.length, source: 'OpenFreeMap' };
    const t0 = performance.now();
    drawAll();
    console.info(`Vector basemap: ${parts.length} tiles (z${zd}); full redraw ${Math.round(performance.now() - t0)} ms (last progressive ${Math.round(drawMs)} ms)`);
    onProgress?.(finished, tiles.length);
    return { loaded: parts.length, total: tiles.length, source: `OpenFreeMap · ${theme.name} style` };
  })();

  return { canvas, size, z, tileSize: 256, ox, oy, uv, done, attribution: () => 'OpenFreeMap' };
}
