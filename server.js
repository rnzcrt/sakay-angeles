import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from './src/data/validate.js';
import { createRateLimiter } from './src/security/rateLimit.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const DATA = path.resolve(process.env.ROUTE_DATA_DIR || path.join(ROOT, 'public/data'));
const HISTORY = path.resolve(process.env.ROUTE_HISTORY_DIR || path.join(ROOT, '.route-history'));
const PORT = Number(process.env.PORT || 4173);
const SESSION_TTL = 12 * 60 * 60 * 1000;
const oauthLimiter = createRateLimiter({ limit: 20, windowMs: 15 * 60_000 });
const adminLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const sessions = new Map();
const oauthStates = new Map();
const allowedUsers = new Set((process.env.ADMIN_GITHUB_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
let validBaseUrl = false;
try { const base = new URL(process.env.BASE_URL); validBaseUrl = base.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(base.hostname); } catch { /* unset or malformed */ }
const configured = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && Buffer.byteLength(process.env.SESSION_SECRET || '') >= 32 && validBaseUrl && allowedUsers.size);
const secureCookie = (process.env.BASE_URL || '').startsWith('https://');
const cookie = (name, value, options = {}) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${options.maxAge ?? 43200}${secureCookie ? '; Secure' : ''}`;
const signSession = (id) => createHmac('sha256', process.env.SESSION_SECRET || '').update(id).digest('hex');
function sessionIdFromCookie(value = '') {
  if (!process.env.SESSION_SECRET) return null;
  const dot = value.lastIndexOf('.'); if (dot < 1) return null;
  const id = value.slice(0, dot); const signature = Buffer.from(value.slice(dot + 1)); const expected = Buffer.from(signSession(id));
  return signature.length === expected.length && timingSafeEqual(signature, expected) ? id : null;
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map((v) => v.trim().split(/=(.*)/s)).filter(([k, v]) => k && v !== undefined)); }
function sessionFor(req) {
  const id = sessionIdFromCookie(parseCookies(req).sakay_admin);
  const session = id && sessions.get(id);
  if (!session || session.expires < Date.now()) { if (id) sessions.delete(id); return null; }
  session.expires = Date.now() + SESSION_TTL;
  return session;
}
async function body(req, maxBytes = 4_000_000) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw Object.assign(new Error('Request is too large.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}
async function readData() {
  const [routesFile, stopsFile, geojson] = await Promise.all(['routes.json', 'stops.json', 'routes.geojson'].map((f) => readFile(path.join(DATA, f), 'utf8').then(JSON.parse)));
  return { routesFile, stopsFile, routes: routesFile.routes, stops: stopsFile.stops, transfers: stopsFile.transfers ?? [], geojson };
}
async function atomicWrite(file, value) {
  const temp = `${file}.${randomBytes(5).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}
function datasetValidation(d) { return validateDataset({ routes: d.routes, stops: d.stops, transfers: d.transfers, geojson: d.geojson }); }
function markEditedUnverified(d, routeIds, before) {
  const ids = new Set(routeIds);
  d.routes = d.routes.map((route) => {
    if (!ids.has(route.id)) return route;
    const { geometryEvidence, ...rest } = route;
    return { ...rest, geometryStatus: 'unverified', directions: (rest.directions ?? []).map(({ evidence, ...direction }) => ({ ...direction, verificationStatus: 'unverified' })) };
  });
  d.geojson = { ...d.geojson, features: d.geojson.features.map((feature) => ids.has(feature.properties?.routeId) ? { ...feature, properties: { ...feature.properties, draft: true } } : feature) };
  const oldStops = new Map(before.stops.map((s) => [s.id, s]));
  d.stops = d.stops.map((stop) => {
    if (!ids.has(stop.routeId) || JSON.stringify(stop) === JSON.stringify(oldStops.get(stop.id))) return stop;
    const { source, ...rest } = stop;
    return { ...rest, verificationStatus: 'unverified' };
  });
}
async function saveRevision(before, audit, author) {
  await mkdir(HISTORY, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(4).toString('hex')}`;
  const record = { id, createdAt: new Date().toISOString(), author, audit, data: before };
  await atomicWrite(path.join(HISTORY, `${id}.json`), record);
  return id;
}
async function historyList() {
  await mkdir(HISTORY, { recursive: true, mode: 0o700 });
  const files = (await readdir(HISTORY)).filter((f) => f.endsWith('.json')).sort().reverse();
  return Promise.all(files.map(async (f) => { const { id, createdAt, author, audit } = JSON.parse(await readFile(path.join(HISTORY, f), 'utf8')); return { id, createdAt, author, audit }; }));
}
async function writeDataset(d) {
  await mkdir(DATA, { recursive: true });
  await Promise.all([
    atomicWrite(path.join(DATA, 'routes.json'), d.routesFile),
    atomicWrite(path.join(DATA, 'stops.json'), { ...d.stopsFile, stops: d.stops, transfers: d.transfers }),
    atomicWrite(path.join(DATA, 'routes.geojson'), d.geojson),
  ]);
}
function validAudit(a) {
  return a && ['change', 'reason', 'source', 'observation'].every((k) => typeof a[k] === 'string' && a[k].trim().length > 0) && a.change.length <= 1000 && a.reason.length <= 2000 && a.source.length <= 1000 && a.observation.length <= 3000;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const expected = process.env.BASE_URL ? new URL(process.env.BASE_URL).origin : `http://${req.headers.host}`;
  return origin === expected;
}

function requestAddress(req) {
  // Render's public proxy chain does not provide a documented, verifiable
  // trust boundary for these headers. Do not let request headers choose a key.
  return req.socket.remoteAddress || 'unknown';
}

function securityHeaders() {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://github.com; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com https://fonts.openmaptiles.org; img-src 'self' data: blob: https:; worker-src 'self' blob:; connect-src 'self' https://tiles.openfreemap.org https://nominatim.openstreetmap.org https://router.project-osrm.org https://routing.openstreetmap.de https://overpass-api.de https://api.github.com; upgrade-insecure-requests",
  };
  if (secureCookie) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

function changedRouteIds(before, next) {
  const ids = new Set();
  const routes = new Map(before.routes.map((route) => [route.id, route]));
  for (const route of next.routes) if (JSON.stringify(route) !== JSON.stringify(routes.get(route.id))) ids.add(route.id);
  const groupedFeatures = (features) => {
    const result = new Map();
    for (const feature of features) {
      const id = feature.properties?.routeId;
      result.set(id, [...(result.get(id) || []), feature]);
    }
    return result;
  };
  const oldFeatures = groupedFeatures(before.geojson.features);
  const newFeatures = groupedFeatures(next.geojson.features);
  for (const id of new Set([...oldFeatures.keys(), ...newFeatures.keys()])) {
    if (JSON.stringify(oldFeatures.get(id) || []) !== JSON.stringify(newFeatures.get(id) || [])) ids.add(id);
  }
  const groupedStops = (stops) => {
    const result = new Map();
    for (const stop of stops) result.set(stop.routeId, [...(result.get(stop.routeId) || []), stop]);
    return result;
  };
  const oldStops = groupedStops(before.stops);
  const newStops = groupedStops(next.stops);
  for (const id of new Set([...oldStops.keys(), ...newStops.keys()])) {
    if (JSON.stringify(oldStops.get(id) || []) !== JSON.stringify(newStops.get(id) || [])) ids.add(id);
  }
  return ids;
}

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(securityHeaders())) res.setHeader(name, value);
  try {
    const url = new URL(req.url, process.env.BASE_URL || `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && (pathname.startsWith('/api/admin/') || pathname === '/auth/logout') && !sameOrigin(req)) return json(res, 403, { error: 'Request origin could not be verified.' });
    if (req.method === 'GET' && pathname === '/api/admin/session') {
      const s = sessionFor(req); return json(res, 200, { configured, authenticated: Boolean(s), user: s?.login ?? null });
    }
    if (req.method === 'GET' && pathname === '/auth/github') {
      if (!configured) return json(res, 503, { error: 'Administrator access is not configured on this server.' });
      const rate = oauthLimiter(requestAddress(req)); if (!rate.allowed) return json(res, 429, { error: 'Too many sign-in attempts. Try again later.' }, { 'Retry-After': String(rate.retryAfter) });
      for (const [state, expiry] of oauthStates) if (expiry <= Date.now()) oauthStates.delete(state);
      if (oauthStates.size >= 10_000) return json(res, 503, { error: 'Sign-in is temporarily unavailable. Try again shortly.' });
      const state = randomBytes(24).toString('hex'); oauthStates.set(state, Date.now() + 10 * 60_000);
      const redirect = new URL('https://github.com/login/oauth/authorize');
      redirect.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
      redirect.searchParams.set('redirect_uri', `${process.env.BASE_URL.replace(/\/+$/, '')}/auth/callback`);
      redirect.searchParams.set('scope', 'public_repo'); redirect.searchParams.set('state', state);
      res.writeHead(302, { Location: redirect.toString(), 'Set-Cookie': cookie('sakay_oauth_state', state, { maxAge: 600 }), 'Cache-Control': 'no-store' }); return res.end();
    }
    if (req.method === 'GET' && pathname === '/auth/callback') {
      const rate = oauthLimiter(requestAddress(req)); if (!rate.allowed) return json(res, 429, { error: 'Too many sign-in attempts. Try again later.' }, { 'Retry-After': String(rate.retryAfter) });
      const cookies = parseCookies(req); const state = url.searchParams.get('state');
      if (!configured || !state || cookies.sakay_oauth_state !== state || !oauthStates.has(state) || oauthStates.get(state) < Date.now()) return json(res, 400, { error: 'Sign-in could not be verified. Try again.' });
      oauthStates.delete(state);
      const exchange = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), state }) });
      const tokenData = await exchange.json(); if (!exchange.ok || !tokenData.access_token) return json(res, 401, { error: 'GitHub sign-in failed.' });
      const profileRes = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Sakay-Angeles' } });
      const profile = await profileRes.json(); const login = String(profile.login || '').toLowerCase();
      if (!profileRes.ok || !allowedUsers.has(login)) return json(res, 403, { error: 'This GitHub account is not authorized to manage routes.' }, { 'Set-Cookie': cookie('sakay_oauth_state', '', { maxAge: 0 }) });
      for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
      if (sessions.size >= 10_000) return json(res, 503, { error: 'Administrator sign-in is temporarily unavailable.' });
      const sessionId = randomBytes(32).toString('hex'); sessions.set(sessionId, { login, token: tokenData.access_token, expires: Date.now() + SESSION_TTL });
      res.writeHead(302, { Location: '/admin/routes', 'Set-Cookie': [cookie('sakay_admin', `${sessionId}.${signSession(sessionId)}`), cookie('sakay_oauth_state', '', { maxAge: 0 })], 'Cache-Control': 'no-store' }); return res.end();
    }
    if (req.method === 'POST' && pathname === '/auth/logout') {
      const id = sessionIdFromCookie(parseCookies(req).sakay_admin); if (id) sessions.delete(id); res.writeHead(204, { 'Set-Cookie': cookie('sakay_admin', '', { maxAge: 0 }), 'Cache-Control': 'no-store' }); return res.end();
    }
    if (pathname.startsWith('/api/admin/')) {
      const session = sessionFor(req); if (!session) return json(res, 401, { error: 'Administrator sign-in required.' });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const rate = adminLimiter(session.login); if (!rate.allowed) return json(res, 429, { error: 'Too many changes. Try again shortly.' }, { 'Retry-After': String(rate.retryAfter) });
      }
      if (req.method === 'GET' && pathname === '/api/admin/dataset') return json(res, 200, await readData());
      if (req.method === 'GET' && pathname === '/api/admin/history') return json(res, 200, await historyList());
      if (req.method === 'GET' && pathname === '/api/admin/history/item') {
        const id = url.searchParams.get('id'); if (!/^[0-9TZ.-]+-[a-f0-9]+$/.test(id || '')) return json(res, 400, { error: 'Invalid revision id.' });
        const record = JSON.parse(await readFile(path.join(HISTORY, `${id}.json`), 'utf8')); return json(res, 200, record);
      }
      if (req.method === 'POST' && pathname === '/api/admin/save') {
        const payload = await body(req); if (!validAudit(payload.audit)) return json(res, 400, { error: 'Change, reason, source, and observation are required.' });
        const before = await readData(); const d = payload.data;
        if (!d || !Array.isArray(d.routes) || !Array.isArray(d.stops) || !Array.isArray(d.transfers) || !d.geojson || !Array.isArray(d.geojson.features) ||
            !Array.isArray(payload.editedRouteIds) || payload.editedRouteIds.length === 0 || !payload.editedRouteIds.every((id) => before.routes.some((r) => r.id === id))) return json(res, 400, { error: 'Invalid route dataset or edited route list.' });
        if (d.routes.length !== before.routes.length || d.routes.some((r) => !r || !before.routes.some((old) => old.id === r.id))) return json(res, 400, { error: 'Route identifiers cannot be added or removed here.' });
        const actualEditedIds = changedRouteIds(before, d);
        const declaredEditedIds = new Set(payload.editedRouteIds);
        if (!actualEditedIds.size || actualEditedIds.size !== declaredEditedIds.size || [...actualEditedIds].some((id) => !declaredEditedIds.has(id))) return json(res, 400, { error: 'editedRouteIds must list exactly the changed routes; empty saves are not accepted.' });
        if (JSON.stringify(before.transfers) !== JSON.stringify(d.transfers)) return json(res, 400, { error: 'Transfer records cannot be changed through route geometry editing.' });
        d.routesFile = before.routesFile; d.stopsFile = before.stopsFile;
        markEditedUnverified(d, payload.editedRouteIds, before);
        const check = datasetValidation(d); if (!check.valid) return json(res, 422, { error: 'Route data did not pass validation.', details: check.errors.slice(0, 20) });
        const audit = { ...payload.audit, date: new Date().toISOString().slice(0, 10) };
        const revision = await saveRevision(before, audit, session.login);
        d.routesFile.routes = d.routes;
        await writeDataset(d); return json(res, 200, { ok: true, revision });
      }
      if (req.method === 'POST' && pathname === '/api/admin/restore') {
        const payload = await body(req); if (!/^[0-9TZ.-]+-[a-f0-9]+$/.test(payload.id || '')) return json(res, 400, { error: 'Invalid revision id.' });
        const record = JSON.parse(await readFile(path.join(HISTORY, `${payload.id}.json`), 'utf8'));
        const current = await readData(); const revision = await saveRevision(current, { change: `Restored revision ${payload.id}`, reason: 'Administrator requested rollback', source: 'Route history', observation: 'Previous saved dataset restored; route data remains unverified.' }, session.login);
        const restored = record.data; restored.routes = restored.routes.map((r) => ({ ...r, geometryStatus: 'unverified', directions: (r.directions ?? []).map((d) => ({ ...d, verificationStatus: 'unverified' })) }));
        restored.routesFile.routes = restored.routes;
        await writeDataset(restored); return json(res, 200, { ok: true, revision });
      }
      if (req.method === 'GET' && pathname === '/api/admin/feedback') {
        const resIssues = await fetch('https://api.github.com/repos/rnzcrt/sakay-angeles/issues?state=open&per_page=100&labels=community-feedback', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sakay-Angeles' } });
        if (!resIssues.ok) return json(res, 502, { error: 'Could not load GitHub community reports.' });
        const issues = await resIssues.json(); return json(res, 200, issues.filter((i) => !i.pull_request).map(({ number, title, html_url, body: issueBody, created_at, labels }) => ({ number, title, url: html_url, body: issueBody, createdAt: created_at, labels: labels.map((l) => l.name) })));
      }
      if (req.method === 'POST' && pathname === '/api/admin/feedback/status') {
        const p = await body(req); if (!Number.isInteger(p.number) || !['accepted', 'rejected', 'resolved', 'needs-information'].includes(p.status)) return json(res, 400, { error: 'Invalid report status.' });
        const label = `feedback-${p.status}`;
        const ghHeaders = { Authorization: `Bearer ${session.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Sakay-Angeles' };
        const labelCheck = await fetch(`https://api.github.com/repos/rnzcrt/sakay-angeles/labels/${encodeURIComponent(label)}`, { headers: ghHeaders });
        if (labelCheck.status === 404) await fetch('https://api.github.com/repos/rnzcrt/sakay-angeles/labels', { method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: label, color: p.status === 'rejected' ? 'b60205' : p.status === 'resolved' ? '0e8a16' : '1d76db', description: `Maintainer review status: ${p.status}` }) });
        const existingIssue = await fetch(`https://api.github.com/repos/rnzcrt/sakay-angeles/issues/${p.number}`, { headers: ghHeaders });
        if (!existingIssue.ok) return json(res, 502, { error: 'Could not load that GitHub report.' });
        for (const oldLabel of (await existingIssue.json()).labels.map((l) => l.name).filter((name) => name.startsWith('feedback-'))) {
          await fetch(`https://api.github.com/repos/rnzcrt/sakay-angeles/issues/${p.number}/labels/${encodeURIComponent(oldLabel)}`, { method: 'DELETE', headers: ghHeaders });
        }
        const result = await fetch(`https://api.github.com/repos/rnzcrt/sakay-angeles/issues/${p.number}/labels`, { method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: [label] }) });
        if (!result.ok) return json(res, 502, { error: 'GitHub could not update the report label.' });
        if (p.note) await fetch(`https://api.github.com/repos/rnzcrt/sakay-angeles/issues/${p.number}/comments`, { method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: `Maintainer status: ${p.status}\n\n${String(p.note).slice(0, 2000)}` }) });
        await fetch(`https://api.github.com/repos/rnzcrt/sakay-angeles/issues/${p.number}`, { method: 'PATCH', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ state: p.status === 'resolved' ? 'closed' : 'open' }) });
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Unknown admin endpoint.' });
    }
    if (req.method === 'GET' && pathname.startsWith('/data/')) {
      const name = path.basename(pathname);
      if (!['routes.json', 'stops.json', 'routes.geojson'].includes(name)) return json(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': name.endsWith('.geojson') || name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain', 'Cache-Control': 'no-cache' }); return res.end(await readFile(path.join(DATA, name)));
    }
    if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/routes') { res.writeHead(302, { Location: '/admin.html', 'Cache-Control': 'no-store' }); return res.end(); }
    if (pathname === '/trace.html') {
      if (!sessionFor(req)) return json(res, 401, { error: 'Administrator sign-in required.' });
    }
    let file = pathname === '/' ? path.join(DIST, 'index.html') : path.resolve(DIST, `.${pathname}`);
    if (!file.startsWith(`${DIST}${path.sep}`) && file !== path.join(DIST, 'index.html')) return json(res, 404, { error: 'Not found.' });
    const bytes = await readFile(file);
    const ext = path.extname(file); const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' })[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600' }); res.end(bytes);
  } catch (error) {
    const status = error.status || 500;
    json(res, status, { error: status >= 500 ? 'Server error.' : error.message || 'Request could not be processed.' });
  }
});

server.listen(PORT, process.env.HOST, () => console.log(`Sakay Angeles listening on http://localhost:${PORT}${configured ? '' : ' (admin OAuth not configured)'}`));
