// Pedestrian routing through FOSSGIS's OSRM foot-profile instance. Its API is
// OSRM-compatible, but the hosted graph/profile is explicitly pedestrian.
import { isValidLngLat } from '../routing/geo.js';
import { WALKING_ROUTING_CONFIG } from '../config.js';
import { haversineMeters } from '../routing/geo.js';

let requestQueue = Promise.resolve();
let lastRequestAt = 0;
export function resetWalkingThrottle() { requestQueue = Promise.resolve(); lastRequestAt = 0; }

function report(onDiagnostic, fields) {
  try { onDiagnostic?.({ provider: 'FOSSGIS OSRM foot profile', profile: 'foot', ...fields }); } catch { /* diagnostics must not break routing */ }
}

function instruction(step) {
  const m = step.maneuver ?? {};
  const road = step.name ? ` onto ${step.name}` : '';
  const modifier = m.modifier ? ` ${m.modifier}` : '';
  const action = ({ depart: 'Start walking', arrive: 'Arrive', turn: 'Turn', 'new name': 'Continue', merge: 'Merge', 'on ramp': 'Take the ramp', 'off ramp': 'Leave the ramp', fork: 'Keep', 'end of road': 'At the end of the road, turn' })[m.type] ?? 'Continue';
  return `${action}${modifier}${road}`.trim();
}

/** Return a pedestrian-network route and text steps, or null when unavailable. */
export function routeWalking(a, b, {
  fetchImpl = globalThis.fetch,
  config = WALKING_ROUTING_CONFIG,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onDiagnostic,
} = {}) {
  if (!isValidLngLat(a) || !isValidLngLat(b) || typeof fetchImpl !== 'function') {
    report(onDiagnostic, { status: 'not_requested', reason: 'invalid_coordinates_or_fetch' });
    return Promise.resolve(null);
  }
  const url = `${config.baseUrl}/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson&steps=true`;
  const run = async () => {
    const wait = (lastRequestAt + (config.minIntervalMs ?? 0)) - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
    report(onDiagnostic, { status: 'request_started' });
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
    try {
      const response = await fetchImpl(url, { signal: controller?.signal });
      if (!response.ok) {
        report(onDiagnostic, { status: 'http_error', httpStatus: response.status });
        return null;
      }
      const data = await response.json();
      const route = data?.code === 'Ok' ? data.routes?.[0] : null;
      const coordinates = route?.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(isValidLngLat) ||
          !Number.isFinite(route.distance) || route.distance <= 0 || !Number.isFinite(route.duration) || route.duration < 0) {
        report(onDiagnostic, { status: 'invalid_response', providerCode: data?.code ?? null, geometryVertices: Array.isArray(coordinates) ? coordinates.length : 0 });
        return null;
      }
      const snapLimit = config.maxSnapDistanceMeters ?? 250;
      const startSnap = haversineMeters(a, coordinates[0]);
      const endSnap = haversineMeters(b, coordinates.at(-1));
      if (startSnap > snapLimit || endSnap > snapLimit) {
        report(onDiagnostic, { status: 'endpoint_too_far_from_foot_network', startSnapMeters: Math.round(startSnap), endSnapMeters: Math.round(endSnap), geometryVertices: coordinates.length });
        return null;
      }
      const steps = (route.legs ?? []).flatMap((leg) => leg.steps ?? []).map((step) => ({
        instruction: instruction(step),
        distanceMeters: Math.round(step.distance ?? 0),
      })).filter((step) => step.distanceMeters > 0);
      const result = {
        coordinates: coordinates.map(([lng, lat]) => [lng, lat]),
        distanceMeters: Math.round(route.distance),
        durationSeconds: Math.round(route.duration),
        steps,
      };
      report(onDiagnostic, { status: 'route_ok', geometryVertices: result.coordinates.length, distanceMeters: result.distanceMeters });
      return result;
    } catch (error) {
      report(onDiagnostic, { status: error?.name === 'AbortError' ? 'timeout' : 'network_error' });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const result = requestQueue.then(run, run);
  requestQueue = result.then(() => undefined, () => undefined);
  return result;
}
