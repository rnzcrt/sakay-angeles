import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubDataStore, GitHubDataStoreError, readGitHubDataConfig, ROUTE_DATA_FILES } from '../src/security/githubDataStore.js';
import { runMigration } from '../scripts/migrate-github-data.js';
import { FakeGitHubDataApi } from './helpers/fake-github-data-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, 'public/data');
const config = { token: 'test-private-token', owner: 'data-owner', repo: 'sakay-data', branch: 'main' };
const env = {
  SAKAY_DATA_GITHUB_TOKEN: config.token,
  SAKAY_DATA_GITHUB_OWNER: config.owner,
  SAKAY_DATA_GITHUB_REPO: config.repo,
  SAKAY_DATA_GITHUB_BRANCH: config.branch,
};

async function localFiles() {
  const names = ROUTE_DATA_FILES;
  const files = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(LOCAL, name), 'utf8'))));
  return Object.fromEntries(names.map((name, i) => [name, files[i]]));
}
const asStoreFiles = (files) => ({ routesFile: files['routes.json'], stopsFile: files['stops.json'], geojson: files['routes.geojson'] });

function api(initialFiles, options = {}) {
  const fake = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: config.branch, token: config.token, initialFiles, ...options });
  return { fake, store: createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake), cacheMs: 0 }) };
}

test('GitHub data storage configuration rejects missing and malformed settings without exposing tokens', () => {
  assert.throws(() => readGitHubDataConfig({}), (error) => error.code === 'CONFIG' && /SAKAY_DATA_GITHUB_TOKEN/.test(error.message));
  assert.throws(() => readGitHubDataConfig({ ...env, SAKAY_DATA_GITHUB_BRANCH: 'bad..branch' }), (error) => error.code === 'CONFIG' && !error.message.includes(config.token));
  assert.equal(readGitHubDataConfig(env).branch, 'main');
  for (const invalid of [
    { SAKAY_DATA_GITHUB_OWNER: '..' }, { SAKAY_DATA_GITHUB_REPO: '..' },
    { SAKAY_DATA_GITHUB_BRANCH: '../main' }, { SAKAY_DATA_GITHUB_BRANCH: 'topic//main' },
    { SAKAY_DATA_GITHUB_BRANCH: 'topic/.hidden' }, { SAKAY_DATA_GITHUB_BRANCH: '@' },
  ]) assert.throws(() => readGitHubDataConfig({ ...env, ...invalid }), (error) => error.code === 'CONFIG');
});

test('GitHub storage rejects invalid credentials and non-private repositories safely', async () => {
  const files = await localFiles();
  const badAuth = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, initialFiles: files, token: 'other-token' });
  const store = createGitHubDataStore(env, { fetchImpl: badAuth.fetch.bind(badAuth) });
  await assert.rejects(store.load(), (error) => error.code === 'AUTH' && !error.message.includes(config.token));
  const denied = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, initialFiles: files, token: config.token, denyAccess: true });
  await assert.rejects(createGitHubDataStore(env, { fetchImpl: denied.fetch.bind(denied) }).load(), (error) => error.code === 'PERMISSION');
  const publicRepo = api(files, { privateRepo: false }).store;
  await assert.rejects(publicRepo.load(), (error) => error.code === 'NOT_PRIVATE');
});

test('reads the three files from one configured branch commit and reloads after process restart', async () => {
  const files = await localFiles();
  const { fake, store } = api(files);
  const snapshot = await store.load();
  assert.deepEqual(snapshot.routesFile, files['routes.json']);
  assert.deepEqual(snapshot.stopsFile, files['stops.json']);
  assert.deepEqual(snapshot.geojson, files['routes.geojson']);
  assert.match(snapshot.commitSha, /^[a-f0-9]{40}$/);
  const secondProcess = createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake) });
  assert.deepEqual(await secondProcess.load(), snapshot);
});

test('an empty configured branch reports an explicit uninitialized dataset instead of reading local files', async () => {
  const fake = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: config.branch, token: config.token });
  const store = createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake) });
  await assert.rejects(store.load(), (error) => error.code === 'EMPTY_REPOSITORY' && /migration command/.test(error.message));
});

test('GitHub data reads reject truncated trees, malformed tree responses and partial datasets', async () => {
  const files = await localFiles();
  const truncatedApi = api(files);
  const truncatedFetch = async (input, init) => {
    const response = await truncatedApi.fake.fetch(input, init);
    return String(input).includes('/git/trees/') ? Response.json({ truncated: true, tree: [] }) : response;
  };
  await assert.rejects(createGitHubDataStore(env, { fetchImpl: truncatedFetch }).load(), (error) => error.code === 'TREE_TOO_LARGE');
  const malformedFetch = async (input, init) => {
    const response = await truncatedApi.fake.fetch(input, init);
    return String(input).includes('/git/trees/') ? Response.json({ truncated: false, tree: null }) : response;
  };
  await assert.rejects(createGitHubDataStore(env, { fetchImpl: malformedFetch }).load(), (error) => error.code === 'UPSTREAM');
  const partial = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: config.branch, token: config.token, initialFiles: { 'routes.json': files['routes.json'] } });
  await assert.rejects(createGitHubDataStore(env, { fetchImpl: partial.fetch.bind(partial) }).load(), (error) => error.code === 'INCOMPLETE_DATA');
});

test('read-only data preflight verifies private repository, branch and all three data files without exposing contents', async () => {
  const files = await localFiles();
  const { fake, store } = api(files);
  const status = await store.preflight();
  assert.equal(status.ready, true);
  assert.equal(status.authentication, 'passed');
  assert.equal(status.repository, 'accessible-private');
  assert.equal(status.branch, 'accessible');
  assert.equal(status.routeDataFiles, 'readable');
  assert.match(status.branchSha, /^[a-f0-9]{40}$/);
  assert.equal(JSON.stringify(status).includes(config.token), false);
  assert.equal(fake.commitOrder.length, 1, 'preflight is read-only and creates no commits');
});

test('preflight distinguishes an inaccessible branch and invalid credentials', async () => {
  const empty = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: 'other', token: config.token });
  const missingBranch = await createGitHubDataStore(env, { fetchImpl: empty.fetch.bind(empty) }).preflight();
  assert.equal(missingBranch.code, 'BRANCH_NOT_FOUND');
  assert.equal(missingBranch.branch, 'missing');
  const badAuth = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: config.branch, token: 'wrong' });
  const authStatus = await createGitHubDataStore(env, { fetchImpl: badAuth.fetch.bind(badAuth) }).preflight();
  assert.equal(authStatus.code, 'AUTH');
  assert.equal(authStatus.authentication, 'failed');
});

test('commits all three route files atomically and records a recoverable revision', async () => {
  const files = await localFiles();
  const { fake, store } = api(files);
  const before = await store.load();
  const next = structuredClone(files);
  next['routes.json'].migrationTest = 'metadata update';
  next['stops.json'].migrationTest = 'stops update';
  next['routes.geojson'].migrationTest = 'geometry update';
  const result = await store.createDatasetCommit({ routesFile: next['routes.json'], stopsFile: next['stops.json'], geojson: next['routes.geojson'] }, {
    expectedCommitSha: before.commitSha,
    author: 'allowed-admin',
    audit: { change: 'Test atomic edit', reason: 'Automated test', source: 'Test fixture', observation: 'No real route was changed.' },
  });
  const after = await store.load({ refresh: true });
  assert.equal(after.commitSha, result.commitSha);
  assert.deepEqual(after.routesFile, next['routes.json']);
  assert.deepEqual(after.stopsFile, next['stops.json']);
  assert.deepEqual(after.geojson, next['routes.geojson']);
  const commit = fake.commits.get(result.commitSha);
  assert.deepEqual(commit.parents.map((parent) => parent.sha), [before.commitSha]);
  assert.deepEqual((await store.listHistory()).map((item) => item.commitSha), [result.commitSha]);
  assert.deepEqual(await store.loadAtRevision(result.commitSha), after);
});

test('writes reject invalid audit metadata and keep cache isolated from caller mutation', async () => {
  const files = await localFiles();
  const { store } = api(files);
  const before = await store.load();
  const next = structuredClone(files);
  next['routes.json'].cacheMutation = 'committed';
  const options = { expectedCommitSha: before.commitSha, author: 'allowed-admin', audit: { change: 'Cache isolation', reason: 'Test fixture', source: 'Automated test', observation: 'No route data changed.' } };
  await assert.rejects(store.createDatasetCommit({ routesFile: next['routes.json'], stopsFile: next['stops.json'], geojson: next['routes.geojson'] }, { ...options, audit: { change: 'missing fields' } }), (error) => error.code === 'INVALID_AUDIT');
  await store.createDatasetCommit({ routesFile: next['routes.json'], stopsFile: next['stops.json'], geojson: next['routes.geojson'] }, options);
  next['routes.json'].cacheMutation = 'mutated-after-commit';
  assert.equal((await store.load()).routesFile.cacheMutation, 'committed');
});

test('concurrent administrator writes from one branch SHA allow one commit and reject the stale writer', async () => {
  const files = await localFiles();
  const { store: firstWriter, fake } = api(files);
  const secondWriter = createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake), cacheMs: 0 });
  const [firstSnapshot, secondSnapshot] = await Promise.all([firstWriter.load(), secondWriter.load()]);
  assert.equal(firstSnapshot.commitSha, secondSnapshot.commitSha);
  const firstFiles = structuredClone(files);
  firstFiles['routes.json'].writerMarker = 'first';
  const secondFiles = structuredClone(files);
  secondFiles['routes.json'].writerMarker = 'second';
  const write = (store, next, author) => store.createDatasetCommit({ routesFile: next['routes.json'], stopsFile: next['stops.json'], geojson: next['routes.geojson'] }, {
    expectedCommitSha: firstSnapshot.commitSha,
    audit: { change: `Concurrent write ${author}`, reason: 'Concurrency test', source: 'Test fixture', observation: 'No real data changed.' },
    author,
  });
  const outcomes = await Promise.allSettled([write(firstWriter, firstFiles, 'admin-one'), write(secondWriter, secondFiles, 'admin-two')]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((result) => result.status === 'rejected');
  assert.ok(['STALE_WRITE', 'CONFLICT'].includes(rejected.reason.code));
  assert.equal(rejected.reason.status, 409);
  const winner = await createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake) }).load({ refresh: true });
  assert.ok(['first', 'second'].includes(winner.routesFile.writerMarker));
});

test('writes reject a stale expected branch SHA before creating Git objects', async () => {
  const files = await localFiles();
  const { fake, store } = api(files);
  const current = await store.load();
  await assert.rejects(store.createDatasetCommit(asStoreFiles(files), {
    expectedCommitSha: 'a'.repeat(40), author: 'test-admin',
    audit: { change: 'Stale test', reason: 'Test only', source: 'Fixture', observation: 'No data changed.' },
  }), (error) => error.code === 'STALE_WRITE');
  assert.equal(fake.commitOrder.length, 1);
  assert.equal(fake.refs.get(config.branch), current.commitSha);
});

test('migration preview is read-only, apply backs up first, and repeat is idempotent', async (t) => {
  const files = await localFiles();
  const fake = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: config.branch, token: config.token });
  const store = createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake) });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sakay-github-migration-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const backupRoot = path.join(temp, 'backups');
  const preview = await runMigration({ store, localDirectory: LOCAL, backupRoot });
  assert.equal(preview.state, 'empty');
  assert.equal(preview.applied, false);
  await assert.rejects(stat(backupRoot), { code: 'ENOENT' });
  const applied = await runMigration({ store, localDirectory: LOCAL, backupRoot, apply: true, confirmed: true });
  assert.equal(applied.applied, true);
  assert.match(applied.migration.commitSha, /^[a-f0-9]{40}$/);
  assert.equal((await stat(applied.backup)).mode & 0o077, 0, 'backup directory is owner-only');
  for (const name of ROUTE_DATA_FILES) assert.equal((await stat(path.join(applied.backup, name))).mode & 0o077, 0, 'backup file is owner-only');
  const repeat = await runMigration({ store, localDirectory: LOCAL, backupRoot, apply: true, confirmed: true });
  assert.equal(repeat.state, 'already-migrated');
  assert.equal(repeat.applied, false);
  assert.equal(repeat.migration.commitSha, applied.migration.commitSha);
});

test('migration preserves an existing remote repository tree without overwriting its unrelated files', async () => {
  const files = await localFiles();
  const fake = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: config.branch, token: config.token, initialFiles: { 'README.md': 'Keep this repository file.' } });
  const store = createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake) });
  const storeFiles = asStoreFiles(files);
  const preview = await store.inspectMigration(storeFiles);
  assert.equal(preview.state, 'empty');
  const report = await runMigration({ store, localDirectory: LOCAL });
  assert.deepEqual(report.target, { owner: config.owner, repository: config.repo, branch: config.branch, currentCommitSha: preview.branchSha });
  assert.equal(report.access.repository, 'verified');
  assert.equal(report.access.branch, 'verified');
  assert.equal(report.access.routeDataFilesFound, false);
  assert.equal(report.outcome, 'would-create-three-files');
  await store.migrate(storeFiles);
  const head = fake.refs.get(config.branch);
  const treeSha = fake.commits.get(head).tree.sha;
  assert.ok(fake.trees.get(treeSha).has('README.md'));
  assert.equal((await store.load()).routesFile.routes.length, files['routes.json'].routes.length);
});

test('migration checks the default branch and blocks adding a competing data branch', async () => {
  const files = await localFiles();
  const fake = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: 'main', token: config.token, initialFiles: files });
  const stagingEnv = { ...env, SAKAY_DATA_GITHUB_BRANCH: 'staging' };
  const store = createGitHubDataStore(stagingEnv, { fetchImpl: fake.fetch.bind(fake) });
  await assert.rejects(store.inspectMigration(asStoreFiles(files)), (error) => error.code === 'REMOTE_DATA_EXISTS');

  const cleanFake = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: 'main', token: config.token, initialFiles: { 'README.md': 'unrelated file' } });
  const cleanStore = createGitHubDataStore(stagingEnv, { fetchImpl: cleanFake.fetch.bind(cleanFake) });
  await assert.rejects(cleanStore.inspectMigration(asStoreFiles(files)), (error) => error.code === 'TARGET_BRANCH_MISSING');
  assert.equal(cleanFake.commitOrder.length, 1, 'blocked branch initialization makes no commit');
});

test('migration refuses to proceed when repository branch listing reaches the API page limit', async () => {
  const files = await localFiles();
  const fake = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: 'main', token: config.token, initialFiles: { 'README.md': 'unrelated file' } });
  const sha = fake.refs.get('main');
  for (let index = 1; index < 100; index += 1) fake.refs.set(`branch-${index}`, sha);
  const store = createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake) });
  await assert.rejects(store.inspectMigration(asStoreFiles(files)), (error) => error.code === 'BRANCH_SCAN');
  assert.equal(fake.commitOrder.length, 1);
});

test('migration refuses to overwrite remote route data and requires explicit confirmation', async () => {
  const files = await localFiles();
  const { fake, store } = api(files);
  const different = structuredClone(files);
  different['routes.json'].unexpected = true;
  await assert.rejects(store.inspectMigration(asStoreFiles(different)), (error) => error.code === 'REMOTE_DATA_EXISTS');
  await assert.rejects(runMigration({ store, localDirectory: LOCAL, apply: true }), /--confirm-import/);
  const current = await store.load({ refresh: true });
  await store.createDatasetCommit({ routesFile: different['routes.json'], stopsFile: different['stops.json'], geojson: different['routes.geojson'] }, {
    expectedCommitSha: current.commitSha, author: 'test-admin', audit: { change: 'Synthetic conflict', reason: 'Test only', source: 'Fixture', observation: 'No real data.' },
  });
  const report = await runMigration({ store, localDirectory: LOCAL });
  assert.equal(report.outcome, 'blocked');
  assert.equal(report.access.repository, 'verified');
  assert.equal(report.access.branch, 'verified');
  assert.equal(report.access.routeDataFilesFound, true);
  assert.match(report.target.currentCommitSha, /^[a-f0-9]{40}$/);
  assert.equal(fake.commitOrder.length, 2, 'conflict preview never creates a commit');
});

test('migration stops before remote access when a local file fails dataset validation', async (t) => {
  const files = await localFiles();
  const fake = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, branch: config.branch, token: config.token });
  const store = createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake) });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sakay-github-invalid-migration-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(path.join(temp, 'data'));
  files['routes.geojson'].features[0].geometry.coordinates[0] = [500, 200];
  for (const name of ROUTE_DATA_FILES) {
    await writeFile(path.join(temp, 'data', name), JSON.stringify(files[name]));
  }
  await assert.rejects(runMigration({ store, localDirectory: path.join(temp, 'data') }), /failed validation/);
  assert.equal(fake.refs.size, 0);
});

test('data store failures never report a configured credential value', async () => {
  const files = await localFiles();
  const fake = new FakeGitHubDataApi({ owner: config.owner, repo: config.repo, token: config.token, initialFiles: files, privateRepo: false });
  const store = createGitHubDataStore(env, { fetchImpl: fake.fetch.bind(fake) });
  await assert.rejects(store.load(), (error) => error instanceof GitHubDataStoreError && !error.message.includes(config.token));
});

test('malformed audit trailers and invalid historical revisions are rejected safely', async () => {
  const files = await localFiles();
  const { store, fake } = api(files);
  const current = await store.load();
  const commit = fake.commits.get(current.commitSha);
  commit.message = 'Synthetic malformed audit\n\nSakay-Audit: bm90LWpzb24';
  assert.equal(store.parseAudit(commit.message), null);
  await assert.rejects(store.loadAtRevision(current.commitSha), (error) => error.code === 'INVALID_REVISION');
  await assert.rejects(store.loadAtRevision('../bad-sha'), (error) => error.code === 'INVALID_REVISION');
});
