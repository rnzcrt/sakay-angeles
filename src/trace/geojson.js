// Pure helpers for the route tracer (testable in Node).
//
// Model: a route can have up to two traced DIRECTION lines, 'a' and 'b'.
// A line stores the points the contributor clicked (`waypoints`) and the path
// between each consecutive pair (`segments`, one per gap — a straight line or a
// road-snapped path). `oneWay: true` means the jeepney only travels in the
// traced order; old files with no direction info are imported as two-way lines.

import { isValidLngLat, haversineMeters, pathLengthMeters } from '../routing/geo.js';
import { validateDataset } from '../data/validate.js';

export const DIRECTIONS = ['a', 'b'];
export const directionLabel = (d) => (d === 'b' ? 'Route 2 (coming back)' : 'Route 1 (going)');
export const lineKey = (routeId, dir) => `${routeId}|${dir}`;
export const splitKey = (key) => { const i = key.lastIndexOf('|'); return [key.slice(0, i), key.slice(i + 1)]; };
export const geometryIdFor = (routeId, dir) => `${routeId}-${dir}-draft`;

export const emptyLine = () => ({ waypoints: [], segments: [], oneWay: true, startName: '', endName: '' });

/** Full path of a line (segments joined; a single waypoint is a 1-point path). */
export function pathOf(line) {
  const out = [];
  line.segments.forEach((seg, i) => out.push(...(i === 0 ? seg : seg.slice(1))));
  if (!out.length && line.waypoints.length === 1) return [line.waypoints[0]];
  return out;
}

const straight = (coords) => coords.slice(1).map((c, i) => [coords[i], c]);

/** Line built from a plain coordinate list (legacy files / imports). */
export function lineFromCoords(coords, { oneWay = false, startName = '', endName = '' } = {}) {
  const clean = coords.filter(isValidLngLat).map((c) => [c[0], c[1]]);
  return { waypoints: clean, segments: straight(clean), oneWay, startName, endName };
}

/** Map<lineKey, line> from a FeatureCollection. Features without a direction are legacy two-way lines. */
export function geojsonToLines(geojson) {
  const lines = new Map();
  for (const f of geojson?.features ?? []) {
    const p = f?.properties ?? {};
    const routeId = p.routeId;
    const g = f?.geometry;
    const coords = g?.type === 'LineString' ? g.coordinates : g?.type === 'MultiLineString' ? g.coordinates.flat() : null;
    if (!routeId || !coords) continue;
    const dir = p.direction === 'b' ? 'b' : 'a';
    const key = lineKey(routeId, dir);
    const incoming = lineFromCoords(coords, {
      oneWay: p.oneWay === true,
      startName: typeof p.startName === 'string' ? p.startName : '',
      endName: typeof p.endName === 'string' ? p.endName : '',
    });
    if (!incoming.waypoints.length) continue;
    if (lines.has(key)) {
      const prev = lines.get(key);
      prev.waypoints.push(...incoming.waypoints);
      prev.segments = straight(prev.waypoints);
    } else lines.set(key, incoming);
  }
  return lines;
}

const round = (n) => Math.round(n * 1e6) / 1e6; // ~0.1 m

/** FeatureCollection with one LineString per traced direction (≥ 2 path points). */
export function linesToGeoJson(lines, routes) {
  const features = [];
  for (const r of routes) {
    for (const dir of DIRECTIONS) {
      const line = lines.get(lineKey(r.id, dir));
      if (!line) continue;
      const path = pathOf(line);
      if (path.length < 2) continue;
      const properties = {
        routeId: r.id,
        directionId: `${r.id}-${dir}`,
        geometryId: geometryIdFor(r.id, dir),
        direction: dir,
        oneWay: Boolean(line.oneWay),
        draft: true,
      };
      if (line.startName) properties.startName = line.startName;
      if (line.endName) properties.endName = line.endName;
      features.push({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: path.map((c) => [round(c[0]), round(c[1])]) } });
    }
  }
  return {
    type: 'FeatureCollection',
    note: 'Illustrative DRAFT route lines traced by hand. Not verified; not used for verified trip planning.',
    features,
  };
}

export function lengthKm(coords) {
  return coords.length < 2 ? 0 : pathLengthMeters(coords) / 1000;
}

function densify(coords, step) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    const n = Math.max(1, Math.ceil(haversineMeters(a, b) / step));
    for (let k = 1; k <= n; k += 1) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/**
 * Detects a line that goes back over the road it came from (out-and-back) and
 * a line that closes into a loop. retraceRatio = share of points that lie within
 * `nearM` of an earlier point more than `minGapM` of travel earlier.
 */
export function analyzeLine(coords, { stepM = 40, nearM = 35, minGapM = 300 } = {}) {
  if (coords.length < 2) return { retraceRatio: 0, retraced: false, closesLoop: false, sameStartEnd: false, startEndMeters: 0, lengthKm: 0 };
  const pts = densify(coords, stepM);
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + haversineMeters(pts[i - 1], pts[i]));
  let hits = 0;
  for (let j = 0; j < pts.length; j += 1) {
    for (let i = 0; i < j && cum[j] - cum[i] > minGapM; i += 1) {
      if (haversineMeters(pts[i], pts[j]) < nearM) { hits += 1; break; }
    }
  }
  const retraceRatio = hits / pts.length;
  const startEndMeters = haversineMeters(pts[0], pts.at(-1));
  return {
    retraceRatio,
    retraced: retraceRatio >= 0.3,
    closesLoop: startEndMeters <= 150,
    sameStartEnd: startEndMeters <= 150,
    startEndMeters,
    lengthKm: cum.at(-1) / 1000,
  };
}

/** Validate an export against the route list before the user saves it. */
export function validateDraftExport(geojson, routes) {
  return validateDataset({ routes, stops: [], transfers: [], geojson });
}

/**
 * Does Route 2 really run back from where Route 1 ends to where Route 1 starts?
 * Route 2's first point should be at Route 1's last point; its last point at Route 1's first point.
 */
export function checkDirectionPair(lineA, lineB, toleranceM = 150) {
  const a = pathOf(lineA);
  const b = pathOf(lineB);
  if (a.length < 2 || b.length < 2) return null;
  const startGapM = Math.round(haversineMeters(b[0], a.at(-1)));
  const endGapM = Math.round(haversineMeters(b.at(-1), a[0]));
  const bStartsAtAEnd = startGapM <= toleranceM;
  const bEndsAtAStart = endGapM <= toleranceM;
  return { startGapM, endGapM, bStartsAtAEnd, bEndsAtAStart, ok: bStartsAtAEnd && bEndsAtAStart };
}

/** Split one line at waypoint `i`: the first part ends there, the second part starts there. */
export function splitLineAt(line, i) {
  const wp = line.waypoints;
  const keep = (extra) => ({ oneWay: true, startName: '', endName: '', ...extra });
  return [
    keep({ waypoints: wp.slice(0, i + 1), segments: line.segments.slice(0, i), startName: line.startName ?? '' }),
    keep({ waypoints: wp.slice(i), segments: line.segments.slice(i), endName: line.startName ?? '' }),
  ];
}
