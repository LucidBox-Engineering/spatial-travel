import { MODES, extentFor, computeTimes, heuristicTimes } from './travel.js?v=11';
import { createMesh, computeWarps, blendPositions, locate, forward } from './warp.js?v=11';
import { buildBasemap } from './basemap.js?v=11';
import { WarpRenderer } from './renderer.js?v=11';
import { fromLocal } from './geo.js?v=11';

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
    if (!data?.stations || !warps) return;
    const pos = currentPositions();
    // Project each station once per frame; lines reuse the projections.
    const proj = new Map();
    const project = (s) => {
      if (!proj.has(s)) {
        const p = forward(data.mesh, pos, s.x, s.y);
        proj.set(s, p && r.toScreen(p[0], p[1]));
      }
      return proj.get(s);
    };
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const line of data.lines || []) {
      ctx.beginPath();
      let pen = false;
      for (const s of line.pts) {
        const q = project(s);
        if (!q) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(q[0], q[1]);
        else ctx.moveTo(q[0], q[1]);
        pen = true;
      }
      ctx.lineWidth = line.metro ? 2 : 2.5;
      ctx.strokeStyle = line.colour || (line.metro ? '#2457c5' : '#1f2a37');
      ctx.globalAlpha = 0.55;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const s of data.stations) {
      const q = project(s);
      if (!q) continue;
      const [sx, sy] = q;
      if (sx < -10 || sy < -10 || sx > r.width + 10 || sy > r.height + 10) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, s.lines > 1 ? 3.6 : s.metro ? 2.6 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = s.metro ? '#2457c5' : '#1f2a37';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.restore();
  });

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
const loading = { times: null, tiles: null };

function updateLoader() {
  const msg = loading.times || loading.tiles;
  const el = $('#loader');
  el.classList.toggle('show', !!msg);
  if (msg) $('#loader-text').textContent = msg.replace(/…\s*\d+%$/, '…');
  const pct = loading.times ? /(\d+)%$/.exec(loading.times)?.[1] : loading.tilesPct;
  $('#loader-bar').style.width = pct != null ? `${Math.max(4, pct)}%` : '';
  $('#loader').classList.toggle('indeterminate', pct == null);
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
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${dest.lat}&lon=${dest.lng}`,
    );
    const j = await res.json();
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
  return `${state.dest.lat.toFixed(5)},${state.dest.lng.toFixed(5)}|${state.mode}|${bucket}`;
}

const basemapCache = new Map();

function getBasemap(dest, radius) {
  const key = `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}|${Math.round(radius)}`;
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
        renderer.setTexture(bm.canvas);
        anim.dirty = true;
      }
    }, 250);
  });
  bm.done.then((info) => {
    if (data?.basemap === bm) {
      renderer.setTexture(bm.canvas);
      anim.dirty = true;
    }
    $('#tiles-src').textContent = info.loaded ? info.source : 'unavailable (offline)';
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
  data = { key, mesh, basemap, times, source: 'Loading…', stations: null, lines: null, bucket };
  renderer.setMesh(mesh, uvs);
  renderer.setTexture(basemap.canvas);
  renderer.setTimes(times);
  renderer._lastTimes = times;
  warps = computeWarps(mesh, times, state.budget);
  renderer.setWarps(warps);
  // Until real travel times arrive, show the plain map (no warp, no time
  // shading); the loader indicates progress.
  data.ready = false;
  tween(renderer.state, 'strength', 0, 500);
  tween(renderer.state, 'shade', 0, 300);
  setStatus('Calculating travel times…', 'busy');
  updateSourceLine();
  anim.dirty = true;

  try {
    const res = await computeTimes(state.dest, state.mode, mesh, signal, (msg) => {
      if (token === loadToken) setStatus(msg, 'busy');
    }, bucket);
    if (token !== loadToken) return;
    data.times = res.times;
    data.source = res.source;
    data.stations = res.stations || null;
    data.lines = res.lines || null;
    showResult(res.times);
    const est = /estimate/i.test(res.source);
    setStatus(est ? 'Using estimated travel times.' : 'Travel times loaded.', est ? 'warn' : 'ok');
    updateSourceLine();
  } catch (err) {
    if (signal.aborted) return;
    console.error(err);
    setStatus('Could not load travel times — showing estimate.', 'warn');
    showResult(data.times);
  }
}

// Real times are in: shade the map and warp it into the selected view.
function showResult(times) {
  data.times = times;
  data.ready = true;
  renderer.setTimes(times);
  renderer._lastTimes = times;
  warps = computeWarps(data.mesh, times, state.budget);
  renderer.setWarps(warps);
  updateLeafletReach();
  tween(renderer.state, 'shade', 1, 500);
  applyView();
}

function rewarp() {
  if (!data) return;
  warps = computeWarps(data.mesh, data.times, state.budget);
  renderer.setWarps(warps);
  renderer.state.budget = state.budget;
  if (data.ready) updateLeafletReach();
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
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`);
    const items = await res.json();
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
  if (!hit) {
    tip.hidden = true;
    return;
  }
  const km = Math.hypot(hit.x, hit.y) / 1000;
  const t = Math.round(hit.time);
  tip.innerHTML = `<b>${t < 1 ? '< 1 min' : formatMinutes(t)}</b> ${MODES[state.mode].icon}<br><span>${km < 1 ? Math.round(km * 1000) + ' m' : (km < 100 ? km.toFixed(1) : Math.round(km)) + ' km'} away${hit.time > state.budget ? ' · over budget' : ''}</span>`;
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
  const h = `#${state.dest.lat.toFixed(5)},${state.dest.lng.toFixed(5)},${state.mode},${state.budget},${state.view}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

function syncControls() {
  document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.mode === state.mode));
  document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.view === state.view));
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
  syncControls();
  map.setView([lat, lng], 12);
  setDestination({ lat, lng }, null);
  return true;
}

syncControls();
if (!readHash()) showWarp(false);
