/**
 * forge.js — GitHub integration through the user's `gh` CLI (paseo's model:
 * the forge CLI IS the transport; auth = whatever gh is logged into; we never
 * touch tokens). PR + checks arrive in ONE batched GraphQL query per target
 * with a 30 s TTL cache, in-flight dedupe and last-good fallback.
 */
import { execFile } from 'node:child_process';
import { originUrl } from './git.js';

const GH_TIMEOUT = 30000;
const PR_CACHE_TTL = 30000;
const AUTH_CACHE_TTL = 300000;
const MAX_CACHE_ENTRIES = 512;

function setBounded(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}

function execGh(args, opts = {}) {
  const { cwd, timeout = GH_TIMEOUT, signal } = opts;
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      {
        cwd,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        env,
        signal,
      },
      (error, stdout, stderr) => {
        if (!error) resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        else
          resolve({
            ok: false,
            code: typeof error.code === 'number' ? error.code : 1,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? error.message),
          });
      },
    );
  });
}

let ghProbe = null;
/** Is the gh CLI installed? (cached forever per process) */
export async function ghAvailable(signal) {
  if (ghProbe === null) {
    const r = await execGh(['--version'], { timeout: 10000, signal });
    if (signal?.aborted) return false;
    ghProbe = r.ok;
  }
  return ghProbe;
}

const authStates = new Map();
/** Is gh authenticated for one exact host? (cached 5 min per host) */
export async function ghAuthenticated(host = 'github.com', signal) {
  if (!(await ghAvailable(signal))) return false;
  const key = String(host).toLowerCase();
  const state = authStates.get(key);
  if (state && Date.now() - state.at < AUTH_CACHE_TTL) return state.ok;
  const r = await execGh(['auth', 'status', '--hostname', key], { timeout: 15000, signal });
  if (signal?.aborted) return false;
  setBounded(authStates, key, { at: Date.now(), ok: r.ok });
  return r.ok;
}

export function invalidateGhAuth(host) {
  if (host === undefined) authStates.clear();
  else authStates.delete(String(host).toLowerCase());
}

/**
 * Parse a GitHub owner/repo out of an origin URL (https or ssh).
 * @returns {{owner:string, repo:string, host:string}|null}
 */
export function parseGithubRemote(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  const raw = url.trim();
  let host;
  let pathname;
  try {
    if (/^(?:https?|ssh|git):\/\//i.test(raw)) {
      const parsed = new URL(raw);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
      host = /^https?:$/i.test(parsed.protocol) ? parsed.host : parsed.hostname;
      pathname = parsed.pathname;
    } else {
      const match = /^(?:[^@/]+@)?([^:/?#]+):([^?#]+)$/.exec(raw);
      if (!match) return null;
      host = match[1];
      pathname = `/${match[2]}`;
    }
  } catch {
    return null;
  }
  const parts = String(pathname || '').replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const transportHost = String(host || '').toLowerCase().replace(/\.$/, '');
  // GitHub's documented SSH-over-443 endpoint is transport-only; the gh API
  // and repository selector still use github.com.
  const normalizedHost = transportHost === 'ssh.github.com' ? 'github.com' : transportHost;
  if (!normalizedHost || !repo || /[%\\]/.test(owner + repo)) return null;
  return { host: normalizedHost, owner, repo };
}

export function forgeRepositoryKey(identity) {
  if (!identity?.host || !identity?.owner || !identity?.repo) return null;
  return `${String(identity.host).toLowerCase()}/${String(identity.owner).toLowerCase()}/${String(identity.repo).toLowerCase()}`;
}

export async function forgeIdentityForCwd(cwd) {
  // The Git remote is the only repository identity bound to this authorized
  // cwd. Never let ambient gh defaults substitute another host/repository.
  // Distinct GHES transport/API hostnames therefore require an explicit remote
  // using the API hostname; guessing that mapping would be a retargeting bug.
  const remote = await originUrl(cwd).catch(() => null);
  return parseGithubRemote(remote);
}

function ghRepo(identity) {
  return `${identity.host}/${identity.owner}/${identity.repo}`;
}

/* ------------------------------------------------------------------ */
/* PR status (batched GraphQL + TTL cache)                             */
/* ------------------------------------------------------------------ */

const prCache = new Map(); // key → {at, value}
const prInflight = new Map(); // key → Promise
const prLastGood = new Map(); // key → value
let prEpoch = 0;

const PR_GRAPHQL_FIELDS = `number url title state isDraft baseRefName headRefName headRefOid headRepositoryOwner{login} mergedAt mergeable reviewDecision statusCheckRollup{state contexts(first:50){nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}`;

function prQuery(owner, repo, headRefName, pullNumber) {
  const q = (s) => JSON.stringify(String(s));
  const selector = Number.isSafeInteger(pullNumber)
    ? `pullRequest(number:${pullNumber}){${PR_GRAPHQL_FIELDS}}`
    : `pullRequests(headRefName:${q(headRefName)},first:10,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${PR_GRAPHQL_FIELDS}}}`;
  return `query{repository(owner:${q(owner)},name:${q(repo)}){${selector}}}`;
}

function foldChecks(rollup) {
  if (!rollup) return { status: 'none', completed: 0, total: 0 };
  const nodes = rollup.contexts?.nodes ?? [];
  let total = 0;
  let completed = 0;
  let failure = false;
  let pending = false;
  for (const node of nodes) {
    if (!node) continue;
    total += 1;
    if (node.__typename === 'CheckRun') {
      if (node.status === 'COMPLETED') {
        completed += 1;
        if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(node.conclusion))
          failure = true;
      } else pending = true;
    } else {
      // StatusContext
      if (node.state === 'SUCCESS') completed += 1;
      else if (['FAILURE', 'ERROR'].includes(node.state)) {
        completed += 1;
        failure = true;
      } else pending = true;
    }
  }
  // rollup.state is GitHub's own fold: SUCCESS/FAILING/PENDING/EXPECTED...
  const state = rollup.state ?? '';
  if (failure || state === 'FAILING') return { status: 'failure', completed, total };
  if (pending || state === 'PENDING' || (total > 0 && completed < total)) return { status: 'pending', completed, total };
  if (total === 0) return { status: 'none', completed: 0, total: 0 };
  return { status: 'success', completed, total };
}

function normalizePr(node, headSha) {
  const merged = node.mergedAt !== null && node.mergedAt !== undefined;
  const state = merged || node.state === 'MERGED' ? 'merged' : node.state === 'OPEN' ? 'open' : 'closed';
  const numberMatch = /(?:pull|pulls|merge_requests)\/(\d+)/.exec(node.url ?? '');
  return {
    number: node.number ?? (numberMatch ? Number(numberMatch[1]) : null),
    url: node.url,
    title: node.title,
    state,
    isDraft: Boolean(node.isDraft),
    baseRefName: node.baseRefName,
    headRefName: node.headRefName,
    headRefOid: node.headRefOid,
    headOwnerLogin: node.headRepositoryOwner?.login ?? null,
    headShaMatches: headSha ? node.headRefOid === headSha : false,
    mergeable: node.mergeable ?? 'UNKNOWN',
    reviewDecision: node.reviewDecision ?? null,
    checks: foldChecks(node.statusCheckRollup),
  };
}

/**
 * PR + checks status for one (repo, headRef) target.
 * Candidate pick prefers exact head SHA match, then newest (paseo).
 * @returns {Promise<{pr:object|null, forgeAuth:'ok'|'cli_missing'|'unauthenticated'|'no_remote'|'error'}>}
 */
export async function prStatus(target) {
  const { owner, repo, headRef, headSha } = target;
  const host = String(target.host || 'github.com').toLowerCase();
  if (!owner || !repo || !headRef) return { pr: null, forgeAuth: 'no_remote' };
  if (!(await ghAvailable())) return { pr: null, forgeAuth: 'cli_missing' };
  if (!(await ghAuthenticated(host))) return { pr: null, forgeAuth: 'unauthenticated' };
  const key = `${forgeRepositoryKey({ host, owner, repo })}@${Number.isSafeInteger(target.pullNumber) ? `#${target.pullNumber}` : headRef}:${headSha ?? ''}`;
  const cached = prCache.get(key);
  if (cached && Date.now() - cached.at < PR_CACHE_TTL) return cached.value;
  const inflight = prInflight.get(key);
  if (inflight) return inflight;
  const epoch = prEpoch;
  const promise = (async () => {
    const r = await execGh(['api', '--hostname', host, 'graphql', '-f', `query=${prQuery(owner, repo, headRef, target.pullNumber)}`]);
    const parsed = tryParseGraphql(r.stdout);
    let value;
    if (parsed && parsed.nodes) value = pickPr(parsed.nodes, headSha);
    else if (parsed && parsed.forgeAuth === 'error') value = { pr: null, forgeAuth: 'error', error: parsed.error };
    else value = { pr: null, forgeAuth: 'error', error: (r.stderr || 'gh graphql failed').slice(0, 400) };
    if (prInflight.get(key) === promise) prInflight.delete(key);
    if (epoch !== prEpoch) return prStatus(target);
    if (value.forgeAuth === 'error') {
      const good = prLastGood.get(key);
      if (good) return good; // last-good fallback; do not cache the error
    }
    if (epoch === prEpoch) {
      setBounded(prCache, key, { at: Date.now(), value });
      if (value.pr) setBounded(prLastGood, key, value);
    }
    return value;
  })();
  setBounded(prInflight, key, promise);
  return promise;
}

function tryParseGraphql(stdout) {
  try {
    const data = JSON.parse(stdout);
    const repository = data?.data?.repository;
    const nodes = Array.isArray(repository?.pullRequests?.nodes)
      ? repository.pullRequests.nodes
      : repository && Object.prototype.hasOwnProperty.call(repository, 'pullRequest')
        ? repository.pullRequest ? [repository.pullRequest] : []
        : null;
    if (!Array.isArray(nodes)) {
      if (data?.errors) return { pr: null, forgeAuth: 'error', error: String(data.errors[0]?.message ?? '').slice(0, 400) };
      return null;
    }
    return { nodes, forgeAuth: 'ok' };
  } catch {
    return null;
  }
}

/**
 * Batched PR status for many targets: ONE aliased GraphQL call (paseo batches
 * ≤25 per call). Returns Map<key, {pr, forgeAuth}>.
 */
export async function prStatusBatch(targets, options = {}) {
  const signal = options.signal;
  const out = new Map();
  if (targets.length === 0) return out;
  if (!(await ghAvailable(signal))) {
    for (const t of targets) out.set(t.key, { pr: null, forgeAuth: signal?.aborted ? 'error' : 'cli_missing' });
    return out;
  }
  const freshByHost = new Map();
  for (const target of targets) {
    const host = String(target.host || 'github.com').toLowerCase();
    if (!(await ghAuthenticated(host, signal))) {
      out.set(target.key, { pr: null, forgeAuth: signal?.aborted ? 'error' : 'unauthenticated' });
      continue;
    }
    const item = { ...target, host };
    item.cacheKey = `${forgeRepositoryKey(item)}@${Number.isSafeInteger(item.pullNumber) ? `#${item.pullNumber}` : item.headRef}:${item.headSha ?? ''}`;
    const cached = prCache.get(item.cacheKey);
    if (cached && Date.now() - cached.at < PR_CACHE_TTL) out.set(item.key, cached.value);
    else {
      const list = freshByHost.get(host) || [];
      list.push(item);
      freshByHost.set(host, list);
    }
  }
  for (const [host, fresh] of freshByHost) {
    for (let i = 0; i < fresh.length; i += 20) {
      const chunk = fresh.slice(i, i + 20);
      const q = (s) => JSON.stringify(String(s));
      const parts = chunk.map((t, idx) => {
        const selector = Number.isSafeInteger(t.pullNumber)
          ? `pullRequest(number:${t.pullNumber}){${PR_GRAPHQL_FIELDS}}`
          : `pullRequests(headRefName:${q(t.headRef)},first:10,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${PR_GRAPHQL_FIELDS}}}`;
        return `t${idx}:repository(owner:${q(t.owner)},name:${q(t.repo)}){${selector}}`;
      });
      const epoch = prEpoch;
      const r = await execGh(['api', '--hostname', host, 'graphql', '-f', `query=query{${parts.join('')}}`], { timeout: 45000, signal });
      if (epoch !== prEpoch) {
        const retried = await prStatusBatch(chunk, options);
        for (const target of chunk) out.set(target.key, retried.get(target.key));
        continue;
      }
      let data = null;
      try {
        data = JSON.parse(r.stdout);
      } catch {
        /* partial below */
      }
      chunk.forEach((t, idx) => {
        const repository = data?.data?.[`t${idx}`];
        const nodes = Array.isArray(repository?.pullRequests?.nodes)
          ? repository.pullRequests.nodes
          : repository && Object.prototype.hasOwnProperty.call(repository, 'pullRequest')
            ? repository.pullRequest ? [repository.pullRequest] : []
            : null;
        const value = Array.isArray(nodes)
          ? pickPr(nodes, t.headSha)
          : prLastGood.get(t.cacheKey) ?? { pr: null, forgeAuth: 'error', error: (r.stderr || '').slice(0, 400) };
        if (Array.isArray(nodes) && epoch === prEpoch) {
          setBounded(prCache, t.cacheKey, { at: Date.now(), value });
          if (value.pr) setBounded(prLastGood, t.cacheKey, value);
        }
        out.set(t.key, value);
      });
    }
  }
  return out;
}

function pickPr(nodes, headSha) {
  if (!nodes || nodes.length === 0) return { pr: null, forgeAuth: 'ok' };
  const exact = headSha ? nodes.find((n) => n.headRefOid === headSha) : null;
  const node = exact ?? nodes[0];
  return { pr: normalizePr(node, headSha), forgeAuth: 'ok' };
}

/** Drop every cached PR projection under one canonical repository/ref prefix. */
export function invalidatePr(prefix) {
  prEpoch += 1;
  for (const cache of [prCache, prLastGood]) {
    for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of [...prInflight.keys()]) if (key.startsWith(prefix)) prInflight.delete(key);
}

/* ------------------------------------------------------------------ */
/* issue / pull-request listing (the picker's data source)              */
/* ------------------------------------------------------------------ */

const LIST_CACHE_TTL = 30000;
const listCache = new Map(); // key → {at, value}
let listEpoch = 0;

/**
 * One page of issues + pull requests for a repository (paseo's
 * searchIssuesAndPrs): both `gh` subcommands in parallel, merged newest-first.
 * The authorized cwd selects a canonical host/owner/repo identity; every gh
 * invocation then carries that exact identity explicitly, so ambient GH_HOST,
 * GH_REPO, linked-worktree layout, and enterprise/public slug collisions cannot
 * retarget a query.
 *
 * `--state` is deliberately NOT passed: gh's default (open) is the only set a
 * picker should offer, and a merged PR cannot be checked out anyway.
 *
 * @param {{cwd:string, query?:string, limit?:number}} opts
 * @returns {Promise<{items:object[], authState:'authenticated'|'cli_missing'|'unauthenticated'|'error'}>}
 */
export async function listForgeItems(opts) {
  const { cwd, query = '', limit = 20, signal } = opts;
  const identity = opts.identity || await forgeIdentityForCwd(cwd);
  if (!identity) return { items: [], authState: 'no_remote' };
  if (!(await ghAvailable(signal))) return { items: [], authState: signal?.aborted ? 'error' : 'cli_missing', repository: identity };
  if (!(await ghAuthenticated(identity.host, signal))) return { items: [], authState: signal?.aborted ? 'error' : 'unauthenticated', repository: identity };
  const repositoryKey = forgeRepositoryKey(identity);
  const key = `${repositoryKey}\u0000${query}\u0000${limit}`;
  const cached = listCache.get(key);
  if (cached && Date.now() - cached.at < LIST_CACHE_TTL) return cached.value;

  const fields = 'number,title,url,state,body,labels,updatedAt';
  const epoch = listEpoch;
  const [pulls, issues] = await Promise.all([
    execGh(
      [
        'pr',
        'list',
        '--repo',
        ghRepo(identity),
        '--search',
        query,
        '--json',
        // `headRepositoryOwner` is not optional decoration: the PR checkout
        // path names a fork's local branch `<owner>/<headRef>` and must know
        // whether the head is cross-repository at all. Without it every fork
        // PR is indistinguishable from a same-repo one and gets checked out
        // under the wrong branch name with a bogus origin upstream.
        `${fields},baseRefName,headRefName,headRepositoryOwner,isCrossRepository`,
        '--limit',
        String(limit),
      ],
      { cwd, signal },
    ),
    execGh(['issue', 'list', '--repo', ghRepo(identity), '--search', query, '--json', fields, '--limit', String(limit)], { cwd, signal }),
  ]);
  if (signal?.aborted) return { items: [], authState: 'error', repository: identity, error: 'aborted' };
  if (epoch !== listEpoch) return listForgeItems(opts);

  // `gh` reports its own transport problems on stderr with a non-zero exit;
  // a JSON array on stdout is the only success shape.
  const parse = (result, kind) => {
    if (!result.ok) return { failed: true };
    try {
      const rows = JSON.parse(result.stdout);
      if (!Array.isArray(rows)) return { failed: true };
      return {
        items: rows.map((row) => normalizeForgeItem(row, kind, identity)),
      };
    } catch {
      return { failed: true };
    }
  };
  const pullResult = parse(pulls, 'change_request');
  const issueResult = parse(issues, 'issue');
  // A repository that disabled its issue tracker answers `gh issue list` with
  // a non-zero exit and "... repository has disabled issues"; the issue side
  // is then legitimately empty, and the pull request side stands alone.
  const issuesDisabled = issueResult.failed && /has disabled issues/i.test(String(issues.stderr || ''));
  const issuesFailed = issueResult.failed && !issuesDisabled;
  if (pullResult.failed && issuesFailed) {
    const stderr = `${pulls.stderr} ${issues.stderr}`.toLowerCase();
    const authState = /auth|login|credential/.test(stderr) ? 'unauthenticated' : 'error';
    const value = { items: [], authState, repository: identity, error: (pulls.stderr || issues.stderr || '').trim().slice(0, 400) };
    setBounded(listCache, key, { at: Date.now(), value });
    return value;
  }

  const items = [...(pullResult.items ?? []), ...(issueResult.items ?? [])];
  // newest first; a missing updatedAt sorts last (equal timestamps keep PRs
  // before issues, paseo's stable order)
  items.sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  });
  const partial = pullResult.failed || issuesFailed;
  const value = {
    items,
    authState: partial ? 'partial' : 'authenticated',
    repository: identity,
    ...(partial ? {
      // Which half failed decides the client's message: an issue-side failure
      // must not be reported as "pull request list unavailable".
      partialSide: pullResult.failed ? 'pulls' : 'issues',
      error: (pullResult.failed ? pulls.stderr : issues.stderr).trim().slice(0, 400) || 'partial forge listing failure',
    } : {}),
  };
  setBounded(listCache, key, { at: Date.now(), value });
  return value;
}

/** Flatten one `gh --json` row into the picker's shape (labels → names). */
function normalizeForgeItem(row, kind, identity) {
  // The explicit --repo selector is authoritative. A returned URL is display
  // data and must never be allowed to retarget a persisted reference.
  const repository = identity;
  const labels = Array.isArray(row.labels)
    ? row.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
    : [];
  return {
    kind,
    host: repository?.host ?? null,
    owner: repository?.owner ?? null,
    repo: repository?.repo ?? null,
    number: row.number,
    title: row.title ?? '',
    url: row.url ?? '',
    state: typeof row.state === 'string' ? row.state.toLowerCase() : '',
    body: typeof row.body === 'string' ? row.body : null,
    labels,
    updatedAt: row.updatedAt ?? null,
    ...(kind === 'change_request'
      ? {
          baseRefName: row.baseRefName ?? null,
          headRefName: row.headRefName ?? null,
          // The fork's branch-owner login: what the checkout names a fork PR's
          // local branch after (`<owner>/<headRef>`), so a list row must carry
          // it exactly like the detail view does.
          headOwnerLogin: row.headRepositoryOwner?.login ?? null,
          // `isCrossRepository` is GitHub's own fork flag — more reliable than
          // comparing owners (an org-owned branch of the same repo is not a
          // fork, and a renamed owner must not flip the decision).
          fork: typeof row.isCrossRepository === 'boolean'
            ? row.isCrossRepository
            : typeof row.headRepositoryOwner?.login === 'string' && identity?.owner
              ? row.headRepositoryOwner.login.toLowerCase() !== String(identity.owner).toLowerCase()
              : null,
        }
      : {}),
  };
}

/** Drop cached list pages for one canonical repository. */
export function invalidateForgeList(identity) {
  listEpoch += 1;
  const repositoryKey = forgeRepositoryKey(identity);
  for (const key of [...listCache.keys()]) {
    if (!repositoryKey || key.startsWith(`${repositoryKey}\u0000`)) listCache.delete(key);
  }
}

/**
 * One issue or pull request in full, straight from `gh` — the reference
 * codec's data source. A pull request is tried first because the two share
 * one number sequence, so a bare number is ambiguous and `gh pr view` reports
 * a non-pull-request number as a plain failure; when both views fail the
 * caller's message carries what `gh` said last.
 *
 * @param {{cwd:string, number:number, kind?:'change_request'|'issue'}} opts
 * @returns {Promise<{ok:true,item:object}|{ok:false,authState:string,message:string}>}
 */
export async function pullRequestDetail(opts) {
  const { cwd, number, kind, signal } = opts;
  const identity = opts.identity || await forgeIdentityForCwd(cwd);
  if (!Number.isSafeInteger(number) || number <= 0) return { ok: false, authState: 'error', message: 'number required' };
  if (!identity) return { ok: false, authState: 'no_remote', message: 'GitHub repository identity unavailable' };
  if (!(await ghAvailable(signal))) return { ok: false, authState: signal?.aborted ? 'error' : 'cli_missing', repository: identity, message: signal?.aborted ? 'aborted' : 'gh CLI not installed' };
  if (!(await ghAuthenticated(identity.host, signal))) return { ok: false, authState: signal?.aborted ? 'error' : 'unauthenticated', repository: identity, message: signal?.aborted ? 'aborted' : 'gh is not authenticated for this host' };

  const fields = 'number,title,url,state,body,labels,updatedAt';
  const bodies = {
    change_request: [
      'pr',
      'view',
      String(number),
      '--repo',
      ghRepo(identity),
      '--json',
      `${fields},baseRefName,headRefName,headRefOid,headRepositoryOwner,isCrossRepository`,
    ],
    issue: ['issue', 'view', String(number), '--repo', ghRepo(identity), '--json', fields],
  };
  const order = kind === 'issue' ? ['issue'] : kind === 'change_request' ? ['change_request'] : ['change_request', 'issue'];
  const found = [];
  let lastError = null;
  const isNotFound = (message) => /Could not resolve to (?:a PullRequest|an Issue)|\bnot found\b|no (?:issue|pull request).*found|no pull requests or issues matched|HTTP 404/i.test(message);
  for (const candidate of order) {
    const r = await execGh(bodies[candidate], { cwd, signal });
    if (signal?.aborted) return { ok: false, authState: 'error', reason: 'aborted', repository: identity, message: 'aborted' };
    if (!r.ok) {
      lastError = r.stderr.trim().slice(0, 400);
      if (!isNotFound(lastError)) {
        return { ok: false, authState: 'error', reason: 'dependency', repository: identity, message: lastError || 'gh detail lookup failed' };
      }
      continue;
    }
    try {
      const row = JSON.parse(r.stdout);
      if (row && typeof row.number === 'number') {
        const item = normalizeForgeItem(row, candidate, identity);
        if (kind) return { ok: true, item, repository: identity };
        found.push(item);
        continue;
      }
      return { ok: false, authState: 'error', reason: 'dependency', repository: identity, message: 'gh returned an unexpected payload' };
    } catch (error) {
      return { ok: false, authState: 'error', reason: 'dependency', repository: identity, message: String((error && error.message) || error).slice(0, 400) };
    }
  }
  if (found.length === 1) return { ok: true, item: found[0], repository: identity };
  if (found.length > 1) {
    return {
      ok: false,
      authState: 'error',
      reason: 'ambiguous',
      repository: identity,
      message: `both an issue and pull request matched #${number}; select an explicit kind`,
    };
  }
  return {
    ok: false,
    authState: 'error',
    reason: 'not_found',
    repository: identity,
    message: lastError || `no issue or pull request #${number}`,
  };
}

/* ------------------------------------------------------------------ */
/* mutations                                                           */
/* ------------------------------------------------------------------ */

/** Create a PR; returns {ok, url} or {ok:false, message}. */
export async function createPullRequest({ host = 'github.com', owner, repo, base, head, title, body, draft = false }) {
  const args = ['pr', 'create', '--repo', ghRepo({ host, owner, repo }), '--base', base, '--head', head, '--title', title, '--body', body ?? ''];
  if (draft) args.push('--draft');
  const r = await execGh(args, { timeout: 60000 });
  if (!r.ok) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 600) };
  const url = r.stdout.trim().split('\n').pop();
  return { ok: true, url };
}

/** Merge a PR: method merge|squash|rebase; auto enables auto-merge. */
export async function mergePullRequest({ host = 'github.com', owner, repo, number, method = 'squash', auto = false }) {
  const flag = method === 'merge' ? '--merge' : method === 'rebase' ? '--rebase' : '--squash';
  const args = ['pr', 'merge', String(number), '--repo', ghRepo({ host, owner, repo }), flag];
  if (auto) args.push('--auto');
  const r = await execGh(args, { timeout: 60000 });
  if (!r.ok) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 600) };
  return { ok: true };
}

export async function disableAutoMerge({ host = 'github.com', owner, repo, number }) {
  const r = await execGh(['pr', 'merge', String(number), '--repo', ghRepo({ host, owner, repo }), '--disable-auto'], {
    timeout: 30000,
  });
  if (!r.ok) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 600) };
  return { ok: true };
}
