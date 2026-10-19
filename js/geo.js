// Small geographic helpers. All "local" coordinates are metres east (x) and
// north (y) of a reference point.

export const EARTH_CIRC = 40075016.686;

// Azimuthal equidistant projection centred on `origin`: distances and
// bearings from the origin are exact, so the app also works at inter-city
// scales (hundreds of km).
const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;

export function toLocal(origin, lat, lng) {
  const p1 = origin.lat * RAD;
  const p2 = lat * RAD;
  const dl = (lng - origin.lng) * RAD;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  const brg = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  return [d * Math.sin(brg), d * Math.cos(brg)];
}

export function fromLocal(origin, x, y) {
  const d = Math.hypot(x, y) / R_EARTH;
  const brg = Math.atan2(x, y);
  const p1 = origin.lat * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brg));
  const l2 = origin.lng * RAD + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / RAD, lng: ((((l2 / RAD + 540) % 360) + 360) % 360) - 180 };
}

// Web Mercator world pixel coordinates at a given zoom and tile size.
export function worldPx(lat, lng, z, tileSize = 256) {
  const size = tileSize * Math.pow(2, z);
  const s = Math.sin((lat * Math.PI) / 180);
  const x = ((lng + 180) / 360) * size;
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
  return [x, y];
}

// Ground metres per CSS pixel at zoom z for 256px tiles.
export function metresPerPx(lat, z) {
  return (EARTH_CIRC * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, z));
}

export function bboxAround(origin, radius) {
  const b = { south: 90, west: 180, north: -90, east: -180 };
  for (let k = 0; k < 72; k++) {
    const th = (k / 72) * 2 * Math.PI;
    for (const f of [1, Math.SQRT2]) {
      const p = fromLocal(origin, radius * f * Math.sin(th), radius * f * Math.cos(th));
      b.south = Math.min(b.south, p.lat);
      b.north = Math.max(b.north, p.lat);
      b.west = Math.min(b.west, p.lng);
      b.east = Math.max(b.east, p.lng);
    }
  }
  b.south = Math.max(-85, b.south);
  b.north = Math.min(85, b.north);
  return b;
}
