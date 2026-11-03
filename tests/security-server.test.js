import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRateLimiter } from '../src/security/rateLimit.js';

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
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sakay-security-'));
  const dataDir = path.join(temp, 'data'); const historyDir = path.join(temp, 'history');
  await mkdir(dataDir); await mkdir(historyDir);
  for (const name of ['routes.json', 'stops.json', 'routes.geojson']) {
    await writeFile(path.join(dataDir, name), await readFile(path.join(root, 'public/data', name)));
  }
  const probe = createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address(); await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const allowlist = process.env.ADMIN_GITHUB_USERS || 'allowed-admin';
  const child = spawn(process.execPath, ['--import', path.join(root, 'tests/mock-github.mjs'), path.join(root, 'server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_URL: base,
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || 'test-client-id', GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || 'test-client-secret',
      SESSION_SECRET: process.env.SESSION_SECRET || 'test-only-session-secret-with-more-than-32-bytes', ADMIN_GITHUB_USERS: allowlist,
      TRUST_PROXY_CLIENT_IP: 'true',
      MOCK_GITHUB_LOGIN: allowlist.split(',')[0].trim(),
      ROUTE_DATA_DIR: dataDir, ROUTE_HISTORY_DIR: historyDir },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  t.after(async () => { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 1500); }); await rm(temp, { recursive: true, force: true }); });
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
  assert.equal((await fetch(`${base}/api/admin/dataset`, { headers })).status, 200);
  response = await fetch(`${base}/admin.html`, { headers, redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const original = JSON.parse(await readFile(path.join(dataDir, 'routes.geojson'), 'utf8'));
  const dataset = await (await fetch(`${base}/api/admin/dataset`, { headers })).json();
  const feature = dataset.geojson.features[0];
  const routeId = feature.properties.routeId;
  const target = feature.geometry.type === 'LineString' ? feature.geometry.coordinates : feature.geometry.coordinates[0];
  target[0] = [target[0][0] + 0.0001, target[0][1]];
  const payload = { data: dataset, editedRouteIds: [routeId], audit: { change: 'Adjust route trace', reason: 'Test verification only', source: 'Automated test fixture', observation: 'Temporary integration test; not real route evidence.' } };

  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 401, 'protected writes reject users without an admin session');
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 415);
  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
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

  response = await fetch(`${base}/api/admin/save`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const { revision } = await response.json();
  const saved = JSON.parse(await readFile(path.join(dataDir, 'routes.geojson'), 'utf8'));
  assert.notDeepEqual(saved.features[0].geometry, original.features[0].geometry);
  assert.equal((await (await fetch(`${base}/api/admin/history`, { headers })).json()).length, 1);
  const historyResponse = await fetch(`${base}/api/admin/history/item?id=${encodeURIComponent(revision)}`, { headers });
  assert.equal(historyResponse.status, 200);
  const oldSnapshot = await historyResponse.json();
  assert.deepEqual(oldSnapshot.data.geojson.features[0].geometry, original.features[0].geometry);
  response = await fetch(`${base}/api/admin/restore`, { method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: revision }) });
  assert.equal(response.status, 200);
  const restored = JSON.parse(await readFile(path.join(dataDir, 'routes.geojson'), 'utf8'));
  assert.deepEqual(restored.features[0].geometry, original.features[0].geometry);

  response = await fetch(`${base}/api/admin/history/item?id=2026-01-01T00-00-00.000Z-deadbeef`, { headers });
  assert.equal(response.status, 500);
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
        SESSION_SECRET: sessionSecret, ADMIN_GITHUB_USERS: 'allowed-admin' },
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
