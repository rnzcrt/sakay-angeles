import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha1').update(value).digest('hex');
const json = (value, status = 200) => Response.json(value, { status });

export class FakeGitHubDataApi {
  constructor({ owner = 'data-owner', repo = 'sakay-data', privateRepo = true, branch = 'main', initialFiles = null, initialMessage = 'Initial repository commit', token = 'test-data-token', denyAccess = false } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.privateRepo = privateRepo;
    this.branch = branch;
    this.token = token;
    this.denyAccess = denyAccess;
    this.refs = new Map();
    this.commits = new Map();
    this.trees = new Map();
    this.blobs = new Map();
    this.commitOrder = [];
    if (initialFiles) {
      const files = Object.fromEntries(Object.entries(initialFiles).map(([path, value]) => [path, JSON.stringify(value, null, 2) + '\n']));
      const tree = this.createTree(files);
      const sha = digest(`initial:${tree.sha}`);
      this.commits.set(sha, { sha, tree: { sha: tree.sha }, parents: [], message: initialMessage, author: { name: 'fixture', date: '2026-01-01T00:00:00Z' } });
      this.refs.set(branch, sha);
      this.commitOrder.push(sha);
    }
  }

  createTree(files, baseSha) {
    const entries = new Map(baseSha ? this.trees.get(baseSha) || [] : []);
    for (const [path, content] of Object.entries(files)) {
      const sha = digest(`blob:${content}`);
      this.blobs.set(sha, Buffer.from(content).toString('base64'));
      entries.set(path, sha);
    }
    const sha = digest(JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b))));
    this.trees.set(sha, entries);
    return { sha, entries };
  }

  async fetch(input, init = {}) {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.github.com' || url.pathname !== `/repos/${this.owner}/${this.repo}` && !url.pathname.startsWith(`/repos/${this.owner}/${this.repo}/`)) {
      return json({ message: 'Not found' }, 404);
    }
    if (this.denyAccess) return json({ message: 'Resource access denied' }, 403);
    if (init.headers?.Authorization !== `Bearer ${this.token}`) return json({ message: 'Bad credentials' }, 401);
    const root = `/repos/${this.owner}/${this.repo}`;
    const relative = url.pathname.slice(root.length).replace(/^\//, '');
    const method = init.method || 'GET';
    if (relative === '' && method === 'GET') return json({ private: this.privateRepo, default_branch: this.refs.size ? this.branch : null });
    if (relative === 'branches' && method === 'GET') return json([...this.refs].map(([name, sha]) => ({ name, commit: { sha } })));
    if (relative.startsWith('git/ref/heads/') && method === 'GET') {
      const branch = decodeURIComponent(relative.slice('git/ref/heads/'.length));
      const sha = this.refs.get(branch);
      return sha ? json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }) : json({ message: 'Reference not found' }, 404);
    }
    if (relative.startsWith('git/commits/') && method === 'GET') {
      const commit = this.commits.get(relative.slice('git/commits/'.length));
      return commit ? json(commit) : json({ message: 'Commit not found' }, 404);
    }
    if (relative.startsWith('git/trees/') && method === 'GET') {
      const entries = this.trees.get(relative.slice('git/trees/'.length));
      return entries ? json({ truncated: false, tree: [...entries].map(([path, sha]) => ({ path, sha, type: 'blob' })) }) : json({ message: 'Tree not found' }, 404);
    }
    if (relative.startsWith('git/blobs/') && method === 'GET') {
      const content = this.blobs.get(relative.slice('git/blobs/'.length));
      return content ? json({ encoding: 'base64', content }) : json({ message: 'Blob not found' }, 404);
    }
    if (relative === 'git/trees' && method === 'POST') {
      const body = JSON.parse(init.body);
      const files = Object.fromEntries((body.tree || []).map((entry) => [entry.path, entry.content]));
      const tree = this.createTree(files, body.base_tree);
      return json({ sha: tree.sha });
    }
    if (relative === 'git/commits' && method === 'POST') {
      const body = JSON.parse(init.body);
      const sha = digest(`${body.message}:${body.tree}:${JSON.stringify(body.parents)}`);
      const commit = { sha, tree: { sha: body.tree }, parents: body.parents.map((parent) => ({ sha: parent })), message: body.message, author: { ...body.author, date: new Date().toISOString() } };
      this.commits.set(sha, commit);
      this.commitOrder.unshift(sha);
      return json(commit, 201);
    }
    if (relative.startsWith('git/refs/heads/') && method === 'PATCH') {
      const branch = decodeURIComponent(relative.slice('git/refs/heads/'.length));
      const current = this.refs.get(branch);
      const next = this.commits.get(JSON.parse(init.body).sha);
      if (!next || !current || next.parents[0]?.sha !== current) return json({ message: 'Update is not a fast-forward' }, 422);
      this.refs.set(branch, next.sha);
      return json({ ref: `refs/heads/${branch}`, object: { sha: next.sha } });
    }
    if (relative === 'git/refs' && method === 'POST') {
      const body = JSON.parse(init.body);
      const branch = body.ref.replace(/^refs\/heads\//, '');
      if (this.refs.has(branch)) return json({ message: 'Reference already exists' }, 422);
      if (!this.commits.has(body.sha)) return json({ message: 'Commit not found' }, 422);
      this.refs.set(branch, body.sha);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (relative === 'commits' && method === 'GET') {
      const branch = url.searchParams.get('sha') || this.branch;
      const head = this.refs.get(branch);
      const reachable = new Set();
      let cursor = head;
      while (cursor && !reachable.has(cursor)) {
        reachable.add(cursor);
        cursor = this.commits.get(cursor)?.parents[0]?.sha;
      }
      const page = Number(url.searchParams.get('page') || 1);
      const perPage = Number(url.searchParams.get('per_page') || 30);
      return json(this.commitOrder.filter((sha) => reachable.has(sha)).slice((page - 1) * perPage, page * perPage).map((sha) => {
        const item = this.commits.get(sha);
        return { sha, commit: { message: item.message, author: item.author } };
      }));
    }
    return json({ message: 'Unsupported fake GitHub API operation' }, 404);
  }
}
