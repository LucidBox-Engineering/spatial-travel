import { MODES, extentFor, computeTimes, heuristicTimes } from './travel.js';
import { createMesh, computeWarps, blendPositions, locate, forward } from './warp.js';
import { buildBasemap } from './basemap.js';
import { WarpRenderer } from './renderer.js';
import { fromLocal } from './geo.js';

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
    ctx.save();
    for (const s of data.stations) {
      const p = forward(data.mesh, pos, s.x, s.y);
      if (!p) continue;
      const [sx, sy] = r.toScreen(p[0], p[1]);
      if (sx < -10 || sy < -10 || sx > r.width + 10 || sy > r.height + 10) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, s.metro ? 2.6 : 3.2, 0, Math.PI * 2);
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
  const bm = buildBasemap(dest, radius, renderer.maxTex, () => {
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
  data = { key, mesh, basemap, times, source: 'Quick estimate (loading real data…)', stations: null, bucket };
  renderer.setMesh(mesh, uvs);
  renderer.setTexture(basemap.canvas);
  renderer.setTimes(times);
  renderer._lastTimes = times;
  warps = computeWarps(mesh, times, state.budget);
  renderer.setWarps(warps);
  applyView();
  updateLeafletReach();
  setStatus('Estimating…', 'busy');
  updateSourceLine();
  anim.dirty = true;

  try {
    const res = await computeTimes(state.dest, state.mode, mesh, signal, (msg) => {
      if (token === loadToken) setStatus(msg, 'busy');
    });
    if (token !== loadToken) return;
    data.times = res.times;
    data.source = res.source;
    data.stations = res.stations || null;
    morphTo(res.times);
    const est = /estimate/i.test(res.source);
    setStatus(est ? 'Using estimated travel times.' : 'Travel times loaded.', est ? 'warn' : 'ok');
    updateSourceLine();
  } catch (err) {
    if (signal.aborted) return;
    console.error(err);
    setStatus('Could not load travel times — showing estimate.', 'warn');
  }
}

// Smoothly blend from the current times/warps to new ones.
function morphTo(newTimes) {
  const myData = data;
  const startWarps = warps;
  const endWarps = computeWarps(data.mesh, newTimes, state.budget);
  const startTimes = renderer._lastTimes || newTimes;
  const t0 = performance.now();
  const ms = 700;
  const lerpArr = (a, b, u) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * u;
    return out;
  };
  const step = (now) => {
    if (data !== myData) return;
    const u = ease(Math.min(1, (now - t0) / ms));
    const w = {
      ...endWarps,
      dist: lerpArr(startWarps.dist, endWarps.dist, u),
      size: lerpArr(startWarps.size, endWarps.size, u),
      reachMedian: startWarps.reachMedian + (endWarps.reachMedian - startWarps.reachMedian) * u,
      k: startWarps.k + (endWarps.k - startWarps.k) * u,
    };
    warps = w;
    renderer.setWarps(w);
    const t = lerpArr(startTimes, newTimes, u);
    renderer.setTimes(t);
    renderer._lastTimes = t;
    anim.dirty = true;
    if (u < 1) requestAnimationFrame(step);
    else {
      warps = endWarps;
      renderer.setWarps(endWarps);
      renderer.setTimes(newTimes);
      renderer._lastTimes = newTimes;
      updateLeafletReach();
    }
  };
  requestAnimationFrame(step);
}

function rewarp() {
  if (!data) return;
  warps = computeWarps(data.mesh, data.times, state.budget);
  renderer.setWarps(warps);
  renderer.state.budget = state.budget;
  updateLeafletReach();
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
  tween(renderer.state, 'strength', v.strength, 1100);
  tween(renderer.state, 'blend', v.blend, 1100);
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

const budgetInput = $('#budget');
let budgetTimer = null;
budgetInput.addEventListener('input', () => {
  state.budget = Number(budgetInput.value);
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

// Pan / zoom / hover on the warped map
const stageEl = $('#warp-overlay');
let drag = null;
stageEl.addEventListener('pointerdown', (e) => {
  stageEl.setPointerCapture(e.pointerId);
  const s = renderer.state;
  drag = { x: e.clientX, y: e.clientY, cx: s.cx, cy: s.cy, scale: s.scale };
});
stageEl.addEventListener('pointermove', (e) => {
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      userView = { cx: drag.cx - dx / drag.scale, cy: drag.cy + dy / drag.scale, scale: drag.scale };
      anim.dirty = true;
    }
  }
  hover(e);
});
stageEl.addEventListener('pointerup', () => (drag = null));
stageEl.addEventListener('pointerleave', () => ($('#tooltip').hidden = true));
stageEl.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const s = renderer.state;
    const rect = stageEl.getBoundingClientRect();
    const [wx, wy] = renderer.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const f = Math.exp(-e.deltaY * 0.0015);
    const scale = s.scale * f;
    userView = { scale, cx: wx - (wx - s.cx) / f, cy: wy - (wy - s.cy) / f };
    anim.dirty = true;
  },
  { passive: false },
);
stageEl.addEventListener('dblclick', () => {
  userView = null;
  anim.dirty = true;
});

function hover(e) {
  const tip = $('#tooltip');
  if (!warps || !data) return;
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
  tip.innerHTML = `<b>${t < 1 ? '< 1' : t} min</b> ${MODES[state.mode].icon}<br><span>${km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km'} away${hit.time > state.budget ? ' · over budget' : ''}</span>`;
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
  budgetInput.value = state.budget;
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
  if (Number(m[3]) >= 5 && Number(m[3]) <= 120) state.budget = Number(m[3]);
  if (VIEWS[m[4]]) state.view = m[4];
  syncControls();
  map.setView([lat, lng], 12);
  setDestination({ lat, lng }, null);
  return true;
}

syncControls();
if (!readHash()) showWarp(false);
