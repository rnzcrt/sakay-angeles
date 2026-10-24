import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLocation, GEO_ERROR } from '../src/services/geolocation.js';
import { searchPlaces, clearGeocodeCache, GEOCODE_ERROR, createNominatimProvider } from '../src/services/geocoding.js';
import { routeWalking, resetWalkingThrottle } from '../src/services/walking.js';
import { findNearbyPedestrianFacilities } from '../src/services/pedestrianFacilities.js';
import { estimateItineraryFares, estimateJeepneyFare } from '../src/services/fares.js';

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

test('pedestrian router returns network geometry and its measured distance', async () => {
  resetWalkingThrottle();
  const result = await routeWalking([120.58, 15.15], [120.59, 15.16], {
    config: { baseUrl: 'https://walk.test/route/v1/driving', timeoutMs: 1000 },
    fetchImpl: async (url) => {
      assert.match(url, /120\.58,15\.15;120\.59,15\.16/);
      return { ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 1450, duration: 900, geometry: { coordinates: [[120.58, 15.15], [120.585, 15.155], [120.59, 15.16]] }, legs: [{ steps: [{ distance: 500, name: 'Sample Street', maneuver: { type: 'depart' } }] }] }] }) };
    },
  });
  assert.equal(result.distanceMeters, 1450);
  assert.equal(result.durationSeconds, 900);
  assert.equal(result.coordinates.length, 3);
  assert.match(result.steps[0].instruction, /Sample Street/);
});

test('short pedestrian paths are accepted while failed or far-snapped paths return no geometry', async () => {
  resetWalkingThrottle();
  const start = [120.58, 15.15];
  const end = [120.5801, 15.1506];
  const options = { config: { baseUrl: 'https://walk.test/route/v1/driving', timeoutMs: 1000, minIntervalMs: 0, maxSnapDistanceMeters: 80 } };
  const short = await routeWalking(start, end, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 75, duration: 60, geometry: { coordinates: [start, [120.58005, 15.1503], end] }, legs: [] }] }) }) });
  assert.equal(short.distanceMeters, 75);
  assert.equal(short.coordinates.length, 3);
  resetWalkingThrottle();
  const diagnostics = [];
  const failed = await routeWalking(start, end, { ...options, onDiagnostic: (event) => diagnostics.push(event), fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(failed, null);
  assert.equal(diagnostics.at(-1).status, 'http_error');
  resetWalkingThrottle();
  const unsnappable = await routeWalking(start, end, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 75, duration: 60, geometry: { coordinates: [[120.59, 15.15], [120.5901, 15.1506]] }, legs: [] }] }) }) });
  assert.equal(unsnappable, null);
});

test('pedestrian facility lookup labels mapped bridges and excludes private crossings', async () => {
  const facilities = await findNearbyPedestrianFacilities([120.58, 15.15], {
    config: { endpoint: 'https://overpass.test/api', radiusMeters: 1200, timeoutMs: 1000 },
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'POST');
      return { ok: true, json: async () => ({ elements: [
        { type: 'way', id: 1, center: { lon: 120.581, lat: 15.151 }, tags: { highway: 'footway', bridge: 'yes', name: 'Sample Footbridge' } },
        { type: 'node', id: 2, lon: 120.582, lat: 15.152, tags: { highway: 'crossing', access: 'private' } },
      ] }) };
    },
  });
  assert.equal(facilities.length, 1);
  assert.equal(facilities[0].kind, 'Pedestrian footbridge');
  assert.equal(facilities[0].name, 'Sample Footbridge');
});

test('traditional jeepney fare uses the 4 km minimum and succeeding-km matrix', () => {
  assert.equal(estimateJeepneyFare({ distanceMeters: 4000, distanceUncertaintyMeters: 0, fareClass: 'traditional' }).fare, 14);
  assert.equal(estimateJeepneyFare({ distanceMeters: 5000, distanceUncertaintyMeters: 0, fareClass: 'traditional' }).fare, 16);
  assert.equal(estimateJeepneyFare({ distanceMeters: 5001, distanceUncertaintyMeters: 0, fareClass: 'traditional' }).fare, 18);
  assert.equal(estimateJeepneyFare({ distanceMeters: 5000, distanceUncertaintyMeters: 0, fareClass: 'modern' }).fare, 19.4);
});

test('traditional discounted matrix rates apply to student, senior and PWD fares', () => {
  for (const passengerType of ['student', 'senior', 'pwd']) {
    const fare = estimateJeepneyFare({ distanceMeters: 5000, distanceUncertaintyMeters: 0, fareClass: 'traditional', passengerType });
    assert.equal(fare.fare, 12.85);
    assert.deepEqual(fare.discountRange, { min: 3.15, max: 3.15 });
  }
});

test('each jeepney ride is priced separately; walks cost nothing and unknown vehicle classes stay unavailable', () => {
  const summary = estimateItineraryFares([
    { type: 'ride', routeId: 'one', routeName: 'One', fareClass: 'traditional', rideMeters: 3000, fareDistanceUncertaintyMeters: 0 },
    { type: 'transfer', walkMeters: 100 },
    { type: 'ride', routeId: 'two', routeName: 'Two', fareClass: 'traditional', rideMeters: 3000, fareDistanceUncertaintyMeters: 0 },
  ]);
  assert.equal(summary.totalFare, 28);
  assert.equal(summary.rides.length, 2);
  assert.equal(estimateJeepneyFare({ distanceMeters: 3000, fareClass: null }).status, 'unavailable');
});

test('approximate distances produce dynamic fare ranges and incomplete rides never masquerade as a total', () => {
  const ride = estimateJeepneyFare({ distanceMeters: 5000, fareClass: 'traditional' });
  assert.equal(ride.status, 'range_estimate');
  assert.deepEqual(ride.fareRange, { min: 16, max: 18 });
  const student = estimateJeepneyFare({ distanceMeters: 5000, fareClass: 'traditional', passengerType: 'student' });
  assert.deepEqual(student.fareRange, { min: 12.85, max: 14.45 });
  const total = estimateItineraryFares([
    { type: 'ride', routeName: 'known', fareClass: 'traditional', rideMeters: 5000 },
    { type: 'ride', routeName: 'unknown', fareClass: null, rideMeters: 3000 },
  ], 'student');
  assert.equal(total.status, 'unavailable');
  assert.equal(total.totalFare, null);
  assert.deepEqual(total.partialKnownFareRange, { min: 12.85, max: 14.45 });
  assert.equal(estimateItineraryFares([]).totalFare, null);
});
