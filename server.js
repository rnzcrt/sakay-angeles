import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from './src/data/validate.js';
import { createRateLimiter } from './src/security/rateLimit.js';
import { createGitHubDataStore, GitHubDataStoreError } from './src/security/githubDataStore.js';
import { loadLocalEnvironment } from './scripts/load-local-env.js';

loadLocalEnvironment();

const PORT = Number(process.env.PORT || 4173);
const dataStore = createGitHubDataStore();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

const PUBLIC_ROUTE_FIELDS = ['id', 'name', 'sourceLabel', 'sourceSubLabel', 'jeepneyColorName', 'displayColor', 'fareClass', 'fareClassEvidence', 'geometryStatus', 'geometryEvidence', 'tracingStatus', 'vehicleType', 'description', 'sourceLandmarks', 'labelNotes', 'source', 'requestedDirection', 'active', 'startPoint', 'destination', 'via'];
const PUBLIC_STOP_FIELDS = ['id', 'routeId', 'directionId', 'name', 'kind', 'terminalLabel', 'verificationStatus', 'source', 'notes'];
const PUBLIC_TRANSFER_FIELDS = ['id', 'fromStopId', 'toStopId', 'walkMeters', 'verificationStatus', 'source', 'notes'];
const PUBLIC_GEOMETRY_FIELDS = ['routeId', 'directionId', 'geometryId', 'direction', 'oneWay', 'draft', 'startName', 'endName', 'startStopId', 'endStopId', 'endpointVerificationStatus', 'endpointSource'];
const PUBLIC_EVIDENCE_FIELDS = ['source', 'method', 'checkedAt'];
const PUBLIC_DIRECTION_FIELDS = ['id', 'geometryId', 'orderedStopIds', 'verificationStatus', 'label', 'active', 'startPoint', 'destination', 'via', 'description'];
const PUBLIC_SECONDARY_SOURCE_FIELDS = ['source', 'status', 'matchToLegend', 'startPoint', 'endPoint', 'roads', 'landmarks', 'conflictsWithLegend'];
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
async function readData({ refresh = false } = {}) {
  const snapshot = await dataStore.load({ refresh });
  const data = { ...snapshot, routes: snapshot.routesFile.routes, stops: snapshot.stopsFile.stops, transfers: snapshot.stopsFile.transfers ?? [] };
  const check = datasetValidation(data);
  if (!check.valid) throw new GitHubDataStoreError('INVALID_DATA', 'The private route dataset failed validation. No data was served or changed.', 503);
  return data;
}
function datasetValidation(d) { return validateDataset({ routes: d.routes, stops: d.stops, transfers: d.transfers, geojson: d.geojson }); }
function publicRecord(record, fields) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  return Object.fromEntries(fields.filter((field) => {
    if (!Object.hasOwn(record, field)) return false;
    const value = record[field];
    return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  }).map((field) => [field, record[field]]));
}
function publicStringArray(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []; }
function publicEvidence(value) { return publicRecord(value, PUBLIC_EVIDENCE_FIELDS); }
function publicDirection(value) {
  const result = publicRecord(value, PUBLIC_DIRECTION_FIELDS);
  if (Array.isArray(value?.orderedStopIds)) result.orderedStopIds = publicStringArray(value.orderedStopIds);
  if (value?.evidence && typeof value.evidence === 'object' && !Array.isArray(value.evidence)) result.evidence = publicEvidence(value.evidence);
  return result;
}
function publicSecondarySource(value) {
  const result = publicRecord(value, PUBLIC_SECONDARY_SOURCE_FIELDS);
  for (const field of ['roads', 'landmarks', 'conflictsWithLegend']) if (Object.hasOwn(value || {}, field)) result[field] = publicStringArray(value[field]);
  return result;
}
function publicRoute(value) {
  const result = publicRecord(value, PUBLIC_ROUTE_FIELDS);
  for (const field of ['sourceLandmarks', 'labelNotes']) if (Object.hasOwn(value || {}, field)) result[field] = publicStringArray(value[field]);
  if (value?.directions !== undefined) result.directions = Array.isArray(value.directions) ? value.directions.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map(publicDirection) : [];
  if (value?.secondarySources !== undefined) result.secondarySources = Array.isArray(value.secondarySources) ? value.secondarySources.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map(publicSecondarySource) : [];
  for (const field of ['fareClassEvidence', 'geometryEvidence']) {
    if (!Object.hasOwn(value || {}, field) || value[field] === undefined) continue;
    if (value[field] === null) result[field] = null;
    else if (value[field] && typeof value[field] === 'object' && !Array.isArray(value[field])) result[field] = publicEvidence(value[field]);
    else delete result[field];
  }
  return result;
}
function publicCoordinates(value) {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) return [...value];
  if (value.length && value.every(Array.isArray)) return value.map(publicCoordinates).filter((item) => item !== undefined);
  return undefined;
}
function publicGeometry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'LineString') {
    const coordinates = publicCoordinates(value.coordinates);
    return coordinates?.length >= 2 && coordinates.every((p) => Array.isArray(p) && p.length === 2) ? { type: 'LineString', coordinates } : null;
  }
  if (value.type === 'MultiLineString') {
    const coordinates = publicCoordinates(value.coordinates);
    return coordinates?.length && coordinates.every((line) => Array.isArray(line) && line.length >= 2 && line.every((p) => Array.isArray(p) && p.length === 2)) ? { type: 'MultiLineString', coordinates } : null;
  }
  return null;
}
function markEditedUnverified(d, routeIds, before) {
  const ids = new Set(routeIds);
  const oldStops = new Map(before.stops.map((s) => [s.id, s]));
  const nextStops = new Map(d.stops.map((stop) => [stop.id, stop]));
  const changedStops = new Set();
  for (const stop of before.stops) if (ids.has(stop.routeId) && JSON.stringify(stop) !== JSON.stringify(nextStops.get(stop.id))) changedStops.add(stop.id);
  for (const stop of d.stops) if (ids.has(stop.routeId) && JSON.stringify(stop) !== JSON.stringify(oldStops.get(stop.id))) changedStops.add(stop.id);

  const featuresFor = (features, id) => features.filter((feature) => feature.properties?.routeId === id);
  const geometryChanged = new Set([...ids].filter((id) => JSON.stringify(featuresFor(before.geojson.features, id)) !== JSON.stringify(featuresFor(d.geojson.features, id))));
  d.routes = d.routes.map((route) => {
    if (!ids.has(route.id)) return route;
    const previous = before.routes.find((item) => item.id === route.id);
    const previousDirections = new Map((previous?.directions ?? []).map((direction) => [direction.id, direction]));
    const affectedDirectionIds = new Set();
    if (geometryChanged.has(route.id)) for (const direction of route.directions ?? []) affectedDirectionIds.add(direction.id);
    else for (const direction of route.directions ?? []) {
      const old = previousDirections.get(direction.id);
      const changedDirectionClaim = old && ['geometryId', 'orderedStopIds', 'startPoint', 'destination', 'via'].some((field) => {
        const previousValue = ['startPoint', 'destination', 'via'].includes(field) ? (old[field] || '') : old[field];
        const nextValue = ['startPoint', 'destination', 'via'].includes(field) ? (direction[field] || '') : direction[field];
        return JSON.stringify(previousValue) !== JSON.stringify(nextValue);
      });
      if (changedDirectionClaim) affectedDirectionIds.add(direction.id);
      for (const stopId of changedStops) {
        const oldStop = oldStops.get(stopId);
        const nextStop = nextStops.get(stopId);
        if (old?.orderedStopIds?.includes(stopId) || direction.orderedStopIds?.includes(stopId) || oldStop?.directionId === direction.id || nextStop?.directionId === direction.id) affectedDirectionIds.add(direction.id);
      }
    }
    const directions = (route.directions ?? []).map((direction) => {
      const old = previousDirections.get(direction.id);
      if (!old || geometryChanged.has(route.id) || affectedDirectionIds.has(direction.id)) {
        const { evidence, ...rest } = direction;
        return { ...rest, verificationStatus: 'unverified' };
      }
      const { evidence, ...rest } = direction;
      return { ...rest, verificationStatus: old.verificationStatus, ...(old.evidence ? { evidence: old.evidence } : {}) };
    });
    if (!previous || geometryChanged.has(route.id)) {
      const { geometryEvidence, ...rest } = route;
      return { ...rest, geometryStatus: 'unverified', directions };
    }
    const { geometryEvidence, ...rest } = route;
    return { ...rest, geometryStatus: previous.geometryStatus, ...(previous.geometryEvidence ? { geometryEvidence: previous.geometryEvidence } : {}), directions };
  });
  d.geojson = { ...d.geojson, features: d.geojson.features.map((feature) => geometryChanged.has(feature.properties?.routeId) ? { ...feature, properties: { ...feature.properties, draft: true } } : feature) };
  d.stops = d.stops.map((stop) => {
    if (!ids.has(stop.routeId)) return stop;
    const previous = oldStops.get(stop.id);
    if (!previous || changedStops.has(stop.id)) {
      const { source, ...rest } = stop;
      return { ...rest, verificationStatus: 'unverified' };
    }
    const { source, ...rest } = stop;
    return { ...rest, verificationStatus: previous.verificationStatus, ...(previous.source ? { source: previous.source } : {}) };
  });
}
async function writeDataset(d, { expectedCommitSha, audit, author }) {
  return dataStore.createDatasetCommit({
    routesFile: d.routesFile,
    stopsFile: { ...d.stopsFile, stops: d.stops, transfers: d.transfers },
    geojson: d.geojson,
  }, { expectedCommitSha, audit, author });
}
function validAudit(a) {
  return a && ['change', 'reason', 'source', 'observation'].every((k) => typeof a[k] === 'string' && a[k].trim().length > 0) && a.change.length <= 1000 && a.reason.length <= 2000 && a.source.length <= 1000 && a.observation.length <= 3000;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const expected = process.env.BASE_URL ? new URL(process.env.BASE_URL).origin : `http://${req.headers.host}`;
  if (origin === expected) return true;

  // The local Vite admin page proxies writes to the Node server, so the
  // browser origin is localhost:5173 while BASE_URL points at localhost:4173.
  // Accept only Vite's fixed loopback origins during non-production runs.
  if (process.env.NODE_ENV === 'production') return false;
  let base;
  try { base = new URL(expected); } catch { return false; }
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) return false;
  return origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173';
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
'Content-Security-Policy': `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://github.com; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com https://fonts.openmaptiles.org; img-src 'self' data: blob: https:; worker-src 'self' blob:; connect-src 'self' https://tiles.openfreemap.org https://nominatim.openstreetmap.org https://router.project-osrm.org https://routing.openstreetmap.de https://overpass-api.de${secureCookie ? '; upgrade-insecure-requests' : ''}`,
  };
  if (secureCookie) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

function changedRouteIds(before, next) {
  const ids = new Set();
  const routes = new Map(before.routes.map((route) => [route.id, route]));
  const nextRoutes = new Map(next.routes.map((route) => [route.id, route]));
  for (const id of new Set([...routes.keys(), ...nextRoutes.keys()])) {
    if (JSON.stringify(routes.get(id)) !== JSON.stringify(nextRoutes.get(id))) ids.add(id);
  }
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
      if (req.method === 'GET' && pathname === '/api/admin/dataset') return json(res, 200, await readData({ refresh: true }));
      if (req.method === 'GET' && pathname === '/api/admin/history') return json(res, 200, await dataStore.listHistory());
      if (req.method === 'GET' && pathname === '/api/admin/history/item') {
        const id = url.searchParams.get('id'); if (!/^[a-f0-9]{40}$/i.test(id || '')) return json(res, 400, { error: 'Invalid revision id.' });
        const [record, history] = await Promise.all([dataStore.loadAtRevision(id), dataStore.listHistory()]);
        const metadata = history.find((item) => item.id === id);
        if (!metadata) return json(res, 404, { error: 'Route data revision not found.' });
        return json(res, 200, { ...metadata, data: { ...record, routes: record.routesFile.routes, stops: record.stopsFile.stops, transfers: record.stopsFile.transfers ?? [] } });
      }
      if (req.method === 'POST' && pathname === '/api/admin/save') {
        const payload = await body(req); if (!validAudit(payload.audit)) return json(res, 400, { error: 'Change, reason, source, and observation are required.' });
        const before = await readData({ refresh: true }); const d = payload.data;
        if (!/^[a-f0-9]{40}$/i.test(payload.expectedCommitSha || '') || payload.expectedCommitSha !== before.commitSha) return json(res, 409, { error: 'Route data changed since you loaded it. Reload the latest data before saving.' });
        if (!d || !Array.isArray(d.routes) || !Array.isArray(d.stops) || !Array.isArray(d.transfers) || !d.geojson || !Array.isArray(d.geojson.features) ||
            !Array.isArray(payload.editedRouteIds) || payload.editedRouteIds.length === 0 || !payload.editedRouteIds.every((id) => typeof id === 'string' && (before.routes.some((r) => r.id === id) || d.routes.some((r) => r?.id === id)))) return json(res, 400, { error: 'Invalid route dataset or edited route list.' });
        if (new Set(d.routes.map((r) => r?.id)).size !== d.routes.length) return json(res, 400, { error: 'Route identifiers must be unique.' });
        const actualEditedIds = changedRouteIds(before, d);
        const declaredEditedIds = new Set(payload.editedRouteIds);
        if (!actualEditedIds.size || payload.editedRouteIds.length !== declaredEditedIds.size || actualEditedIds.size !== declaredEditedIds.size || [...actualEditedIds].some((id) => !declaredEditedIds.has(id))) return json(res, 400, { error: 'editedRouteIds must list exactly the changed routes; empty saves are not accepted.' });
        const nextTransfers = new Map(d.transfers.map((transfer) => [transfer?.id, transfer]));
        if (nextTransfers.size !== d.transfers.length || d.transfers.some((transfer) => !before.transfers.some((old) => old.id === transfer?.id && JSON.stringify(old) === JSON.stringify(transfer)))) return json(res, 400, { error: 'Transfer records cannot be added or edited through route management.' });
        const retainedStopIds = new Set(d.stops.map((stop) => stop.id));
        const deletedStopIds = new Set(before.stops.filter((stop) => !retainedStopIds.has(stop.id)).map((stop) => stop.id));
        const deletedTransfers = before.transfers.filter((transfer) => !nextTransfers.has(transfer.id));
        if (deletedTransfers.some((transfer) => !deletedStopIds.has(transfer.fromStopId) && !deletedStopIds.has(transfer.toStopId))) return json(res, 400, { error: 'A transfer may only be removed as part of deleting a route stop it references.' });
        d.routesFile = before.routesFile; d.stopsFile = before.stopsFile;
        markEditedUnverified(d, payload.editedRouteIds, before);
        const check = datasetValidation(d); if (!check.valid) return json(res, 422, { error: 'Route data did not pass validation.', details: check.errors.slice(0, 20) });
        const audit = { ...payload.audit, date: new Date().toISOString().slice(0, 10) };
        d.routesFile.routes = d.routes;
        const saved = await writeDataset(d, { expectedCommitSha: payload.expectedCommitSha, audit, author: session.login });
        return json(res, 200, { ok: true, revision: saved.commitSha, commitSha: saved.commitSha });
      }
      if (req.method === 'POST' && pathname === '/api/admin/restore') {
        const payload = await body(req);
        if (!/^[a-f0-9]{40}$/i.test(payload.id || '') || !/^[a-f0-9]{40}$/i.test(payload.expectedCommitSha || '')) return json(res, 400, { error: 'Invalid route data revision.' });
        const current = await readData({ refresh: true });
        if (payload.expectedCommitSha !== current.commitSha) return json(res, 409, { error: 'Route data changed since you loaded it. Reload the latest data before restoring.' });
        const record = await dataStore.loadAtRevision(payload.id);
        const restored = {
          ...record,
          routes: record.routesFile.routes.map((r) => {
            const { geometryEvidence, ...route } = r;
            return { ...route, geometryStatus: 'unverified', directions: (route.directions ?? []).map(({ evidence, ...direction }) => ({ ...direction, verificationStatus: 'unverified' })) };
          }),
          stops: record.stopsFile.stops,
          transfers: record.stopsFile.transfers ?? [],
        };
        restored.geojson = { ...restored.geojson, features: restored.geojson.features.map((feature) => ({ ...feature, properties: { ...feature.properties, draft: true } })) };
        restored.routesFile = { ...record.routesFile, routes: restored.routes };
        restored.stopsFile = { ...record.stopsFile, stops: record.stopsFile.stops, transfers: record.stopsFile.transfers ?? [] };
        const check = datasetValidation(restored); if (!check.valid) return json(res, 422, { error: 'Saved revision did not pass route validation.' });
        const saved = await writeDataset(restored, {
          expectedCommitSha: payload.expectedCommitSha,
          audit: { change: `Restored route data revision ${payload.id.slice(0, 8)}`, reason: 'Administrator requested restoration of a saved dataset.', source: 'Private route data commit history', observation: 'Restored data is retained as unverified until reviewed.' },
          author: session.login,
        });
        return json(res, 200, { ok: true, revision: saved.commitSha, commitSha: saved.commitSha });
      }
      if (req.method === 'GET' && pathname === '/api/admin/feedback') {
        try {
          const resIssues = await fetch('https://api.github.com/repos/rnzcrt/sakay-angeles/issues?state=open&per_page=100&labels=community-feedback', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sakay-Angeles' } });
          if (!resIssues.ok) return json(res, 502, { error: 'Could not load GitHub community reports.' });
          const issues = await resIssues.json();
          if (!Array.isArray(issues)) return json(res, 502, { error: 'GitHub returned an invalid community report response.' });
          return json(res, 200, issues.filter((i) => i && typeof i === 'object' && !i.pull_request && Number.isSafeInteger(i.number) && Array.isArray(i.labels))
            .map(({ number, title, html_url, body: issueBody, created_at, labels }) => ({ number, title, url: html_url, body: issueBody, createdAt: created_at, labels: labels.filter((labelItem) => typeof labelItem?.name === 'string').map((labelItem) => labelItem.name) })));
        } catch { return json(res, 502, { error: 'Could not load GitHub community reports.' }); }
      }
      if (req.method === 'POST' && pathname === '/api/admin/feedback/status') {
        const p = await body(req); if (!Number.isSafeInteger(p.number) || p.number < 1 || !['accepted', 'rejected', 'resolved', 'needs-information'].includes(p.status) || (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 2000))) return json(res, 400, { error: 'Invalid report status or note.' });
        const label = `feedback-${p.status}`;
        const ghHeaders = { Authorization: `Bearer ${session.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Sakay-Angeles' };
        let statusLabelApplied = false;
        try {
          const apiRoot = 'https://api.github.com/repos/rnzcrt/sakay-angeles';
          const existingIssue = await fetch(`${apiRoot}/issues/${p.number}`, { headers: ghHeaders });
          if (existingIssue.status === 404) return json(res, 404, { error: 'That GitHub community report was not found.' });
          if (!existingIssue.ok) return json(res, 502, { error: 'Could not load that GitHub report.' });
          const issue = await existingIssue.json();
          if (!issue || issue.pull_request || issue.number !== p.number || !Array.isArray(issue.labels)) return json(res, 400, { error: 'The requested GitHub item is not a valid community report.' });
          if (!issue.labels.some((item) => item && typeof item.name === 'string' && item.name === 'community-feedback')) return json(res, 400, { error: 'The requested GitHub issue is not a community-feedback report.' });

          const labelCheck = await fetch(`${apiRoot}/labels/${encodeURIComponent(label)}`, { headers: ghHeaders });
          if (labelCheck.status === 404) {
            const createdLabel = await fetch(`${apiRoot}/labels`, { method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: label, color: p.status === 'rejected' ? 'b60205' : p.status === 'resolved' ? '0e8a16' : '1d76db', description: `Maintainer review status: ${p.status}` }) });
            if (!createdLabel.ok) {
              if (createdLabel.status !== 422) return json(res, 502, { error: 'GitHub could not prepare the report status label.' });
              const concurrentLabel = await fetch(`${apiRoot}/labels/${encodeURIComponent(label)}`, { headers: ghHeaders });
              if (!concurrentLabel.ok) return json(res, 502, { error: 'GitHub could not verify the report status label.' });
            }
          } else if (!labelCheck.ok) return json(res, 502, { error: 'GitHub could not verify the report status label.' });

          const result = await fetch(`${apiRoot}/issues/${p.number}/labels`, { method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: [label] }) });
          if (!result.ok) return json(res, 502, { error: 'GitHub could not apply the report status label.' });
          statusLabelApplied = true;

          for (const oldLabel of issue.labels.filter((item) => typeof item?.name === 'string').map((item) => item.name).filter((name) => name.startsWith('feedback-') && name !== label)) {
            const removed = await fetch(`${apiRoot}/issues/${p.number}/labels/${encodeURIComponent(oldLabel)}`, { method: 'DELETE', headers: ghHeaders });
            if (!removed.ok && removed.status !== 404) return json(res, 502, { error: 'The new status label was applied, but GitHub could not remove the previous status label.' });
          }
          if (p.note) {
            const comment = await fetch(`${apiRoot}/issues/${p.number}/comments`, { method: 'POST', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: `Maintainer status: ${p.status}\n\n${p.note}` }) });
            if (!comment.ok) return json(res, 502, { error: 'The status label was applied, but GitHub could not add the review note.' });
          }
          const updatedIssue = await fetch(`${apiRoot}/issues/${p.number}`, { method: 'PATCH', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ state: p.status === 'resolved' ? 'closed' : 'open' }) });
          if (!updatedIssue.ok) return json(res, 502, { error: 'The status label was applied, but GitHub could not update the report state.' });
          return json(res, 200, { ok: true });
        } catch {
          return json(res, 502, { error: statusLabelApplied ? 'The status label was applied, but a follow-up GitHub operation failed.' : 'GitHub could not update the report status.' });
        }
      }
      return json(res, 404, { error: 'Unknown admin endpoint.' });
    }
    if (req.method === 'GET' && pathname === '/api/routes') {
      const data = await readData();
      const publicRoutes = data.routes.filter((route) => route.active !== false);
      const publicRouteIds = new Set(publicRoutes.map((route) => route.id));
      const publicDirections = new Map(publicRoutes.map((route) => [route.id, new Set((route.directions ?? []).filter((direction) => direction.active !== false).map((direction) => direction.id))]));
      const stopIsPublic = (stop) => publicRouteIds.has(stop.routeId) && (!stop.directionId || publicDirections.get(stop.routeId)?.has(stop.directionId));
      const publicStopIds = new Set(data.stops.filter(stopIsPublic).map((stop) => stop.id));
      return json(res, 200, {
        meta: {
          ...(typeof data.routesFile.source === 'string' ? { source: data.routesFile.source } : {}),
          ...(typeof data.routesFile.dataStatus === 'string' ? { dataStatus: data.routesFile.dataStatus } : {}),
        },
        stops: data.stops.filter((stop) => stop && typeof stop === 'object' && !Array.isArray(stop) && stopIsPublic(stop)).map((stop) => {
          const result = publicRecord(stop, PUBLIC_STOP_FIELDS);
          const coordinates = publicCoordinates(stop.coordinates);
          if (coordinates?.length === 2 && coordinates.every((n) => typeof n === 'number')) result.coordinates = coordinates;
          return result;
        }),
        transfers: data.transfers.filter((transfer) => publicStopIds.has(transfer.fromStopId) && publicStopIds.has(transfer.toStopId)).map((transfer) => publicRecord(transfer, PUBLIC_TRANSFER_FIELDS)),
        routes: publicRoutes.filter((route) => route && typeof route === 'object' && !Array.isArray(route)).map((route) => ({
          ...publicRoute(route),
          directions: Array.isArray(route.directions) ? route.directions.filter((direction) => direction?.active !== false).map(publicDirection) : [],
          verifiedTerminals: data.stops.filter((stop) => stop.routeId === route.id && stopIsPublic(stop) && stop.kind === 'terminal' && stop.verificationStatus === 'verified').map((stop) => publicRecord(stop, PUBLIC_STOP_FIELDS)),
        })),
        geojson: {
          type: data.geojson.type,
          features: data.geojson.features.filter((feature) => {
            const route = data.routes.find((item) => item.id === feature.properties?.routeId);
            if (!route || route.active === false) return false;
            const directions = route.directions ?? [];
            const direction = directions.find((item) => item.id === feature.properties?.directionId || item.geometryId === feature.properties?.geometryId);
            if (direction) return direction.active !== false;
            // Legacy a/b geometry is public only while the route has no explicit
            // direction records to which it can be safely associated.
            return directions.length === 0;
          }).map((feature) => ({
            type: feature.type,
            properties: publicRecord(feature.properties, PUBLIC_GEOMETRY_FIELDS),
            geometry: publicGeometry(feature.geometry),
          })),
        },
      });
    }
    if (req.method === 'GET' && pathname.startsWith('/data/')) return json(res, 404, { error: 'Not found.' });
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
