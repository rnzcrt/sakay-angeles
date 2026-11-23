import { createGitHubDataStore, GitHubDataStoreError } from '../src/security/githubDataStore.js';
import { loadLocalEnvironment } from './load-local-env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function configFailureReport(error, env = process.env) {
  return {
    target: { owner: env.SAKAY_DATA_GITHUB_OWNER || null, repository: env.SAKAY_DATA_GITHUB_REPO || null, branch: env.SAKAY_DATA_GITHUB_BRANCH || null },
    configuration: error?.code === 'CONFIG' ? 'invalid' : 'not-verified', authentication: 'not-checked',
    repository: 'not-checked', branch: 'not-checked', routeDataFiles: 'not-checked',
    branchSha: null, ready: false, code: error?.code || 'PREFLIGHT_FAILED',
    message: error instanceof GitHubDataStoreError ? error.message : 'GitHub data preflight could not start.',
  };
}

async function main() {
  try {
    loadLocalEnvironment();
    const store = createGitHubDataStore();
    const status = await store.preflight();
    console.log(JSON.stringify({ target: { owner: store.config.owner, repository: store.config.repo, branch: store.config.branch }, ...status }, null, 2));
    if (!status.ready) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify(configFailureReport(error), null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
