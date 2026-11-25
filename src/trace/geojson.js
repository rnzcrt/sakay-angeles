// Pure helpers for the route tracer (testable in Node).
//
// Lines are keyed by stable direction id. Legacy route records without direction
// records retain the familiar 'a' and 'b' tracing controls.
// A line stores the points the contributor clicked (`waypoints`) and the path
// between each consecutive pair (`segments`, one per gap — a straight line or a
// road-snapped path). `oneWay: true` means the jeepney only travels in the
// traced order; old files with no direction info are imported as two-way lines.

import { isValidLngLat, haversineMeters, pathLengthMeters } from '../routing/geo.js';
import { validateDataset } from '../data/validate.js';

export const DIRECTIONS = ['a', 'b'];
export const routeDirections = (route) => Array.isArray(route?.directions) && route.directions.length
  ? route.directions.map((direction) => ({ ...direction, id: direction.id, label: direction.label || direction.id }))
  : [{ id: 'a', label: 'Route 1 (going)' }, { id: 'b', label: 'Route 2 (coming back)' }];
export const directionLabel = (d, route) => routeDirections(route).find((direction) => direction.id === d)?.label ?? (d === 'b' ? 'Route 2 (coming back)' : d === 'a' ? 'Route 1 (going)' : d);
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

/** Insert a traced vertex at a waypoint index and rebuild only adjacent segments. */
export async function insertWaypoint(line, index, point, makeSegment) {
  if (!line || !Array.isArray(line.waypoints) || !Array.isArray(line.segments) || !isValidLngLat(point) ||
      !Number.isInteger(index) || index < 0 || index > line.waypoints.length || typeof makeSegment !== 'function') {
    throw new TypeError('Invalid route vertex insertion.');
  }
  const coordinate = [point[0], point[1]];
  const before = line.waypoints[index - 1];
  const after = line.waypoints[index];
  if (before && after) {
    const left = await makeSegment(before, coordinate);
    const right = await makeSegment(coordinate, after);
    line.segments.splice(index - 1, 1, left, right);
  } else if (before) {
    line.segments.push(await makeSegment(before, coordinate));
  } else if (after) {
    line.segments.unshift(await makeSegment(coordinate, after));
  }
  line.waypoints.splice(index, 0, coordinate);
  return line;
}

const straight = (coords) => coords.slice(1).map((c, i) => [coords[i], c]);

/** Line built from a plain coordinate list (legacy files / imports). */
export function lineFromCoords(coords, { oneWay = false, startName = '', endName = '' } = {}) {
  const clean = coords.filter(isValidLngLat).map((c) => [c[0], c[1]]);
  return { waypoints: clean, segments: straight(clean), oneWay, startName, endName };
}

/** Map<lineKey, line> from a FeatureCollection. Multipart geometry is deliberately rejected:
 * the editor stores one continuous path per direction and must never connect separate parts.
 */
export function geojsonToLines(geojson, routes = []) {
  const lines = new Map();
  for (const [index, f] of (geojson?.features ?? []).entries()) {
    const p = f?.properties ?? {};
    const routeId = p.routeId;
    const g = f?.geometry;
    if (g?.type === 'MultiLineString') {
      const identity = p.geometryId || p.directionId || routeId || `feature ${index + 1}`;
      throw new Error(`Cannot edit multipart geometry "${identity}" yet. Its separate line parts were preserved; convert or edit it with a multipart-aware tool before importing.`);
    }
    const coords = g?.type === 'LineString' ? g.coordinates : null;
    if (!routeId || !coords) continue;
    const route = routes.find((item) => item.id === routeId);
    const explicitDirections = Array.isArray(route?.directions) && route.directions.length > 0;
    let dir;
    if (explicitDirections) {
      const byId = p.directionId === undefined
        ? undefined
        : route.directions.find((direction) => direction.id === p.directionId);
      const byGeometry = p.geometryId === undefined
        ? undefined
        : route.directions.find((direction) => direction.geometryId === p.geometryId);
      const legacyDir = ['a', 'b'].includes(p.direction) ? p.direction : null;
      const exactLegacyReference = legacyDir && p.directionId === `${routeId}-${legacyDir}`;
      if (p.directionId !== undefined && !byId && !exactLegacyReference) {
        throw new Error(`Geometry for "${routeId}" references unknown direction "${p.directionId}". It was not imported.`);
      }
      if (byId && byGeometry && byId.id !== byGeometry.id) {
        throw new Error(`Geometry for "${routeId}" has conflicting direction and geometry references. It was not imported.`);
      }
      if (byId?.geometryId && p.geometryId !== byId.geometryId) {
        throw new Error(`Geometry for direction "${byId.id}" does not match its stored geometry reference. It was not imported.`);
      }
      const metadataDirection = byId ?? byGeometry;
      if (metadataDirection) dir = metadataDirection.id;
      else if (exactLegacyReference || (p.directionId === undefined && p.geometryId === undefined && legacyDir)) dir = legacyDir;
      else {
        throw new Error(`Geometry for "${routeId}" does not identify one of its configured directions. It was not imported.`);
      }
    } else {
      dir = p.direction === 'b' ? 'b' : 'a';
      if (p.directionId !== undefined && p.directionId !== `${routeId}-${dir}`) {
        throw new Error(`Legacy geometry for "${routeId}" references an unexpected direction "${p.directionId}". It was not imported.`);
      }
    }
    const key = lineKey(routeId, dir);
    const incoming = lineFromCoords(coords, {
      oneWay: p.oneWay === true,
      startName: typeof p.startName === 'string' ? p.startName : '',
      endName: typeof p.endName === 'string' ? p.endName : '',
    });
    if (!incoming.waypoints.length) continue;
    if (lines.has(key)) {
      throw new Error(`More than one geometry feature maps to "${routeId}" direction "${dir}". The editor cannot safely combine separate features.`);
    }
    lines.set(key, incoming);
  }
  return lines;
}

const round = (n) => Math.round(n * 1e6) / 1e6; // ~0.1 m

/** FeatureCollection with one LineString per traced direction (≥ 2 path points). */
export function linesToGeoJson(lines, routes) {
  const features = [];
  for (const r of routes) {
    for (const direction of routeDirections(r)) {
      const dir = direction.id;
      const line = lines.get(lineKey(r.id, dir));
      if (!line) continue;
      const path = pathOf(line);
      if (path.length < 2) continue;
      const properties = {
        routeId: r.id,
        directionId: direction.id === 'a' || direction.id === 'b' ? `${r.id}-${dir}` : direction.id,
        geometryId: direction.geometryId || geometryIdFor(r.id, dir),
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
export function validateDraftExport(geojson, routes, stops = []) {
  return validateDataset({ routes, stops, transfers: [], geojson });
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

/** A snapped path that is far longer than the gap between the two clicks is a detour. */
export function isDetour(straightM, pathM, ratio = 2.2, minExtraM = 350) {
  return pathM > Math.max(straightM * ratio, straightM + minExtraM);
}

/** Segments whose path is a long detour compared with the straight gap between their two clicks. */
export function findDetours(line) {
  const out = [];
  line.segments.forEach((seg, i) => {
    const a = line.waypoints[i];
    const b = line.waypoints[i + 1];
    if (!a || !b) return;
    const straightM = haversineMeters(a, b);
    const pathM = pathLengthMeters(seg);
    if (isDetour(straightM, pathM)) out.push({ index: i, from: i + 1, to: i + 2, straightM: Math.round(straightM), pathM: Math.round(pathM) });
  });
  return out;
}

/** Replace every detour segment with a straight line between its two clicks. Returns how many were fixed. */
export function straightenDetours(line) {
  const found = findDetours(line);
  for (const d of found) line.segments[d.index] = [line.waypoints[d.index], line.waypoints[d.index + 1]];
  return found.length;
}
