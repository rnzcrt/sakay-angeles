// Road snapping between two clicked points (used only by the route tracer).
import { ROUTING_CONFIG } from '../config.js';
import { isValidLngLat } from '../routing/geo.js';

export const SNAP_ERROR = Object.freeze({ NETWORK: 'network_error', TIMEOUT: 'timeout', HTTP: 'http_error', NO_ROUTE: 'no_route', BAD_RESPONSE: 'bad_response' });

const MESSAGES = {
  [SNAP_ERROR.NETWORK]: 'Road snapping is unavailable right now, so a straight line was used for that part.',
  [SNAP_ERROR.TIMEOUT]: 'Road snapping timed out, so a straight line was used for that part.',
  [SNAP_ERROR.HTTP]: 'The road-snapping service is busy or refused the request, so a straight line was used for that part.',
  [SNAP_ERROR.NO_ROUTE]: 'No drivable path was found between those points (one-way streets can cause this), so a straight line was used.',
  [SNAP_ERROR.BAD_RESPONSE]: 'Road snapping returned something unexpected, so a straight line was used for that part.',
};

export function buildSnapUrl(a, b, config = ROUTING_CONFIG) {
  return `${config.baseUrl}/${config.profile}/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson&steps=false&alternatives=false`;
}

export function parseSnapResponse(json) {
  if (!json || json.code !== 'Ok' || !Array.isArray(json.routes) || !json.routes.length) return null;
  const coords = json.routes[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2 || !coords.every(isValidLngLat)) return null;
  return coords.map((c) => [c[0], c[1]]);
}

let chain = Promise.resolve();
let lastAt = 0;
export function resetSnapThrottle() { chain = Promise.resolve(); lastAt = 0; }

/** @returns {Promise<{ok:true,coords:number[][]}|{ok:false,code:string,message:string}>} */
export function snapSegment(a, b, {
  fetchImpl = typeof fetch !== 'undefined' ? fetch : undefined,
  config = ROUTING_CONFIG,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const fail = (code) => ({ ok: false, code, message: MESSAGES[code] });
  const run = async () => {
    if (!fetchImpl) return fail(SNAP_ERROR.NETWORK);
    const wait = lastAt + config.minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
    try {
      const res = await fetchImpl(buildSnapUrl(a, b, config), { signal: controller?.signal });
      if (res.status === 400 || res.status === 404) return fail(SNAP_ERROR.NO_ROUTE);
      if (!res.ok) return fail(SNAP_ERROR.HTTP);
      let json;
      try { json = await res.json(); } catch { return fail(SNAP_ERROR.BAD_RESPONSE); }
      if (json?.code === 'NoRoute' || json?.code === 'NoSegment') return fail(SNAP_ERROR.NO_ROUTE);
      const coords = parseSnapResponse(json);
      return coords ? { ok: true, coords } : fail(SNAP_ERROR.BAD_RESPONSE);
    } catch (e) {
      return fail(e?.name === 'AbortError' ? SNAP_ERROR.TIMEOUT : SNAP_ERROR.NETWORK);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}
