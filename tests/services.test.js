import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLocation, GEO_ERROR } from '../src/services/geolocation.js';
import { searchPlaces, clearGeocodeCache, GEOCODE_ERROR, createNominatimProvider } from '../src/services/geocoding.js';

const geo = (impl) => ({ getCurrentPosition: impl });

test('10. geolocation: permission denied gives a helpful message', async () => {
  const res = await requestLocation({ geolocation: geo((_ok, fail) => fail({ code: 1 })), isSecureContext: true });
  assert.equal(res.ok, false);
  assert.equal(res.code, GEO_ERROR.DENIED);
  assert.match(res.message, /search for your starting point|pick it on the map/i);
});

test('10. geolocation: timeout, unavailable, unsupported, insecure origin', async () => {
  assert.equal((await requestLocation({ geolocation: geo((_o, f) => f({ code: 3 })) })).code, GEO_ERROR.TIMEOUT);
  assert.equal((await requestLocation({ geolocation: geo((_o, f) => f({ code: 2 })) })).code, GEO_ERROR.UNAVAILABLE);
  assert.equal((await requestLocation({ geolocation: undefined })).code, GEO_ERROR.UNSUPPORTED);
  assert.equal((await requestLocation({ geolocation: geo(() => {}), isSecureContext: false })).code, GEO_ERROR.INSECURE);
  assert.equal((await requestLocation({ geolocation: geo(() => { throw new Error('boom'); }) })).code, GEO_ERROR.UNKNOWN);
});

test('geolocation: success returns [lng, lat]', async () => {
  const res = await requestLocation({ geolocation: geo((ok) => ok({ coords: { longitude: 1.5, latitude: 2.5, accuracy: 12 } })) });
  assert.deepEqual(res, { ok: true, coordinates: [1.5, 2.5], accuracyMeters: 12 });
});

const quick = { sleep: async () => {}, minIntervalMs: 0 };

test('10. geocoding: network failure is reported, not thrown', async () => {
  clearGeocodeCache();
  const res = await searchPlaces('Main Gate', { ...quick, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(res.ok, false);
  assert.equal(res.code, GEOCODE_ERROR.NETWORK);
  assert.match(res.message, /pick the point on the map/);
});

test('geocoding: HTTP error, bad JSON, timeout/abort, empty query', async () => {
  clearGeocodeCache();
  assert.equal((await searchPlaces('x1', { ...quick, fetchImpl: async () => ({ ok: false, status: 429 }) })).code, GEOCODE_ERROR.HTTP);
  assert.equal((await searchPlaces('x2', { ...quick, fetchImpl: async () => ({ ok: true, json: async () => ({ not: 'array' }) }) })).code, GEOCODE_ERROR.BAD_RESPONSE);
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal((await searchPlaces('x3', { ...quick, fetchImpl: async () => { throw abort; } })).code, GEOCODE_ERROR.TIMEOUT);
  assert.equal((await searchPlaces('   ', { ...quick, fetchImpl: async () => { throw new Error('should not be called'); } })).code, GEOCODE_ERROR.EMPTY_QUERY);
});

test('geocoding: results are parsed, tagged by service area, and cached', async () => {
  clearGeocodeCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(url, /nominatim/);
    return { ok: true, json: async () => [
      { display_name: 'In Area, Angeles, Pampanga, PH', lon: '120.59', lat: '15.15' },
      { display_name: 'Far Away, Manila, PH', lon: '121.0', lat: '14.6' },
      { display_name: 'Broken', lon: 'x', lat: 'y' },
    ] };
  };
  const first = await searchPlaces('test place', { ...quick, fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(first.results.length, 2);
  assert.equal(first.results[0].inServiceArea, true);
  assert.equal(first.results[1].inServiceArea, false);
  await searchPlaces('Test Place', { ...quick, fetchImpl });
  assert.equal(calls, 1, 'second identical search should hit the cache');
});

test('geocoding: requests are throttled to the configured interval', async () => {
  clearGeocodeCache();
  let t = 1000;
  const waits = [];
  const opts = { fetchImpl: async () => ({ ok: true, json: async () => [] }), now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, minIntervalMs: 1100 };
  await searchPlaces('one', opts);
  t += 100;
  await searchPlaces('two', opts);
  assert.equal(waits.length >= 1, true);
  assert.ok(waits.at(-1) <= 1100 && waits.at(-1) > 0);
});

test('provider adapter builds a bounded-bias Philippine query without autocomplete params', () => {
  const url = createNominatimProvider().buildUrl('Holy Angel University');
  assert.match(url, /countrycodes=ph/);
  assert.match(url, /viewbox=/);
  assert.match(url, /bounded=0/);
});
