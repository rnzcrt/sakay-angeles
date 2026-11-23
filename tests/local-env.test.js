import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readGitHubDataConfig } from '../src/security/githubDataStore.js';
import { configFailureReport } from '../scripts/preflight-github-data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_KEYS = ['SAKAY_DATA_GITHUB_TOKEN', 'SAKAY_DATA_GITHUB_OWNER', 'SAKAY_DATA_GITHUB_REPO', 'SAKAY_DATA_GITHUB_BRANCH'];

async function checkEnvFile(contents, shell = {}, expectedOwner = 'fixture-owner') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sakay-env-test-'));
  try {
    const file = path.join(directory, '.env');
    await writeFile(file, contents, { mode: 0o600 });
    const env = { ...process.env };
    for (const key of ENV_KEYS) delete env[key];
    Object.assign(env, shell, { TEST_ENV_FILE: file });
    const helper = pathToFileURL(path.join(ROOT, 'scripts/load-local-env.js')).href;
    const source = `import { loadLocalEnvironment } from ${JSON.stringify(helper)}; loadLocalEnvironment(process.env.TEST_ENV_FILE); console.log(JSON.stringify({ token: process.env.SAKAY_DATA_GITHUB_TOKEN === 'fixture-token', owner: process.env.SAKAY_DATA_GITHUB_OWNER === ${JSON.stringify(expectedOwner)}, repo: process.env.SAKAY_DATA_GITHUB_REPO === 'fixture-repo', branch: process.env.SAKAY_DATA_GITHUB_BRANCH === 'fixture-branch' }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(result.status, 0, 'isolated Node process should load the .env file');
    return JSON.parse(result.stdout.trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('local .env loading reads all GitHub storage settings without printing their values', async () => {
  const loaded = await checkEnvFile([
    'SAKAY_DATA_GITHUB_TOKEN=fixture-token',
    'SAKAY_DATA_GITHUB_OWNER=fixture-owner',
    'SAKAY_DATA_GITHUB_REPO=fixture-repo',
    'SAKAY_DATA_GITHUB_BRANCH=fixture-branch',
  ].join('\n'));
  assert.deepEqual(loaded, { token: true, owner: true, repo: true, branch: true });
});

test('shell-provided GitHub settings take precedence over local .env values', async () => {
  const loaded = await checkEnvFile([
    'SAKAY_DATA_GITHUB_TOKEN=fixture-token',
    'SAKAY_DATA_GITHUB_OWNER=fixture-owner',
    'SAKAY_DATA_GITHUB_REPO=fixture-repo',
    'SAKAY_DATA_GITHUB_BRANCH=fixture-branch',
  ].join('\n'), { SAKAY_DATA_GITHUB_OWNER: 'shell-owner' }, 'shell-owner');
  assert.deepEqual(loaded, { token: true, owner: true, repo: true, branch: true });
});

test('missing settings keep the safe CONFIG diagnostic and never include a token value', () => {
  const sentinel = 'never-print-this-fixture-token';
  let error;
  try { readGitHubDataConfig({ SAKAY_DATA_GITHUB_TOKEN: sentinel }); } catch (caught) { error = caught; }
  assert.equal(error?.code, 'CONFIG');
  const report = configFailureReport(error, { SAKAY_DATA_GITHUB_TOKEN: sentinel });
  const diagnostic = JSON.stringify(report);
  assert.match(diagnostic, /CONFIG/);
  assert.match(diagnostic, /SAKAY_DATA_GITHUB_OWNER/);
  assert.doesNotMatch(diagnostic, new RegExp(sentinel));
});
