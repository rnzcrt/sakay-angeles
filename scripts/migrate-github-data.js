import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from '../src/data/validate.js';
import { createGitHubDataStore } from '../src/security/githubDataStore.js';
import { loadLocalEnvironment } from './load-local-env.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILES = ['routes.json', 'stops.json', 'routes.geojson'];

export async function loadLocalRouteFiles(directory = path.join(ROOT, 'public/data')) {
  const values = await Promise.all(FILES.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  return { routesFile: values[0], stopsFile: values[1], geojson: values[2] };
}

function validateLocalFiles(files) {
  const result = validateDataset({
    routes: files.routesFile.routes,
    stops: files.stopsFile.stops,
    transfers: files.stopsFile.transfers ?? [],
    geojson: files.geojson,
  });
  if (!result.valid) {
    const detail = result.errors.slice(0, 12).map((item) => `${item.path}: ${item.message}`).join('\n');
    throw new Error(`Local route dataset failed validation:\n${detail}`);
  }
  return result;
}

async function createBackup(files, backupRoot, now) {
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const folder = path.join(backupRoot, `github-data-migration-${new Date(now()).toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);
  await mkdir(folder, { recursive: false, mode: 0o700 });
  await Promise.all(FILES.map((name) => writeFile(path.join(folder, name), `${JSON.stringify(files[name === 'routes.json' ? 'routesFile' : name === 'stops.json' ? 'stopsFile' : 'geojson'], null, 2)}\n`, { flag: 'wx', mode: 0o600 })));
  return folder;
}

export async function runMigration({ store, localDirectory, backupRoot = path.join(ROOT, '.route-data-backups'), apply = false, confirmed = false, now = Date.now }) {
  if (!store) throw new TypeError('A configured GitHub data store is required.');
  if (apply && !confirmed) throw new Error('Migration apply requires the explicit --confirm-import flag.');
  const files = await loadLocalRouteFiles(localDirectory);
  const validation = validateLocalFiles(files);
  let remote;
  try { remote = await store.inspectMigration(files); }
  catch (error) {
    if (apply) throw error;
    const details = error?.details || {};
    return {
      target: { owner: store.config.owner, repository: store.config.repo, branch: store.config.branch, currentCommitSha: details.branchSha ?? null },
      access: {
        repository: details.repositoryAccessible ? 'verified' : 'not-verified',
        branch: details.branchAccessible ? 'verified' : 'not-verified',
        routeDataFilesFound: typeof details.routeDataFilesFound === 'boolean' ? details.routeDataFilesFound : 'unknown',
      },
      outcome: 'blocked', reason: error?.message || 'GitHub target could not be verified.',
      routes: files.routesFile.routes.length, stops: files.stopsFile.stops.length,
      geojsonFeatures: files.geojson.features.length,
      validation: { passed: true, errors: validation.errors, warnings: validation.warnings ?? [] },
      applied: false,
    };
  }
  const preview = {
    target: { owner: store.config.owner, repository: store.config.repo, branch: store.config.branch, currentCommitSha: remote.branchSha ?? null },
    access: { repository: remote.repositoryAccessible ? 'verified' : 'not-verified', branch: remote.branchAccessible ? 'verified' : 'will-be-created-from-safe-base', routeDataFilesFound: remote.routeDataFilesFound },
    outcome: remote.state === 'already-migrated' ? 'no-changes' : 'would-create-three-files',
    state: remote.state,
    routes: files.routesFile.routes.length,
    stops: files.stopsFile.stops.length,
    geojsonFeatures: files.geojson.features.length,
    validation: { passed: true, errors: validation.errors, warnings: validation.warnings ?? [] },
  };
  if (!apply || remote.state === 'already-migrated') return { ...preview, applied: false, migration: remote };
  const backup = await createBackup(files, backupRoot, now);
  const migration = await store.migrate(files);
  return { ...preview, applied: migration.state === 'migrated', backup, migration };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const confirmed = process.argv.includes('--confirm-import');
  let result;
  try {
    loadLocalEnvironment();
    const store = createGitHubDataStore();
    result = await runMigration({ store, apply, confirmed });
  } catch (error) {
    if (apply) throw error;
    result = {
      target: { owner: process.env.SAKAY_DATA_GITHUB_OWNER || null, repository: process.env.SAKAY_DATA_GITHUB_REPO || null, branch: process.env.SAKAY_DATA_GITHUB_BRANCH || null, currentCommitSha: null },
      access: { repository: 'not-verified', branch: 'not-verified', routeDataFilesFound: 'unknown' },
      outcome: 'blocked', reason: error?.message || 'Migration preview could not verify the GitHub target.', applied: false,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === 'blocked') process.exitCode = 1;
  if (apply && !confirmed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message || 'Route data migration failed.');
    process.exitCode = 1;
  });
}
