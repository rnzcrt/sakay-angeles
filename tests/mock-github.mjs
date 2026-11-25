import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeGitHubDataApi } from './helpers/fake-github-data-api.mjs';

const realFetch = globalThis.fetch;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readFixture = (name) => JSON.parse(readFileSync(path.join(root, 'public/data', name), 'utf8'));
const fixtureRoutes = readFixture('routes.json');
const fixtureStops = readFixture('stops.json');
fixtureStops.transfers ??= [];
fixtureStops.transfers.push({ id: 'test-m-gate-transfer', fromStopId: 'm-gate-friendship-terminal-a', toStopId: 'm-gate-friendship-terminal-b', walkMeters: 30, verificationStatus: 'unverified' });
fixtureRoutes.routes[0].privateAdminNote = 'fixture-admin-only-value';
fixtureRoutes.routes[0].geometryStatus = 'verified';
fixtureRoutes.routes[0].geometryEvidence = {
  source: 'Public geometry evidence source', method: 'Public geometry evidence method', checkedAt: '2026-01-01',
  privateAdminNote: 'private-geometry-evidence-sentinel', internalId: 'private-geometry-evidence-id',
  nested: { audit: 'private-geometry-evidence-nested-sentinel', values: ['private-geometry-evidence-array-sentinel'] },
};
fixtureRoutes.routes[0].fareClass = 'traditional';
fixtureRoutes.routes[0].fareClassEvidence = {
  source: 'Public fare evidence source', method: 'Public fare evidence method', checkedAt: '2026-01-02',
  privateAdminNote: 'private-fare-evidence-sentinel', internalId: 'private-fare-evidence-id',
  nested: { credential: 'private-fare-evidence-nested-sentinel', values: ['private-fare-evidence-array-sentinel'] },
};
fixtureRoutes.routes[0].directions = [{
  id: 'm-gate-friendship-a', geometryId: 'm-gate-friendship-a-draft', label: 'Public direction label', verificationStatus: 'verified',
  orderedStopIds: ['m-gate-friendship-terminal-a', 'm-gate-friendship-terminal-b'],
  privateDirectionNote: 'private-direction-sentinel',
  evidence: { source: 'Public evidence source', method: 'Public evidence method', checkedAt: '2026-01-01', privateEvidenceNote: 'private-evidence-sentinel', nested: { credential: 'private-deep-direction-sentinel' } },
  nested: { adminId: 'private-direction-object-sentinel' },
}];
fixtureRoutes.routes[0].secondarySources[0].privateSourceNote = 'private-secondary-sentinel';
fixtureRoutes.routes[0].secondarySources[0].roads.push({ privateRoadNote: 'private-array-element-sentinel' });
fixtureRoutes.routes[0].secondarySources[0].nested = { privateMetadata: 'private-deep-secondary-sentinel' };
fixtureRoutes.routes[0].secondarySources.push({ source: 'Public nested source', status: 'unverified', roads: ['Public road'], landmarks: ['Public landmark'], conflictsWithLegend: ['Public conflict'], nested: { credential: 'private-secondary-array-deep-sentinel' } });
const fixtureGeojson = readFixture('routes.geojson');
for (const feature of fixtureGeojson.features.filter((item) => item.properties.routeId === fixtureRoutes.routes[0].id)) feature.properties.draft = false;
fixtureGeojson.features[0].properties.privateAdminNote = 'fixture-admin-only-value';
fixtureGeojson.features[0].properties.nested = { audit: 'private-geometry-nested-sentinel' };
const initialAudit = Buffer.from(JSON.stringify({ author: 'fixture-admin', record: {
  change: 'Initial synthetic fixture', reason: 'Test-only historical fixture', source: 'Automated test fixture',
  observation: 'Synthetic data for restore regression tests.', date: '2026-01-01',
} })).toString('base64url');
const dataApi = new FakeGitHubDataApi({
  owner: process.env.SAKAY_DATA_GITHUB_OWNER || 'test-owner',
  repo: process.env.SAKAY_DATA_GITHUB_REPO || 'test-data',
  token: process.env.SAKAY_DATA_GITHUB_TOKEN || 'test-data-token',
  initialMessage: `Initial synthetic fixture\n\nSakay-Audit: ${initialAudit}`,
  initialFiles: {
    'routes.json': fixtureRoutes,
    'stops.json': fixtureStops,
    'routes.geojson': fixtureGeojson,
  },
});
const feedbackIssue = {
  number: 123, title: 'Synthetic route report', html_url: 'https://github.com/rnzcrt/sakay-angeles/issues/123',
  body: 'Test fixture only.', created_at: '2026-01-01T00:00:00Z', state: 'open',
  labels: [{ name: 'community-feedback' }, { name: 'feedback-accepted' }, { name: 'triaged' }],
};
const feedbackLabels = new Set(['community-feedback', 'feedback-accepted']);
const fails = (failure, name) => failure.split(',').includes(name);
let feedbackPatchCount = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://github.com/login/oauth/access_token') {
    const request = JSON.parse(init.body || '{}');
    return Response.json({ access_token: request.code === 'outsider' ? 'mock-outsider-token' : 'mock-admin-token' });
  }
  if (url === 'https://api.github.com/user') {
    const outsider = String(init.headers?.Authorization || '').includes('mock-outsider-token');
    return Response.json({ login: outsider ? 'not-allowed' : process.env.MOCK_GITHUB_LOGIN || 'allowed-admin' });
  }
  if (url.startsWith('https://api.github.com/repos/rnzcrt/sakay-angeles/')) {
    const parsedUrl = new URL(url);
    const path = `${parsedUrl.pathname.replace('/repos/rnzcrt/sakay-angeles/', '')}${parsedUrl.search}`;
    const method = init.method || 'GET';
    const failure = process.env.MOCK_FEEDBACK_FAILURE;
    if (process.env.MOCK_GITHUB_WRITE_LOG && ['POST', 'PATCH', 'DELETE'].includes(method)) appendFileSync(process.env.MOCK_GITHUB_WRITE_LOG, `${method} ${path}\n`);
    if (path === 'issues?state=open&per_page=100&labels=community-feedback' && method === 'GET') return Response.json([feedbackIssue]);
    if (path.startsWith('labels/') && method === 'GET') return feedbackLabels.has(decodeURIComponent(path.slice('labels/'.length))) ? Response.json({ name: decodeURIComponent(path.slice('labels/'.length)) }) : Response.json({ message: 'Not found' }, { status: 404 });
    if (path === 'labels' && method === 'POST') {
      const status = JSON.parse(init.body).name;
      if (fails(failure, 'create-label') && status === 'feedback-needs-information') return Response.json({ message: 'Synthetic failure' }, { status: 500 });
      const label = JSON.parse(init.body).name; feedbackLabels.add(label); return Response.json({ name: label }, { status: 201 });
    }
    const issueNumber = Number(path.match(/^issues\/(\d+)(?:\/|$)/)?.[1] || path.match(/^issues\/(\d+)$/)?.[1]);
    if (issueNumber === 127 && path === 'issues/127' && method === 'GET') return Response.json({ message: 'Not found' }, { status: 404 });
    if ([123, 124, 125, 126].includes(issueNumber) && path === `issues/${issueNumber}` && method === 'GET') {
      const issue = structuredClone(feedbackIssue);
      issue.number = issueNumber;
      if (issueNumber === 124) issue.labels = [{ name: 'triaged' }, { name: 'documentation' }];
      if (issueNumber === 125) issue.pull_request = { url: 'https://api.github.com/pulls/125' };
      if (issueNumber === 126) delete issue.labels;
      return Response.json(issue);
    }
    if (path === 'issues/123/labels' && method === 'POST') {
      if (fails(failure, 'add-label')) return Response.json({ message: 'Synthetic failure' }, { status: 500 });
      for (const name of JSON.parse(init.body).labels) if (!feedbackIssue.labels.some((item) => item.name === name)) feedbackIssue.labels.push({ name });
      return Response.json(feedbackIssue.labels);
    }
    if (path.startsWith('issues/123/labels/') && method === 'DELETE') {
      if (fails(failure, 'delete-label')) return Response.json({ message: 'Synthetic failure' }, { status: 500 });
      const name = decodeURIComponent(path.slice('issues/123/labels/'.length));
      feedbackIssue.labels = feedbackIssue.labels.filter((item) => item.name !== name);
      return new Response(null, { status: 204 });
    }
    if (path === 'issues/123/comments' && method === 'POST') {
      if (fails(failure, 'comment')) return Response.json({ message: 'Synthetic failure' }, { status: 500 });
      return Response.json({ id: 1 }, { status: 201 });
    }
    if (path === 'issues/123' && method === 'PATCH') {
      feedbackPatchCount += 1;
      if (fails(failure, 'patch-issue') && feedbackPatchCount > 1) return Response.json({ message: 'Synthetic failure' }, { status: 500 });
      feedbackIssue.state = JSON.parse(init.body).state; return Response.json(feedbackIssue);
    }
  }
  if (url.startsWith(`https://api.github.com/repos/${process.env.SAKAY_DATA_GITHUB_OWNER || 'test-owner'}/${process.env.SAKAY_DATA_GITHUB_REPO || 'test-data'}`)) return dataApi.fetch(input, init);
  return realFetch(input, init);
};
