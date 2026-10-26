// DRAFT corridor matcher — deliberately separate from the verified planner.
//
// It works from hand-traced, UNVERIFIED route lines only (no stops, no known
// direction of travel). It answers: "which traced lines pass near my start and
// near my destination, and where might two lines connect?" Results are rough
// guidance, never reliable journeys, and the UI must say so.
//
// Recommendations prioritize practical access and total walking, then include
// transfers and a ROUGH estimated door-to-door time (see DRAFT_TIME).
// Lines marked one-way (`oneWay: true` in the GeoJSON) are only ridden in the
// traced direction (a closed loop may wrap around). Older lines with no
// direction information are treated as two-way. A transfer is assumed only
// where two lines come within `maxTransferMeters` of each other. The network
// search can chain any number of distinct route IDs (not just one transfer).

import { DRAFT_TIME, PLANNER_DEFAULTS } from '../config.js';
import { geometryPositions, haversineMeters, isValidLngLat } from './geo.js';
import { draftAccessibilityScore, rankDraftCandidates } from './draftRanking.js';

export const DRAFT_DEFAULTS = {
  // Walking to the route / from the drop-off is allowed up to this far (a "long walk" note is shown in the UI).
  // First search radius for route matching. This is a proximity bound, not a
  // statement that a 2.5 km walk is recommended; the complete itinerary is
  // ranked after pedestrian routing, and direct walking remains an option.
  maxWalkMeters: 2500,
  walkSearchRadii: [500, 1000, 1800, 2500],
  // The jeepney stops at the kerb on the same side of the road as the person: shift the stop this far toward them.
  kerbMeters: 10,
  // Treat crossings as easy transfers and allow a short walk between nearby,
  // non-intersecting lines when there is no shared stop.
  maxTransferMeters: 500,
  minRideMeters: 300,
  maxAlternatives: PLANNER_DEFAULTS.maxAlternatives,
  densifyMeters: 40,
  maxCandidates: 24,
  // Keep short trips on foot when a jeepney would add a boarding and extra fare.
  walkInsteadMeters: 1200,
};

export const DRAFT_STATUS = Object.freeze({
  SUCCESS: 'draft_success',
  NONE: 'draft_none',
  NO_LINES: 'draft_no_lines',
  INVALID_INPUT: 'invalid_input',
});

/** Move `point` toward `target` by at most `meters` (small distances: flat-earth approximation). */
export function shiftToward(point, target, meters) {
  const d = haversineMeters(point, target);
  if (d < 1 || meters <= 0) return point;
  const f = Math.min(meters, d) / d;
  return [point[0] + (target[0] - point[0]) * f, point[1] + (target[1] - point[1]) * f];
}

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
  fareClass: entry.route.fareClass ?? null,
  directionLabel: entry.directionLabel,
  oneWay: entry.oneWay,
  isLoop: entry.isLoop,
  boardPoint: from.point,
  alightPoint: to.point,
  rideMeters: rideMeters(entry, from, to),
  segment: segmentFor(entry, from, to), // only the part actually ridden
});

// Access-weighted shortest-path search across every traced jeepney line.
// Densified line points are graph nodes, consecutive points are ride edges, and nearby points on
// different route IDs are possible (unverified) transfers. The search has no
// fixed transfer-count limit; it avoids reboarding a route already used.
function connectedJourneys(origin, destination, near, options) {
  const entries = near.map((n) => n.e);
  const nodes = [];
  const byEntry = new Map();
  for (const entry of entries) {
    const ids = entry.line.pts.map((point, index) => {
      const id = nodes.length;
      nodes.push({ entry, index, point });
      return id;
    });
    byEntry.set(entry, ids);
  }
  const edges = Array.from({ length: nodes.length }, () => []);
  const link = (a, b, edge) => { edges[a].push({ to: b, ...edge }); };
  for (const entry of entries) {
    const ids = byEntry.get(entry);
    for (let i = 0; i < ids.length - 1; i += 1) {
      const meters = entry.line.cum[i + 1] - entry.line.cum[i];
      link(ids[i], ids[i + 1], { type: 'ride', entry, meters });
      if (!entry.oneWay) link(ids[i + 1], ids[i], { type: 'ride', entry, meters });
    }
    if (entry.isLoop && ids.length > 2) {
      const meters = haversineMeters(entry.line.pts.at(-1), entry.line.pts[0]);
      link(ids.at(-1), ids[0], { type: 'ride', entry, meters });
    }
  }

  // Spatial buckets keep transfer discovery local even when route traces are
  // long. At Angeles latitude, 0.001 degree cells are roughly 100 m wide.
  const cell = (p) => [Math.floor(p[0] * 1000), Math.floor(p[1] * 1000)];
  const buckets = new Map();
  nodes.forEach((node, id) => {
    const [x, y] = cell(node.point);
    const key = `${x},${y}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(id);
  });
  const transferPairs = new Set();
  nodes.forEach((node, id) => {
    const [x, y] = cell(node.point);
    const nearestByEntry = new Map();
    // Five cells cover the 500 m transfer radius even for points on opposite
    // sides of cell boundaries (cells are about 100 m at Angeles latitude).
    for (let dx = -5; dx <= 5; dx += 1) for (let dy = -5; dy <= 5; dy += 1) {
      for (const otherId of buckets.get(`${x + dx},${y + dy}`) ?? []) {
        const other = nodes[otherId];
        if (other.entry.route.id === node.entry.route.id) continue;
        const meters = haversineMeters(node.point, other.point);
        if (meters > options.maxTransferMeters) continue;
        const old = nearestByEntry.get(other.entry);
        if (!old || meters < old.meters) nearestByEntry.set(other.entry, { otherId, meters });
      }
    }
    for (const { otherId, meters } of nearestByEntry.values()) {
      const key = id < otherId ? `${id}:${otherId}` : `${otherId}:${id}`;
      if (transferPairs.has(key)) continue;
      transferPairs.add(key);
      link(id, otherId, { type: 'transfer', meters });
      link(otherId, id, { type: 'transfer', meters });
    }
  });

  const nodeId = (entry, index) => byEntry.get(entry)[index];
  const sources = [];
  const targets = [];
  for (const n of near) {
    for (const c of n.oc) sources.push({ id: nodeId(n.e, c.index), candidate: c });
    for (const c of n.dc) targets.push({ id: nodeId(n.e, c.index), candidate: c });
  }
  if (!sources.length || !targets.length) return [];

  // Binary min-heap of [cost, state]. State stores whether the rider has
  // actually ridden a useful distance, so nearby endpoints don't create a
  // zero-ride transit itinerary.
  const heap = [];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= item[0]) break; heap[i] = heap[p]; i = p; }
    heap[i] = item;
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (true) {
        let c = i * 2 + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c += 1;
        if (heap[c][0] >= last[0]) break;
        heap[i] = heap[c]; i = c;
      }
      heap[i] = last;
    }
    return top;
  };
  const stateCount = nodes.length * 2;
  const dist = new Float64Array(stateCount); dist.fill(Infinity);
  const prev = new Array(stateCount);
  const stateFor = (id, ridden) => id * 2 + Number(ridden);
  const walkScore = (meters) => meters + walkMin(meters) * 10;
  const waitScore = DRAFT_TIME.waitPerBoardingMin * 10;
  for (const s of sources) {
    const state = stateFor(s.id, false);
    const cost = walkScore(s.candidate.distanceMeters) + s.candidate.distanceMeters * 1.5 + waitScore;
    if (cost < dist[state]) { dist[state] = cost; push([cost, state]); }
  }
  while (heap.length) {
    const [cost, state] = pop();
    if (cost !== dist[state]) continue;
    const id = Math.floor(state / 2);
    const ridden = Boolean(state % 2);
    for (const edge of edges[id]) {
      let extra;
      let nextRidden = ridden;
      if (edge.type === 'ride') {
        extra = rideMin(edge.meters) * 10;
        nextRidden = true;
      } else {
        extra = walkScore(edge.meters) + 250 + waitScore;
      }
      // Reaching the next route after any partial ride also counts as having
      // ridden; the threshold filters trips that only shuffle at one junction.
      const nextState = stateFor(edge.to, nextRidden);
      const nextCost = cost + extra;
      if (nextCost >= dist[nextState]) continue;
      dist[nextState] = nextCost;
      prev[nextState] = { state, edge };
      push([nextCost, nextState]);
    }
  }

  const bestByRouteSequence = new Map();
  for (const target of targets) {
    for (const ridden of [false, true]) {
      if (!ridden) continue;
      const endState = stateFor(target.id, true);
      const pathScore = dist[endState] + walkScore(target.candidate.distanceMeters);
      if (!Number.isFinite(pathScore)) continue;
      const states = [endState];
      while (prev[states[0]]) states.unshift(prev[states[0]].state);
      const pathNodes = states.map((s) => nodes[Math.floor(s / 2)]);
      const pathEdges = states.slice(1).map((s) => prev[s].edge);
      const legs = [];
      let from = pathNodes[0];
      let to = from;
      let transferWalkMeters = 0;
      for (let i = 0; i < pathEdges.length; i += 1) {
        const edge = pathEdges[i];
        if (edge.type === 'ride') to = pathNodes[i + 1];
        else {
          if (from.entry === to.entry && from.index !== to.index) {
            legs.push(makeLeg(from.entry, candidate(from.entry.line, from.index, 0), candidate(from.entry.line, to.index, 0)));
          }
          transferWalkMeters += edge.meters;
          from = pathNodes[i + 1];
          to = from;
        }
      }
      if (from.entry === to.entry && from.index !== to.index) {
        legs.push(makeLeg(from.entry, candidate(from.entry.line, from.index, 0), candidate(from.entry.line, to.index, 0)));
      }
      if (!legs.length) continue;
      // Don't recommend paying for a token ride just to leave the jeep and walk
      // the rest. This guard was lost when the one-transfer search became a
      // network search; keep tiny ride fragments out of the candidate pool.
      if (legs.some((leg) => leg.rideMeters < options.minRideMeters)) continue;
      const sequence = legs.map((leg) => leg.routeId).join('>');
      const item = {
        transfers: legs.length - 1,
        legs,
        accessWalkMeters: pathNodes[0].point ? haversineMeters(origin, pathNodes[0].point) : 0,
        egressWalkMeters: haversineMeters(destination, pathNodes.at(-1).point),
        transferWalkMeters,
        transferPoint: null,
        totalWalkMeters: Math.round(haversineMeters(origin, pathNodes[0].point) + transferWalkMeters + haversineMeters(destination, pathNodes.at(-1).point)),
        approxRideMeters: Math.round(legs.reduce((sum, leg) => sum + leg.rideMeters, 0)),
        estimatedMinutes: Math.round(
          walkMin(haversineMeters(origin, pathNodes[0].point) + transferWalkMeters + target.candidate.distanceMeters) +
          rideMin(legs.reduce((sum, leg) => sum + leg.rideMeters, 0)) +
          DRAFT_TIME.waitPerBoardingMin * legs.length,
        ),
        id: sequence,
      };
      const old = bestByRouteSequence.get(sequence);
      if (!old || draftAccessibilityScore(item) < draftAccessibilityScore(old)) bestByRouteSequence.set(sequence, item);
    }
  }
  return [...bestByRouteSequence.values()];
}

const compareFastest = (a, b) =>
  a.estimatedMinutes - b.estimatedMinutes || a.totalWalkMeters - b.totalWalkMeters || a.transfers - b.transfers || a.id.localeCompare(b.id);

export function planDraftTrip({ origin, destination, lines, options = {} }) {
  const o = { ...DRAFT_DEFAULTS, ...options };
  if (!isValidLngLat(origin) || !isValidLngLat(destination)) {
    return { status: DRAFT_STATUS.INVALID_INPUT, message: 'Set a valid start and destination first.', itineraries: [] };
  }
  if (!lines.length) {
    return { status: DRAFT_STATUS.NO_LINES, message: 'No route lines have been traced yet.', itineraries: [] };
  }

  const items = [];

  // A short walk is a real alternative to paying for another jeepney. Keep it
  // beside transit suggestions so the rider can choose; its time uses the same
  // rough walking-speed assumption as the draft estimates.
  const directWalkMeters = haversineMeters(origin, destination);
  if (directWalkMeters <= o.walkInsteadMeters) {
    items.push({
      transfers: 0,
      legs: [],
      accessWalkMeters: directWalkMeters,
      egressWalkMeters: 0,
      transferWalkMeters: 0,
      transferPoint: null,
      walkingOnly: true,
    });
  }

  // Expand the proximity search in steps. Each result is a complete itinerary;
  // the pedestrian network later supplies the real walk distance for ranking.
  // Keep candidates from earlier radii so a slightly longer walk can still win
  // on time or transfers when the whole trip is considered.
  const radii = [...new Set([...(o.walkSearchRadii ?? []), o.maxWalkMeters])]
    .filter((radius) => Number.isFinite(radius) && radius > 0 && radius <= o.maxWalkMeters)
    .sort((a, b) => a - b);
  for (const radius of radii) {
    const near = lines.map((e) => ({
      e,
      oc: localMinima(e.line, origin, radius, o.maxCandidates),
      dc: localMinima(e.line, destination, radius, o.maxCandidates),
    }));
    // This supports any useful chain of distinct route IDs, including three
    // or more rides; each returned candidate is an end-to-end trip.
    items.push(...connectedJourneys(origin, destination, near, o));
  }

  const seen = new Map();
  for (const it of items) {
    // The jeepney stops at the kerb on the same side of the road as the person.
    if (it.walkingOnly) {
      it.totalWalkMeters = Math.round(directWalkMeters);
      it.approxRideMeters = 0;
      it.estimatedMinutes = Math.max(1, Math.round(walkMin(it.totalWalkMeters)));
      it.id = 'walk';
      it.draft = true;
      it.walkLines = [[origin, destination]];
      seen.set(it.id, it);
      continue;
    }
    const first = it.legs[0];
    const last = it.legs.at(-1);
    const boardKerb = Math.min(o.kerbMeters, it.accessWalkMeters);
    const alightKerb = Math.min(o.kerbMeters, it.egressWalkMeters);
    first.boardPoint = shiftToward(first.boardPoint, origin, o.kerbMeters);
    last.alightPoint = shiftToward(last.alightPoint, destination, o.kerbMeters);
    it.accessWalkMeters -= boardKerb;
    it.egressWalkMeters -= alightKerb;
    it.totalWalkMeters = Math.round(it.accessWalkMeters + it.transferWalkMeters + it.egressWalkMeters);
    it.approxRideMeters = Math.round(it.legs.reduce((s, l) => s + l.rideMeters, 0));
    it.estimatedMinutes = Math.round(
      walkMin(it.totalWalkMeters) + rideMin(it.approxRideMeters) + DRAFT_TIME.waitPerBoardingMin * it.legs.length,
    );
    it.id = it.legs.map((l) => l.routeId).join('>');
    it.draft = true;
    // Dotted walking guides for the map: origin → board, (alight → next board), alight → destination.
    it.walkLines = [[origin, first.boardPoint]];
    for (let i = 0; i < it.legs.length - 1; i += 1) it.walkLines.push([it.legs[i].alightPoint, it.legs[i + 1].boardPoint]);
    it.walkLines.push([last.alightPoint, destination]);
    const prev = seen.get(it.id);
    if (!prev || draftAccessibilityScore(it) < draftAccessibilityScore(prev)) seen.set(it.id, it);
  }
  const all = [...seen.values()];
  if (!all.length) {
    const nearestTo = (p) => Math.min(...lines.map((e) => nearest(e.line, p).distanceMeters));
    const originGap = nearestTo(origin);
    const destGap = nearestTo(destination);
    const km = (m) => (m / 1000).toFixed(1);
    let message;
    if (originGap > o.maxWalkMeters && destGap > o.maxWalkMeters) {
      message = `Your start (${km(originGap)} km) and destination (${km(destGap)} km) are both far from every traced route (more than ${km(o.maxWalkMeters)} km).`;
    } else if (originGap > o.maxWalkMeters) {
      message = `Your start is ${km(originGap)} km from the nearest traced route, which is further than ${km(o.maxWalkMeters)} km of walking.`;
    } else if (destGap > o.maxWalkMeters) {
      message = `Your destination is ${km(destGap)} km from the nearest traced route, which is further than ${km(o.maxWalkMeters)} km of walking.`;
    } else {
      message = 'The traced route network does not connect your start to your destination. Try nearby points, or trace the missing routes.';
    }
    return { status: DRAFT_STATUS.NONE, message, itineraries: [], details: { originGapMeters: Math.round(originGap), destGapMeters: Math.round(destGap) } };
  }
  // Use access, total walking, transfers, and rough time for the recommendation.
  // Also keep the independently calculated fastest and least-walk options.
  const ranking = rankDraftCandidates(all);
  const displayLimit = o.maxAlternatives;
  const candidateLimit = Math.max(displayLimit, Math.floor(options.candidateLimit ?? displayLimit));
  const sorted = [...all].sort((a, b) => draftAccessibilityScore(a) - draftAccessibilityScore(b) || compareFastest(a, b));
  const itineraries = [...new Set([ranking.recommended, ranking.fastest, ranking.leastWalking, ...sorted].filter(Boolean))].slice(0, candidateLimit);
  return {
    status: DRAFT_STATUS.SUCCESS,
    message: 'Rough guidance from hand-traced, unverified lines. Stops, direction of travel and actual service are unknown.',
    itineraries,
    displayLimit,
  };
}
