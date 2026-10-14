// Place search behind a small provider adapter. The default provider is the
// public Nominatim service, which forbids autocomplete-style traffic: search
// only on explicit submit, at most one request per second, and cache results.

import { GEOCODING_CONFIG, SERVICE_AREA_BBOX } from '../config.js';
import { bboxContains, isValidLngLat } from '../routing/geo.js';

export const GEOCODE_ERROR = Object.freeze({
  EMPTY_QUERY: 'empty_query',
  NETWORK: 'network_error',
  TIMEOUT: 'timeout',
  HTTP: 'http_error',
  BAD_RESPONSE: 'bad_response',
});

const MESSAGES = {
  [GEOCODE_ERROR.EMPTY_QUERY]: 'Type a place name or landmark first.',
  [GEOCODE_ERROR.NETWORK]: 'Place search is unavailable right now. You can pick the point on the map instead.',
  [GEOCODE_ERROR.TIMEOUT]: 'Place search timed out. Try again, or pick the point on the map.',
  [GEOCODE_ERROR.HTTP]: 'Place search is busy or unavailable. Try again shortly, or pick the point on the map.',
  [GEOCODE_ERROR.BAD_RESPONSE]: 'Place search returned something unexpected. Pick the point on the map instead.',
};

/** Provider adapter: replace this to switch geocoder. */
export function createNominatimProvider(config = GEOCODING_CONFIG, bbox = SERVICE_AREA_BBOX) {
  return {
    name: config.provider,
    attribution: config.attribution,
    buildUrl(query) {
      const params = new URLSearchParams({
        format: 'jsonv2',
        limit: String(config.limit),
        countrycodes: config.countryCodes,
        // Bias (not restrict) to the service area; west,north,east,south.
        viewbox: `${bbox[0]},${bbox[3]},${bbox[2]},${bbox[1]}`,
        bounded: '0',
        q: query,
      });
      return `${config.baseUrl}?${params}`;
    },
    parse(json) {
      if (!Array.isArray(json)) throw new Error('not an array');
      return json
        .map((r) => ({
          label: String(r.display_name ?? '').split(',').slice(0, 3).join(',').trim(),
          fullLabel: String(r.display_name ?? ''),
          coordinates: [Number(r.lon), Number(r.lat)],
        }))
        .filter((r) => r.label && isValidLngLat(r.coordinates));
    },
  };
}

const cache = new Map();
let lastRequestAt = 0;

export function clearGeocodeCache() {
  cache.clear();
  lastRequestAt = 0;
}

/**
 * @returns {Promise<{ok:true,results:Array<{label,fullLabel,coordinates,inServiceArea}>}|{ok:false,code:string,message:string}>}
 */
export async function searchPlaces(query, {
  provider = createNominatimProvider(),
  fetchImpl = typeof fetch !== 'undefined' ? fetch : undefined,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  minIntervalMs = GEOCODING_CONFIG.minIntervalMs,
  timeoutMs = GEOCODING_CONFIG.timeoutMs,
  bbox = SERVICE_AREA_BBOX,
} = {}) {
  const fail = (code) => ({ ok: false, code, message: MESSAGES[code] });
  const q = (query ?? '').trim();
  if (!q) return fail(GEOCODE_ERROR.EMPTY_QUERY);
  if (!fetchImpl) return fail(GEOCODE_ERROR.NETWORK);

  const key = `${provider.name}:${q.toLowerCase()}`;
  const tag = (list) => list.map((r) => ({ ...r, inServiceArea: bboxContains(bbox, r.coordinates) }));
  if (cache.has(key)) return { ok: true, results: tag(cache.get(key)) };

  const wait = lastRequestAt + minIntervalMs - now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = now();

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(provider.buildUrl(q), {
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!res.ok) return fail(GEOCODE_ERROR.HTTP);
    let parsed;
    try {
      parsed = provider.parse(await res.json());
    } catch {
      return fail(GEOCODE_ERROR.BAD_RESPONSE);
    }
    cache.set(key, parsed);
    return { ok: true, results: tag(parsed) };
  } catch (e) {
    return fail(e?.name === 'AbortError' ? GEOCODE_ERROR.TIMEOUT : GEOCODE_ERROR.NETWORK);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
