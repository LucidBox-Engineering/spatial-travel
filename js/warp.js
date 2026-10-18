// Polar mesh around the destination and the two time-based warps.
//
// The mesh is a set of rings (radius) x rays (bearing) centred on the
// destination. Every vertex keeps its geographic position and gets two warped
// positions along the same bearing:
//
//  - distance warp: radius proportional to travel time, so every location
//    reached in time t sits on the circle of radius k * t.
//  - size warp: the local radial scale is a decreasing function of travel time
//    (integrated outward along each ray), so quickly-reached places are
//    magnified and slow-to-reach places are shrunk.

const TAU = Math.PI * 2;

export function createMesh(radius, NT = 128, NR = 56) {
  const count = 1 + NT * NR;
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const r = new Float64Array(count);
  const theta = new Float64Array(count);
  const radii = new Float64Array(NR + 1);
  for (let j = 1; j <= NR; j++) radii[j] = radius * Math.pow(j / NR, 1.35);
  for (let j = 1; j <= NR; j++) {
    for (let i = 0; i < NT; i++) {
      const v = 1 + (j - 1) * NT + i;
      const th = (TAU * i) / NT;
      theta[v] = th;
      r[v] = radii[j];
      x[v] = radii[j] * Math.sin(th);
      y[v] = radii[j] * Math.cos(th);
    }
  }
  const idx = (j, i) => (j === 0 ? 0 : 1 + (j - 1) * NT + (i % NT));
  const tris = [];
  for (let i = 0; i < NT; i++) tris.push(0, idx(1, i), idx(1, i + 1));
  for (let j = 1; j < NR; j++) {
    for (let i = 0; i < NT; i++) {
      const a = idx(j, i);
      const b = idx(j + 1, i);
      const c = idx(j + 1, i + 1);
      const d = idx(j, i + 1);
      tris.push(a, b, c, a, c, d);
    }
  }
  return { radius, NT, NR, count, x, y, r, theta, radii, idx, indices: new Uint16Array(tris) };
}

function median(arr) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Light angular smoothing, then make time non-decreasing along each ray so
// the warped mesh never folds over itself.
function monotoneTimes(mesh, times) {
  const { NT, NR, idx, radii, radius } = mesh;
  const sm = new Float64Array(mesh.count);
  sm[0] = 0;
  for (let j = 1; j <= NR; j++) {
    for (let i = 0; i < NT; i++) {
      sm[idx(j, i)] =
        (times[idx(j, i + NT - 1)] + 2 * times[idx(j, i)] + times[idx(j, i + 1)]) / 4;
    }
  }
  const tMax = Math.max(1, ...Array.from(sm).filter(Number.isFinite));
  const mono = new Float64Array(mesh.count);
  for (let i = 0; i < NT; i++) {
    let prev = 0;
    for (let j = 1; j <= NR; j++) {
      const v = idx(j, i);
      const minStep = (0.002 * tMax * (radii[j] - radii[j - 1])) / radius;
      prev = Math.max(Number.isFinite(sm[v]) ? sm[v] : prev, prev + minStep);
      mono[v] = prev;
    }
  }
  return mono;
}

// Geographic distance along each ray at which `budget` is reached.
function reachPerRay(mesh, mono, budget) {
  const { NT, NR, idx, radii } = mesh;
  const reach = new Float64Array(NT);
  for (let i = 0; i < NT; i++) {
    reach[i] = radii[NR];
    let prevT = 0;
    for (let j = 1; j <= NR; j++) {
      const t = mono[idx(j, i)];
      if (t >= budget) {
        const u = (budget - prevT) / Math.max(1e-9, t - prevT);
        reach[i] = radii[j - 1] + u * (radii[j] - radii[j - 1]);
        break;
      }
      prevT = t;
    }
  }
  return reach;
}

// Magnification as a function of travel time: x3 at the destination, x1 at
// the budget, x1/3 at twice the budget.
export function sizeScale(t, budget) {
  return Math.min(4, Math.max(0.12, Math.exp(Math.log(3) * (1 - t / budget))));
}

export function computeWarps(mesh, times, budget) {
  const { NT, NR, idx, radii, count } = mesh;
  const mono = monotoneTimes(mesh, times);
  const reach = reachPerRay(mesh, mono, budget);
  const reachMedian = median(reach);

  // Distance warp
  const k = reachMedian / budget;
  const dist = new Float32Array(count * 2);
  for (let v = 1; v < count; v++) {
    const s = Math.sin(mesh.theta[v]);
    const c = Math.cos(mesh.theta[v]);
    dist[2 * v] = s * k * mono[v];
    dist[2 * v + 1] = c * k * mono[v];
  }

  // Size warp
  const rr = new Float64Array(count);
  const atBudget = new Float64Array(NT);
  for (let i = 0; i < NT; i++) {
    let acc = 0;
    let prevT = 0;
    let found = false;
    for (let j = 1; j <= NR; j++) {
      const v = idx(j, i);
      const t = mono[v];
      const dr = radii[j] - radii[j - 1];
      const segScale = (sizeScale(prevT, budget) + 4 * sizeScale((prevT + t) / 2, budget) + sizeScale(t, budget)) / 6;
      const next = acc + segScale * dr;
      if (!found && t >= budget) {
        const u = (budget - prevT) / Math.max(1e-9, t - prevT);
        atBudget[i] = acc + u * (next - acc);
        found = true;
      }
      acc = next;
      rr[v] = acc;
      prevT = t;
    }
    if (!found) atBudget[i] = acc;
  }
  const scale = reachMedian / median(atBudget);
  const size = new Float32Array(count * 2);
  for (let v = 1; v < count; v++) {
    size[2 * v] = Math.sin(mesh.theta[v]) * rr[v] * scale;
    size[2 * v + 1] = Math.cos(mesh.theta[v]) * rr[v] * scale;
  }

  const orig = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    orig[2 * v] = mesh.x[v];
    orig[2 * v + 1] = mesh.y[v];
  }
  return { orig, dist, size, reachMedian, k, budget };
}

export function blendPositions(warps, strength, blend) {
  const { orig, dist, size } = warps;
  const out = new Float32Array(orig.length);
  for (let n = 0; n < orig.length; n++) {
    const target = dist[n] + (size[n] - dist[n]) * blend;
    out[n] = orig[n] + (target - orig[n]) * strength;
  }
  return out;
}

// Find the mesh triangle containing point (px, py) in the given positions and
// return interpolated travel time and geographic position, or null.
export function locate(mesh, pos, times, px, py) {
  const I = mesh.indices;
  for (let n = 0; n < I.length; n += 3) {
    const a = I[n];
    const b = I[n + 1];
    const c = I[n + 2];
    const ax = pos[2 * a], ay = pos[2 * a + 1];
    const bx = pos[2 * b], by = pos[2 * b + 1];
    const cx = pos[2 * c], cy = pos[2 * c + 1];
    const minX = Math.min(ax, bx, cx);
    const maxX = Math.max(ax, bx, cx);
    if (px < minX || px > maxX) continue;
    const minY = Math.min(ay, by, cy);
    const maxY = Math.max(ay, by, cy);
    if (py < minY || py > maxY) continue;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
    const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    return {
      time: l1 * times[a] + l2 * times[b] + l3 * times[c],
      x: l1 * mesh.x[a] + l2 * mesh.x[b] + l3 * mesh.x[c],
      y: l1 * mesh.y[a] + l2 * mesh.y[b] + l3 * mesh.y[c],
    };
  }
  return null;
}

// Map a geographic local point to the given (blended) positions by bilinear
// interpolation in the polar grid.
export function forward(mesh, pos, x, y) {
  const r = Math.hypot(x, y);
  if (r >= mesh.radius) return null;
  let th = Math.atan2(x, y);
  if (th < 0) th += TAU;
  const b = (th / TAU) * mesh.NT;
  const i0 = Math.floor(b);
  const w = b - i0;
  let j = 0;
  while (j < mesh.NR - 1 && mesh.radii[j + 1] < r) j++;
  const u = (r - mesh.radii[j]) / (mesh.radii[j + 1] - mesh.radii[j]);
  const P = (jj, ii) => {
    const v = mesh.idx(jj, ii);
    return [pos[2 * v], pos[2 * v + 1]];
  };
  const p00 = P(j, i0), p01 = P(j, i0 + 1), p10 = P(j + 1, i0), p11 = P(j + 1, i0 + 1);
  const lerp = (a, c, t) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
  return lerp(lerp(p00, p01, w), lerp(p10, p11, w), u);
}
