// Graph-based jeepney journey planner.
//
// What the graph contains
//   * Nodes: verified stop ids.
//   * Ride edges: consecutive stops of one *directional* route variant, in the
//     order stored in `orderedStopIds`. Nothing is assumed to run both ways.
//   * Walk links: explicit, verified `transfers` records only.
// What it never does
//   * infer a transfer from geographic proximity or similar landmark names;
//   * use unverified routes, directions or stops;
//   * invent travel times, fares or vehicle positions.
//
// Ranking of alternatives (see compareItineraries):
//   1. fewer transfers, 2. less total walking (access + transfers + egress),
//   3. shorter approximate ride distance, 4. stable id order.
//
// Distances are straight-line (great-circle) estimates, not road distances.

import { PLANNER_DEFAULTS } from '../config.js';
import { validateDataset } from '../data/validate.js';
import { haversineMeters, isValidLngLat } from './geo.js';

export const PLAN_STATUS = Object.freeze({
  SUCCESS: 'success',
  NO_VERIFIED_ROUTE: 'no_verified_route',
  ORIGIN_TOO_FAR: 'origin_too_far_from_stop',
  DESTINATION_TOO_FAR: 'destination_too_far_from_stop',
  INVALID_INPUT: 'invalid_input',
  DATA_ERROR: 'data_error',
});

const MAX_RAW_ITINERARIES = 5000;

/** Why a direction is excluded from planning, or null if it is usable. */
export function ineligibleReason(route, direction, stopsById) {
  if (route.geometryStatus !== 'verified') return 'route geometry is not verified';
  if (direction.verificationStatus !== 'verified') return 'direction is not verified';
  const ids = direction.orderedStopIds ?? [];
  if (ids.length < 2) return 'direction has fewer than two stops';
  for (const id of ids) {
    const stop = stopsById.get(id);
    if (!stop) return `unknown stop ${id}`;
    if (stop.verificationStatus !== 'verified') return `stop ${id} is not verified`;
  }
  return null;
}

/**
 * Build the planning graph from verified data only.
 * Exposed so tests (and the UI) can inspect which directions were excluded.
 */
export function buildGraph(data) {
  const stopsById = new Map((data.stops ?? []).map((s) => [s.id, s]));
  const routesById = new Map((data.routes ?? []).map((r) => [r.id, r]));
  const directions = [];
  const directionsById = new Map();
  const excluded = [];
  const servedBy = new Map(); // stopId -> [{directionId, index}]
  const rideEdges = [];

  for (const route of data.routes ?? []) {
    for (const direction of route.directions ?? []) {
      const reason = ineligibleReason(route, direction, stopsById);
      if (reason) {
        excluded.push({ routeId: route.id, directionId: direction.id, reason });
        continue;
      }
      const entry = {
        id: direction.id,
        routeId: route.id,
        label: direction.label ?? direction.id,
        stopIds: [...direction.orderedStopIds],
        geometryId: direction.geometryId,
      };
      directions.push(entry);
      directionsById.set(entry.id, entry);
      entry.stopIds.forEach((stopId, index) => {
        if (!servedBy.has(stopId)) servedBy.set(stopId, []);
        servedBy.get(stopId).push({ directionId: entry.id, index });
        if (index > 0) {
          const from = entry.stopIds[index - 1];
          rideEdges.push({
            from,
            to: stopId,
            directionId: entry.id,
            routeId: route.id,
            meters: haversineMeters(stopsById.get(from).coordinates, stopsById.get(stopId).coordinates),
          });
        }
      });
    }
  }

  // Explicit verified walking transfers (symmetric).
  const walkLinks = new Map();
  const addLink = (from, to, t) => {
    if (!walkLinks.has(from)) walkLinks.set(from, []);
    walkLinks.get(from).push({ toStopId: to, walkMeters: t.walkMeters, transferId: t.id });
  };
  for (const t of data.transfers ?? []) {
    const a = stopsById.get(t.fromStopId);
    const b = stopsById.get(t.toStopId);
    if (t.verificationStatus !== 'verified' || !a || !b) continue;
    if (a.verificationStatus !== 'verified' || b.verificationStatus !== 'verified') continue;
    addLink(t.fromStopId, t.toStopId, t);
    addLink(t.toStopId, t.fromStopId, t);
  }

  return { stopsById, routesById, directions, directionsById, excluded, servedBy, rideEdges, walkLinks };
}

/** Nearest usable stops for boarding ('board') or alighting ('alight'). */
function findCandidates(graph, point, role, options) {
  const all = [];
  let nearbyButUnusable = false;
  for (const [stopId, entries] of graph.servedBy) {
    const usable = entries.some((e) => {
      const len = graph.directionsById.get(e.directionId).stopIds.length;
      return role === 'board' ? e.index < len - 1 : e.index > 0;
    });
    const stop = graph.stopsById.get(stopId);
    if (!usable) {
      if (haversineMeters(point, stop.coordinates) <= options.maxWalkMeters) nearbyButUnusable = true;
      continue;
    }
    all.push({ stop, distanceMeters: haversineMeters(point, stop.coordinates) });
  }
  all.sort((a, b) => a.distanceMeters - b.distanceMeters || a.stop.id.localeCompare(b.stop.id));
  const within = all.filter((c) => c.distanceMeters <= options.maxWalkMeters).slice(0, options.maxStopCandidates);
  return { nearest: all[0] ?? null, within, nearbyButUnusable };
}

function searchItineraries(graph, originCands, destCands, options) {
  const destByStop = new Map(destCands.map((c) => [c.stop.id, c]));
  const maxRides = options.maxTransfers + 1;
  const found = [];

  function ride(boardStopId, access, legs, usedRoutes, visited, rideCount) {
    for (const { directionId, index } of graph.servedBy.get(boardStopId) ?? []) {
      const dir = graph.directionsById.get(directionId);
      if (usedRoutes.has(dir.routeId)) continue;
      for (let j = index + 1; j < dir.stopIds.length; j += 1) {
        if (found.length >= MAX_RAW_ITINERARIES) return;
        const alightStopId = dir.stopIds[j];
        if (visited.has(alightStopId)) continue;
        const rideLeg = {
          type: 'ride',
          directionId,
          routeId: dir.routeId,
          boardIndex: index,
          alightIndex: j,
          boardStopId,
          alightStopId,
        };
        const nextLegs = [...legs, rideLeg];
        const dest = destByStop.get(alightStopId);
        if (dest) {
          found.push({ access, legs: nextLegs, egress: dest });
          continue;
        }
        if (rideCount + 1 >= maxRides) continue;
        const usedNext = new Set(usedRoutes).add(dir.routeId);
        const visitedNext = new Set(visited).add(alightStopId);
        // Same-stop transfer: only possible when another verified direction serves this very stop.
        ride(
          alightStopId,
          access,
          [...nextLegs, { type: 'transfer', mode: 'same-stop', fromStopId: alightStopId, toStopId: alightStopId, walkMeters: 0 }],
          usedNext,
          visitedNext,
          rideCount + 1,
        );
        // Explicit verified walking transfers.
        for (const link of graph.walkLinks.get(alightStopId) ?? []) {
          if (visitedNext.has(link.toStopId)) continue;
          ride(
            link.toStopId,
            access,
            [
              ...nextLegs,
              {
                type: 'transfer',
                mode: 'walk',
                fromStopId: alightStopId,
                toStopId: link.toStopId,
                walkMeters: link.walkMeters,
                transferId: link.transferId,
              },
            ],
            usedNext,
            new Set(visitedNext).add(link.toStopId),
            rideCount + 1,
          );
        }
      }
    }
  }

  for (const access of originCands) {
    ride(access.stop.id, access, [], new Set(), new Set([access.stop.id]), 0);
  }
  return found;
}

const stopSummary = (stop) => ({ id: stop.id, name: stop.name, coordinates: stop.coordinates });

function assembleItinerary(raw, graph) {
  let rideMeters = 0;
  let transferWalk = 0;
  const legs = raw.legs.map((leg) => {
    if (leg.type === 'transfer') {
      transferWalk += leg.walkMeters;
      return {
        type: 'transfer',
        mode: leg.mode,
        walkMeters: leg.walkMeters,
        transferId: leg.transferId,
        fromStop: stopSummary(graph.stopsById.get(leg.fromStopId)),
        toStop: stopSummary(graph.stopsById.get(leg.toStopId)),
      };
    }
    const dir = graph.directionsById.get(leg.directionId);
    const route = graph.routesById.get(leg.routeId);
    const stopIds = dir.stopIds.slice(leg.boardIndex, leg.alightIndex + 1);
    for (let i = 1; i < stopIds.length; i += 1) {
      rideMeters += haversineMeters(graph.stopsById.get(stopIds[i - 1]).coordinates, graph.stopsById.get(stopIds[i]).coordinates);
    }
    return {
      type: 'ride',
      routeId: route.id,
      routeName: route.name,
      jeepneyColorName: route.jeepneyColorName,
      displayColor: route.displayColor,
      directionId: dir.id,
      directionLabel: dir.label,
      geometryId: dir.geometryId,
      boardStop: stopSummary(graph.stopsById.get(leg.boardStopId)),
      alightStop: stopSummary(graph.stopsById.get(leg.alightStopId)),
      stopIds,
      stopCount: stopIds.length - 1,
    };
  });
  const transfers = raw.legs.filter((l) => l.type === 'transfer').length;
  const accessMeters = raw.access.distanceMeters;
  const egressMeters = raw.egress.distanceMeters;
  const key =
    raw.legs
      .map((l) => (l.type === 'ride' ? `${l.directionId}:${l.boardStopId}>${l.alightStopId}` : `T:${l.fromStopId}>${l.toStopId}`))
      .join('|');
  return {
    id: key,
    transfers,
    totalWalkMeters: Math.round(accessMeters + transferWalk + egressMeters),
    approxRideMeters: Math.round(rideMeters),
    access: { stop: stopSummary(raw.access.stop), walkMeters: Math.round(accessMeters) },
    legs,
    egress: { stop: stopSummary(raw.egress.stop), walkMeters: Math.round(egressMeters) },
  };
}

/** Explicit, testable ranking rule. */
export function compareItineraries(a, b) {
  return (
    a.transfers - b.transfers ||
    a.totalWalkMeters - b.totalWalkMeters ||
    a.approxRideMeters - b.approxRideMeters ||
    a.id.localeCompare(b.id)
  );
}

function fail(status, message, details = {}) {
  return { status, message, itineraries: [], details };
}

/**
 * @param {{origin:[number,number], destination:[number,number], data:{routes:Array,stops:Array,transfers?:Array}, options?:object}} input
 */
export function planTrip({ origin, destination, data, options = {} }) {
  const opts = { ...PLANNER_DEFAULTS, ...options };

  if (!isValidLngLat(origin)) {
    return fail(PLAN_STATUS.INVALID_INPUT, 'The starting point is missing or is not a valid location.', { field: 'origin' });
  }
  if (!isValidLngLat(destination)) {
    return fail(PLAN_STATUS.INVALID_INPUT, 'The destination is missing or is not a valid location.', { field: 'destination' });
  }
  if (!(opts.maxWalkMeters > 0) || !Number.isInteger(opts.maxTransfers) || opts.maxTransfers < 0) {
    return fail(PLAN_STATUS.INVALID_INPUT, 'Planner options are invalid.', { field: 'options' });
  }

  if (!data || !Array.isArray(data.routes) || !Array.isArray(data.stops)) {
    return fail(PLAN_STATUS.DATA_ERROR, 'Route data is missing or malformed.', { errors: [] });
  }
  if (!options.skipValidation) {
    const check = validateDataset({ routes: data.routes, stops: data.stops, transfers: data.transfers ?? [] });
    if (!check.valid) {
      return fail(PLAN_STATUS.DATA_ERROR, 'The route data failed validation, so no trip can be planned.', {
        errors: check.errors.slice(0, 10),
        errorCount: check.errors.length,
      });
    }
  }

  const graph = options.graph ?? buildGraph(data);
  const baseDetails = {
    verifiedDirectionCount: graph.directions.length,
    excludedDirectionCount: graph.excluded.length,
    maxWalkMeters: opts.maxWalkMeters,
    maxTransfers: opts.maxTransfers,
  };

  if (graph.directions.length === 0) {
    return fail(
      PLAN_STATUS.NO_VERIFIED_ROUTE,
      "We don't have enough verified route data to recommend a reliable trip yet.",
      baseDetails,
    );
  }

  const originCands = findCandidates(graph, origin, 'board', opts);
  const destCands = findCandidates(graph, destination, 'alight', opts);
  if (originCands.within.length === 0 && originCands.nearbyButUnusable) {
    return fail(
      PLAN_STATUS.NO_VERIFIED_ROUTE,
      'A verified stop is nearby your starting point, but no verified jeepney direction lets you board there.',
      baseDetails,
    );
  }
  if (destCands.within.length === 0 && destCands.nearbyButUnusable) {
    return fail(
      PLAN_STATUS.NO_VERIFIED_ROUTE,
      'A verified stop is nearby your destination, but no verified jeepney direction lets you get off there (routes are one-way unless a reverse direction is verified).',
      baseDetails,
    );
  }
  if (originCands.within.length === 0) {
    return fail(
      PLAN_STATUS.ORIGIN_TOO_FAR,
      `No verified jeepney stop is within ${opts.maxWalkMeters} m (straight line) of your starting point.`,
      {
        ...baseDetails,
        nearestStop: originCands.nearest && { ...stopSummary(originCands.nearest.stop), distanceMeters: Math.round(originCands.nearest.distanceMeters) },
        destinationAlsoTooFar: destCands.within.length === 0,
      },
    );
  }
  if (destCands.within.length === 0) {
    return fail(
      PLAN_STATUS.DESTINATION_TOO_FAR,
      `No verified jeepney stop is within ${opts.maxWalkMeters} m (straight line) of your destination.`,
      {
        ...baseDetails,
        nearestStop: destCands.nearest && { ...stopSummary(destCands.nearest.stop), distanceMeters: Math.round(destCands.nearest.distanceMeters) },
      },
    );
  }

  const raw = searchItineraries(graph, originCands.within, destCands.within, opts);
  const unique = new Map();
  for (const r of raw) {
    const itinerary = assembleItinerary(r, graph);
    const existing = unique.get(itinerary.id);
    if (!existing || compareItineraries(itinerary, existing) < 0) unique.set(itinerary.id, itinerary);
  }
  const itineraries = [...unique.values()].sort(compareItineraries).slice(0, opts.maxAlternatives);

  if (itineraries.length === 0) {
    const near = haversineMeters(origin, destination) <= opts.maxWalkMeters;
    return fail(
      PLAN_STATUS.NO_VERIFIED_ROUTE,
      near
        ? 'Your start and destination are very close together; walking may be simpler, and no verified jeepney ride connects them.'
        : `No verified connection was found within ${opts.maxTransfers} transfer${opts.maxTransfers === 1 ? '' : 's'}. The routes may not connect in the current data.`,
      { ...baseDetails, closeTogether: near },
    );
  }

  return {
    status: PLAN_STATUS.SUCCESS,
    message: 'Itineraries are built only from verified stops, ordered directions and verified transfers.',
    itineraries,
    details: { ...baseDetails, alternativesFound: unique.size },
  };
}
