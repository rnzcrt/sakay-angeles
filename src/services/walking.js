// Pedestrian routing through the public OpenStreetMap.de OSRM foot instance.
// This is best-effort only: callers should keep their straight-line fallback
// and label it clearly when the service is unavailable.
import { isValidLngLat } from '../routing/geo.js';
import { WALKING_ROUTING_CONFIG } from '../config.js';


function instruction(step) {
  const m = step.maneuver ?? {};
  const road = step.name ? ` onto ${step.name}` : '';
  const modifier = m.modifier ? ` ${m.modifier}` : '';
  const action = ({ depart: 'Start walking', arrive: 'Arrive', turn: 'Turn', 'new name': 'Continue', merge: 'Merge', 'on ramp': 'Take the ramp', 'off ramp': 'Leave the ramp', fork: 'Keep', 'end of road': 'At the end of the road, turn' })[m.type] ?? 'Continue';
  return `${action}${modifier}${road}`.trim();
}

/** Return a walkable OSM path and text steps, or null when unavailable. */
export async function routeWalking(a, b, { fetchImpl = globalThis.fetch, config = WALKING_ROUTING_CONFIG } = {}) {
  if (!isValidLngLat(a) || !isValidLngLat(b) || typeof fetchImpl !== 'function') return null;
  const url = `${config.baseUrl}/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson&steps=true`;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
  try {
    const response = await fetchImpl(url, { signal: controller?.signal });
    if (!response.ok) return null;
    const data = await response.json();
    const route = data?.code === 'Ok' ? data.routes?.[0] : null;
    const coordinates = route?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(isValidLngLat)) return null;
    const steps = (route.legs ?? []).flatMap((leg) => leg.steps ?? []).map((step) => ({
      instruction: instruction(step),
      distanceMeters: Math.round(step.distance ?? 0),
    })).filter((step) => step.distanceMeters > 0);
    return { coordinates, distanceMeters: Math.round(route.distance ?? 0), durationSeconds: Math.round(route.duration ?? 0), steps };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
