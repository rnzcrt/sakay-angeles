// Server-only persistence for the private sakay-angeles-data repository.
// This module must never be imported by browser code.

const FILES = ['routes.json', 'stops.json', 'routes.geojson'];
const API = 'https://api.github.com';
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^(?!\/)(?!.*\/\/)(?!.*\/$)(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9._/-]+$/;
const SHA_RE = /^[a-f0-9]{40}$/i;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSha = (value) => typeof value === 'string' && SHA_RE.test(value);
const validBranch = (value) => typeof value === 'string' && BRANCH_RE.test(value) && value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock') && part !== '@');
const validAuditText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validAuditDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export class GitHubDataStoreError extends Error {
  constructor(code, message, status = 503, details = {}) {
    super(message);
    this.name = 'GitHubDataStoreError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function readGitHubDataConfig(env = process.env) {
  const names = ['SAKAY_DATA_GITHUB_TOKEN', 'SAKAY_DATA_GITHUB_OWNER', 'SAKAY_DATA_GITHUB_REPO', 'SAKAY_DATA_GITHUB_BRANCH'];
  const missing = names.filter((name) => typeof env[name] !== 'string' || !env[name].trim());
  if (missing.length) throw new GitHubDataStoreError('CONFIG', `Missing required GitHub data storage settings: ${missing.join(', ')}.`, 500);
  const config = {
    token: env.SAKAY_DATA_GITHUB_TOKEN.trim(),
    owner: env.SAKAY_DATA_GITHUB_OWNER.trim(),
    repo: env.SAKAY_DATA_GITHUB_REPO.trim(),
    branch: env.SAKAY_DATA_GITHUB_BRANCH.trim(),
  };
  if (!OWNER_RE.test(config.owner) || !REPO_RE.test(config.repo) || config.repo === '.' || config.repo === '..' || !validBranch(config.branch)) {
    throw new GitHubDataStoreError('CONFIG', 'GitHub data storage owner, repository, or branch setting is invalid.', 500);
  }
  return config;
}

const clone = (value) => structuredClone(value);
const encodePath = (value) => value.split('/').map(encodeURIComponent).join('/');
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const auditTrailer = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export class GitHubDataStore {
  constructor(config, { fetchImpl = fetch, cacheMs = 15_000, now = Date.now } = {}) {
    if (typeof config?.token !== 'string' || !config.token.trim() || !OWNER_RE.test(config?.owner || '') ||
        !REPO_RE.test(config?.repo || '') || config.repo === '.' || config.repo === '..' || !validBranch(config?.branch)) {
      throw new GitHubDataStoreError('CONFIG', 'GitHub data storage configuration is incomplete.', 500);
    }
    this.config = { token: config.token.trim(), owner: config.owner, repo: config.repo, branch: config.branch };
    this.fetch = fetchImpl;
    this.cacheMs = cacheMs;
    this.now = now;
    this.cache = null;
    this.repositoryCheck = null;
  }

  url(path) {
    const { owner, repo } = this.config;
    const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return path ? `${base}/${path}` : base;
  }

  async request(path, { method = 'GET', body, allow404 = false } = {}) {
    let response;
    try {
      response = await this.fetch(this.url(path), {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.config.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Sakay-Angeles-Data-Store',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new GitHubDataStoreError('UNAVAILABLE', 'Could not reach the private route data repository.');
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      if (response.status === 401) throw new GitHubDataStoreError('AUTH', 'GitHub rejected the route data storage credentials.', 503);
      if (response.status === 403) throw new GitHubDataStoreError('PERMISSION', 'GitHub denied access to the private route data repository.', 503);
      if (response.status === 404) throw new GitHubDataStoreError('NOT_FOUND', 'The configured private route data repository or resource was not found.', 503);
      if ([409, 422].includes(response.status)) throw new GitHubDataStoreError('CONFLICT', 'The route data changed during this operation. Reload the latest data and try again.', 409);
      throw new GitHubDataStoreError('UPSTREAM', 'The private route data repository could not complete the request.');
    }
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new GitHubDataStoreError('UPSTREAM', 'The private route data repository returned an invalid response.'); }
  }

  async ensurePrivateRepository() {
    if (!this.repositoryCheck) {
      this.repositoryCheck = this.request('', {}).then((repo) => {
        if (!isRecord(repo) || repo.private !== true) throw new GitHubDataStoreError('NOT_PRIVATE', 'Configured route data repository must be private.', 500);
        if (repo.default_branch !== null && repo.default_branch !== undefined && !validBranch(repo.default_branch)) throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid default branch name.');
        return repo;
      }).catch((error) => { this.repositoryCheck = null; throw error; });
    }
    return this.repositoryCheck;
  }

  async branchRef(branch = this.config.branch) {
    if (!validBranch(branch)) throw new GitHubDataStoreError('CONFIG', 'GitHub data branch setting is invalid.', 500);
    await this.ensurePrivateRepository();
    const ref = await this.request(`git/ref/heads/${encodePath(branch)}`, { allow404: true });
    if (ref && (!validSha(ref.object?.sha) || ref.object?.type !== 'commit')) throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid branch reference.');
    return ref;
  }

  async commitObject(sha) {
    if (!validSha(sha)) throw new GitHubDataStoreError('INVALID_REVISION', 'Invalid route data revision.', 400);
    const commit = await this.request(`git/commits/${sha}`);
    if (!isRecord(commit) || !validSha(commit.sha) || commit.sha.toLowerCase() !== sha.toLowerCase() || !validSha(commit.tree?.sha) || !Array.isArray(commit.parents)) throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid commit response.');
    return commit;
  }

  async treeFiles(treeSha) {
    if (!validSha(treeSha)) throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid tree reference.');
    const tree = await this.request(`git/trees/${treeSha}?recursive=1`);
    if (!isRecord(tree)) throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid tree response.');
    if (typeof tree.truncated !== 'boolean' || !Array.isArray(tree.tree)) throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid tree response.');
    if (tree.truncated) throw new GitHubDataStoreError('TREE_TOO_LARGE', 'The private data repository tree is too large to read safely.');
    if (tree.tree.some((entry) => !isRecord(entry) || typeof entry.path !== 'string' || !['blob', 'tree', 'commit'].includes(entry.type) || !validSha(entry.sha))) {
      throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid tree response.');
    }
    const routeEntries = new Map(tree.tree.filter((entry) => FILES.includes(entry.path)).map((entry) => [entry.path, entry]));
    if ([...routeEntries.values()].some((entry) => entry.type !== 'blob')) throw new GitHubDataStoreError('INCOMPLETE_DATA', 'A route-data path is not a regular file in the private repository. No data was changed.');
    const files = new Map(tree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]));
    const found = FILES.filter((name) => routeEntries.has(name));
    if (!found.length) return null;
    if (found.length !== FILES.length) throw new GitHubDataStoreError('INCOMPLETE_DATA', 'The private repository contains only part of the route dataset. No data was changed.');
    const values = await Promise.all(FILES.map(async (name) => {
      const blob = await this.request(`git/blobs/${files.get(name)}`);
      if (!isRecord(blob) || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new GitHubDataStoreError('INVALID_DATA', `Could not decode ${name} from the private repository.`);
      const encoded = blob.content.replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new GitHubDataStoreError('INVALID_DATA', `Could not decode ${name} from the private repository.`);
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'))); }
      catch { throw new GitHubDataStoreError('INVALID_DATA', `The private repository contains invalid JSON in ${name}.`); }
    }));
    return { routesFile: values[0], stopsFile: values[1], geojson: values[2] };
  }

  async snapshotAtCommit(sha, { requireRevision = false } = {}) {
    const commit = await this.commitObject(sha);
    if (requireRevision && !this.parseAudit(commit.message)) throw new GitHubDataStoreError('INVALID_REVISION', 'That commit is not a saved route data revision.', 404);
    const files = await this.treeFiles(commit.tree?.sha);
    if (!files) throw new GitHubDataStoreError('EMPTY_DATASET', 'The configured branch has no route dataset yet. Run the explicit migration command before serving route data.', 503);
    return { ...files, commitSha: sha };
  }

  async readRemote() {
    const ref = await this.branchRef();
    if (!ref) throw new GitHubDataStoreError('EMPTY_REPOSITORY', 'The configured branch is empty or does not exist. Run the explicit migration command before serving route data.', 503);
    return this.snapshotAtCommit(ref.object?.sha);
  }

  async load({ refresh = false } = {}) {
    const age = this.cache ? this.now() - this.cache.at : Infinity;
    if (!refresh && this.cache && age >= 0 && age < this.cacheMs) return clone(this.cache.value);
    const value = await this.readRemote();
    this.cache = { at: this.now(), value };
    return clone(value);
  }

  async preflight() {
    const status = {
      configuration: 'valid', authentication: 'not-checked', repository: 'not-checked',
      branch: 'not-checked', routeDataFiles: 'not-checked', branchSha: null,
      ready: false, code: null, message: null,
    };
    try {
      const repository = await this.ensurePrivateRepository();
      status.authentication = 'passed';
      status.repository = repository?.private === true ? 'accessible-private' : 'blocked-not-private';
      const ref = await this.request(`git/ref/heads/${encodePath(this.config.branch)}`, { allow404: true });
      if (!ref) {
        status.branch = 'missing'; status.routeDataFiles = 'not-checked';
        status.code = 'BRANCH_NOT_FOUND'; status.message = 'The configured branch does not exist; create or select the intended branch before migration.';
        return status;
      }
      status.branch = 'accessible'; status.branchSha = ref.object?.sha || null;
      const snapshot = await this.snapshotAtCommit(status.branchSha);
      status.routeDataFiles = snapshot ? 'readable' : 'missing';
      if (!snapshot) {
        status.code = 'DATA_FILES_MISSING'; status.message = 'The branch is accessible but has no route-data files. Run the explicit migration preview before any migration.';
        return status;
      }
      status.ready = true; status.code = 'READY'; status.message = 'GitHub authentication, private repository, branch, and all three route-data files are accessible.';
      return status;
    } catch (error) {
      status.code = error?.code || 'UPSTREAM';
      status.message = error?.message || 'GitHub data preflight failed.';
      if (['AUTH', 'PERMISSION'].includes(status.code)) status.authentication = 'failed';
      else if (status.authentication === 'not-checked') status.authentication = 'failed-or-unavailable';
      if (status.code === 'NOT_FOUND' && status.repository === 'not-checked') status.repository = 'missing-or-inaccessible';
      if (['INCOMPLETE_DATA', 'INVALID_DATA'].includes(status.code)) status.routeDataFiles = 'invalid-or-incomplete';
      if (status.code === 'EMPTY_DATASET') { status.code = 'DATA_FILES_MISSING'; status.routeDataFiles = 'missing'; status.message = 'The configured branch exists but contains no route-data files.'; }
      return status;
    }
  }

  async loadAtRevision(sha) {
    await this.ensurePrivateRepository();
    return this.snapshotAtCommit(sha, { requireRevision: true });
  }

  parseAudit(message = '') {
    const line = String(message).split('\n').find((part) => part.startsWith('Sakay-Audit: '));
    if (!line) return null;
    try {
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(line.slice('Sakay-Audit: '.length), 'base64url')));
      const record = envelope?.record;
      if (!isRecord(envelope) || typeof envelope.author !== 'string' || !/^[A-Za-z0-9_.-]{1,39}$/.test(envelope.author) || !isRecord(record) ||
          !validAuditText(record.change, 1000) || !validAuditText(record.reason, 2000) || !validAuditText(record.source, 1000) ||
          !validAuditText(record.observation, 3000) || !validAuditDate(record.date)) return null;
      return { author: envelope.author, record: { change: record.change, reason: record.reason, source: record.source, observation: record.observation, date: record.date } };
    }
    catch { return null; }
  }

  async listHistory() {
    const ref = await this.branchRef();
    if (!ref) return [];
    const entries = [];
    for (let page = 1; page <= 1000; page += 1) {
      const commits = await this.request(`commits?sha=${encodeURIComponent(this.config.branch)}&per_page=100&page=${page}`);
      if (!Array.isArray(commits)) throw new GitHubDataStoreError('HISTORY', 'Could not read route data revision history.');
      for (const item of commits) {
        if (!isRecord(item) || !validSha(item.sha) || !isRecord(item.commit)) continue;
        const audit = this.parseAudit(item.commit?.message);
        if (audit) entries.push({
          id: item.sha,
          commitSha: item.sha,
          createdAt: item.commit?.author?.date || item.commit?.committer?.date || '',
          author: audit.author || item.commit?.author?.name || 'Administrator',
          audit: audit.record || {},
        });
      }
      if (commits.length < 100) return entries;
    }
    throw new GitHubDataStoreError('HISTORY_LIMIT', 'Revision history is too large to load safely.');
  }

  async inspectMigration(localFiles) {
    const localFile = (name) => localFiles[name === 'routes.json' ? 'routesFile' : name === 'stops.json' ? 'stopsFile' : 'geojson'];
    const repository = await this.ensurePrivateRepository();
    const branches = await this.request('branches?per_page=100');
    if (!Array.isArray(branches) || branches.length >= 100) throw new GitHubDataStoreError('BRANCH_SCAN', 'Could not safely verify every repository branch before migration. No data was changed.');
    if (branches.some((item) => !isRecord(item) || !validBranch(item.name) || !validSha(item.commit?.sha))) throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid branch listing. Migration is blocked.');
    const configuredBranch = branches.find((item) => item.name === this.config.branch);
    for (const item of branches) {
      if (item.name === this.config.branch) continue;
      const commit = await this.commitObject(item.commit?.sha);
      if (await this.treeFiles(commit.tree.sha)) throw new GitHubDataStoreError('REMOTE_DATA_EXISTS', 'Another repository branch already contains route data. Migration will not create a competing dataset.', 409, {
        branchSha: configuredBranch?.commit?.sha || null, repositoryAccessible: true, branchAccessible: Boolean(configuredBranch), routeDataFilesFound: true,
      });
    }
    if (!configuredBranch && branches.length > 0) throw new GitHubDataStoreError('TARGET_BRANCH_MISSING', 'The configured branch does not exist in this initialized repository. Create that branch explicitly, then rerun the read-only preview; no data was changed.', 409, {
      branchSha: null, repositoryAccessible: true, branchAccessible: false, routeDataFilesFound: false,
    });
    const ref = await this.branchRef();
    if (ref) {
      const commit = await this.commitObject(ref.object.sha);
      const existing = await this.treeFiles(commit.tree.sha);
      if (!existing) return { state: 'empty', branchSha: ref.object.sha, baseSha: ref.object.sha, repositoryAccessible: true, branchAccessible: true, routeDataFilesFound: false };
      if (FILES.every((name) => JSON.stringify(existing[name === 'routes.json' ? 'routesFile' : name === 'stops.json' ? 'stopsFile' : 'geojson']) === JSON.stringify(localFile(name)))) {
        return { state: 'already-migrated', branchSha: ref.object.sha, commitSha: ref.object.sha, repositoryAccessible: true, branchAccessible: true, routeDataFilesFound: true };
      }
      throw new GitHubDataStoreError('REMOTE_DATA_EXISTS', 'The configured branch already contains route data. Migration will not overwrite it.', 409, {
        branchSha: ref.object.sha, repositoryAccessible: true, branchAccessible: true, routeDataFilesFound: true,
      });
    }
    if (repository.default_branch && repository.default_branch !== this.config.branch) {
      const defaultRef = await this.branchRef(repository.default_branch);
      if (!defaultRef) throw new GitHubDataStoreError('BRANCH_STATE', 'GitHub reports a default branch that could not be read. Migration is blocked.', 409);
      const commit = await this.commitObject(defaultRef.object.sha);
      const existing = await this.treeFiles(commit.tree.sha);
      if (existing) throw new GitHubDataStoreError('REMOTE_DATA_EXISTS', 'The repository default branch already contains route data. Migration will not create a competing dataset.', 409);
      throw new GitHubDataStoreError('TARGET_BRANCH_MISSING', 'The configured branch does not exist in this initialized repository. Create that branch explicitly, then rerun the read-only preview; no data was changed.', 409, {
        branchSha: null, repositoryAccessible: true, branchAccessible: false, routeDataFilesFound: false,
      });
    }
    if (repository.default_branch === this.config.branch) throw new GitHubDataStoreError('BRANCH_STATE', 'GitHub reports the configured branch as the default, but its reference could not be verified. Migration is blocked.', 409);
    return { state: 'empty', branchSha: null, baseSha: null, repositoryAccessible: true, branchAccessible: false, routeDataFilesFound: false };
  }

  async createDatasetCommit(files, { expectedCommitSha = null, audit, author, allowInitialize = false } = {}) {
    const date = audit?.date || new Date(this.now()).toISOString().slice(0, 10);
    if (!isRecord(audit) || !validAuditText(audit.change, 1000) || !validAuditText(audit.reason, 2000) || !validAuditText(audit.source, 1000) || !validAuditText(audit.observation, 3000) || !validAuditDate(date)) {
      throw new GitHubDataStoreError('INVALID_AUDIT', 'A complete, bounded route-data audit record is required for every write.', 400);
    }
    if (!isRecord(files) || !isRecord(files.routesFile) || !isRecord(files.stopsFile) || !isRecord(files.geojson)) throw new GitHubDataStoreError('INVALID_DATA', 'A complete route dataset is required for every write.', 400);
    const currentRef = await this.branchRef();
    const currentSha = currentRef?.object?.sha || null;
    if (currentSha !== expectedCommitSha) throw new GitHubDataStoreError('STALE_WRITE', 'Route data changed since you loaded it. Reload the latest data before saving.', 409);
    if (!currentRef && !allowInitialize) throw new GitHubDataStoreError('EMPTY_REPOSITORY', 'The configured branch is not initialized. Use the explicit migration workflow first.', 503);
    const currentCommit = currentRef ? await this.commitObject(currentSha) : null;
    if (currentCommit) await this.treeFiles(currentCommit.tree.sha); // rejects partial existing datasets; an empty tree is safe.

    const treeBody = {
      ...(currentCommit ? { base_tree: currentCommit.tree.sha } : {}),
      tree: FILES.map((name) => ({ path: name, mode: '100644', type: 'blob', content: serialize(files[name === 'routes.json' ? 'routesFile' : name === 'stops.json' ? 'stopsFile' : 'geojson']) })),
    };
    const tree = await this.request('git/trees', { method: 'POST', body: treeBody });
    if (!validSha(tree?.sha)) throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid tree creation response.');
    const safeAuthor = String(author || 'route-data-migration').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 39) || 'route-data-migration';
    const record = { change: audit.change, reason: audit.reason, source: audit.source, observation: audit.observation, date };
    const subject = String(record.change || 'Saved route data').replace(/[\r\n]+/g, ' ').slice(0, 100).trim() || 'Saved route data';
    const message = `Sakay data revision: ${subject}\n\nSakay-Audit: ${auditTrailer({ author: safeAuthor, record })}`;
    const identity = { name: safeAuthor, email: `${safeAuthor}@users.noreply.github.com` };
    const commit = await this.request('git/commits', {
      method: 'POST',
      body: { message, tree: tree.sha, parents: currentRef ? [currentSha] : [], author: identity, committer: identity },
    });
    if (!validSha(commit?.sha)) throw new GitHubDataStoreError('UPSTREAM', 'GitHub returned an invalid commit creation response.');

    if (currentRef) {
      const latest = await this.branchRef();
      if (!latest || latest.object?.sha !== currentSha) throw new GitHubDataStoreError('STALE_WRITE', 'Route data changed during this save. Reload the latest data before saving.', 409);
      await this.request(`git/refs/heads/${encodePath(this.config.branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    } else {
      const latest = await this.branchRef();
      if (latest) throw new GitHubDataStoreError('STALE_WRITE', 'The configured branch was initialized during migration. Review the remote data before retrying.', 409);
      await this.request('git/refs', { method: 'POST', body: { ref: `refs/heads/${this.config.branch}`, sha: commit.sha } });
    }
    const value = clone({ ...files, commitSha: commit.sha });
    this.cache = { at: this.now(), value };
    return { commitSha: commit.sha };
  }

  async migrate(localFiles, { author = 'route-data-migration' } = {}) {
    const state = await this.inspectMigration(localFiles);
    if (state.state === 'already-migrated') return { ...state, commitSha: state.branchSha };
    const result = await this.createDatasetCommit(localFiles, {
      expectedCommitSha: state.branchSha,
      allowInitialize: true,
      author,
      audit: {
        change: 'Initial route data migration',
        reason: 'Explicit migration from the reviewed local route dataset.',
        source: 'Local migration command',
        observation: 'Imported existing data without changing route IDs, geometry, or verification status.',
      },
    });
    return { state: 'migrated', ...result };
  }
}

export function createGitHubDataStore(env = process.env, options = {}) {
  return new GitHubDataStore(readGitHubDataConfig(env), options);
}

export const ROUTE_DATA_FILES = Object.freeze([...FILES]);
