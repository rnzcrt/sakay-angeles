// DRAFT corridor matcher — deliberately separate from the verified planner.
//
// It works from hand-traced, UNVERIFIED route lines only (no stops, no known
// direction of travel). It answers: "which traced lines pass near my start and
// near my destination, and where might two lines connect?" Results are rough
// guidance, never reliable journeys, and the UI must say so.
//
// Ranking is by a ROUGH estimated door-to-door time (assumed walking and
// jeepney speeds plus a waiting allowance, see DRAFT_TIME), then transfers.
// Lines marked one-way (`oneWay: true` in the GeoJSON) are only ridden in the
// traced direction (a closed loop may wrap around). Older lines with no
// direction information are treated as two-way. A transfer is assumed only
// where two lines come within `maxTransferMeters` of each other.

import { DRAFT_TIME, PLANNER_DEFAULTS } from '../config.js';
import { geometryPositions, haversineMeters, isValidLngLat } from './geo.js';

export const DRAFT_DEFAULTS = {
  maxWalkMeters: PLANNER_DEFAULTS.maxWalkMeters,
  maxTransferMeters: 150,
  minRideMeters: 300,
  maxAlternatives: PLANNER_DEFAULTS.maxAlternatives,
  densifyMeters: 40,
  maxCandidates: 12,
};

export const DRAFT_STATUS = Object.freeze({
  SUCCESS: 'draft_success',
  NONE: 'draft_none',
  NO_LINES: 'draft_no_lines',
  INVALID_INPUT: 'invalid_input',
});

const walkMin = (m) => (m / 1000 / DRAFT_TIME.walkKmh) * 60;
const rideMin = (m) => (m / 1000 / DRAFT_TIME.jeepneyKmh) * 60;

/** Insert points so no segment is longer than `step` metres. */
export function densify(coords, step) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    const n = Math.max(1, Math.ceil(haversineMeters(a, b) / step));
    for (let k = 1; k <= n; k += 1) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

function prepareLine(coords, step) {
  const pts = densify(coords, step);
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + haversineMeters(pts[i - 1], pts[i]));
  return { pts, cum };
}

const candidate = (line, index, distanceMeters) => ({
  index,
  along: line.cum[index],
  distanceMeters,
  point: line.pts[index],
});

/** Single nearest point on a densified line. */
function nearest(line, p) {
  let best = { d: Infinity, i: 0 };
  for (let i = 0; i < line.pts.length; i += 1) {
    const d = haversineMeters(line.pts[i], p);
    if (d < best.d) best = { d, i };
  }
  return candidate(line, best.i, best.d);
}

/**
 * Local minima of distance along the line within maxWalk. A line traced out and
 * back has one minimum per pass, so we can pick whichever pass gives the
 * shorter ride.
 */
function localMinima(line, p, maxWalk, limit) {
  const d = line.pts.map((q) => haversineMeters(q, p));
  const out = [];
  for (let i = 0; i < d.length; i += 1) {
    if (d[i] > maxWalk) continue;
    if ((i === 0 || d[i] <= d[i - 1]) && (i === d.length - 1 || d[i] <= d[i + 1])) out.push(candidate(line, i, d[i]));
  }
  return out.sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, limit);
}

/** Points of the line from index i to j (reversed if i > j). */
export function sliceLine(line, i, j) {
  return i <= j ? line.pts.slice(i, j + 1) : line.pts.slice(j, i + 1).reverse();
}

/**
 * Build one entry per traced direction from a GeoJSON FeatureCollection.
 * Features are grouped by route + direction; features without `direction` are
 * legacy two-way lines (`oneWay` must be exactly `true` to count as one-way).
 */
export function buildDraftLines(geojson, routes, step = DRAFT_DEFAULTS.densifyMeters) {
  const groups = new Map();
  for (const f of geojson?.features ?? []) {
    const p = f?.properties ?? {};
    const coords = geometryPositions(f.geometry).filter(isValidLngLat);
    if (!p.routeId || coords.length < 2) continue;
    const direction = p.direction === 'a' || p.direction === 'b' ? p.direction : 'legacy';
    const key = `${p.routeId}|${direction}`;
    const g = groups.get(key) ?? { routeId: p.routeId, direction, oneWay: p.oneWay === true, startName: p.startName, endName: p.endName, coords: [] };
    g.coords.push(...coords);
    groups.set(key, g);
  }
  // Route 1 + Route 2 that join up (Route 1 ends where Route 2 starts, and Route 2 ends where Route 1
  // starts) are the same jeepney going round, so riders may stay on board across the turnaround:
  // treat them as one closed loop.
  const near = (p, q) => haversineMeters(p, q) <= 150;
  for (const id of new Set([...groups.values()].map((g) => g.routeId))) {
    const a = groups.get(`${id}|a`);
    const b = groups.get(`${id}|b`);
    if (a && b && near(a.coords.at(-1), b.coords[0]) && near(b.coords.at(-1), a.coords[0])) {
      const weld = haversineMeters(a.coords.at(-1), b.coords[0]) <= 30;
      groups.delete(`${id}|a`);
      groups.delete(`${id}|b`);
      groups.set(`${id}|loop`, { routeId: id, direction: 'loop', oneWay: true, startName: a.startName, endName: a.startName, coords: [...a.coords, ...(weld ? b.coords.slice(1) : b.coords)] });
    }
  }
  const byId = new Map(routes.map((r) => [r.id, r]));
  const entries = [];
  for (const g of groups.values()) {
    const route = byId.get(g.routeId);
    if (!route) continue;
    const line = prepareLine(g.coords, step);
    const oneWay = g.oneWay;
    const closes = oneWay && haversineMeters(line.pts[0], line.pts.at(-1)) <= 150;
    const label = g.direction === 'legacy' ? 'traced both ways'
      : g.direction === 'loop' ? 'Route 1 + Route 2 (one loop)'
      : closes ? 'loop route'
      : g.direction === 'b' ? 'Route 2 (coming back)' : 'Route 1 (going)';
    entries.push({
      route,
      line,
      oneWay,
      direction: g.direction,
      directionLabel: label,
      startName: g.startName,
      endName: g.endName,
      isLoop: closes,
    });
  }
  return entries.sort((a, b) => routes.indexOf(a.route) - routes.indexOf(b.route) || a.direction.localeCompare(b.direction));
}

/** Ride distance from one candidate to another, or null when the line cannot be ridden that way. */
function rideMeters(entry, from, to) {
  if (!entry.oneWay) return Math.abs(to.along - from.along);
  if (to.along >= from.along) return to.along - from.along;
  return entry.isLoop ? entry.line.cum.at(-1) - from.along + to.along : null;
}

function segmentFor(entry, from, to) {
  if (!entry.oneWay) return sliceLine(entry.line, from.index, to.index);
  if (to.index >= from.index) return entry.line.pts.slice(from.index, to.index + 1);
  return [...entry.line.pts.slice(from.index), ...entry.line.pts.slice(0, to.index + 1)];
}

const makeLeg = (entry, from, to) => ({
  routeId: entry.route.id,
  routeName: entry.route.name,
  jeepneyColorName: entry.route.jeepneyColorName,
  displayColor: entry.route.displayColor,
  directionLabel: entry.directionLabel,
  oneWay: entry.oneWay,
  isLoop: entry.isLoop,
  boardPoint: from.point,
  alightPoint: to.point,
  rideMeters: rideMeters(entry, from, to),
  segment: segmentFor(entry, from, to), // only the part actually ridden
});

const compare = (a, b) =>
  a.estimatedMinutes - b.estimatedMinutes ||
  a.transfers - b.transfers ||
  a.totalWalkMeters - b.totalWalkMeters ||
  a.id.localeCompare(b.id);

export function planDraftTrip({ origin, destination, lines, options = {} }) {
  const o = { ...DRAFT_DEFAULTS, ...options };
  if (!isValidLngLat(origin) || !isValidLngLat(destination)) {
    return { status: DRAFT_STATUS.INVALID_INPUT, message: 'Set a valid start and destination first.', itineraries: [] };
  }
  if (!lines.length) {
    return { status: DRAFT_STATUS.NO_LINES, message: 'No route lines have been traced yet.', itineraries: [] };
  }

  const near = lines.map((e) => ({
    e,
    oc: localMinima(e.line, origin, o.maxWalkMeters, o.maxCandidates),
    dc: localMinima(e.line, destination, o.maxWalkMeters, o.maxCandidates),
  }));
  const items = [];

  // Direct: one line passes near both ends; choose the pair of passes with the lowest time.
  for (const n of near) {
    let best = null;
    for (const a of n.oc) {
      for (const b of n.dc) {
        const ride = rideMeters(n.e, a, b);
        if (ride === null || ride < o.minRideMeters) continue;
        const cost = walkMin(a.distanceMeters + b.distanceMeters) + rideMin(ride);
        if (!best || cost < best.cost) best = { cost, a, b };
      }
    }
    if (!best) continue;
    items.push({
      transfers: 0,
      legs: [makeLeg(n.e, best.a, best.b)],
      accessWalkMeters: best.a.distanceMeters,
      egressWalkMeters: best.b.distanceMeters,
      transferWalkMeters: 0,
      transferPoint: null,
    });
  }

  // One transfer: A near start, B near destination, lines come within maxTransferMeters.
  for (const a of near) {
    if (!a.oc.length) continue;
    for (const b of near) {
      if (a.e.route.id === b.e.route.id || !b.dc.length) continue;
      let best = null;
      for (let i = 0; i < a.e.line.pts.length; i += 1) {
        const onB = nearest(b.e.line, a.e.line.pts[i]);
        if (onB.distanceMeters > o.maxTransferMeters) continue;
        const atACand = candidate(a.e.line, i, onB.distanceMeters);
        let first = null;
        for (const c of a.oc) {
          const ride = rideMeters(a.e, c, atACand);
          if (ride === null || ride < o.minRideMeters / 2) continue;
          const cost = walkMin(c.distanceMeters) + rideMin(ride);
          if (!first || cost < first.cost) first = { cost, c };
        }
        let second = null;
        for (const d of b.dc) {
          const ride = rideMeters(b.e, onB, d);
          if (ride === null || ride < o.minRideMeters / 2) continue;
          const cost = walkMin(d.distanceMeters) + rideMin(ride);
          if (!second || cost < second.cost) second = { cost, d };
        }
        if (!first || !second) continue;
        const total = first.cost + second.cost + walkMin(onB.distanceMeters);
        if (!best || total < best.total) best = { total, i, onB, first, second };
      }
      if (!best) continue;
      const atA = candidate(a.e.line, best.i, best.onB.distanceMeters);
      items.push({
        transfers: 1,
        legs: [makeLeg(a.e, best.first.c, atA), makeLeg(b.e, best.onB, best.second.d)],
        accessWalkMeters: best.first.c.distanceMeters,
        egressWalkMeters: best.second.d.distanceMeters,
        transferWalkMeters: best.onB.distanceMeters,
        transferPoint: atA.point,
      });
    }
  }

  const seen = new Map();
  for (const it of items) {
    it.totalWalkMeters = Math.round(it.accessWalkMeters + it.transferWalkMeters + it.egressWalkMeters);
    it.approxRideMeters = Math.round(it.legs.reduce((s, l) => s + l.rideMeters, 0));
    it.estimatedMinutes = Math.round(
      walkMin(it.totalWalkMeters) + rideMin(it.approxRideMeters) + DRAFT_TIME.waitPerBoardingMin * it.legs.length,
    );
    it.id = it.legs.map((l) => l.routeId).join('>');
    it.draft = true;
    // Dotted walking guides for the map: origin → board, (alight → next board), alight → destination.
    it.walkLines = [[origin, it.legs[0].boardPoint]];
    if (it.legs.length > 1) it.walkLines.push([it.legs[0].alightPoint, it.legs[1].boardPoint]);
    it.walkLines.push([it.legs.at(-1).alightPoint, destination]);
    const prev = seen.get(it.id);
    if (!prev || compare(it, prev) < 0) seen.set(it.id, it);
  }
  const itineraries = [...seen.values()].sort(compare).slice(0, o.maxAlternatives);
  if (!itineraries.length) {
    return {
      status: DRAFT_STATUS.NONE,
      message: `No traced line passes within ${o.maxWalkMeters} m of both points, even allowing one connection. Try points closer to a route, or trace the missing routes.`,
      itineraries: [],
    };
  }
  return {
    status: DRAFT_STATUS.SUCCESS,
    message: 'Rough guidance from hand-traced, unverified lines. Stops, direction of travel and actual service are unknown.',
    itineraries,
  };
}
