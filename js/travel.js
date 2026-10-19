// Travel-time estimation. Everything returns minutes from a location TO the
// destination.
//
//  - walk / drive: a fast heuristic model gives an instant first answer, then
//    real road-network durations are fetched from public OSRM / Valhalla
//    servers on a coarse polar grid and used to correct the heuristic.
//  - train: rail / metro stations are fetched from OpenStreetMap (Overpass) and
//    a simple station-to-station model estimates door-to-door time.
//
// If every network source fails the heuristic result is kept, so the app is
// always usable.

import { fromLocal, toLocal, bboxAround } from './geo.js?v=9';
import { fetchNetwork, stationTimes } from './transit.js?v=9';

export const MODES = {
  walk: { label: 'Walk', icon: '🚶' },
  drive: { label: 'Drive', icon: '🚗' },
  train: { label: 'Train', icon: '🚆' },
};

// ---------------------------------------------------------------------------
// Heuristic models (crow-fly distance in metres -> minutes)

const WALK_M_PER_MIN = 80;

function walkHeuristic(d) {
  return (d * 1.3) / WALK_M_PER_MIN;
}

function driveHeuristic(d) {
  const dd = d * 1.35;
  const kmh = 25 + 60 * (1 - Math.exp(-dd / 20000));
  return dd / ((kmh * 1000) / 60) + 2;
}

// Getting to / from a station: walk up to 1.5 km, beyond that assume a
// feeder bus or bike at ~18 km/h after a short wait.
function stationAccess(d) {
  const dd = d * 1.25;
  if (dd <= 1500) return dd / 75;
  return 1500 / 75 + 5 + (dd - 1500) / 300;
}

function trainHeuristic(d) {
  return Math.min(stationAccess(d), 12 + (d * 1.25) / (45000 / 60));
}

export function heuristic(mode, d) {
  if (mode === 'walk') return walkHeuristic(d);
  if (mode === 'drive') return driveHeuristic(d);
  return trainHeuristic(d);
}

// Crow-fly distance reachable within `minutes` according to the heuristic.
function heuristicReach(mode, minutes) {
  let lo = 0;
  let hi = 4000000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (heuristic(mode, mid) < minutes) lo = mid;
    else hi = mid;
  }
  return lo;
}

// The fetched area depends on a bucketed budget so that small slider moves can
// reuse the same data.
const BUCKETS = [10, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720];

export function extentFor(mode, budget) {
  const bucket = BUCKETS.find((b) => b >= budget) ?? BUCKETS[BUCKETS.length - 1];
  return { bucket, radius: Math.max(400, 1.8 * heuristicReach(mode, bucket)) };
}

// ---------------------------------------------------------------------------
// Network helpers

async function fetchJson(url, signal, timeoutMs = 20000, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function osrmProvider(name, base, profile) {
  return {
    name,
    chunk: 80,
    async table(dest, pts, signal) {
      const coords = [dest, ...pts].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const sources = pts.map((_, i) => i + 1).join(';');
      const url = `${base}/table/v1/${profile}/${coords}?sources=${sources}&destinations=0&annotations=duration`;
      const json = await fetchJson(url, signal);
      if (json.code !== 'Ok' || !json.durations) throw new Error(json.message || json.code || 'bad response');
      return pts.map((_, i) => {
        const sec = json.durations[i]?.[0];
        const snap = json.sources?.[i]?.distance ?? 0;
        if (sec == null) return NaN;
        // Points off the network (lakes, parks, fields) are snapped to the
        // nearest road; charge walking time for that gap.
        return sec / 60 + Math.min(720, snap / 70);
      });
    },
  };
}

function valhallaProvider(name, costing) {
  return {
    name,
    chunk: 40,
    async table(dest, pts, signal) {
      const body = {
        sources: pts.map((p) => ({ lat: p.lat, lon: p.lng })),
        targets: [{ lat: dest.lat, lon: dest.lng }],
        costing,
      };
      const url = `https://valhalla1.openstreetmap.de/sources_to_targets?json=${encodeURIComponent(JSON.stringify(body))}`;
      const json = await fetchJson(url, signal);
      const rows = json.sources_to_targets;
      if (!rows) throw new Error('bad response');
      return pts.map((_, i) => {
        const sec = rows[i]?.[0]?.time;
        return sec == null ? NaN : sec / 60;
      });
    },
  };
}

const ROAD_PROVIDERS = {
  walk: [
    osrmProvider('OSRM foot (FOSSGIS)', 'https://routing.openstreetmap.de/routed-foot', 'foot'),
    valhallaProvider('Valhalla pedestrian (FOSSGIS)', 'pedestrian'),
  ],
  drive: [
    osrmProvider('OSRM car (FOSSGIS)', 'https://routing.openstreetmap.de/routed-car', 'driving'),
    osrmProvider('OSRM car (demo server)', 'https://router.project-osrm.org', 'driving'),
    valhallaProvider('Valhalla auto (FOSSGIS)', 'auto'),
  ],
};

// ---------------------------------------------------------------------------
// Road modes: sample a coarse polar grid, then correct the heuristic.

const SAMPLE_BEARINGS = 24;
const SAMPLE_FRACTIONS = [0.04, 0.09, 0.16, 0.25, 0.36, 0.49, 0.64, 0.81, 1.0];

async function roadTimes(dest, mode, mesh, signal, onStatus) {
  const R = mesh.radius;
  const samples = [];
  for (let j = 0; j < SAMPLE_FRACTIONS.length; j++) {
    for (let i = 0; i < SAMPLE_BEARINGS; i++) {
      const th = (2 * Math.PI * i) / SAMPLE_BEARINGS;
      const r = SAMPLE_FRACTIONS[j] * R;
      const x = r * Math.sin(th);
      const y = r * Math.cos(th);
      samples.push({ ...fromLocal(dest, x, y), r });
    }
  }

  for (const provider of ROAD_PROVIDERS[mode]) {
    try {
      const out = new Array(samples.length);
      let done = 0;
      for (let s = 0; s < samples.length; s += provider.chunk) {
        const chunk = samples.slice(s, s + provider.chunk);
        onStatus?.(`Getting ${MODES[mode].label.toLowerCase()} times… ${Math.round((100 * done) / samples.length)}%`);
        const res = await provider.table(dest, chunk, signal);
        res.forEach((t, k) => (out[s + k] = t));
        done += chunk.length;
      }
      const valid = out.filter((t) => Number.isFinite(t)).length;
      if (valid < samples.length * 0.3) throw new Error('too few reachable points');
      return { times: correctHeuristic(mode, mesh, samples, out), source: provider.name };
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`${provider.name} failed:`, err);
    }
  }
  return null;
}

// Interpolate observed/heuristic ratios onto the fine mesh.
function correctHeuristic(mode, mesh, samples, observed) {
  const NB = SAMPLE_BEARINGS;
  const NF = SAMPLE_FRACTIONS.length;
  const ratio = new Float64Array(NB * NF);
  for (let k = 0; k < samples.length; k++) {
    ratio[k] = observed[k] / heuristic(mode, samples[k].r);
  }
  // Fill unreachable samples from ring neighbours, then from adjacent rings.
  for (let pass = 0; pass < 4; pass++) {
    for (let j = 0; j < NF; j++) {
      for (let i = 0; i < NB; i++) {
        const k = j * NB + i;
        if (Number.isFinite(ratio[k])) continue;
        const nb = [j * NB + ((i + 1) % NB), j * NB + ((i + NB - 1) % NB)];
        if (j > 0) nb.push((j - 1) * NB + i);
        if (j < NF - 1) nb.push((j + 1) * NB + i);
        const vals = nb.map((n) => ratio[n]).filter(Number.isFinite);
        if (vals.length) ratio[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
    }
  }
  for (let k = 0; k < ratio.length; k++) if (!Number.isFinite(ratio[k])) ratio[k] = 1.5;
  let inner = 0;
  for (let i = 0; i < NB; i++) inner += ratio[i];
  inner /= NB;

  const fracs = [0, ...SAMPLE_FRACTIONS];
  const at = (j, i) => (j === 0 ? inner : ratio[(j - 1) * NB + (i % NB)]);
  const times = new Float32Array(mesh.count);
  for (let v = 0; v < mesh.count; v++) {
    const r = mesh.r[v];
    const f = r / mesh.radius;
    let j = 0;
    while (j < fracs.length - 2 && fracs[j + 1] < f) j++;
    const u = Math.min(1, Math.max(0, (f - fracs[j]) / (fracs[j + 1] - fracs[j])));
    const b = (mesh.theta[v] / (2 * Math.PI)) * NB;
    const i0 = Math.floor(b);
    const w = b - i0;
    const r0 = at(j, i0) * (1 - w) + at(j, i0 + 1) * w;
    const r1 = at(j + 1, i0) * (1 - w) + at(j + 1, i0 + 1) * w;
    times[v] = (r0 * (1 - u) + r1 * u) * heuristic(mode, r);
  }
  return times;
}

// ---------------------------------------------------------------------------
// Train: OSM rail lines (see transit.js), falling back to station
// locations with a station-to-station model when no line data exists.

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function fetchStations(dest, radius, signal) {
  const b = bboxAround(dest, radius);
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  // Inter-city extents: only proper rail stations (no halts or metro), and
  // thinned to one per grid cell so the model stays fast.
  const regional = radius > 150000;
  const q = regional
    ? `[out:json][timeout:60];(
    nwr["railway"="station"]["station"!~"^(subway|light_rail|monorail|funicular|tram|miniature)$"](${bbox});
  );out center tags;`
    : `[out:json][timeout:25];(
    nwr["railway"~"^(station|halt)$"](${bbox});
    nwr["public_transport"="station"]["train"="yes"](${bbox});
    nwr["station"~"^(subway|light_rail)$"](${bbox});
  );out center tags;`;
  const cell = Math.max(150, radius / 70);
  for (const url of OVERPASS) {
    try {
      const json = await fetchJson(url, signal, regional ? 75000 : 30000, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const stations = [];
      const seen = new Set();
      for (const el of json.elements || []) {
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat == null) continue;
        const t = el.tags || {};
        if (t.railway === 'tram_stop' || t.station === 'tram' || t.disused || t['abandoned:railway']) continue;
        const [x, y] = toLocal(dest, lat, lng);
        const metro = t.station === 'subway' || t.subway === 'yes' || t.station === 'light_rail';
        // de-duplicate station nodes / areas mapped twice (and thin out
        // dense areas at large scales): keep one station per grid cell
        const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        stations.push({ x, y, metro, name: t.name || '' });
      }
      return stations;
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`Overpass ${url} failed:`, err);
    }
  }
  return null;
}

function rideTime(a, b) {
  const D = Math.hypot(a.x - b.x, a.y - b.y);
  if (a.metro && b.metro) return (D * 1.2) / (30000 / 60);
  const kmh = 35 + 55 * (1 - Math.exp(-D / 40000));
  return (D * 1.15) / ((kmh * 1000) / 60) + (a.metro !== b.metro ? 4 : 0);
}

// Station-only fallback: no line data, so assume any station reaches any
// other directly at line speed.
function bestFromStationsOnly(stations) {
  const WAIT = 6;
  const byEgress = stations
    .map((s) => ({ s, egress: stationAccess(Math.hypot(s.x, s.y)) }))
    .sort((p, q) => p.egress - q.egress)
    .slice(0, 10);
  return stations.map((a) => {
    let m = Infinity;
    for (const { s, egress } of byEgress) m = Math.min(m, (a === s ? 0 : rideTime(a, s)) + egress);
    return m + WAIT;
  });
}

// Per mesh vertex: soft minimum over "go directly" and "get to station k,
// then best[k] from there", so station catchment boundaries blend instead of
// forming sharp creases. `access(v, k, d)` is the time from vertex v to
// station k (k = -1 means straight to the destination); d is crow-fly metres.
const crowAccess = (v, k, d) => stationAccess(d);

function timesViaStations(mesh, stations, best, access = crowAccess) {
  const TAU = 1.5;
  const times = new Float32Array(mesh.count);
  for (let v = 0; v < mesh.count; v++) {
    const x = mesh.x[v];
    const y = mesh.y[v];
    let m = access(v, -1, Math.hypot(x, y));
    let sum = 1;
    for (let k = 0; k < stations.length; k++) {
      const s = stations[k];
      const c = access(v, k, Math.hypot(x - s.x, y - s.y)) + best[k];
      if (c < m) {
        sum = sum * Math.exp((c - m) / TAU) + 1;
        m = c;
      } else if (c - m < 12 * TAU) {
        sum += Math.exp((m - c) / TAU);
      }
    }
    times[v] = Math.max(0, m - TAU * Math.log(sum));
  }
  return times;
}

// ---------------------------------------------------------------------------
// Real walking routes for the station legs.
//
// Crow-fly walking ignores rivers, motorways and rail yards. Routing every
// mesh vertex to every station is far too many requests, so:
//   1. a first pass with crow-fly access gives each vertex a rough time;
//   2. only vertices inside the budget envelope or near its frontier are
//      refined, and only for stations within walking range that could
//      plausibly be their best choice (plus walking straight to the
//      destination);
//   3. those (vertex, station) pairs are sampled, batched into OSRM foot
//      "table" requests, and turned into per-station detour ratios;
//   4. every vertex near a sampled station uses the measured time if it was
//      sampled, otherwise the crow-fly estimate scaled by the ratio of the
//      nearest sample for that station.

const FOOT_TABLE = 'https://routing.openstreetmap.de/routed-foot/table/v1/foot';
const WALK_RANGE = 1500; // crow-fly metres considered "walkable" to a station
const MAX_COORDS = 100; // per OSRM table request
const MAX_REQUESTS = 40;
const crowWalk = (d) => (d * 1.25) / 75;
const feeder = (d) => (d * 1.25 > 1500 ? stationAccess(d) : Infinity);

// Minutes walking from each source to each target (sources x targets).
async function footMatrix(sources, targets, signal) {
  const all = [...targets, ...sources];
  const coords = all.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const src = sources.map((_, i) => i + targets.length).join(';');
  const dst = targets.map((_, i) => i).join(';');
  const json = await fetchJson(`${FOOT_TABLE}/${coords}?sources=${src}&destinations=${dst}&annotations=duration`, signal);
  if (json.code !== 'Ok' || !json.durations) throw new Error(json.message || json.code || 'bad response');
  return sources.map((_, i) => {
    const snap = json.sources?.[i]?.distance ?? 0;
    return targets.map((_, j) => {
      const sec = json.durations[i]?.[j];
      return sec == null ? NaN : sec / 60 + snap / 70;
    });
  });
}

// Real walking time from the destination to stations near it (egress leg).
async function realEgress(dest, stations, signal) {
  const near = [];
  stations.forEach((s, k) => {
    if (Math.hypot(s.x, s.y) <= WALK_RANGE) near.push(k);
  });
  const out = new Map();
  for (let i = 0; i < near.length; i += MAX_COORDS - 1) {
    const chunk = near.slice(i, i + MAX_COORDS - 1);
    const m = await footMatrix(
      chunk.map((k) => fromLocal(dest, stations[k].x, stations[k].y)),
      [dest],
      signal,
    );
    chunk.forEach((k, n) => Number.isFinite(m[n][0]) && out.set(k, m[n][0]));
  }
  return out;
}

async function refineAccess(dest, mesh, stations, best, envelope, signal, onStatus) {
  const first = timesViaStations(mesh, stations, best);
  const DEST = stations.length; // pseudo-station: walk straight to the destination
  const pos = (k) => (k === DEST ? { x: 0, y: 0 } : stations[k]);
  const bestOf = (k) => (k === DEST ? 0 : best[k]);

  // Stations in walking range of each vertex in the envelope band.
  const pairs = new Map(); // station -> vertex ids
  const grid = new Map();
  stations.forEach((s, k) => {
    const key = `${Math.floor(s.x / WALK_RANGE)},${Math.floor(s.y / WALK_RANGE)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(k);
  });
  const nearby = (x, y) => {
    const cx = Math.floor(x / WALK_RANGE);
    const cy = Math.floor(y / WALK_RANGE);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(grid.get(`${cx + dx},${cy + dy}`) || []));
    return out;
  };
  for (let v = 0; v < mesh.count; v++) {
    if (first[v] > envelope) continue;
    const x = mesh.x[v];
    const y = mesh.y[v];
    const cands = nearby(x, y);
    if (Math.hypot(x, y) <= WALK_RANGE) cands.push(DEST);
    for (const k of cands) {
      const p = pos(k);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d > WALK_RANGE) continue;
      // Only stations that could plausibly be this vertex's best choice.
      if (crowWalk(d) + bestOf(k) > first[v] + 10) continue;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k).push(v);
    }
  }
  if (!pairs.size) return { times: first, refined: 0 };

  // Thin samples per station so everything fits in MAX_REQUESTS requests.
  const stationIds = [...pairs.keys()];
  let total = 0;
  for (const k of stationIds) total += pairs.get(k).length + 1;
  const keepFrac = Math.min(1, (MAX_REQUESTS * MAX_COORDS) / total);
  for (const k of stationIds) {
    const vs = pairs.get(k);
    const n = Math.max(3, Math.min(MAX_COORDS - 1, Math.round(vs.length * keepFrac)));
    if (vs.length > n) pairs.set(k, Array.from({ length: n }, (_, i) => vs[Math.floor((i * vs.length) / n)]));
  }

  // Pack stations (targets) and their vertices (sources) into requests.
  const batches = [];
  let cur = { targets: [], sources: new Set() };
  for (const k of stationIds) {
    const vs = pairs.get(k);
    const extra = 1 + vs.filter((v) => !cur.sources.has(v)).length;
    if (cur.targets.length && cur.targets.length + cur.sources.size + extra > MAX_COORDS) {
      batches.push(cur);
      cur = { targets: [], sources: new Set() };
    }
    cur.targets.push(k);
    vs.forEach((v) => cur.sources.add(v));
  }
  if (cur.targets.length) batches.push(cur);
  batches.length = Math.min(batches.length, MAX_REQUESTS);

  // samples[k] = list of { x, y, ratio } measured around station k
  const samples = new Map();
  const measured = new Map(); // `${v},${k}` -> minutes
  const ll = (x, y) => fromLocal(dest, x, y);
  let done = 0;
  const queue = batches.slice();
  const worker = async () => {
    while (queue.length) {
      const b = queue.shift();
      const src = [...b.sources];
      const m = await footMatrix(
        src.map((v) => ll(mesh.x[v], mesh.y[v])),
        b.targets.map((k) => (k === DEST ? dest : ll(pos(k).x, pos(k).y))),
        signal,
      );
      src.forEach((v, i) =>
        b.targets.forEach((k, j) => {
          const w = m[i][j];
          if (!Number.isFinite(w)) return;
          const p = pos(k);
          const d = Math.hypot(mesh.x[v] - p.x, mesh.y[v] - p.y);
          if (d > WALK_RANGE) return;
          measured.set(`${v},${k}`, w);
          if (!samples.has(k)) samples.set(k, []);
          samples.get(k).push({ x: mesh.x[v], y: mesh.y[v], ratio: w / Math.max(0.5, crowWalk(d)) });
        }),
      );
      onStatus?.(`Walking routes to stations… ${Math.round((100 * ++done) / batches.length)}%`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const access = (v, k, d) => {
    if (k === -1) k = DEST;
    if (d > WALK_RANGE) return stationAccess(d);
    const w = measured.get(`${v},${k}`);
    if (w != null) return Math.min(w, feeder(d));
    const list = samples.get(k);
    if (!list) return stationAccess(d);
    const x = mesh.x[v];
    const y = mesh.y[v];
    let bestD = Infinity;
    let ratio = 1;
    for (const smp of list) {
      const dd = (smp.x - x) ** 2 + (smp.y - y) ** 2;
      if (dd < bestD) {
        bestD = dd;
        ratio = smp.ratio;
      }
    }
    return Math.min(crowWalk(d) * ratio, feeder(d));
  };
  return { times: timesViaStations(mesh, stations, best, access), refined: measured.size };
}

async function trainTimes(dest, mesh, signal, onStatus, budget) {
  onStatus?.('Loading rail lines…');
  const net = await fetchNetwork(dest, mesh.radius * 1.15, signal);
  if (net && net.lines.length) {
    // Walk from the last station to the destination along real paths.
    let egress = new Map();
    try {
      onStatus?.('Walking routes from the destination…');
      egress = await realEgress(dest, net.stations, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('Egress walking routes failed:', err);
    }
    onStatus?.('Routing through the rail network…');
    const best = stationTimes(net, (s, k) => egress.get(k) ?? stationAccess(Math.hypot(s.x, s.y)));
    const idx = [];
    for (let k = 0; k < net.stations.length; k++) if (Number.isFinite(best[k])) idx.push(k);
    const stations = idx.map((k) => net.stations[k]);
    const bestList = idx.map((k) => best[k]);

    let times;
    let walkNote;
    try {
      const envelope = budget + Math.max(10, 0.25 * budget);
      const res = await refineAccess(dest, mesh, stations, bestList, envelope, signal, onStatus);
      times = res.times;
      walkNote = `${res.refined + egress.size} walking routes`;
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('Access walking routes failed:', err);
      times = timesViaStations(mesh, stations, bestList);
      walkNote = 'walking estimated';
    }
    return {
      times,
      source: `${net.lines.length} OSM rail lines, ${stations.length} stations, ${walkNote}`,
      stations,
      lines: net.lines.map((l) => ({ metro: l.metro, colour: l.colour, pts: l.seq.map((s) => net.stations[s]) })),
    };
  }
  // No route data: fall back to station locations only.
  onStatus?.('Finding train stations…');
  const stations = await fetchStations(dest, mesh.radius * 1.15, signal);
  if (stations && stations.length) {
    return {
      times: timesViaStations(mesh, stations, bestFromStationsOnly(stations)),
      source: `${stations.length} OSM stations (no line data) + rail speed model`,
      stations,
    };
  }
  return {
    times: heuristicTimes('train', mesh),
    source: stations ? 'No stations nearby — bus/walk estimate' : 'Rail lookup failed — estimate',
  };
}

// ---------------------------------------------------------------------------

export function heuristicTimes(mode, mesh) {
  const times = new Float32Array(mesh.count);
  for (let v = 0; v < mesh.count; v++) times[v] = heuristic(mode, mesh.r[v]);
  return times;
}

// Returns { times: Float32Array (per mesh vertex), source: string, stations?, lines? }
export async function computeTimes(dest, mode, mesh, signal, onStatus, budget = 60) {
  if (mode === 'train') return trainTimes(dest, mesh, signal, onStatus, budget);
  const res = await roadTimes(dest, mode, mesh, signal, onStatus);
  if (res) return res;
  return { times: heuristicTimes(mode, mesh), source: 'Routing servers unreachable — estimate' };
}
