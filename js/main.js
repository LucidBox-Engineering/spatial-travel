import { MODES, extentFor, computeTimes, heuristicTimes, fetchJson, UNREACHABLE } from './travel.js?v=33';
import { createMesh, computeWarps, blendPositions, locate, forward, sampleTime } from './warp.js?v=33';
import { buildBasemap, detailLayout } from './basemap.js?v=33';
import { THEMES } from './vectormap.js?v=33';
import { WarpRenderer, LIMIT_SLACK } from './renderer.js?v=33';
import { fromLocal, worldPx } from './geo.js?v=33';

const $ = (sel) => document.querySelector(sel);

const VIEWS = {
  geo: { strength: 0, blend: 0 },
  distance: { strength: 1, blend: 0 },
  size: { strength: 1, blend: 1 },
};

const state = {
  dest: null,
  destName: '',
  mode: 'drive',
  budget: 30,
  view: 'distance',
  theme: 'peach', // 'osm' or a key of THEMES (vectormap.js)
  maxWalk: 15, // train mode: longest walk to / from a station, minutes
  picking: true,
};

let data = null; // { key, mesh, basemap, times, source, stations, bucket }
let warps = null;
let loadToken = 0;
let abortCtrl = null;
let userView = null; // manual pan/zoom override { cx, cy, scale }

// ---------------------------------------------------------------------------
// Leaflet picker map

const map = L.map('pickmap', { zoomControl: true, zoomSnap: 0.25 }).setView([43.6532, -79.3832], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
let marker = null;
let reachCircle = null;

map.on('click', (e) => setDestination({ lat: e.latlng.lat, lng: e.latlng.lng }, null));

// ---------------------------------------------------------------------------
// Renderer

let renderer;
try {
  renderer = new WarpRenderer($('#warp-gl'), $('#warp-overlay'));
} catch (err) {
  $('#warp-error').textContent = `Sorry — ${err.message}`;
  $('#warp-error').hidden = false;
}

renderer &&
  (renderer.overlayDraw = (ctx, r) => {
    if (!data?.ready || !warps) return;
    const pos = currentPositions();
    if (data.stations) drawStations(ctx, r, pos);
  });

function drawStations(ctx, r, pos) {
  {
    const proj = new Map();
    const project = (s) => {
      if (!proj.has(s)) {
        const p = forward(data.mesh, pos, s.x, s.y);
        proj.set(s, p && r.toScreen(p[0], p[1]));
      }
      return proj.get(s);
    };
    ctx.save();
    ctx.globalAlpha = 0.85;
    data.stations.forEach((s, i) => {
      const q = project(s);
      if (!q) return;
      const [sx, sy] = q;
      if (sx < -10 || sy < -10 || sx > r.width + 10 || sy > r.height + 10) return;
      ctx.beginPath();
      ctx.arc(sx, sy, s.lines > 1 ? 3.6 : s.metro ? 2.6 : 3.2, 0, Math.PI * 2);
      // Stations outside the budget are greyed like the map around them.
      ctx.fillStyle = data.stationIn && !data.stationIn[i] ? '#9a9a9a' : s.metro ? '#2457c5' : '#1f2a37';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    });
    ctx.restore();
  }
}

// The inside/outside threshold used everywhere (see LIMIT_SLACK).
const limit = () => state.budget + LIMIT_SLACK;

let posCache = null;
function currentPositions() {
  const s = renderer.state;
  const key = `${s.strength}|${s.blend}`;
  if (!posCache || posCache.key !== key || posCache.warps !== warps) {
    posCache = { key, warps, pos: blendPositions(warps, s.strength, s.blend) };
  }
  return posCache.pos;
}

// ---------------------------------------------------------------------------
// Animation

const anim = { tweens: [], dirty: true };

function tween(obj, key, to, ms = 900) {
  anim.tweens = anim.tweens.filter((t) => !(t.obj === obj && t.key === key));
  anim.tweens.push({ obj, key, from: obj[key], to, start: performance.now(), ms });
  anim.dirty = true;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function frame(now) {
  if (anim.tweens.length) {
    anim.tweens = anim.tweens.filter((t) => {
      const u = Math.min(1, (now - t.start) / t.ms);
      t.obj[t.key] = t.from + (t.to - t.from) * ease(u);
      return u < 1;
    });
    anim.dirty = true;
  }
  if (renderer?.state.loading && warps) anim.dirty = true;
  if (renderer) watchViewForDetail(now);
  if (anim.dirty && renderer) {
    fitView();
    renderer.render();
    anim.dirty = false;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function fitView() {
  if (!warps) return;
  const s = renderer.state;
  if (userView) {
    Object.assign(s, userView);
    return;
  }
  // Fit the area reachable within ~1.4x the budget (plus the destination).
  const pos = currentPositions();
  const times = renderer._lastTimes || data.times;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (let v = 0; v < data.mesh.count; v++) {
    if (times[v] > state.budget * 1.4) continue;
    const x = pos[2 * v];
    const y = pos[2 * v + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const min = warps.reachMedian * 0.6;
  minX = Math.min(minX, -min);
  maxX = Math.max(maxX, min);
  minY = Math.min(minY, -min);
  maxY = Math.max(maxY, min);
  s.cx = (minX + maxX) / 2;
  s.cy = (minY + maxY) / 2;
  s.scale = Math.min((renderer.width - 24) / (maxX - minX), (renderer.height - 24) / (maxY - minY));
}

// ---------------------------------------------------------------------------
// Data pipeline

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.dataset.kind = kind;
  loading.times = kind === 'busy' ? text : null;
  updateLoader();
}

// Loading indicator: a pill with spinner + message over the map, and
// ripples expanding from the destination (drawn by the renderer).
const loading = { times: null, tiles: null, error: null };

function updateLoader() {
  if (loading.times) loading.error = null; // a new load is under way
  const msg = loading.error || loading.times || loading.tiles;
  const el = $('#loader');
  el.classList.toggle('show', !!msg);
  el.classList.toggle('error', !!loading.error);
  $('#loader-retry').hidden = !loading.error;
  if (msg) $('#loader-text').textContent = msg.replace(/…\s*\d+%$/, '…');
  const pct = loading.error ? null : loading.times ? /(\d+)%$/.exec(loading.times)?.[1] : loading.tilesPct;
  $('#loader-bar').style.width = pct != null ? `${Math.max(4, pct)}%` : '';
  el.classList.toggle('indeterminate', pct == null && !loading.error);
  if (renderer) renderer.state.loading = !!loading.times;
  anim.dirty = true;
}

async function setDestination(dest, name) {
  state.dest = dest;
  state.destName = name || `${dest.lat.toFixed(4)}, ${dest.lng.toFixed(4)}`;
  $('#dest-name').textContent = state.destName;
  if (!name) reverseGeocode(dest);
  if (marker) marker.setLatLng(dest);
  else marker = L.marker(dest).addTo(map);
  userView = null;
  data = null;
  if (renderer) {
    // start each new destination from the plain map, then morph
    anim.tweens = [];
    renderer.state.strength = 0;
    renderer.state.blend = VIEWS[state.view].blend;
  }
  showWarp(true);
  await reload();
}

async function reverseGeocode(dest) {
  try {
    // Rounded so repeat visits hit the cache; throttled + cached via fetchJson.
    const j = await fetchJson(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${dest.lat.toFixed(5)}&lon=${dest.lng.toFixed(5)}`,
    );
    if (state.dest === dest && j.display_name) {
      state.destName = j.display_name.split(',').slice(0, 3).join(',');
      $('#dest-name').textContent = state.destName;
    }
  } catch {
    /* name stays as coordinates */
  }
}

function dataKey() {
  const { bucket } = extentFor(state.mode, state.budget);
  return `${state.dest.lat.toFixed(5)},${state.dest.lng.toFixed(5)}|${state.mode}|${bucket}${state.mode === 'train' ? `|w${state.maxWalk}` : ''}`;
}

const basemapCache = new Map();

function getBasemap(dest, radius) {
  const key = `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}|${Math.round(radius)}|${state.theme}`;
  if (basemapCache.has(key)) return basemapCache.get(key);
  let pending = false;
  const bm = buildBasemap(dest, radius, renderer.maxTex, (done, total) => {
    if (data?.basemap === bm || !data) {
      loading.tiles = done < total ? 'Loading map…' : null;
      loading.tilesPct = done < total ? Math.round((100 * done) / total) : null;
      updateLoader();
    }
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (data?.basemap === bm) {
        uploadBase(bm);
        anim.dirty = true;
      }
    }, 250);
  }, undefined, state.theme);
  bm.done.then((info) => {
    if (data?.basemap === bm) {
      uploadBase(bm);
      anim.dirty = true;
    }
    $('#tiles-src').textContent = info.loaded ? info.source + (state.theme === 'osm' ? '' : ' · © OpenMapTiles') : 'unavailable (offline)';
    if (data?.basemap === bm) {
      loading.tiles = null;
      loading.tilesPct = null;
      updateLoader();
    }
  });
  basemapCache.clear(); // keep memory bounded: only the latest
  basemapCache.set(key, bm);
  return bm;
}

async function reload() {
  if (!state.dest || !renderer) return;
  const key = dataKey();
  if (data?.key === key) {
    rewarp();
    return;
  }
  const token = ++loadToken;
  abortCtrl?.abort();
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;
  writeHash();

  const { radius, bucket } = extentFor(state.mode, state.budget);
  // Reuse the mesh's extent for walk/drive/train only when identical.
  const mesh = createMesh(radius);
  const basemap = getBasemap(state.dest, radius);
  const uvs = new Float32Array(mesh.count * 2);
  for (let v = 0; v < mesh.count; v++) {
    const ll = fromLocal(state.dest, mesh.x[v], mesh.y[v]);
    const [u, w] = basemap.uv(ll.lat, ll.lng);
    uvs[2 * v] = u;
    uvs[2 * v + 1] = w;
  }
  const times = heuristicTimes(state.mode, mesh);
  data = { key, mesh, basemap, uvs, times, source: 'Loading…', stations: null, lines: null, bucket };
  renderer.setMesh(mesh, uvs);
  renderer.setTimeField(null);
  clearDetail();
  uploadBase(basemap);
  renderer.setTimes(times);
  renderer._lastTimes = times;
  warps = computeWarps(mesh, times, state.budget);
  renderer.setWarps(warps);
  // Until real travel times arrive, show the plain map (no warp, no time
  // shading); the loader indicates progress.
  data.ready = false;
  tween(renderer.state, 'strength', 0, 500);
  tween(renderer.state, 'shade', 0, 300);
  renderLineLegend(null);
  setStatus('Calculating travel times…', 'busy');
  updateSourceLine();
  anim.dirty = true;

  try {
    const res = await computeTimes(state.dest, state.mode, mesh, signal, (msg) => {
      if (token === loadToken) setStatus(msg, 'busy');
    }, bucket, { maxWalk: state.maxWalk });
    if (token !== loadToken) return;
    if (res.failed) {
      showFailure(`${res.source}. Try again in a moment.`);
      return;
    }
    data.times = res.times;
    data.source = res.source;
    // Let the map finish drawing before warping it (up to 4 s), so the
    // basemap is in place first rather than filling in mid-animation.
    const myData = data;
    await Promise.race([data.basemap.done, new Promise((r) => setTimeout(r, 4000))]);
    if (token !== loadToken || data !== myData) return;
    data.stations = res.stations || null;
    data.lines = res.lines || null;
    data.field = res.field || null;
    refreshLineTextures();
    renderLineLegend(res.legend || null);
    showResult(res.times);
    const est = /estimate/i.test(res.source);
    setStatus(est ? 'Using estimated travel times.' : 'Travel times loaded.', est ? 'warn' : 'ok');
    updateSourceLine();
  } catch (err) {
    if (signal.aborted) return;
    console.error(err);
    showFailure('Could not load travel times.');
  }
}

// Data servers unreachable: keep the plain map (no made-up estimate) and
// offer a retry in the loader pill.
function showFailure(msg) {
  data.source = 'unavailable';
  updateSourceLine();
  setStatus(msg, 'warn');
  loading.error = msg;
  updateLoader();
}

$('#loader-retry').addEventListener('click', () => {
  data = null; // force a fresh fetch (failures are never cached)
  reload();
});

function renderLineLegend(legend) {
  const el = $('#line-legend');
  el.innerHTML = '';
  el.hidden = !legend?.length;
  for (const l of legend || []) {
    const chip = document.createElement('span');
    chip.className = 'line-chip';
    const sw = document.createElement('i');
    sw.style.background = l.colour;
    chip.append(sw, document.createTextNode(l.name));
    el.append(chip);
  }
}

// Real times are in: shade the map and warp it into the selected view.
async function showResult(times) {
  data.times = times;
  const myData = data;
  data.grid = await buildTimeGrid(myData, myData.field);
  if (data !== myData) return;
  renderer.setTimeField(data.grid?.data, data.grid?.n, data.grid?.R);
  data.ready = true;
  renderer.setTimes(times);
  renderer._lastTimes = times;
  warps = computeWarps(data.mesh, times, state.budget);
  renderer.setWarps(warps);
  updateLeafletReach();
  computeStationReach();
  tween(renderer.state, 'shade', 1, 500);
  applyView();
}

// Which stations lie inside the budget (for greying the others).
function computeStationReach() {
  if (!data?.stations || !warps) return;
  const times = renderer._lastTimes || data.times;
  data.stationIn = data.stations.map((st) => timeAt(st.x, st.y) <= limit());
}

// ---------------------------------------------------------------------------
// Fine travel-time grid for shading. The mesh (a few hundred metres between
// points) is right for the warp but too coarse for small walking catchments
// around stations; the grid (~1024^2 over the area) is evaluated from the
// same model, lightly smoothed, and sampled per pixel by the shader. Station
// catchments then merge with the main envelope and render identically.

const GRID_N = 1024;

function timeAt(x, y) {
  const g = data?.grid;
  if (!g) return sampleTime(data.mesh, renderer._lastTimes || data.times, x, y);
  const fx = ((x / g.R) * 0.5 + 0.5) * (g.n - 1);
  const fy = (0.5 - (y / g.R) * 0.5) * (g.n - 1);
  if (fx < 0 || fy < 0 || fx > g.n - 1 || fy > g.n - 1) return Infinity;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(g.n - 1, x0 + 1), y1 = Math.min(g.n - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0;
  const v = (i, j) => g.data[j * g.n + i];
  return (v(x0, y0) * (1 - ax) + v(x1, y0) * ax) * (1 - ay) + (v(x0, y1) * (1 - ax) + v(x1, y1) * ax) * ay;
}

async function buildTimeGrid(myData, field) {
  const n = GRID_N;
  const R = myData.mesh.radius;
  const fn = field || ((x, y) => sampleTime(myData.mesh, myData.times, x, y));
  const cap = myData.bucket * 3; // far-outside values don't matter; keeps the blur honest
  const g = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const y = R - (2 * R * j) / (n - 1);
    for (let i = 0; i < n; i++) {
      const x = -R + (2 * R * i) / (n - 1);
      const t = fn(x, y);
      g[j * n + i] = Number.isFinite(t) ? Math.min(t, cap) : cap;
    }
    if (j % 64 === 63) {
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
      if (data !== myData) return null;
    }
  }
  // Light smoothing: separable 5-tap Gaussian.
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(n * n);
  for (const [src, dst, horiz] of [[g, tmp, true], [tmp, g, false]]) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let o = -2; o <= 2; o++) {
          const ii = horiz ? Math.min(n - 1, Math.max(0, i + o)) : i;
          const jj = horiz ? j : Math.min(n - 1, Math.max(0, j + o));
          acc += src[jj * n + ii] * k[o + 2];
        }
        dst[j * n + i] = acc / 16;
      }
    }
  }
  return { n, R, data: g };
}

function rewarp() {
  if (!data) return;
  warps = computeWarps(data.mesh, data.times, state.budget);
  renderer.setWarps(warps);
  renderer.state.budget = state.budget;
  if (data.ready) {
    updateLeafletReach();
    computeStationReach();
  }
  anim.dirty = true;
}

function updateLeafletReach() {
  if (!warps || !state.dest) return;
  if (reachCircle) reachCircle.remove();
  reachCircle = L.circle(state.dest, {
    radius: warps.reachMedian,
    color: '#de2654',
    weight: 1.5,
    fill: false,
    dashArray: '4 5',
  }).addTo(map);
}

function updateSourceLine() {
  $('#times-src').textContent = data?.source || '—';
}

// ---------------------------------------------------------------------------
// UI wiring

function applyView() {
  if (!renderer) return;
  const v = VIEWS[state.view];
  renderer.state.budget = state.budget;
  if (data?.ready) {
    tween(renderer.state, 'strength', v.strength, 1100);
    tween(renderer.state, 'blend', v.blend, 1100);
  }
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === state.view));
  writeHash();
}

function showWarp(on) {
  state.picking = !on;
  $('#stage').classList.toggle('picking', !on);
  $('#pick-btn').hidden = !on;
  if (!on) {
    setTimeout(() => map.invalidateSize(), 50);
    if (warps) map.setView(state.dest, map.getZoom());
  }
}

document.querySelectorAll('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    userView = null;
    $('#legend-mode').textContent = MODES[state.mode].label.toLowerCase();
    $('#train-opts').hidden = state.mode !== 'train';
    reload();
  }),
);

document.querySelectorAll('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    state.view = b.dataset.view;
    if (state.dest && state.picking) showWarp(true);
    applyView();
  }),
);

// Non-linear slider: fine steps for local trips, coarse for inter-city.
const BUDGET_STEPS = [5, 10, 15, 20, 25, 30, 40, 45, 50, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 420, 480, 540, 600, 720];
const budgetInput = $('#budget');
budgetInput.max = BUDGET_STEPS.length - 1;
const budgetIndex = (m) =>
  BUDGET_STEPS.reduce((best, v, i) => (Math.abs(v - m) < Math.abs(BUDGET_STEPS[best] - m) ? i : best), 0);
let budgetTimer = null;
budgetInput.addEventListener('input', () => {
  state.budget = BUDGET_STEPS[Number(budgetInput.value)];
  $('#budget-val').textContent = formatMinutes(state.budget);
  $('#legend-max').textContent = formatMinutes(state.budget);
  if (!data) return;
  rewarp();
  clearTimeout(budgetTimer);
  budgetTimer = setTimeout(() => {
    writeHash();
    if (dataKey() !== data.key) reload();
  }, 450);
});

function formatMinutes(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// Poster palettes are already strong: lighter time tint and wash on them.
function applyThemeShading() {
  if (!renderer) return;
  const poster = state.theme !== 'osm';
  renderer.state.tint = poster ? 0.1 : 0.2;
  renderer.state.wash = poster ? 0.25 : 0.35; // lightening of the greyscale beyond the budget
  anim.dirty = true;
}

// ---------------------------------------------------------------------------
// Transit lines are painted into the map texture itself (on a copy of the
// basemap), so they sit just above the map and below the time tint,
// contours, budget line and markers - and warp with the map.

const LINE_ALPHA = 0.55;
const LINE_PX = 2.4; // per line, in texture pixels

function withLines(src, layout, holder) {
  const lines = data?.lines;
  if (!lines?.length || !state.dest) return src;
  holder.composite ||= document.createElement('canvas');
  const c = holder.composite;
  if (c.width !== src.width) c.width = c.height = src.width;
  const ctx = c.getContext('2d');
  ctx.globalAlpha = 1;
  ctx.drawImage(src, 0, 0);
  const toPx = (p) => {
    p.ll ||= fromLocal(state.dest, p.x, p.y);
    const [wx, wy] = worldPx(p.ll.lat, p.ll.lng, layout.z, 256);
    return [wx - layout.ox, wy - layout.oy];
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = LINE_PX;
  ctx.globalAlpha = LINE_ALPHA;
  for (const line of lines) {
    const colours = line.colours || [line.colour || (line.metro ? '#2457c5' : '#1f2a37')];
    const pts = line.pts.map(toPx);
    if (pts.length < 2) continue;
    // Several lines on one shape: side by side along the normal.
    const normals = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    });
    colours.forEach((col, k) => {
      const off = (k - (colours.length - 1) / 2) * LINE_PX;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = p[0] + normals[i][0] * off;
        const y = p[1] + normals[i][1] * off;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.strokeStyle = col;
      ctx.stroke();
    });
  }
  ctx.globalAlpha = 1;
  return c;
}

const baseHolder = {};
function uploadBase(bm) {
  renderer.setTexture(withLines(bm.canvas, bm, baseHolder));
  anim.dirty = true;
}

// Lines changed (new results): repaint both textures.
function refreshLineTextures() {
  if (!data?.basemap) return;
  uploadBase(data.basemap);
  if (detail.layout && detail.bm) renderer.setDetail(withLines(detail.bm.canvas, detail.layout, detail), detail.layout.rect);
}

// ---------------------------------------------------------------------------
// Sharper map when zoomed in: once the view has been still for a moment,
// re-render just the visible area at a higher zoom into a second texture
// that the shader uses inside its rect (raster tiles or vector styles alike).

const detail = { key: null, changedAt: 0, requested: null, ctrl: null, layout: null };

function clearDetail() {
  detail.ctrl?.abort();
  Object.assign(detail, { requested: null, ctrl: null, layout: null });
  renderer?.setDetail(null);
  anim.dirty = true;
}

function watchViewForDetail(now) {
  const s = renderer.state;
  const key = `${s.cx.toFixed(1)},${s.cy.toFixed(1)},${s.scale.toPrecision(6)},${s.strength.toFixed(3)},${s.blend.toFixed(3)}`;
  if (key !== detail.key) {
    detail.key = key;
    detail.changedAt = now;
    return;
  }
  if (now - detail.changedAt < 450 || detail.requested === key || !data?.ready) return;
  detail.requested = key;
  requestDetail();
}

function requestDetail() {
  const pos = currentPositions();
  const { uvs, mesh, basemap } = data;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let v = 0; v < mesh.count; v++) {
    const [sx, sy] = renderer.toScreen(pos[2 * v], pos[2 * v + 1]);
    if (sx < -40 || sy < -40 || sx > renderer.width + 40 || sy > renderer.height + 40) continue;
    u0 = Math.min(u0, uvs[2 * v]); u1 = Math.max(u1, uvs[2 * v]);
    v0 = Math.min(v0, uvs[2 * v + 1]); v1 = Math.max(v1, uvs[2 * v + 1]);
  }
  if (!(u1 > u0)) return;
  const span = Math.max(u1 - u0, v1 - v0) * 1.1;
  if (span > 0.55) {
    // Not zoomed in enough for the base texture to look soft.
    if (detail.layout) clearDetail();
    return;
  }
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  // Already have a sharp-enough texture covering this view?
  const L = detail.layout;
  if (L && L.rect[0] <= cu - span / 2 && L.rect[2] >= cu + span / 2 && L.rect[1] <= cv - span / 2 && L.rect[3] >= cv + span / 2 && L.rect[2] - L.rect[0] <= span * 2.2) return;
  detail.ctrl?.abort();
  const ctrl = new AbortController();
  const layout = detailLayout(basemap, [cu - span / 2, cv - span / 2, cu + span / 2, cv + span / 2]);
  Object.assign(detail, { ctrl, layout, bm: null });
  let pending = false;
  const upload = () => {
    if (detail.ctrl !== ctrl) return;
    renderer.setDetail(withLines(bm.canvas, layout, detail), layout.rect);
    anim.dirty = true;
  };
  const bm = buildBasemap(null, null, renderer.maxTex, () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      upload();
    }, 250);
  }, ctrl.signal, state.theme, layout);
  detail.bm = bm;
  bm.done.then(upload);
}

// Train mode: longest walk to / from a station.
const MAX_WALK_STEPS = [5, 10, 15, 20, 30];
$('#max-walk').addEventListener('change', (e) => {
  state.maxWalk = Number(e.target.value);
  writeHash();
  if (state.mode === 'train') reload();
});

// Map style: swapping only rebuilds the texture (same layout, same uv).
document.querySelectorAll('[data-theme]').forEach((b) =>
  b.addEventListener('click', () => {
    state.theme = b.dataset.theme;
    applyThemeShading();
    syncControls();
    writeHash();
    if (!data) return;
    clearDetail();
    const bm = getBasemap(state.dest, data.mesh.radius);
    data.basemap = bm;
    uploadBase(bm);
    anim.dirty = true;
  }),
);

$('#pick-btn').addEventListener('click', () => showWarp(false));
$('#example-btn').addEventListener('click', () => {
  state.mode = 'train';
  state.budget = 45;
  syncControls();
  setDestination({ lat: 43.6453, lng: -79.3806 }, 'Union Station, Toronto');
});
$('#example-city-btn').addEventListener('click', () => {
  state.mode = 'drive';
  state.budget = 240;
  syncControls();
  map.setView([43.6532, -79.3832], 6);
  setDestination({ lat: 43.6532, lng: -79.3832 }, 'Toronto');
});

// Search (Nominatim)
$('#search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  const list = $('#results');
  list.innerHTML = '';
  if (!q) return;
  list.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const items = await fetchJson(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q.toLowerCase())}`,
    );
    list.innerHTML = '';
    if (!items.length) list.innerHTML = '<li class="muted">No results</li>';
    for (const it of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it.display_name;
      btn.addEventListener('click', () => {
        list.innerHTML = '';
        const dest = { lat: Number(it.lat), lng: Number(it.lon) };
        map.setView(dest, 13);
        setDestination(dest, it.display_name.split(',').slice(0, 3).join(','));
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
  } catch {
    list.innerHTML = '<li class="muted">Search unavailable — click the map instead.</li>';
  }
});

// Pan / zoom / hover on the warped map (mouse, touch and buttons)
const stageEl = $('#warp-overlay');

function viewNow() {
  const s = renderer.state;
  return { cx: s.cx, cy: s.cy, scale: s.scale };
}

function localPoint(e) {
  const rect = stageEl.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

// Zoom by factor f keeping screen point (px, py) fixed.
function zoomAt(px, py, f, base = viewNow()) {
  const wx = (px - renderer.width / 2) / base.scale + base.cx;
  const wy = (renderer.height / 2 - py) / base.scale + base.cy;
  userView = { scale: base.scale * f, cx: wx - (wx - base.cx) / f, cy: wy - (wy - base.cy) / f };
  anim.dirty = true;
}

function animateZoom(f) {
  const base = viewNow();
  const t0 = performance.now();
  const step = (now) => {
    const u = ease(Math.min(1, (now - t0) / 220));
    zoomAt(renderer.width / 2, renderer.height / 2, Math.pow(f, u), base);
    if (u < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function resetView() {
  userView = null;
  $('#tooltip').hidden = true;
  anim.dirty = true;
}

$('#zoom-in').addEventListener('click', () => animateZoom(1.6));
$('#zoom-out').addEventListener('click', () => animateZoom(1 / 1.6));
$('#zoom-reset').addEventListener('click', resetView);

// Active pointers: one pointer pans, two pointers pinch-zoom and pan.
const pointers = new Map();
let gesture = null;
let lastTap = 0;

function startGesture() {
  const pts = [...pointers.values()];
  const base = viewNow();
  if (pts.length === 1) {
    gesture = { kind: 'pan', start: pts[0], base, moved: false };
  } else if (pts.length >= 2) {
    const [a, b] = pts;
    gesture = {
      kind: 'pinch',
      base,
      dist: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])),
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      moved: true,
    };
  } else {
    gesture = null;
  }
}

stageEl.addEventListener('pointerdown', (e) => {
  stageEl.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localPoint(e));
  startGesture();
  if (e.pointerType !== 'mouse') hover(e);
});

stageEl.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, localPoint(e));
  if (gesture?.kind === 'pan') {
    const [px, py] = pointers.get(e.pointerId) || localPoint(e);
    const dx = px - gesture.start[0];
    const dy = py - gesture.start[1];
    if (gesture.moved || Math.abs(dx) + Math.abs(dy) > 4) {
      gesture.moved = true;
      const b = gesture.base;
      userView = { cx: b.cx - dx / b.scale, cy: b.cy + dy / b.scale, scale: b.scale };
      anim.dirty = true;
      if (e.pointerType !== 'mouse') $('#tooltip').hidden = true;
    }
  } else if (gesture?.kind === 'pinch' && pointers.size >= 2) {
    const [a, c] = [...pointers.values()];
    const dist = Math.max(1, Math.hypot(a[0] - c[0], a[1] - c[1]));
    const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    const f = dist / gesture.dist;
    const b = gesture.base;
    // world point under the starting midpoint follows the current midpoint
    const wx = (gesture.mid[0] - renderer.width / 2) / b.scale + b.cx;
    const wy = (renderer.height / 2 - gesture.mid[1]) / b.scale + b.cy;
    const scale = b.scale * f;
    userView = {
      scale,
      cx: wx - (mid[0] - renderer.width / 2) / scale,
      cy: wy - (renderer.height / 2 - mid[1]) / scale,
    };
    anim.dirty = true;
    $('#tooltip').hidden = true;
    return;
  }
  if (e.pointerType === 'mouse' || !gesture?.moved) hover(e);
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const wasTap = gesture?.kind === 'pan' && !gesture.moved;
  pointers.delete(e.pointerId);
  startGesture(); // continue with remaining finger(s) without jumping
  if (wasTap && e.pointerType !== 'mouse') {
    const now = performance.now();
    if (now - lastTap < 300) resetView();
    lastTap = now;
  }
}
stageEl.addEventListener('pointerup', endPointer);
stageEl.addEventListener('pointercancel', endPointer);
stageEl.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse') $('#tooltip').hidden = true;
});
stageEl.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const [px, py] = localPoint(e);
    zoomAt(px, py, Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);
stageEl.addEventListener('dblclick', resetView);

function hover(e) {
  const tip = $('#tooltip');
  if (!warps || !data?.ready) {
    tip.hidden = true;
    return;
  }
  const rect = stageEl.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const [wx, wy] = renderer.toWorld(px, py);
  const hit = locate(data.mesh, currentPositions(), renderer._lastTimes || data.times, wx, wy);
  if (hit) hit.time = timeAt(hit.x, hit.y); // the fine grid the colours come from
  if (!hit) {
    tip.hidden = true;
    return;
  }
  const km = Math.hypot(hit.x, hit.y) / 1000;
  const t = Math.round(hit.time);
  if (hit.time >= UNREACHABLE * 0.99) {
    tip.innerHTML = `<b>Not reachable</b> ${MODES[state.mode].icon}<br><span>more than a ${state.maxWalk} min walk from any useful station</span>`;
    tip.hidden = false;
    tip.style.left = `${px + 14}px`;
    tip.style.top = `${py + 14}px`;
    return;
  }
  tip.innerHTML = `<b>${t < 1 ? '< 1 min' : formatMinutes(t)}</b> ${MODES[state.mode].icon}<br><span>${km < 1 ? Math.round(km * 1000) + ' m' : (km < 100 ? km.toFixed(1) : Math.round(km)) + ' km'} away${hit.time > limit() ? ' · over budget' : ''}</span>`;
  tip.hidden = false;
  tip.style.left = `${px + 14}px`;
  tip.style.top = `${py + 14}px`;
}

window.addEventListener('resize', () => {
  renderer?.resize();
  anim.dirty = true;
});

// ---------------------------------------------------------------------------
// URL hash: #lat,lng,mode,budget,view

function writeHash() {
  if (!state.dest) return;
  const h = `#${state.dest.lat.toFixed(5)},${state.dest.lng.toFixed(5)},${state.mode},${state.budget},${state.view},${state.theme},${state.maxWalk}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

function syncControls() {
  document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.mode === state.mode));
  document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.view === state.view));
  document.querySelectorAll('[data-theme]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.theme === state.theme));
  $('#max-walk').value = String(state.maxWalk);
  $('#train-opts').hidden = state.mode !== 'train';
  applyThemeShading();
  budgetInput.value = budgetIndex(state.budget);
  $('#budget-val').textContent = formatMinutes(state.budget);
  $('#legend-max').textContent = formatMinutes(state.budget);
  $('#legend-mode').textContent = MODES[state.mode].label.toLowerCase();
}

function readHash() {
  const m = location.hash.slice(1).split(',');
  if (m.length < 2) return false;
  const lat = Number(m[0]);
  const lng = Number(m[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (MODES[m[2]]) state.mode = m[2];
  if (Number(m[3]) >= 5 && Number(m[3]) <= 720) state.budget = Number(m[3]);
  if (VIEWS[m[4]]) state.view = m[4];
  if (m[5] === 'osm' || THEMES[m[5]]) state.theme = m[5];
  if (MAX_WALK_STEPS.includes(Number(m[6]))) state.maxWalk = Number(m[6]);
  syncControls();
  map.setView([lat, lng], 12);
  setDestination({ lat, lng }, null);
  return true;
}

syncControls();
if (!readHash()) showWarp(false);
