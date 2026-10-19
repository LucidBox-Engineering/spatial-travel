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

import { fromLocal, toLocal, bboxAround, EARTH_CIRC } from './geo.js?v=35';
import { fetchNetwork, stationTimes, overpass } from './transit.js?v=35';
import { cached, DAY } from './cache.js?v=35';

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

// Getting to / from a station on foot. Train mode is "walk + train": a walk
// longer than the user's max walk (default 15 min) is effectively not an
// option, rather than getting an imagined bus ride. (An
// earlier feeder-bus assumption at 18 km/h in a straight line produced
// perfect circles that ignored rivers.)
export const UNREACHABLE = 1e4; // minutes; shown as "not reachable"
const STATION_WALK_M_PER_MIN = 75; // along streets, 1.25 x crow-fly
let maxWalk = 15;
export function setMaxWalk(min) {
  maxWalk = min;
}
const walkRange = () => (maxWalk * STATION_WALK_M_PER_MIN) / 1.25; // crow-fly metres

// Past the max walk each extra minute costs 20, so such places fall outside
// any sensible budget almost immediately. It's steep rather than a hard
// jump so the map's boundary interpolates to the right place between grid
// points instead of shrinking to jagged blobs.
const OVER_WALK_PENALTY = 20;
function walkCost(t) {
  return t <= maxWalk ? t : Math.min(UNREACHABLE, maxWalk + (t - maxWalk) * OVER_WALK_PENALTY);
}

function stationAccess(d) {
  return walkCost((d * 1.25) / STATION_WALK_M_PER_MIN);
}

function trainHeuristic(d) {
  // Only used to size the area and as a no-data fallback.
  return Math.min((d * 1.25) / STATION_WALK_M_PER_MIN, 12 + (d * 1.25) / (45000 / 60));
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
export const BUCKETS = [10, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720];

export function extentFor(mode, budget) {
  const bucket = BUCKETS.find((b) => b >= budget) ?? BUCKETS[BUCKETS.length - 1];
  return { bucket, radius: Math.max(400, 1.8 * heuristicReach(mode, bucket)) };
}

// ---------------------------------------------------------------------------
// Network helpers

// The free OSM-community services we call (FOSSGIS routing, the OSRM demo,
// Nominatim) rate-limit per client (HTTP 429), so requests to them are
// spaced out, a 429 is retried once after the server's
// Retry-After, and repeated 429s pause all requests to it for a while (callers
// then fall back to estimates). Successful responses are cached (see
// cache.js) so revisiting a destination doesn't re-request.
const throttle = (gap) => ({ base: gap, gap, next: 0, chain: Promise.resolve(), pausedUntil: 0 });
const THROTTLED = {
  'routing.openstreetmap.de': throttle(1500), // FOSSGIS OSRM (walk/drive/train walking)
  'valhalla1.openstreetmap.de': throttle(1100), // FOSSGIS Valhalla fallback
  'router.project-osrm.org': throttle(1100), // OSRM demo server fallback
  'nominatim.openstreetmap.org': throttle(1100), // usage policy: max 1 request/second
  'api.transitous.org': throttle(2000), // community service; one-to-all is expensive
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request in flight per host, and request starts at least `gap` apart.
// (Overlapping requests to the FOSSGIS router were what drew 429s: it
// limits concurrent requests per client, not just their rate.)
async function takeSlot(th) {
  const prev = th.chain;
  let release;
  th.chain = new Promise((r) => (release = r));
  await prev;
  const wait = th.next - Date.now();
  if (wait > 0) await sleep(wait);
  th.next = Date.now() + th.gap;
  return release;
}

export async function fetchJson(url, signal, timeoutMs = 20000, init = {}) {
  const th = THROTTLED[new URL(url).host];
  // Routing responses are cached for a week (memory + IndexedDB).
  if (th && !init.method) return cached(`http:${url}`, 7 * DAY, () => fetchJsonNet(url, signal, timeoutMs, init, th));
  return fetchJsonNet(url, signal, timeoutMs, init, th);
}

async function fetchJsonNet(url, signal, timeoutMs, init, th) {
  for (let attempt = 0; ; attempt++) {
    let release = () => {};
    if (th) {
      if (Date.now() < th.pausedUntil) throw new Error('rate limited: pausing requests');
      release = await takeSlot(th);
      if (signal?.aborted) {
        release();
        throw new DOMException('Aborted', 'AbortError');
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.status === 429 && th) {
        const retryAfter = Number(res.headers.get('Retry-After')) || 0;
        const wait = Math.max(2000, retryAfter * 1000);
        // Slow down for everyone, not just this request.
        th.gap = Math.min(5000, th.gap * 2);
        if (attempt === 0 && wait <= 10000) {
          th.next = Date.now() + wait;
          continue;
        }
        th.pausedUntil = Date.now() + Math.max(30000, wait);
        throw new Error('HTTP 429');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (th) th.gap = Math.max(th.base, th.gap * 0.9); // ease back after backing off
      return await res.json();
    } finally {
      release();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
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


async function fetchStations(dest, radius, signal) {
  const b = bboxAround(dest, radius);
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  // Inter-city extents: only proper rail stations (no halts or metro), and
  // thinned to one per grid cell so the model stays fast.
  const regional = radius > 150000;
  const q = regional
    ? `[out:json][timeout:110];(
    nwr["railway"="station"]["station"!~"^(subway|light_rail|monorail|funicular|tram|miniature)$"](${bbox});
  );out center tags;`
    : `[out:json][timeout:50];(
    nwr["railway"~"^(station|halt)$"](${bbox});
    nwr["public_transport"="station"]["train"="yes"](${bbox});
    nwr["station"~"^(subway|light_rail)$"](${bbox});
  );out center tags;`;
  const cell = Math.max(150, radius / 70);
  const key = `stations:${dest.lat.toFixed(4)},${dest.lng.toFixed(4)}:${Math.round(radius)}`;
  return cached(key, 7 * DAY, async () => {
    const json = await overpass(q, signal, regional ? 120000 : 60000);
    if (!json) return null;
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
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      stations.push({ x, y, metro, name: t.name || '' });
    }
    return stations;
  });
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

// Travel-time field from stations: at any point, a soft minimum over "walk
// straight to the destination" and "walk to station k, then best[k] from
// there", so catchment boundaries blend instead of forming sharp creases.
// `access(x, y, k, d)` is the time from (x, y) to station k (k = -1: straight
// to the destination); d is crow-fly metres. Stations are binned so a point
// only looks at stations it could plausibly walk to.
const crowAccess = (x, y, k, d) => stationAccess(d);

function makeStationField(stations, best, access = crowAccess) {
  const TAU = 1.5;
  const cell = Math.max(200, walkRange());
  const reach = 2; // bins in each direction (covers the over-walk penalty slope)
  const bins = new Map();
  stations.forEach((s, k) => {
    const key = `${Math.floor(s.x / cell)},${Math.floor(s.y / cell)}`;
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(k);
  });
  return (x, y) => {
    let m = access(x, y, -1, Math.hypot(x, y));
    let sum = 1;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let i = -reach; i <= reach; i++) {
      for (let j = -reach; j <= reach; j++) {
        const list = bins.get(`${cx + i},${cy + j}`);
        if (!list) continue;
        for (const k of list) {
          const s = stations[k];
          const c = access(x, y, k, Math.hypot(x - s.x, y - s.y)) + best[k];
          if (c < m) {
            sum = sum * Math.exp((c - m) / TAU) + 1;
            m = c;
          } else if (c - m < 12 * TAU) {
            sum += Math.exp((m - c) / TAU);
          }
        }
      }
    }
    return Math.max(0, m - TAU * Math.log(sum));
  };
}

// Field sampled at the mesh vertices (for the warp); the field itself rides
// along as `.field` for the fine shading grid.
function timesViaStations(mesh, stations, best, access = crowAccess) {
  const field = makeStationField(stations, best, access);
  const times = new Float32Array(mesh.count);
  for (let v = 0; v < mesh.count; v++) times[v] = field(mesh.x[v], mesh.y[v]);
  times.field = field;
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
//   3. the area is tiled and each tile sends one many-to-many OSRM foot
//      "table" request (sample points x the stations they could use), at
//      most MAX_REQUESTS of them, rate-limited, stopping at a time deadline;
//      the results become per-station detour ratios;
//   4. every vertex near a sampled station uses the measured time if it was
//      sampled, otherwise the crow-fly estimate scaled by the ratio of the
//      nearest sample for that station.

const INTERCITY_RADIUS = 150000; // fetch radius in metres; same as the mainline-only switch in transit.js
const FOOT_TABLE = 'https://routing.openstreetmap.de/routed-foot/table/v1/foot';
const MAX_COORDS = 100; // per OSRM table request
const MAX_REQUESTS = 8;
const MAX_TARGETS = 15; // stations per request
const MAX_SOURCES = 50; // sample points per request (keeps each table ~750 pairs; big ones drew 429s)
const CONCURRENCY = 2; // the shared throttle spaces request starts anyway
const DEADLINE_MS = 12000; // stop issuing requests after this; unsampled pairs are interpolated
const crowWalk = (d) => (d * 1.25) / STATION_WALK_M_PER_MIN;
const capWalk = walkCost;

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
    if (Math.hypot(s.x, s.y) <= walkRange()) near.push(k);
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

// Measured walks per station (keyed by its rounded coordinates), shared
// across reloads in this page: [{ lat, lng, w (minutes) }].
const walkSamples = new Map();
let walkSampleCount = 0;

async function refineAccess(dest, mesh, stations, best, envelope, signal, onStatus) {
  const first = timesViaStations(mesh, stations, best);
  const DEST = stations.length; // pseudo-station: walk straight to the destination
  const pos = (k) => (k === DEST ? { x: 0, y: 0 } : stations[k]);
  const bestOf = (k) => (k === DEST ? 0 : best[k]);

  // Stations in walking range of each vertex in the envelope band.
  const vcands = new Map(); // vertex id -> candidate stations
  const grid = new Map();
  stations.forEach((s, k) => {
    const key = `${Math.floor(s.x / walkRange())},${Math.floor(s.y / walkRange())}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(k);
  });
  const nearby = (x, y) => {
    const cx = Math.floor(x / walkRange());
    const cy = Math.floor(y / walkRange());
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(grid.get(`${cx + dx},${cy + dy}`) || []));
    return out;
  };
  for (let v = 0; v < mesh.count; v++) {
    if (first[v] > envelope) continue;
    const x = mesh.x[v];
    const y = mesh.y[v];
    const cands = nearby(x, y);
    if (Math.hypot(x, y) <= walkRange()) cands.push(DEST);
    for (const k of cands) {
      const p = pos(k);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d > walkRange()) continue;
      // Only stations that could plausibly be this vertex's best choice.
      if (crowWalk(d) + bestOf(k) > first[v] + 10) continue;
      if (!vcands.has(v)) vcands.set(v, []);
      vcands.get(v).push(k);
    }
  }
  if (!vcands.size) return { times: first, refined: 0 };

  // samples[k] = list of { x, y, ratio } measured around station k
  const samples = new Map();
  const measured = new Map(); // `${x},${y},${k}` -> minutes
  const ll = (x, y) => fromLocal(dest, x, y);
  const stationKey = (k) => {
    const b = k === DEST ? dest : ll(pos(k).x, pos(k).y);
    return `${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
  };
  const record = (x, y, k, w) => {
    const p = pos(k);
    const d = Math.hypot(x - p.x, y - p.y);
    if (d > walkRange()) return;
    measured.set(`${Math.round(x)},${Math.round(y)},${k}`, w);
    if (!samples.has(k)) samples.set(k, []);
    samples.get(k).push({ x, y, ratio: w / Math.max(0.5, crowWalk(d)) });
  };
  // Walks measured by earlier runs (before a max-walk or budget change) are
  // reused. A vertex only needs a new request for a station with no
  // measured walk nearby, since ratios come from the nearest sample.
  for (let k = 0; k <= DEST; k++) {
    for (const smp of walkSamples.get(stationKey(k)) || []) {
      const [x, y] = toLocal(dest, smp.lat, smp.lng);
      record(x, y, k, smp.w);
    }
  }
  const cover = walkRange() / 3;
  for (const [v, cands] of vcands) {
    const missing = cands.filter((k) => !(samples.get(k) || []).some((smp) => Math.hypot(smp.x - mesh.x[v], smp.y - mesh.y[v]) < cover));
    if (missing.length) vcands.set(v, missing);
    else vcands.delete(v);
  }

  // Batch spatially: split the area into square tiles and send one
  // many-to-many request per tile (its sample points x the stations they
  // could use). Each request then returns up to ~2,000 useful pairs instead
  // of ~100. Tiles grow until there are at most MAX_REQUESTS of them, or
  // fewer when only a few points are left to measure (after reuse).
  const maxTiles = Math.min(MAX_REQUESTS, Math.max(1, Math.ceil(vcands.size / 25)));
  let tile = 2000;
  let tiles;
  for (;;) {
    tiles = new Map();
    for (const v of vcands.keys()) {
      const key = `${Math.floor(mesh.x[v] / tile)},${Math.floor(mesh.y[v] / tile)}`;
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push(v);
    }
    if (tiles.size <= maxTiles) break;
    tile *= 1.3;
  }
  const batches = [];
  for (const verts of tiles.values()) {
    // The stations most of this tile's points could use.
    const count = new Map();
    for (const v of verts) for (const k of vcands.get(v)) count.set(k, (count.get(k) || 0) + 1);
    const targets = [...count.keys()].sort((p, q) => count.get(q) - count.get(p)).slice(0, MAX_TARGETS);
    const chosen = new Set(targets);
    const usable = verts.filter((v) => vcands.get(v).some((k) => chosen.has(k)));
    const n = Math.min(usable.length, MAX_SOURCES, MAX_COORDS - targets.length);
    const sources = Array.from({ length: n }, (_, i) => usable[Math.floor((i * usable.length) / n)]);
    if (sources.length && targets.length) batches.push({ targets, sources });
  }
  // Nearest the destination first: those matter most if we run out of time.
  batches.sort((p, q) => Math.hypot(mesh.x[p.sources[0]], mesh.y[p.sources[0]]) - Math.hypot(mesh.x[q.sources[0]], mesh.y[q.sources[0]]));

  let done = 0;
  const queue = batches.slice();
  const deadline = performance.now() + DEADLINE_MS;
  const worker = async () => {
    while (queue.length && performance.now() < deadline) {
      const b = queue.shift();
      const src = b.sources;
      let m;
      try {
        m = await footMatrix(
          src.map((v) => ll(mesh.x[v], mesh.y[v])),
          b.targets.map((k) => (k === DEST ? dest : ll(pos(k).x, pos(k).y))),
          signal,
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn('Walking-route batch failed:', err);
        continue; // other batches still help; gaps are interpolated
      } finally {
        onStatus?.(`Walking routes to stations… ${Math.round((100 * ++done) / batches.length)}%`);
      }
      src.forEach((v, i) =>
        b.targets.forEach((k, j) => {
          const w = m[i][j];
          if (!Number.isFinite(w)) return;
          const key = stationKey(k);
          if (!walkSamples.has(key)) walkSamples.set(key, []);
          const a = ll(mesh.x[v], mesh.y[v]);
          walkSamples.get(key).push({ lat: a.lat, lng: a.lng, w });
          if (++walkSampleCount > 200000) (walkSamples.clear(), (walkSampleCount = 0)); // keep memory bounded
          record(mesh.x[v], mesh.y[v], k, w);
        }),
      );
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const access = (x, y, k, d) => {
    if (k === -1) k = DEST;
    if (d > walkRange()) return stationAccess(d);
    // Measured walking routes become per-station detour ratios; use the
    // nearest measured point's ratio (exact at measured points).
    const list = samples.get(k);
    if (!list) return stationAccess(d);
    let bestD = Infinity;
    let ratio = 1;
    for (const smp of list) {
      const dd = (smp.x - x) ** 2 + (smp.y - y) ** 2;
      if (dd < bestD) {
        bestD = dd;
        ratio = smp.ratio;
      }
    }
    return capWalk(crowWalk(d) * ratio);
  };
  return { times: timesViaStations(mesh, stations, best, access), refined: measured.size };
}

// ---------------------------------------------------------------------------
// Train via Transitous (https://transitous.org): a community-run MOTIS
// journey planner over public GTFS timetables. One "one-to-all" request with
// arriveBy=true returns every stop from which the destination can be reached
// within maxTravelTime, with the fastest door-to-destination duration
// (including transfers and the final walk). That replaces the OSM rail-line
// model's guessed speeds and headways with real timetables.

const TRANSITOUS = 'https://api.transitous.org';
const TRANSITOUS_VERSIONS = ['v6', 'v5', 'v4', 'v3', 'v2', 'v1']; // newest first; servers lag MOTIS master
// "RAIL" = high-speed, long-distance, night, regional, suburban and subway;
// TRAM adds light rail such as Calgary's CTrain.
const TRAIN_MODES = 'RAIL,TRAM';
const RAIL_MODES = new Set([
  'RAIL', 'HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL', 'REGIONAL_RAIL', 'REGIONAL_FAST_RAIL',
  'SUBURBAN', 'SUBWAY', 'METRO', 'TRAM',
]);

// Google encoded polyline -> [[lat, lng], ...]
function decodePolyline(str, precision) {
  const f = Math.pow(10, precision || 6);
  const out = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < str.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lng += d;
    }
    out.push([lat / f, lng / f]);
  }
  return out;
}

// Rail/tram route shapes in the area, for drawing the lines on the map
// (MOTIS "experimental/map/routes"; optional - failures just mean no lines).
// Distinct, readable line colours for when GTFS colours are missing or clash.
const LINE_PALETTE = ['#e6194b', '#4363d8', '#3cb44b', '#f58231', '#911eb4', '#0aa5b5', '#f032e6', '#9a6324', '#808000', '#000075', '#e6a100', '#469990'];

// Bounding box (lat/lng) of local points, padded by `pad` metres.
function bboxOfPoints(dest, pts, pad) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const sw = fromLocal(dest, minX - pad, minY - pad);
  const ne = fromLocal(dest, maxX + pad, maxY + pad);
  return { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng, span: Math.max(maxX - minX, maxY - minY) + 2 * pad };
}

async function fetchRoutes(dest, b, signal) {
  const zoom = Math.max(6, Math.min(15, Math.round(Math.log2((EARTH_CIRC * Math.cos((dest.lat * Math.PI) / 180)) / b.span) + 3)));
  const q = new URLSearchParams({ zoom: String(zoom), min: `${b.south.toFixed(5)},${b.west.toFixed(5)}`, max: `${b.north.toFixed(5)},${b.east.toFixed(5)}` });
  return fetchJson(`${TRANSITOUS}/api/experimental/map/routes?${q}`, signal, 30000);
}

const MAX_HOP = 1500; // metres

// Rail/tram route shapes around the reachable stops, for drawing the lines
// (MOTIS "experimental/map/routes"; optional - failures just mean no lines).
// Returns { lines: [{ pts, routes: [key] }], legend: [{ key, name, colour }] }.
async function transitousLines(dest, stops, signal) {
  // 422 = area too big for the server: retry around the quickest 60%, then
  // 35%, of the stations (the ones that matter most for the warp).
  const byTime = [...stops].sort((a, b) => a.best - b.best);
  let json;
  for (const frac of [1, 0.6, 0.35]) {
    const subset = byTime.slice(0, Math.max(2, Math.ceil(byTime.length * frac)));
    try {
      json = await fetchRoutes(dest, bboxOfPoints(dest, subset, frac === 1 ? 1500 : 800), signal);
      break;
    } catch (err) {
      if (!/HTTP 422/.test(err.message) || frac === 0.35) throw err;
    }
  }
  const routes = json.routes || [];
  // One legend entry per named line (directions / variants share a name).
  const legend = new Map();
  const keyOf = (r) => {
    const tr = r.transitRoutes?.[0] || {};
    const name = tr.shortName || tr.longName || `Line ${r.routeIdx ?? ''}`.trim();
    if (!legend.has(name)) legend.set(name, { key: name, name, gtfs: tr.color ? `#${tr.color.replace(/^#/, '')}` : null, mode: r.mode });
    return name;
  };
  const lines = [];
  for (const pl of json.polylines || []) {
    // Routes without real geometry (pathSource NONE) are drawn by MOTIS as
    // straight stop-to-stop lines - across water, through buildings. Skip
    // them; their stations still show.
    const rail = (pl.routeIndexes || [])
      .map((i) => routes[i])
      .filter((r) => r && RAIL_MODES.has(r.mode) && r.pathSource !== 'NONE');
    if (!rail.length || !pl.polyline?.points) continue;
    const keys = [...new Set(rail.map(keyOf))];
    const pts = decodePolyline(pl.polyline.points, pl.polyline.precision).map(([la, ln]) => {
      const [x, y] = toLocal(dest, la, ln);
      return { x, y };
    });
    // Belt and braces: real track shapes have points every few hundred
    // metres at most, so break the line at any single straight hop longer
    // than MAX_HOP (a stop-to-stop shortcut) and drop that hop.
    let run = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) > MAX_HOP) {
        if (run.length > 1) lines.push({ pts: run, routes: keys });
        run = [];
      }
      run.push(pts[i]);
    }
    if (run.length > 1) lines.push({ pts: run, routes: keys });
  }
  // Use GTFS colours when every line has one and they're all different;
  // otherwise assign palette colours so lines can be told apart.
  const entries = [...legend.values()].filter((e) => lines.some((l) => l.routes.includes(e.key)));
  const gtfs = entries.map((e) => e.gtfs);
  const useGtfs = gtfs.every(Boolean) && new Set(gtfs.map((c) => c.toLowerCase())).size === gtfs.length;
  entries.forEach((e, i) => (e.colour = useGtfs ? e.gtfs : LINE_PALETTE[i % LINE_PALETTE.length]));
  const colourOf = new Map(entries.map((e) => [e.key, e.colour]));
  for (const l of lines) l.colours = l.routes.map((k) => colourOf.get(k));
  return { lines, legend: entries.map(({ name, colour }) => ({ name, colour })) };
}

// Arrive by 09:00 on the next weekday (browser local time) - a typical
// commute, and a stable URL so results cache well.
function nextWeekdayNine() {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

async function transitousStops(dest, maxMinutes, signal) {
  const when = nextWeekdayNine();
  const params = (minutes) =>
    new URLSearchParams({
      one: `${dest.lat.toFixed(6)},${dest.lng.toFixed(6)}`,
      arriveBy: 'true',
      time: when.toISOString(),
      maxTravelTime: String(minutes),
      transitModes: TRAIN_MODES,
      // the walk from the last station to the destination
      maxPostTransitTime: String(Math.round(maxWalk * 60)),
    });
  let json = null;
  let lastErr = null;
  outer: for (const version of TRANSITOUS_VERSIONS) {
    for (const minutes of [maxMinutes, Math.min(maxMinutes, 90)].filter((m, i, a) => a.indexOf(m) === i)) {
      try {
        json = await fetchJson(`${TRANSITOUS}/api/${version}/one-to-all?${params(minutes)}`, signal, 60000);
        break outer;
      } catch (err) {
        if (signal?.aborted) throw err;
        lastErr = err;
        if (/HTTP 404/.test(err.message)) continue outer; // endpoint version not deployed
        if (/HTTP 4\d\d/.test(err.message)) continue; // maybe over the server's travel-time limit
        throw err; // network / 5xx: give up on Transitous
      }
    }
  }
  if (!json) throw lastErr || new Error('Transitous: no usable endpoint');
  // Keep rail/tram stops reached by at least one ride (k >= 1). Without this
  // filter the result includes every bus stop within walking distance of a
  // station, and walk-only places near the destination.
  const all = (json.all || []).filter((r) => {
    if (!r.place || !Number.isFinite(r.place.lat) || !Number.isFinite(r.duration)) return false;
    if (r.k != null && r.k < 1) return false;
    const modes = r.place.modes;
    return !Array.isArray(modes) || !modes.length || modes.some((m) => RAIL_MODES.has(m));
  });
  // `duration` is documented only as "total travel duration"; MOTIS reports
  // minutes, but guard against seconds.
  const maxD = Math.max(0, ...all.map((r) => r.duration));
  const toMin = maxD > maxMinutes * 3 ? 1 / 60 : 1;
  // One entry per station: group platforms by GTFS parent station, else merge
  // stops within 150 m. Position = mean of the platforms, time = fastest.
  const MERGE = 150;
  const stops = [];
  const byParent = new Map();
  const grid = new Map();
  for (const r of all) {
    const [x, y] = toLocal(dest, r.place.lat, r.place.lon);
    const best = r.duration * toMin;
    let hit = r.place.parentId ? byParent.get(r.place.parentId) : null;
    const cx = Math.floor(x / MERGE);
    const cy = Math.floor(y / MERGE);
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        hit = (grid.get(`${cx + dx},${cy + dy}`) || []).find((s) => Math.hypot(s.x - x, s.y - y) < MERGE) || null;
      }
    }
    if (hit) {
      hit.n++;
      hit.x += (x - hit.x) / hit.n;
      hit.y += (y - hit.y) / hit.n;
      hit.best = Math.min(hit.best, best);
      continue;
    }
    const metro = Array.isArray(r.place.modes) && r.place.modes.some((m) => m === 'SUBWAY' || m === 'TRAM');
    const stop = { x, y, n: 1, best, k: r.k ?? null, name: r.place.name || '', metro, lines: 1 };
    stops.push(stop);
    if (r.place.parentId) byParent.set(r.place.parentId, stop);
    const key = `${cx},${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(stop);
  }
  return { stops, when };
}

async function trainTimesTransitous(dest, mesh, signal, onStatus, budget) {
  onStatus?.('Asking Transitous for timetable routes…');
  const { stops, when } = await transitousStops(dest, Math.ceil(budget * 1.3), signal);
  const label = `Transitous timetables (arrive ${when.toLocaleDateString(undefined, { weekday: 'short' })} 09:00)`;
  if (!stops.length) {
    // Transitous answered: no rail/tram within walking distance of the
    // destination. That's a real answer, so don't fall back to Overpass.
    return { times: timesViaStations(mesh, [], []), source: `${label}: no rail or tram within walking distance of the destination`, stations: [] };
  }
  onStatus?.('Loading line shapes…');
  const shapes = await transitousLines(dest, stops, signal).catch((err) => {
    if (signal?.aborted) throw err;
    console.warn('Transitous route shapes unavailable:', err);
    return { lines: null, legend: null };
  });
  const best = stops.map((s) => s.best);
  const base = { stations: stops, lines: shapes.lines, legend: shapes.legend };
  const src = `${label}, ${stops.length} stations`;
  const intercity = mesh.radius * 1.15 > INTERCITY_RADIUS;
  if (intercity) return { ...base, times: timesViaStations(mesh, stops, best), source: `${src}, walking estimated` };
  try {
    const envelope = budget + Math.max(10, 0.25 * budget);
    const res = await refineAccess(dest, mesh, stops, best, envelope, signal, onStatus);
    return { ...base, times: res.times, source: `${src}, ${res.refined} walking routes` };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ...base, times: timesViaStations(mesh, stops, best), source: `${src}, walking estimated` };
  }
}

async function trainTimes(dest, mesh, signal, onStatus, budget) {
  // Prefer real timetables; fall back to the OSM rail-line model.
  try {
    const res = await trainTimesTransitous(dest, mesh, signal, onStatus, budget);
    if (res) return res;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('Transitous failed, falling back to OSM rail lines:', err);
  }
  return trainTimesOsm(dest, mesh, signal, onStatus, budget);
}

async function trainTimesOsm(dest, mesh, signal, onStatus, budget) {
  onStatus?.('Loading rail lines…');
  const fetchRadius = mesh.radius * 1.15;
  const net = await fetchNetwork(dest, fetchRadius, signal);
  if (net && net.lines.length) {
    // At inter-city scale (the same threshold that switches to mainline
    // rail only) a few minutes of walking detour barely matters, so skip
    // the walking-route requests and use crow-fly estimates.
    const intercity = fetchRadius > INTERCITY_RADIUS;
    // Walk from the last station to the destination along real paths.
    let egress = new Map();
    if (!intercity) {
      try {
        onStatus?.('Walking routes from the destination…');
        egress = await realEgress(dest, net.stations, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn('Egress walking routes failed:', err);
      }
    }
    onStatus?.('Routing through the rail network…');
    const best = stationTimes(net, (s, k) => (egress.has(k) ? capWalk(egress.get(k)) : stationAccess(Math.hypot(s.x, s.y))));
    const idx = [];
    for (let k = 0; k < net.stations.length; k++) if (Number.isFinite(best[k])) idx.push(k);
    const stations = idx.map((k) => ({ ...net.stations[k], best: best[k] }));
    const bestList = idx.map((k) => best[k]);

    let times;
    let walkNote;
    if (intercity) {
      times = timesViaStations(mesh, stations, bestList);
      walkNote = 'walking estimated (inter-city)';
    } else {
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
    }
    return {
      times,
      source: `${net.lines.length} OSM rail lines, ${stations.length} stations, ${walkNote}`,
      stations,
      lines: net.lines.map((l) => ({ metro: l.metro, colour: l.colour, pts: l.seq.map((s) => net.stations[s]) })),
    };
  }
  // Every Overpass instance failed: don't queue another heavy query against
  // the same busy servers; report the failure so the UI can offer a retry.
  if (net === null) return { failed: true, source: 'Rail data servers are busy' };
  // Area has no route data: fall back to station locations only.
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
// or { failed: true, source } when the data servers could not be reached.
export async function computeTimes(dest, mode, mesh, signal, onStatus, budget = 60, opts = {}) {
  if (mode === 'train') {
    setMaxWalk(opts.maxWalk ?? 15);
    const res = await trainTimes(dest, mesh, signal, onStatus, budget);
    if (res.times?.field) res.field = res.times.field;
    return res;
  }
  const res = await roadTimes(dest, mode, mesh, signal, onStatus);
  if (res) return res;
  return { failed: true, source: 'Routing servers are busy' };
}
