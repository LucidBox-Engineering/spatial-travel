// Line-aware rail model built from OpenStreetMap route relations.
//
// Each train / metro / light-rail route relation lists its stops in order.
// Stops within a short walk of each other are merged into one station so
// lines that share a station form interchanges. The network graph has:
//
//   L(r, i)  "on line r at its i-th stop"        S(s)  "standing in station s"
//
//   L(r, i) -- ride --> L(r, i±1)     time = distance / line speed + dwell
//   S(s)    -- board -> L(r, i)        time = half the line's headway
//   L(r, i) -- alight -> S(s)          time = transfer penalty
//   L(r, i) -- exit  -> destination    time = walk / feeder from the station
//
// One reverse Dijkstra from the destination gives, for every station, the
// best time to the destination using only real lines and paying for waits and
// transfers. Map points then add the time to reach a station.

import { toLocal, bboxAround } from './geo.js?v=8';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const MERGE_DIST = 300; // metres: stops closer than this form one station
const TRANSFER = 3; // minutes to change between lines at a station

async function overpass(q, signal, timeoutMs) {
  for (const url of OVERPASS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`Overpass ${url} failed:`, err);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return null;
}

// Minutes from the "interval" tag (e.g. "10", "00:10", "PT10M"), or null.
function parseInterval(v) {
  if (!v) return null;
  let m = /^(\d+)$/.exec(v);
  if (m) return Number(m[1]);
  m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(v);
  if (m) return Number(m[1] || 0) * 60 + Number(m[2] || 0);
  return null;
}

// Cruise speed (km/h), dwell per stop (min) and typical headway (min).
function lineProfile(tags, avgStopGap) {
  const route = tags.route;
  const service = tags.service || '';
  let p;
  if (route === 'subway') p = { kmh: 40, dwell: 0.5, headway: 5, metro: true };
  else if (route === 'light_rail' || route === 'monorail') p = { kmh: 30, dwell: 0.4, headway: 8, metro: true };
  else if (service === 'high_speed') p = { kmh: 200, dwell: 2, headway: 60, metro: false };
  else if (/long_distance|night/.test(service)) p = { kmh: 110, dwell: 2, headway: 120, metro: false };
  else if (/regional/.test(service) || avgStopGap > 12000) p = { kmh: 85, dwell: 1, headway: 60, metro: false };
  else p = { kmh: 60, dwell: 1, headway: 20, metro: false }; // commuter / suburban
  const interval = parseInterval(tags.interval);
  if (interval) p.headway = interval;
  return p;
}

function parseNetwork(json, dest) {
  const nodes = new Map();
  const rels = [];
  for (const el of json.elements || []) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'relation') rels.push(el);
  }

  // Merge nearby stops into stations using a hash grid.
  const stations = [];
  const grid = new Map();
  const cellOf = (x, y) => [Math.floor(x / MERGE_DIST), Math.floor(y / MERGE_DIST)];
  function stationAt(x, y) {
    const [cx, cy] = cellOf(x, y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const s of grid.get(`${cx + dx},${cy + dy}`) || []) {
          if (Math.hypot(stations[s].x - x, stations[s].y - y) < MERGE_DIST) return s;
        }
      }
    }
    const s = stations.length;
    stations.push({ x, y, metro: false, lines: 0 });
    const key = `${cx},${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(s);
    return s;
  }

  const lines = [];
  for (const rel of rels) {
    const members = (rel.members || []).filter((m) => m.type === 'node' && nodes.has(m.ref));
    let stops = members.filter((m) => /^stop/.test(m.role));
    if (stops.length < 2) stops = members.filter((m) => /^platform/.test(m.role));
    if (stops.length < 2) continue;
    const seq = [];
    for (const m of stops) {
      const n = nodes.get(m.ref);
      const [x, y] = toLocal(dest, n.lat, n.lon);
      const s = stationAt(x, y);
      if (seq[seq.length - 1] !== s) seq.push(s);
    }
    if (seq.length < 2) continue;
    let total = 0;
    for (let i = 1; i < seq.length; i++) {
      total += Math.hypot(stations[seq[i]].x - stations[seq[i - 1]].x, stations[seq[i]].y - stations[seq[i - 1]].y);
    }
    const tags = rel.tags || {};
    const profile = lineProfile(tags, total / (seq.length - 1));
    for (const s of seq) {
      stations[s].lines++;
      if (profile.metro) stations[s].metro = true;
    }
    lines.push({ seq, ...profile, name: tags.ref || tags.name || '', colour: tags.colour || null });
  }
  return { stations, lines };
}

// Minimal binary heap keyed on Float64 distances.
class Heap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const k = this.k;
    const v = this.v;
    const topK = k[0];
    const topV = v[0];
    const lastK = k.pop();
    const lastV = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
}

// Reverse Dijkstra from the destination. Returns per-station minutes to the
// destination (Infinity if not connected) — the time from standing in the
// station, including the wait for the first train.
export function stationTimes(net, egress) {
  const { stations, lines } = net;
  const S = stations.length;
  // Line-node index: offset[r] + i
  const offset = [];
  let L = 0;
  for (const line of lines) {
    offset.push(L);
    L += line.seq.length;
  }
  const N = S + L;
  const dist = new Float64Array(N).fill(Infinity);
  const heap = new Heap();
  // Which line nodes sit at each station (for boarding edges).
  const atStation = Array.from({ length: S }, () => []);
  lines.forEach((line, r) => line.seq.forEach((s, i) => atStation[s].push(S + offset[r] + i)));
  const lineOf = new Int32Array(L);
  const stopOf = new Int32Array(L);
  lines.forEach((line, r) => line.seq.forEach((_, i) => ((lineOf[offset[r] + i] = r), (stopOf[offset[r] + i] = i))));

  // Exit edges: alight at a stop and walk / take a feeder to the destination.
  for (let s = 0; s < S; s++) {
    const e = egress(stations[s], s);
    for (const n of atStation[s]) {
      if (e < dist[n]) {
        dist[n] = e;
        heap.push(e, n);
      }
    }
  }

  while (heap.size) {
    const [d, n] = heap.pop();
    if (d > dist[n]) continue;
    if (n < S) {
      // Station: reached by alighting from any line here (+ transfer).
      for (const m of atStation[n]) {
        const nd = d + TRANSFER;
        if (nd < dist[m]) {
          dist[m] = nd;
          heap.push(nd, m);
        }
      }
      continue;
    }
    const ln = n - S;
    const r = lineOf[ln];
    const i = stopOf[ln];
    const line = lines[r];
    const s = line.seq[i];
    // Boarding this line at this station.
    const board = d + line.headway / 2;
    if (board < dist[s]) {
      dist[s] = board;
      heap.push(board, s);
    }
    // Riding from the neighbouring stops (both directions).
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= line.seq.length) continue;
      const a = stations[line.seq[j]];
      const b = stations[s];
      const ride = (Math.hypot(a.x - b.x, a.y - b.y) * 1.1) / ((line.kmh * 1000) / 60) + line.dwell;
      const m = S + offset[r] + j;
      const nd = d + ride;
      if (nd < dist[m]) {
        dist[m] = nd;
        heap.push(nd, m);
      }
    }
  }
  return dist.subarray(0, S);
}

export async function fetchNetwork(dest, radius, signal) {
  const b = bboxAround(dest, radius);
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  // At inter-city scale only heavy rail lines; locally include metro and
  // light rail too.
  const regional = radius > 150000;
  const routes = regional ? 'train' : 'train|subway|light_rail|monorail';
  const q = `[out:json][timeout:${regional ? 90 : 40}];
rel["type"="route"]["route"~"^(${routes})$"](${bbox})->.routes;
.routes out body;
node(r.routes);
out skel qt;`;
  const json = await overpass(q, signal, regional ? 100000 : 50000);
  if (!json) return null;
  return parseNetwork(json, dest);
}
