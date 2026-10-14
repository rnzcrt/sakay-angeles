import test from 'node:test';
import assert from 'node:assert/strict';
import { snapSegment, buildSnapUrl, parseSnapResponse, resetSnapThrottle, SNAP_ERROR } from '../src/services/routing.js';

const ok = (coords) => async () => ({ ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: coords } }] }) });
const quick = { sleep: async () => {} };
const A = [120.58, 15.15];
const B = [120.59, 15.16];

test('snap URL asks for a full GeoJSON geometry in lng,lat order', () => {
  const url = buildSnapUrl(A, B);
  assert.match(url, /driving\/120\.58,15\.15;120\.59,15\.16\?/);
  assert.match(url, /overview=full/);
  assert.match(url, /geometries=geojson/);
});

test('parseSnapResponse accepts good geometry and rejects bad data', () => {
  assert.deepEqual(parseSnapResponse({ code: 'Ok', routes: [{ geometry: { coordinates: [[1, 2], [3, 4]] } }] }), [[1, 2], [3, 4]]);
  assert.equal(parseSnapResponse({ code: 'NoRoute' }), null);
  assert.equal(parseSnapResponse({ code: 'Ok', routes: [{ geometry: { coordinates: [[1, 2]] } }] }), null);
  assert.equal(parseSnapResponse({ code: 'Ok', routes: [{ geometry: { coordinates: [[1, 2], [999, 4]] } }] }), null);
  assert.equal(parseSnapResponse(null), null);
});

test('snapSegment returns the routed path', async () => {
  resetSnapThrottle();
  const res = await snapSegment(A, B, { ...quick, fetchImpl: ok([[120.58, 15.15], [120.585, 15.152], [120.59, 15.16]]) });
  assert.equal(res.ok, true);
  assert.equal(res.coords.length, 3);
});

test('snapSegment reports failures instead of throwing', async () => {
  resetSnapThrottle();
  assert.equal((await snapSegment(A, B, { ...quick, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } })).code, SNAP_ERROR.NETWORK);
  assert.equal((await snapSegment(A, B, { ...quick, fetchImpl: async () => ({ ok: false, status: 429 }) })).code, SNAP_ERROR.HTTP);
  assert.equal((await snapSegment(A, B, { ...quick, fetchImpl: async () => ({ ok: false, status: 400 }) })).code, SNAP_ERROR.NO_ROUTE);
  assert.equal((await snapSegment(A, B, { ...quick, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 'NoRoute' }) }) })).code, SNAP_ERROR.NO_ROUTE);
  assert.equal((await snapSegment(A, B, { ...quick, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }) })).code, SNAP_ERROR.BAD_RESPONSE);
  const abort = Object.assign(new Error('a'), { name: 'AbortError' });
  assert.equal((await snapSegment(A, B, { ...quick, fetchImpl: async () => { throw abort; } })).code, SNAP_ERROR.TIMEOUT);
  const failed = await snapSegment(A, B, { ...quick, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.match(failed.message, /straight line/);
});

test('requests are throttled', async () => {
  resetSnapThrottle();
  let t = 1000; const waits = [];
  const opts = { fetchImpl: ok([[1, 1], [2, 2]]), now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } };
  await snapSegment(A, B, opts);
  await snapSegment(A, B, opts);
  assert.ok(waits.length >= 1 && waits.at(-1) > 0);
});
