import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRateLimiter } from '../src/security/rateLimit.js';
import { loadData } from '../src/data/loadData.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('rate limiter expires attempts and caps the key set', () => {
  let now = 100;
  const limit = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, now: () => now });
  assert.equal(limit('a').allowed, true);
  assert.equal(limit('a').allowed, true);
  assert.equal(limit('a').allowed, false);
  limit('b'); limit('c');
  assert.equal(limit('c').allowed, true);
  now += 1001;
  assert.equal(limit('a').allowed, true);
});

test('Node server enforces OAuth/admin boundaries and keeps route save/history isolated', async (t) => {
  const probe = createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address(); await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const mockLogDir = mkdtempSync(path.join(os.tmpdir(), 'sakay-feedback-test-'));
  const mockWriteLog = path.join(mockLogDir, 'writes.log');
  const allowlist = process.env.ADMIN_GITHUB_USERS || 'allowed-admin';
  const child = spawn(process.execPath, ['--import', path.join(root, 'tests/mock-github.mjs'), path.join(root, 'server.js')], {
    cwd: root, env: { ...process.env, NODE_ENV: 'development', PORT: String(port), HOST: '127.0.0.1', BASE_URL: base,
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || 'test-client-id', GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || 'test-client-secret',
      SESSION_SECRET: process.env.SESSION_SECRET || 'test-only-session-secret-with-more-than-32-bytes', ADMIN_GITHUB_USERS: allowlist,
      TRUST_PROXY_CLIENT_IP: 'true',
      MOCK_GITHUB_LOGIN: allowlist.split(',')[0].trim(),
      MOCK_FEEDBACK_FAILURE: 'delete-label,create-label,comment,patch-issue',
      MOCK_GITHUB_WRITE_LOG: mockWriteLog,
      SAKAY_DATA_GITHUB_TOKEN: 'test-data-token', SAKAY_DATA_GITHUB_OWNER: 'test-owner',
      SAKAY_DATA_GITHUB_REPO: 'test-data', SAKAY_DATA_GITHUB_BRANCH: 'main' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  t.after(async () => { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 1500); }); rmSync(mockLogDir, { recursive: true, force: true }); });
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${base}/api/admin/session`)).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, 'server starts with isolated OAuth configuration');

  let response = await fetch(`${base}/`);
  assert.equal(response.status, 200, 'homepage is served by the static-file path');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(response.headers.get('permissions-policy'), /geolocation=\(self\)/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('strict-transport-security'), null, 'local HTTP homepage does not receive HSTS');

  response = await fetch(`${base}/api/admin/dataset`);
  assert.equal(response.status, 401);
  assert.equal((await fetch(`${base}/api/admin/dataset`, { headers: { 'X-Admin': 'true', 'X-User': 'allowed-admin' } })).status, 401);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(response.headers.get('permissions-policy'), /geolocation=\(self\)/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /https:\/\/tiles\.openfreemap\.org/);
  assert.match(response.headers.get('content-security-policy'), /worker-src 'self' blob:/);
  assert.equal(response.headers.get('strict-transport-security'), null, 'HSTS is omitted for local HTTP');
  assert.equal((await fetch(`${base}/trace.html`)).status, 401);

  const login = async (code) => {
    const start = await fetch(`${base}/auth/github`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const stateCookie = start.headers.getSetCookie().find((value) => value.startsWith('sakay_oauth_state=')).split(';')[0];
    return fetch(`${base}/auth/callback?state=${encodeURIComponent(state)}&code=${code}&next=https%3A%2F%2Fevil.example`, { headers: { Cookie: stateCookie }, redirect: 'manual' });
  };
  const invalidStart = await fetch(`${base}/auth/github`, { redirect: 'manual' });
  const validState = new URL(invalidStart.headers.get('location')).searchParams.get('state');
  const invalidCookie = invalidStart.headers.getSetCookie().find((value) => value.startsWith('sakay_oauth_state=')).split(';')[0];
  response = await fetch(`${base}/auth/callback?state=wrong-state&code=admin&next=https%3A%2F%2Fevil.example`, { headers: { Cookie: invalidCookie }, redirect: 'manual' });
  assert.equal(response.status, 400, 'OAuth state mismatch is rejected');
  assert.ok(validState);
  assert.equal((await login('outsider')).status, 403);
  response = await login('admin');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/routes');
  const sessionCookie = response.headers.getSetCookie().find((value) => value.startsWith('sakay_admin='));
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /SameSite=Lax/);
  const adminCookie = sessionCookie.split(';')[0];
  const headers = { Cookie: adminCookie };
  const originHeaders = { ...headers, Origin: base };
  response = await fetch(`${base}/api/admin/feedback` , { headers });
  assert.equal(response.status, 200, 'feedback list is loaded from the mocked GitHub API');
  assert.equal((await response.json())[0].number, 123);
  response = await fetch(`${base}/api/admin/feedback/status`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 0, status: 'resolved' }) });
  assert.equal(response.status, 400, 'invalid issue numbers are rejected');
  response = await fetch(`${base}/api/admin/feedback/status`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 123, status: 'resolved', note: { credential: 'invalid' } }) });
  assert.equal(response.status, 400, 'notes must be bounded plain text');

  const submitFeedbackStatus = (number, status, note) => fetch(`${base}/api/admin/feedback/status`, {
    method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number, status, ...(note === undefined ? {} : { note }) }),
  });
  const resetWrites = () => writeFileSync(mockWriteLog, '');
  const writes = () => readFileSync(mockWriteLog, 'utf8');

  resetWrites();
  response = await submitFeedbackStatus(124, 'accepted');
  assert.equal(response.status, 400, 'an issue with ordinary labels but no community-feedback label is rejected');
  assert.equal(writes(), '', 'unrelated issues cause no GitHub writes, including label creation');
  resetWrites();
  response = await submitFeedbackStatus(125, 'accepted');
  assert.equal(response.status, 400, 'pull requests are rejected');
  assert.equal(writes(), '', 'pull requests cause no GitHub writes');
  resetWrites();
  response = await submitFeedbackStatus(126, 'accepted');
  assert.equal(response.status, 400, 'issues without a labels array are rejected');
  assert.equal(writes(), '', 'malformed issues cause no GitHub writes');
  resetWrites();
  response = await submitFeedbackStatus(127, 'accepted');
  assert.equal(response.status, 404, 'a missing issue is reported as not found');
  assert.equal(writes(), '', 'missing issues cause no GitHub writes');

  resetWrites();
  response = await submitFeedbackStatus(123, 'accepted');
  assert.equal(response.status, 200, 'a valid community-feedback issue can be updated');
  const afterValidStatus = await (await fetch(`${base}/api/admin/feedback`, { headers })).json();
  assert.ok(afterValidStatus[0].labels.includes('triaged'), 'ordinary issue labels are preserved');

  resetWrites();
  response = await submitFeedbackStatus(123, 'needs-information');
  assert.equal(response.status, 502, 'a failed status-label creation is not reported as success');
  assert.match((await response.json()).error, /prepare the report status label/i);
  assert.match(writes(), /^POST labels\n$/);
  resetWrites();
  response = await submitFeedbackStatus(123, 'accepted', 'Synthetic comment failure.');
  assert.equal(response.status, 502, 'a failed comment is not reported as success');
  assert.match((await response.json()).error, /could not add the review note/i);
  assert.match(writes(), /POST issues\/123\/comments/);
  resetWrites();
  response = await submitFeedbackStatus(123, 'accepted');
  assert.equal(response.status, 502, 'a failed issue-state update is not reported as success');
  assert.match((await response.json()).error, /could not update the report state/i);
  assert.match(writes(), /PATCH issues\/123/);

  resetWrites();
  response = await fetch(`${base}/api/admin/feedback/status`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 123, status: 'rejected', note: 'Synthetic partial failure test.' }) });
  assert.equal(response.status, 502, 'failed cleanup after applying a status label is not reported as success');
  assert.match((await response.json()).error, /new status label was applied/i);
  assert.equal((await fetch(`${base}/api/admin/dataset`, { headers })).status, 200);
  response = await fetch(`${base}/admin.html`, { headers, redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  response = await fetch(`${base}/api/routes`);
  assert.equal(response.status, 200, 'public route data is served through the public API');
  const publicData = await response.json();
  assert.ok(publicData.routes.length > 0);
  assert.doesNotMatch(JSON.stringify(publicData), /test-data-token/);
  assert.doesNotMatch(JSON.stringify(publicData), /fixture-admin-only-value/, 'public API allowlists fields instead of forwarding private repository metadata');
  const serializedPublic = JSON.stringify(publicData);
  for (const marker of ['private-direction-sentinel', 'private-evidence-sentinel', 'private-deep-direction-sentinel', 'private-direction-object-sentinel', 'private-secondary-sentinel', 'private-array-element-sentinel', 'private-deep-secondary-sentinel', 'private-secondary-array-deep-sentinel', 'private-geometry-nested-sentinel']) {
    assert.doesNotMatch(serializedPublic, new RegExp(marker), `nested private marker ${marker} is excluded`);
  }
  const projectedRoute = publicData.routes.find((route) => route.id === 'm-gate-friendship');
  assert.equal(projectedRoute.directions[0].label, 'Public direction label');
  assert.deepEqual(projectedRoute.directions[0].orderedStopIds, ['m-gate-friendship-terminal-a', 'm-gate-friendship-terminal-b']);
  assert.equal(projectedRoute.directions[0].evidence.source, 'Public evidence source');
  assert.equal(projectedRoute.secondarySources[1].roads[0], 'Public road');
  assert.deepEqual(projectedRoute.geometryEvidence, { source: 'Public geometry evidence source', method: 'Public geometry evidence method', checkedAt: '2026-01-01' });
  assert.deepEqual(projectedRoute.fareClassEvidence, { source: 'Public fare evidence source', method: 'Public fare evidence method', checkedAt: '2026-01-02' });
  assert.equal(publicData.geojson.features[0].geometry.type, 'LineString');
  for (const marker of ['private-geometry-evidence-sentinel', 'private-geometry-evidence-id', 'private-geometry-evidence-nested-sentinel', 'private-geometry-evidence-array-sentinel', 'private-fare-evidence-sentinel', 'private-fare-evidence-id', 'private-fare-evidence-nested-sentinel', 'private-fare-evidence-array-sentinel']) {
    assert.doesNotMatch(serializedPublic, new RegExp(marker), `route evidence excludes ${marker}`);
  }
  const loadedPublicData = await loadData('/', async () => Response.json(publicData));
  assert.equal(loadedPublicData.ok, true, 'client-side validation accepts the API projection with route evidence');
  assert.equal(loadedPublicData.data.routes.find((route) => route.id === 'angeles-san-fernando').geometryEvidence, undefined, 'missing optional evidence remains valid for the current draft route');
  const verifiedExample = structuredClone(publicData);
  const verifiedExampleRoute = verifiedExample.routes.find((route) => route.id === 'm-gate-friendship');
  verifiedExampleRoute.geometryStatus = 'verified';
  verifiedExampleRoute.fareClass = 'traditional';
  assert.equal((await loadData('/', async () => Response.json(verifiedExample))).ok, true, 'projected evidence satisfies client validation when geometry and fare class are verified');
  assert.equal((await fetch(`${base}/data/routes.json`)).status, 404, 'static repository copies are not served');
  let dataset = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const historicalDataset = structuredClone(dataset);
  const metadataOnly = structuredClone(dataset);
  const metadataRoute = metadataOnly.routes[0];
  const metadataRouteId = metadataRoute.id;
  metadataRoute.name = `${metadataRoute.name} metadata edit`;
  metadataRoute.geometryStatus = 'unverified';
  delete metadataRoute.geometryEvidence;
  metadataRoute.directions[0].verificationStatus = 'unverified';
  delete metadataRoute.directions[0].evidence;
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({
    data: metadataOnly, editedRouteIds: [metadataRouteId], expectedCommitSha: dataset.commitSha,
    audit: { change: 'Synthetic metadata-only edit', reason: 'Preserve geometry verification for non-geometric edits', source: 'Automated test fixture', observation: 'Synthetic metadata only.' },
  }) });
  assert.equal(response.status, 200, 'metadata-only route edits are accepted');
  dataset = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const metadataSavedRoute = dataset.routes.find((item) => item.id === metadataRouteId);
  assert.equal(metadataSavedRoute.geometryStatus, 'verified', 'metadata-only edits preserve geometry verification');
  assert.deepEqual(metadataSavedRoute.geometryEvidence, historicalDataset.routes.find((item) => item.id === metadataRouteId).geometryEvidence);
  assert.equal(metadataSavedRoute.directions[0].verificationStatus, 'verified');
  assert.deepEqual(metadataSavedRoute.directions[0].evidence, historicalDataset.routes.find((item) => item.id === metadataRouteId).directions[0].evidence);
  const feature = dataset.geojson.features[0];
  const routeId = feature.properties.routeId;
  const originalGeometry = structuredClone(feature.geometry);
  const target = feature.geometry.type === 'LineString' ? feature.geometry.coordinates : feature.geometry.coordinates[0];
  target[0] = [target[0][0] + 0.0001, target[0][1]];
  const payload = { data: dataset, editedRouteIds: [routeId], expectedCommitSha: dataset.commitSha, audit: { change: 'Adjust route trace', reason: 'Test verification only', source: 'Automated test fixture', observation: 'Temporary integration test; not real route evidence.' } };

  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 401, 'protected writes reject users without an admin session');
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 415);
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...headers, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400, 'the local Vite origin is allowed through the development proxy');
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: ' '.repeat(4_000_001) });
  assert.equal(response.status, 413);
  response = await fetch(`${base}/api/admin/history/item?id=..%2F..%2Fserver.js`, { headers });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/admin/save`, { method: 'GET', headers });
  assert.equal(response.status, 404);
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 403);
  const tampered = structuredClone(payload);
  const unrelatedFeature = tampered.data.geojson.features.find((candidate) => candidate.properties.routeId !== routeId);
  const unrelatedPath = unrelatedFeature.geometry.type === 'LineString' ? unrelatedFeature.geometry.coordinates : unrelatedFeature.geometry.coordinates[0];
  unrelatedPath[0] = [unrelatedPath[0][0] + 0.0001, unrelatedPath[0][1]];
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(tampered) });
  assert.equal(response.status, 400, 'undeclared route changes are rejected');
  const invalidDataset = structuredClone(payload);
  const invalidFeature = invalidDataset.data.geojson.features.find((candidate) => candidate.properties.routeId === routeId);
  invalidFeature.geometry.coordinates[0] = [999, 999];
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(invalidDataset) });
  assert.equal(response.status, 422, 'invalid datasets do not create a remote commit');
  const invalidDirection = structuredClone(payload);
  invalidDirection.data.geojson.features.find((candidate) => candidate.properties.routeId === routeId).properties.directionId = `${routeId}-missing-direction`;
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(invalidDirection) });
  assert.equal(response.status, 422, 'geometry with a missing direction reference is rejected server-side');

  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const { revision } = await response.json();
  const firstSaved = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  assert.notDeepEqual(firstSaved.geojson.features.find((item) => item.properties.routeId === routeId).geometry, originalGeometry);
  const refreshedPublicData = await (await fetch(`${base}/api/routes`)).json();
  assert.deepEqual(refreshedPublicData.geojson.features.find((item) => item.properties.routeId === routeId).geometry, firstSaved.geojson.features.find((item) => item.properties.routeId === routeId).geometry);
  assert.equal((await (await fetch(`${base}/api/admin/history`, { headers })).json()).length, 3);
  const historyResponse = await fetch(`${base}/api/admin/history/item?id=${encodeURIComponent(revision)}`, { headers });
  assert.equal(historyResponse.status, 200);
  const revisionSnapshot = await historyResponse.json();
  assert.deepEqual(revisionSnapshot.data.geojson.features.find((item) => item.properties.routeId === routeId).geometry, firstSaved.geojson.features.find((item) => item.properties.routeId === routeId).geometry);
  const historicalRoute = dataset.routes.find((item) => item.id === routeId);
  assert.equal(historicalRoute.geometryStatus, 'verified');
  assert.equal(historicalRoute.fareClass, 'traditional');
  assert.equal(historicalRoute.fareClassEvidence.source, 'Public fare evidence source');
  assert.equal(historicalRoute.fareClassEvidence.method, 'Public fare evidence method');
  assert.equal(historicalRoute.fareClassEvidence.checkedAt, '2026-01-02');
  assert.equal(historicalRoute.directions[0].verificationStatus, 'verified');
  assert.ok(historicalRoute.geometryEvidence);
  assert.ok(historicalRoute.directions[0].evidence);

  const secondDataset = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const secondFeature = secondDataset.geojson.features.find((item) => item.properties.routeId === routeId);
  const secondPath = secondFeature.geometry.coordinates;
  secondPath[1] = [secondPath[1][0] + 0.0001, secondPath[1][1]];
  const secondPayload = { data: secondDataset, editedRouteIds: [routeId], expectedCommitSha: secondDataset.commitSha,
    audit: { change: 'Second test adjustment', reason: 'Test history rollback', source: 'Automated test fixture', observation: 'Temporary test data only.' } };
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(secondPayload) });
  assert.equal(response.status, 200);
  const secondCommitSha = (await response.json()).commitSha;
  assert.equal((await (await fetch(`${base}/api/admin/history`, { headers })).json()).length, 4);
  response = await fetch(`${base}/api/admin/restore`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: dataset.commitSha, expectedCommitSha: secondCommitSha }) });
  assert.equal(response.status, 200);
  const restoredRevision = (await response.json()).commitSha;
  const restored = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  assert.deepEqual(restored.geojson.features.find((item) => item.properties.routeId === routeId).geometry, historicalDataset.geojson.features.find((item) => item.properties.routeId === routeId).geometry);
  assert.deepEqual(restored.stops, dataset.stops, 'restore preserves historical stops');
  assert.deepEqual(restored.transfers, dataset.transfers, 'restore preserves historical transfers');
  assert.deepEqual(restored.geojson.features.map((item) => item.geometry), historicalDataset.geojson.features.map((item) => item.geometry), 'restore preserves all historical GeoJSON geometry');
  assert.ok(restored.geojson.features.every((item) => item.properties.draft === true), 'restore marks every GeoJSON feature as draft');
  const restoredRoute = restored.routes.find((item) => item.id === routeId);
  assert.equal(restoredRoute.geometryStatus, 'unverified');
  assert.equal(restoredRoute.fareClass, historicalRoute.fareClass, 'fare classification is preserved independently from geometry verification');
  assert.deepEqual(restoredRoute.fareClassEvidence, historicalRoute.fareClassEvidence, 'valid fare evidence is preserved');
  assert.equal(Object.hasOwn(restoredRoute, 'geometryEvidence'), false, 'route geometry evidence is removed');
  assert.ok(restoredRoute.directions.every((item) => item.verificationStatus === 'unverified'));
  assert.ok(restoredRoute.directions.every((item) => !Object.hasOwn(item, 'evidence')), 'direction evidence is removed');
  const historyAfterRestore = await (await fetch(`${base}/api/admin/history`, { headers })).json();
  assert.equal(historyAfterRestore.length, 5, 'restore adds a commit without rewriting existing history');
  assert.equal(historyAfterRestore[0].commitSha, restoredRevision);
  assert.deepEqual(new Set(historyAfterRestore.map((item) => item.commitSha)), new Set([historicalDataset.commitSha, dataset.commitSha, revision, secondCommitSha, restoredRevision]), 'restored source revision and all later commits remain in history');

  const saveAdminDataset = async (current, data, editedRouteId, change) => fetch(`${base}/api/admin/save`, {
    method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, editedRouteIds: [editedRouteId], expectedCommitSha: current.commitSha,
      audit: { change, reason: 'Synthetic route-management integration test', source: 'Automated test fixture', observation: 'No real-world route details were used.' } }),
  });
  let managed = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const spoofRouteId = 'test-managed-unverified-route';
  const spoofData = structuredClone(managed);
  spoofData.routes.push({ id: spoofRouteId, name: 'Synthetic unverified route', sourceLabel: 'Synthetic test label', jeepneyColorName: 'Slate', displayColor: '#667788', geometryStatus: 'verified', geometryEvidence: { source: 'Synthetic claim', method: 'Automated test fixture', checkedAt: '2026-01-01' }, description: 'Test-only route with no traced geometry.', directions: [], active: true });
  spoofData.routesFile.routes = spoofData.routes;
  response = await saveAdminDataset(managed, spoofData, spoofRouteId, 'Reject client-supplied verification');
  assert.equal(response.status, 200);
  managed = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const storedSpoofRoute = managed.routes.find((item) => item.id === spoofRouteId);
  assert.equal(storedSpoofRoute.geometryStatus, 'unverified', 'a newly created route cannot self-assert verified geometry');
  assert.equal(Object.hasOwn(storedSpoofRoute, 'geometryEvidence'), false);
  const removeSpoof = structuredClone(managed);
  removeSpoof.routes = removeSpoof.routes.filter((item) => item.id !== spoofRouteId);
  removeSpoof.routesFile.routes = removeSpoof.routes;
  response = await saveAdminDataset(managed, removeSpoof, spoofRouteId, 'Remove synthetic verification test route');
  assert.equal(response.status, 200);
  managed = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const addedRoute = { id: 'test-managed-jeepney', name: 'Synthetic managed route', sourceLabel: 'Synthetic test label', jeepneyColorName: 'Slate', displayColor: '#667788', geometryStatus: 'unverified', tracingStatus: 'ready-for-tracing', description: 'Test-only metadata.', directions: [], active: true };
  const withAdded = structuredClone(managed); withAdded.routes.push(addedRoute); withAdded.routesFile.routes = withAdded.routes;
  response = await saveAdminDataset(managed, withAdded, addedRoute.id, 'Add synthetic Jeepney before tracing');
  assert.equal(response.status, 200, 'authorized admins can save a new Jeepney before tracing');
  managed = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const savedWithoutGeometry = managed.routes.find((item) => item.id === addedRoute.id);
  assert.ok(savedWithoutGeometry, 'new Jeepney is persisted before route tracing');
  assert.equal(savedWithoutGeometry.geometryStatus, 'unverified');
  assert.deepEqual(savedWithoutGeometry.directions, [], 'new Jeepney does not need directions before tracing');
  assert.equal(managed.geojson.features.some((item) => item.properties.routeId === addedRoute.id), false, 'new Jeepney is saved without geometry');
  let publicManaged = await (await fetch(`${base}/api/routes`)).json();
  assert.equal(publicManaged.routes.find((item) => item.id === addedRoute.id).displayColor, '#667788', 'new active Jeepney metadata is public before tracing');

  const withTrace = structuredClone(managed);
  withTrace.routes.find((item) => item.id === addedRoute.id).directions.push({ id: 'test-managed-direction', geometryId: 'test-managed-geometry', label: 'Synthetic A to B', verificationStatus: 'unverified', orderedStopIds: [], active: true });
  withTrace.geojson.features.push({ type: 'Feature', properties: { routeId: addedRoute.id, directionId: 'test-managed-direction', geometryId: 'test-managed-geometry', direction: 'a', draft: true }, geometry: { type: 'LineString', coordinates: [[120, 15], [120.01, 15]] } });
  response = await saveAdminDataset(managed, withTrace, addedRoute.id, 'Save synthetic traced geometry');
  assert.equal(response.status, 200, 'traced geometry can be saved in a second save without starting point or destination fields');
  managed = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  publicManaged = await (await fetch(`${base}/api/routes`)).json();
  assert.equal(publicManaged.routes.find((item) => item.id === addedRoute.id).active, true);
  assert.equal(publicManaged.routes.find((item) => item.id === addedRoute.id).directions[0].id, 'test-managed-direction');
  assert.equal(publicManaged.geojson.features.some((item) => item.properties.routeId === addedRoute.id), true, 'traced geometry is served after the second save');
  const directionInactiveData = structuredClone(managed);
  directionInactiveData.routes.find((item) => item.id === addedRoute.id).directions[0].active = false;
  response = await saveAdminDataset(managed, directionInactiveData, addedRoute.id, 'Deactivate synthetic direction');
  assert.equal(response.status, 200);
  publicManaged = await (await fetch(`${base}/api/routes`)).json();
  assert.ok(publicManaged.routes.some((item) => item.id === addedRoute.id), 'active Jeepney stays public when one direction is inactive');
  assert.equal(publicManaged.routes.find((item) => item.id === addedRoute.id).directions.length, 0, 'inactive direction is omitted');
  assert.equal(publicManaged.stops.some((item) => item.id === 'test-managed-stop'), false, 'direction-associated stops follow direction publication state');
  assert.equal(publicManaged.geojson.features.some((item) => item.properties.routeId === addedRoute.id), false, 'inactive direction geometry is withheld');
  managed = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const inactiveData = structuredClone(managed);
  inactiveData.routes.find((item) => item.id === addedRoute.id).active = false;
  response = await saveAdminDataset(managed, inactiveData, addedRoute.id, 'Deactivate synthetic managed route');
  assert.equal(response.status, 200);
  publicManaged = await (await fetch(`${base}/api/routes`)).json();
  assert.equal(publicManaged.routes.some((item) => item.id === addedRoute.id), false, 'inactive route is withheld from public listing');
  assert.equal(publicManaged.stops.some((item) => item.id === 'test-managed-stop'), false, 'inactive route stops are withheld');
  assert.equal(publicManaged.geojson.features.some((item) => item.properties.routeId === addedRoute.id), false, 'inactive route geometry is withheld');
  const inactiveSaved = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const deletedData = structuredClone(inactiveSaved);
  deletedData.routes = deletedData.routes.filter((item) => item.id !== addedRoute.id);
  deletedData.stops = deletedData.stops.filter((item) => item.routeId !== addedRoute.id);
  deletedData.geojson.features = deletedData.geojson.features.filter((item) => item.properties.routeId !== addedRoute.id);
  deletedData.routesFile.routes = deletedData.routes;
  response = await saveAdminDataset(inactiveSaved, deletedData, addedRoute.id, 'Delete empty synthetic managed route');
  assert.equal(response.status, 200, 'route, direction, stop and geometry deletion can be committed together without orphaning references');
  const afterDelete = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  assert.equal(afterDelete.routes.some((item) => item.id === addedRoute.id), false);
  assert.equal(afterDelete.stops.some((item) => item.id === 'test-managed-stop'), false);
  assert.equal(afterDelete.geojson.features.some((item) => item.properties.routeId === addedRoute.id), false);

  const historyBeforeStaleRestore = await (await fetch(`${base}/api/admin/history`, { headers })).json();
  response = await fetch(`${base}/api/admin/restore`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: dataset.commitSha, expectedCommitSha: secondCommitSha }) });
  assert.equal(response.status, 409, 'stale expectedCommitSha rejects restoration');
  const historyAfterStaleRestore = await (await fetch(`${base}/api/admin/history`, { headers })).json();
  assert.equal(historyAfterStaleRestore.length, historyBeforeStaleRestore.length, 'stale restoration does not create a commit');
  assert.equal(historyAfterStaleRestore[0].commitSha, historyBeforeStaleRestore[0].commitSha, 'stale restoration leaves the branch head unchanged');

  const beforeCascadeDelete = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const cascadeData = structuredClone(beforeCascadeDelete);
  const removedStopIds = new Set(cascadeData.stops.filter((stop) => stop.routeId === 'm-gate-friendship').map((stop) => stop.id));
  cascadeData.routes = cascadeData.routes.filter((route) => route.id !== 'm-gate-friendship');
  cascadeData.stops = cascadeData.stops.filter((stop) => stop.routeId !== 'm-gate-friendship');
  cascadeData.geojson.features = cascadeData.geojson.features.filter((feature) => feature.properties?.routeId !== 'm-gate-friendship');
  cascadeData.transfers = cascadeData.transfers.filter((transfer) => !removedStopIds.has(transfer.fromStopId) && !removedStopIds.has(transfer.toStopId));
  response = await saveAdminDataset(beforeCascadeDelete, cascadeData, 'm-gate-friendship', 'Delete test route with linked transfer');
  assert.equal(response.status, 200, 'route deletion atomically removes only linked stops, geometry, directions, and transfers');
  const afterCascadeDelete = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  assert.equal(afterCascadeDelete.transfers.some((transfer) => transfer.id === 'test-m-gate-transfer'), false);

  response = await fetch(`${base}/api/admin/history/item?id=${'a'.repeat(40)}`, { headers });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Server error.' });
  response = await fetch(`${base}/auth/logout`, { method: 'POST', headers: originHeaders });
  assert.equal(response.status, 204);
  assert.equal((await fetch(`${base}/api/admin/dataset`, { headers })).status, 401);
  for (let i = 0; i < 14; i += 1) assert.equal((await fetch(`${base}/auth/github`, {
    headers: { 'X-Forwarded-For': `198.51.100.${i + 1}`, 'X-Real-IP': `203.0.113.${i + 1}`, 'CF-Connecting-IP': `192.0.2.${i + 1}` }, redirect: 'manual',
  })).status, 302);
  response = await fetch(`${base}/auth/github`, {
    headers: { 'X-Forwarded-For': '198.51.100.250', 'X-Real-IP': '203.0.113.250', 'CF-Connecting-IP': '192.0.2.250' }, redirect: 'manual',
  });
  assert.equal(response.status, 429, 'spoofed proxy headers cannot create new client-IP buckets');
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});

test('missing and short session secrets leave admin authentication disabled', async (t) => {
  for (const sessionSecret of ['', 'short']) {
    const probe = createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address(); await new Promise((resolve) => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_URL: base,
        GITHUB_CLIENT_ID: 'test-client-id', GITHUB_CLIENT_SECRET: 'test-client-secret',
        SESSION_SECRET: sessionSecret, ADMIN_GITHUB_USERS: 'allowed-admin',
        SAKAY_DATA_GITHUB_TOKEN: 'test-data-token', SAKAY_DATA_GITHUB_OWNER: 'test-owner',
        SAKAY_DATA_GITHUB_REPO: 'test-data', SAKAY_DATA_GITHUB_BRANCH: 'main' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let stopped = false;
    try {
      let ready = false;
      for (let i = 0; i < 80; i += 1) {
        try { if ((await fetch(`${base}/api/admin/session`)).ok) { ready = true; break; } } catch { /* starting */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(ready, true);
      assert.deepEqual(await (await fetch(`${base}/api/admin/session`)).json(), { configured: false, authenticated: false, user: null });
      assert.equal((await fetch(`${base}/auth/github`)).status, 503);
      assert.equal((await fetch(`${base}/api/admin/dataset`)).status, 401);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 1500); });
      stopped = true;
    }
    assert.equal(stopped, true);
  }
});
