// Small geodesy helpers. Coordinates are always [longitude, latitude].

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

export function isValidLngLat(c) {
  return (
    Array.isArray(c) &&
    c.length >= 2 &&
    typeof c[0] === 'number' &&
    typeof c[1] === 'number' &&
    Number.isFinite(c[0]) &&
    Number.isFinite(c[1]) &&
    c[0] >= -180 &&
    c[0] <= 180 &&
    c[1] >= -90 &&
    c[1] <= 90
  );
}

/** Great-circle (straight-line) distance in metres. */
export function haversineMeters(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Sum of straight-line distances between consecutive coordinates. */
export function pathLengthMeters(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) total += haversineMeters(coords[i - 1], coords[i]);
  return total;
}

/** bbox = [west, south, east, north] */
export function bboxContains(bbox, c) {
  return c[0] >= bbox[0] && c[0] <= bbox[2] && c[1] >= bbox[1] && c[1] <= bbox[3];
}

/** Returns [west, south, east, north] or null for an empty list. */
export function boundsOf(coords) {
  let bbox = null;
  for (const c of coords) {
    if (!isValidLngLat(c)) continue;
    if (!bbox) bbox = [c[0], c[1], c[0], c[1]];
    else {
      bbox[0] = Math.min(bbox[0], c[0]);
      bbox[1] = Math.min(bbox[1], c[1]);
      bbox[2] = Math.max(bbox[2], c[0]);
      bbox[3] = Math.max(bbox[3], c[1]);
    }
  }
  return bbox;
}

/** Flatten any GeoJSON LineString / MultiLineString geometry into positions. */
export function geometryPositions(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return geometry.coordinates;
  if (geometry.type === 'MultiLineString') return geometry.coordinates.flat();
  return [];
}
