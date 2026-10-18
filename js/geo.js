// Small geographic helpers. All "local" coordinates are metres east (x) and
// north (y) of a reference point, using an equirectangular approximation that
// is accurate enough for the < 200 km extents this app works with.

export const EARTH_CIRC = 40075016.686;
const M_PER_DEG_LAT = 111132;

export function mPerDegLng(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

export function toLocal(origin, lat, lng) {
  return [(lng - origin.lng) * mPerDegLng(origin.lat), (lat - origin.lat) * M_PER_DEG_LAT];
}

export function fromLocal(origin, x, y) {
  return { lat: origin.lat + y / M_PER_DEG_LAT, lng: origin.lng + x / mPerDegLng(origin.lat) };
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
  const sw = fromLocal(origin, -radius, -radius);
  const ne = fromLocal(origin, radius, radius);
  return { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng };
}
