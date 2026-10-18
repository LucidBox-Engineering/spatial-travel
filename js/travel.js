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

import { fromLocal, toLocal, bboxAround } from './geo.js';

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
  let hi = 400000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (heuristic(mode, mid) < minutes) lo = mid;
    else hi = mid;
  }
  return lo;
}

// The fetched area depends on a bucketed budget so that small slider moves can
// reuse the same data.
const BUCKETS = [10, 20, 30, 45, 60, 90, 120];

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
        return sec / 60 + Math.min(90, snap / 70);
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
        onStatus?.(`Fetching ${MODES[mode].label.toLowerCase()} times from ${provider.name}… ${Math.round((100 * done) / samples.length)}%`);
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
// Train: OSM stations + a station-to-station model.

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function fetchStations(dest, radius, signal) {
  const b = bboxAround(dest, radius);
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  const q = `[out:json][timeout:25];(
    nwr["railway"~"^(station|halt)$"](${bbox});
    nwr["public_transport"="station"]["train"="yes"](${bbox});
    nwr["station"~"^(subway|light_rail)$"](${bbox});
  );out center tags;`;
  for (const url of OVERPASS) {
    try {
      const json = await fetchJson(url, signal, 30000, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const stations = [];
      for (const el of json.elements || []) {
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat == null) continue;
        const t = el.tags || {};
        if (t.railway === 'tram_stop' || t.station === 'tram' || t.disused || t['abandoned:railway']) continue;
        const [x, y] = toLocal(dest, lat, lng);
        const metro = t.station === 'subway' || t.subway === 'yes' || t.station === 'light_rail';
        // de-duplicate station nodes / areas mapped twice
        if (stations.some((s) => Math.hypot(s.x - x, s.y - y) < 150)) continue;
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

function trainTimes(mesh, stations) {
  const WAIT = 6;
  const byEgress = stations
    .map((s) => ({ s, egress: stationAccess(Math.hypot(s.x, s.y)) }))
    .sort((p, q) => p.egress - q.egress)
    .slice(0, 10);
  const best = new Float64Array(stations.length);
  stations.forEach((a, k) => {
    let m = Infinity;
    for (const { s, egress } of byEgress) m = Math.min(m, (a === s ? 0 : rideTime(a, s)) + egress);
    best[k] = m + WAIT;
  });
  const times = new Float32Array(mesh.count);
  for (let v = 0; v < mesh.count; v++) {
    const x = mesh.x[v];
    const y = mesh.y[v];
    // Soft minimum over "walk directly" and every station, so station
    // catchment boundaries blend instead of forming sharp creases.
    const TAU = 1.5;
    let m = stationAccess(Math.hypot(x, y));
    let sum = 1;
    for (let k = 0; k < stations.length; k++) {
      const s = stations[k];
      const c = stationAccess(Math.hypot(x - s.x, y - s.y)) + best[k];
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

export function heuristicTimes(mode, mesh) {
  const times = new Float32Array(mesh.count);
  for (let v = 0; v < mesh.count; v++) times[v] = heuristic(mode, mesh.r[v]);
  return times;
}

// Returns { times: Float32Array (per mesh vertex), source: string, stations? }
export async function computeTimes(dest, mode, mesh, signal, onStatus) {
  if (mode === 'train') {
    onStatus?.('Fetching rail & metro stations from OpenStreetMap…');
    const stations = await fetchStations(dest, mesh.radius * 1.15, signal);
    if (stations && stations.length) {
      return {
        times: trainTimes(mesh, stations),
        source: `${stations.length} OSM stations + rail speed model`,
        stations,
      };
    }
    return {
      times: heuristicTimes(mode, mesh),
      source: stations ? 'No stations nearby — bus/walk estimate' : 'Station lookup failed — estimate',
    };
  }
  const res = await roadTimes(dest, mode, mesh, signal, onStatus);
  if (res) return res;
  return { times: heuristicTimes(mode, mesh), source: 'Routing servers unreachable — estimate' };
}
