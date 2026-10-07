/**
 * api.js — same-origin HTTP surface for the client half, mounted on the
 * harness webServer under `/better-workspaces/api`. JSON everywhere plus one
 * SSE stream (`GET /events`) that re-emits hub snapshots on change.
 *
 * Boundary safety: cwd/path values only select a registry-backed Workspace or
 * verified managed worktree. File paths must remain inside it both lexically
 * and after realpath resolution; Git revisions are typed before execution.
 */
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { lstat, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  isDirfdPinSupported,
  isFileExchangeSupported,
  isWindows,
  procFdPath,
  fileCreateFlags,
  fileOpenFlags,
  verifyStatIdentity,
  verifyStatIdentityFields,
} from './stable.js';
import {
  currentBranchInfo,
  hasRemoteBranch,
  listBranches,
  listCommits,
  listWorktreesRaw,
  originUrl,
  resolveDefaultBranch,
  runGit,
  unpushedShas,
  upstreamInfo,
  withPinnedGitEnvironment,
  withoutPinnedGitEnvironment,
} from './git.js';
import {
  archiveWorktree,
  claimWorktreeCreationSource,
  createWorktree,
  findWorktreeCreation,
  isValidCreationTxId,
  recoverPendingTransactions,
  reconcileWorktreeCreationReceipt,
  releaseWorktreeCreationSource,
  listDeferredWorkspaceDeletions,
  listManagedWorktrees,
  prepareWorkspaceDeletion,
  prepareManagedRoot,
  commitWorktreeCreationReceipt,
  completeWorkspaceDeletion,
  deferredWorkspaceDeletion,
  readMetadata,
  validateWorktreeSelectors,
} from './worktree.js';
import { forgeIdentityForCwd, forgeRepositoryKey, listForgeItems, pullRequestDetail } from './forge.js';
import { commitDiff, computeDiff, resolveDiffRefs } from './diff.js';
import { buildActionLadder, executeAction } from './actions.js';
import { createWorkspaceAuthorizer, isWithinRoot } from './authorize.js';
import { hostMutationCoordinator } from './mutation.js';

export const API_PREFIX = '/better-workspaces/api';

const TEXT_MAX_BYTES = 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const CONTENT_TYPE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function actionFailureStatus(actionName, result) {
  if (Number.isInteger(result?.status) && result.status >= 400 && result.status <= 599) return result.status;
  if (result?.reason === 'inspect-failed') return 500;
  if (['target-unauthorized', 'not-managed'].includes(result?.reason)) return 403;
  if (result?.reasonKey === 'actions.commit.noMessage') return 422;
  const conflict = result?.reasonKey || ['merge-in-progress', 'conflict', 'dirty', 'ahead', 'unpushed', 'unsafe'].includes(result?.reason);
  if (conflict) return 409;
  if (['pull', 'push', 'fetch', 'createPr', 'mergePr', 'enableAutoMerge', 'disableAutoMerge'].includes(actionName)) return 502;
  return 500;
}

function worktreeFailureStatus(result) {
  if (Number.isInteger(result?.status)) return result.status;
  const reason = result?.error || result?.reason;
  if (['dirty', 'ahead', 'unpushed', 'active-session', 'unsafe'].includes(reason)) return 409;
  if (reason === 'not-managed') return 403;
  return 500;
}

function readBody(req, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > TEXT_MAX_BYTES) {
      req.resume();
      rejectPromise(new ApiError(413, 'body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      const error = Object.assign(new Error('request aborted'), { code: 'ABORT_ERR', name: 'AbortError' });
      settle(rejectPromise, error);
      req.destroy();
    };
    const onError = (error) => settle(rejectPromise, error);
    const onData = (chunk) => {
      size += chunk.length;
      if (size > TEXT_MAX_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    };
    const onEnd = () => {
      if (tooLarge) return settle(rejectPromise, new ApiError(413, 'body too large'));
      if (chunks.length === 0) return settle(resolvePromise, {});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'JSON object required');
        settle(resolvePromise, parsed);
      } catch (error) {
        settle(rejectPromise, error instanceof ApiError ? error : new ApiError(400, 'malformed JSON'));
      }
    };
    if (signal?.aborted) return onAbort();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolve `rel` inside `cwd`; null on escape attempts. */
function safeResolve(cwd, rel) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const base = resolve(cwd);
  if (rel === undefined || rel === null || rel === '') return base;
  if (typeof rel !== 'string') return null;
  const target = resolve(base, rel);
  if (!isWithinRoot(base, target)) return null;
  return target;
}

/** First entry of a forwarded header list, normalized; null when absent/empty. */
export function firstForwarded(value) {
  if (typeof value !== 'string') return null;
  const first = value.split(',', 1)[0].trim().toLowerCase();
  return first === '' ? null : first;
}

/**
 * Is the TCP peer a loopback address? Trustworthy local reverse proxies (e.g.
 * cloudflared) connect from there, and browsers cannot forge X-Forwarded-*
 * (forbidden header names), so only this class of peer may vouch for the
 * browser-visible scheme/host. Remote peers stay bound to the socket truth.
 */
export function isLoopbackPeer(socket) {
  const raw = socket?.remoteAddress;
  if (typeof raw !== 'string') return false;
  const address = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  return address === '::1' || address.split('.', 1)[0] === '127';
}

export function sameOrigin(req) {
  const rawOrigin = req.headers.origin;
  const host = req.headers.host;
  if (typeof rawOrigin !== 'string' || typeof host !== 'string') return false;
  let origin;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return false;
  }
  const socketProtocol = req.socket?.encrypted ? 'https' : 'http';
  if (origin.host.toLowerCase() === host.toLowerCase() && origin.protocol === `${socketProtocol}:`) return true;
  // TLS-terminating tunnels/proxies speak plain HTTP to this server, so the
  // socket scheme cannot describe what the browser saw. Only a loopback peer
  // may supply that missing context, and only through an explicit forwarded
  // header (a direct loopback request without one keeps the strict check).
  if (!isLoopbackPeer(req.socket)) return false;
  const forwardedProto = firstForwarded(req.headers['x-forwarded-proto']);
  const forwardedHost = firstForwarded(req.headers['x-forwarded-host']);
  if (forwardedProto === null && forwardedHost === null) return false;
  const effectiveHost = forwardedHost ?? host.toLowerCase();
  const effectiveProtocol = forwardedProto ?? socketProtocol;
  return origin.host.toLowerCase() === effectiveHost && origin.protocol === `${effectiveProtocol}:`;
}

async function existingPathWithin(auth, rel) {
  const resolutionRoot = auth.anchorCwd || auth.cwd;
  const anchoredLexical = safeResolve(resolutionRoot, rel);
  const lexical = safeResolve(auth.cwd, rel);
  if (!anchoredLexical || !lexical) return { ok: false, status: 403, error: 'path escapes workspace' };
  const relFromRoot = relative(resolutionRoot, anchoredLexical);
  if (relFromRoot.split(sep).includes('.git')) {
    return { ok: false, status: 403, error: 'git administrative paths are not editable' };
  }
  try {
    const [file, anchoredRoot] = await Promise.all([realpath(anchoredLexical), realpath(resolutionRoot)]);
    if (!isWithinRoot(anchoredRoot, file)) return { ok: false, status: 403, error: 'path escapes workspace' };
    if (relative(anchoredRoot, file).split(sep).includes('.git')) {
      return { ok: false, status: 403, error: 'git administrative paths are not accessible' };
    }
    return { ok: true, file, lexical };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, status: 404, error: 'missing' };
    return { ok: false, status: 403, error: 'path unavailable' };
  }
}

async function verifyOpenIdentity(handle, auth, lexical) {
  try {
    const rebound = await realpath(lexical);
    if (!isWithinRoot(auth.root, rebound)) return false;
    const [openedStat, reboundStat] = await Promise.all([handle.stat(), stat(rebound)]);
    return openedStat.dev === reboundStat.dev && openedStat.ino === reboundStat.ino;
  } catch {
    return false;
  }
}

async function readCapped(handle, maxBytes) {
  const chunks = [];
  let offset = 0;
  while (offset <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - offset));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) return Buffer.concat(chunks, offset);
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return null;
}

async function openRegularFile(auth, located) {
  const handle = await open(located.file, fileOpenFlags());
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || !(await verifyOpenIdentity(handle, auth, located.lexical))) {
      await handle.close();
      return null;
    }
    return { handle, stat: fileStat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Path-mode parent verification: canonical vs re-resolved parent identity. */
async function verifyParentIdentity(auth, canonicalParent, lexicalParent) {
  try {
    const rebound = await realpath(lexicalParent);
    if (!isWithinRoot(auth.root, rebound)) return false;
    const [canonicalInfo, reboundInfo] = await Promise.all([stat(canonicalParent), stat(rebound)]);
    return canonicalInfo.dev === reboundInfo.dev && canonicalInfo.ino === reboundInfo.ino;
  } catch {
    return false;
  }
}

/**
 * Verified read anchor for one authorized workspace root. dirfd mode holds
 * the verified directory open and anchors reads through /proc; path mode
 * (paseo model) proves the stat identity and anchors at the canonical path.
 * @returns {Promise<{anchorCwd:string, release:()=>Promise<void>}>}
 */
async function openRootAnchor(auth) {
  if (isDirfdPinSupported()) {
    const handle = await open(auth.cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const rootIdentity = await handle.stat();
      if (rootIdentity.dev !== auth.identity?.dev || rootIdentity.ino !== auth.identity?.ino) {
        throw new Error('workspace identity changed');
      }
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    return { anchorCwd: `/proc/self/fd/${handle.fd}`, release: () => handle.close().catch(() => {}) };
  }
  if (!(await verifyStatIdentity(auth.cwd, auth.identity))) throw new Error('workspace identity changed');
  return { anchorCwd: auth.cwd, release: () => Promise.resolve() };
}

async function openAnchoredParent(auth, located) {
  // Writes stay attached to the verified directory for their whole lifetime.
  // On Linux every temp/open/rename goes through the /proc/self/fd dirfd
  // bridge (below); elsewhere the canonical parent path is the anchor and
  // stat identity is re-proven at the boundaries (paseo model, ADR 0013).
  if (located.file !== located.lexical) throw new ApiError(403, 'saving through symlinks is not allowed');
  const canonicalParent = dirname(located.file);
  const lexicalParent = dirname(located.lexical);
  if (!isDirfdPinSupported()) {
    if (!(await verifyParentIdentity(auth, canonicalParent, lexicalParent))) {
      throw new ApiError(409, 'file path changed during save');
    }
    return { handle: null, anchor: canonicalParent, lexicalParent };
  }
  const handle = await open(canonicalParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!(await verifyOpenIdentity(handle, auth, lexicalParent))) throw new ApiError(409, 'file path changed during save');
    const anchor = `/proc/self/fd/${handle.fd}`;
    if ((await realpath(anchor)) !== canonicalParent) throw new ApiError(409, 'file path changed during save');
    return { handle, anchor, lexicalParent };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readAnchoredRegular(anchor, name) {
  const handle = await open(anchor === null || anchor === undefined ? name : `${anchor}/${name}`, fileOpenFlags());
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) return null;
    return { buffer: fileStat.size <= TEXT_MAX_BYTES ? await readCapped(handle, TEXT_MAX_BYTES) : null, stat: fileStat };
  } finally {
    await handle.close().catch(() => {});
  }
}

function createKeyedMutex() {
  const tails = new Map();
  return async (key) => {
    const previous = tails.get(key) || Promise.resolve();
    let releaseGate;
    const gate = new Promise((resolveGate) => { releaseGate = resolveGate; });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (tails.get(key) === tail) tails.delete(key);
    };
  };
}

const hostFileMutationMutex = createKeyedMutex();

async function removeMatchingIdentity(path, identity) {
  if (!path || !identity) return false;
  try {
    const current = await lstat(path);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return false;
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function exchangeAnchored(parentHandle, sourceName, targetName) {
  return new Promise((resolveExchange, rejectExchange) => {
    // GNU mv --exchange maps to renameat2(RENAME_EXCHANGE); --no-copy makes a
    // missing kernel primitive fail closed. Child fd 3 inherits the verified
    // parent directory, so neither operand is reopened through an ambient path.
    const child = spawn(
      '/usr/bin/mv',
      [
        '--exchange',
        '--no-copy',
        '-T',
        '--',
        `/proc/self/fd/3/${sourceName}`,
        `/proc/self/fd/3/${targetName}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', parentHandle.fd], windowsHide: true },
    );
    const chunks = [];
    let size = 0;
    child.stderr.on('data', (chunk) => {
      if (size >= 64 * 1024) return;
      const kept = chunk.subarray(0, 64 * 1024 - size);
      chunks.push(kept);
      size += kept.length;
    });
    child.once('error', (error) => rejectExchange(new ApiError(503, `atomic file exchange unavailable: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) resolveExchange();
      else {
        const stderr = Buffer.concat(chunks).toString('utf8').trim();
        rejectExchange(new ApiError(503, `atomic file exchange unavailable: ${stderr || signal || `exit ${code}`}`.slice(0, 300)));
      }
    });
  });
}

/**
 * Build the webServer route + SSE broadcaster bound to one hub.
 * @returns {{route:object, broadcast:(snapshot:object)=>void, dispose:()=>void}}
 */
export function createApi(hub, options = {}) {
  const cleanup = typeof options.cleanup === 'function' ? options.cleanup : null;
  const resolvePull = typeof options.resolvePull === 'function' ? options.resolvePull : pullRequestDetail;
  const resolveForgeIdentity = typeof options.resolveForgeIdentity === 'function' ? options.resolveForgeIdentity : forgeIdentityForCwd;
  const beforeFileExchange = typeof options.beforeFileExchange === 'function' ? options.beforeFileExchange : null;
  const worktreeWorkspaces =
    typeof options.worktreeWorkspaces === 'function' ? options.worktreeWorkspaces : null;
  const workspaceRows = typeof options.workspaceRows === 'function' ? options.workspaceRows : worktreeWorkspaces;
  const createWorkspace = typeof options.createWorkspace === 'function' ? options.createWorkspace : null;
  const assertCreationSource = typeof options.assertCreationSource === 'function'
    ? options.assertCreationSource : null;
  const assertWorkspaceArchivable = typeof options.assertWorkspaceArchivable === 'function'
    ? options.assertWorkspaceArchivable : null;
  const deleteWorkspace = typeof options.deleteWorkspace === 'function' ? options.deleteWorkspace : null;
  const assertArchiveAllowed = async (workspaceId, path) => {
    if (!assertWorkspaceArchivable) return;
    try {
      await assertWorkspaceArchivable(workspaceId, path);
    } catch (error) {
      throw new ApiError(409, String(error?.message ?? error));
    }
  };
  const workspaceForPath = async (path) => {
    if (!workspaceRows) return null;
    const rows = await workspaceRows();
    const matches = Array.isArray(rows) ? rows.filter((workspace) => workspace?.path === path) : [];
    if (matches.length > 1) throw new ApiError(409, 'workspace registry contains ambiguous path ownership');
    const hit = matches[0] || null;
    if (!hit) return null;
    return {
      workspaceId: hit.workspaceId ?? hit.id ?? null,
      path: hit.path,
      sessionIds: Array.isArray(hit.sessionIds) ? hit.sessionIds.map(String) : [],
    };
  };
  const ensureCreatedWorkspace = async (created, sourceTitle, creation = null) => {
    if (!created?.path || !createWorkspace) return created;
    if (typeof created.workspaceId === 'string') {
      const rows = workspaceRows ? await workspaceRows() : [];
      const exact = Array.isArray(rows)
        ? rows.find((row) => (row?.workspaceId ?? row?.id) === created.workspaceId)
        : null;
      if (exact?.path === created.path) return created;
      const replacements = Array.isArray(rows) ? rows.filter((row) => row?.path === created.path) : [];
      if (exact || replacements.length > 1 || !creation?.txId) {
        throw new Error('worktree: creation receipt Workspace ownership changed');
      }
      if (replacements.length === 1) {
        const adoptedId = replacements[0].workspaceId ?? replacements[0].id;
        if (typeof adoptedId !== 'string' || adoptedId === '') {
          throw new Error('worktree: replacement Workspace identity is invalid');
        }
        const adopted = { ...created, workspaceId: adoptedId };
        await reconcileWorktreeCreationReceipt(
          creation.mainRepoRoot,
          creation.txId,
          creation.fingerprint,
          adopted,
        );
        return adopted;
      }
      const title = `${sourceTitle ? `${sourceTitle} · ` : ''}${created.branch || basename(created.path)}`;
      const workspace = await createWorkspace(created.path, title);
      const workspaceId = workspace?.workspaceId ?? workspace?.id;
      if (typeof workspaceId !== 'string' || workspace?.path !== created.path) {
        throw new Error('workspace registry returned an invalid reconciliation result');
      }
      const reconciled = { ...created, workspaceId };
      await reconcileWorktreeCreationReceipt(
        creation.mainRepoRoot,
        creation.txId,
        creation.fingerprint,
        reconciled,
      );
      return reconciled;
    }
    const title = `${sourceTitle ? `${sourceTitle} · ` : ''}${created.branch || basename(created.path)}`;
    const workspace = await createWorkspace(created.path, title);
    const workspaceId = workspace?.workspaceId ?? workspace?.id;
    if (typeof workspaceId !== 'string' || workspace?.path !== created.path) {
      throw new Error('workspace registry returned an invalid create result');
    }
    const result = { ...created, workspaceId };
    if (creation?.txId) {
      await commitWorktreeCreationReceipt(creation.mainRepoRoot, creation.txId, creation.fingerprint, result);
    }
    return result;
  };
  const convergeArchivedWorkspace = async (result, workspaceId, journalFile, capturedSessionIds) => {
    if (!result?.ok || !deleteWorkspace || workspaceId === null) return result;
    try {
      const deleted = await deleteWorkspace(workspaceId, result.path, capturedSessionIds);
      if (journalFile) await completeWorkspaceDeletion(journalFile);
      return { ...result, ...(deleted ? { workspaceDeleted: workspaceId } : { workspaceAlreadyAbsent: workspaceId }) };
    } catch (error) {
      return {
        ...result,
        warnings: [
          ...(Array.isArray(result.warnings) ? result.warnings : []),
          { stage: 'workspace-delete', message: String(error?.message ?? error) },
        ],
      };
    }
  };
  const authorizer = createWorkspaceAuthorizer({ workspaceRoots: options.workspaceRoots });
  const mutations = options.mutations || hostMutationCoordinator;
  const lockFileMutation = options.fileMutationMutex || hostFileMutationMutex;
  const authorize = async (res, selector) => {
    const result = await authorizer.authorize(selector);
    if (!result.ok) sendJson(res, result.status || 403, { ok: false, error: result.error });
    return result.ok ? result : null;
  };
  const mutationKeyFor = (auth) => {
    // A registered subdirectory has file authority only, but its writes still
    // share the containing repository's mutation schedule.
    if (typeof auth.mainRepoRoot === 'string' && auth.mainRepoRoot !== '') {
      return `git:${auth.mainRepoRoot}`;
    }
    return `workspace:${auth.root}`;
  };
  const sameAuthorization = (before, after) => after?.ok
    && before.cwd === after.cwd
    && before.root === after.root
    && before.gitBoundary === after.gitBoundary
    && before.mainRepoRoot === after.mainRepoRoot
    && before.gitDir === after.gitDir
    && before.gitCommonDir === after.gitCommonDir
    && before.gitDirIdentity?.dev === after.gitDirIdentity?.dev
    && before.gitDirIdentity?.ino === after.gitDirIdentity?.ino
    && before.gitCommonIdentity?.dev === after.gitCommonIdentity?.dev
    && before.gitCommonIdentity?.ino === after.gitCommonIdentity?.ino
    && before.identity?.dev === after.identity?.dev
    && before.identity?.ino === after.identity?.ino
    && before.mainIdentity?.dev === after.mainIdentity?.dev
    && before.mainIdentity?.ino === after.mainIdentity?.ino;
  const assertAuthorizationCurrent = async (before) => {
    const after = await authorizer.authorize(before.cwd);
    if (!sameAuthorization(before, after)) throw new ApiError(409, 'workspace identity changed while waiting for mutation');
    return after;
  };
  const withStableRoot = async (auth, task, { pinGit = false } = {}) => {
    if (!isDirfdPinSupported()) {
      // Path mode (paseo model): the canonical cwd is the anchor; stat
      // identity is proven before the task and re-authorized after it, Git
      // discovers from the working tree (ADR 0013).
      if (!(await verifyStatIdentity(auth.cwd, auth.identity))) {
        throw new ApiError(409, 'workspace identity changed at operation commit point');
      }
      if (auth.mainRepoRoot && auth.mainRepoRoot !== auth.cwd
        && !(await verifyStatIdentity(auth.mainRepoRoot, auth.mainIdentity))) {
        throw new ApiError(409, 'repository family identity changed at operation commit point');
      }
      if (pinGit && auth.gitBoundary === 'root') {
        if (!(await verifyStatIdentityFields(auth.gitDir, auth.gitDirIdentity?.dev, auth.gitDirIdentity?.ino))) {
          throw new ApiError(409, 'Git directory identity changed at operation commit point');
        }
        if (auth.gitCommonDir !== auth.gitDir
          && !(await verifyStatIdentityFields(auth.gitCommonDir, auth.gitCommonIdentity?.dev, auth.gitCommonIdentity?.ino))) {
          throw new ApiError(409, 'Git common directory identity changed at operation commit point');
        }
      }
      const pathResult = pinGit ? await withPinnedGitEnvironment(null, () => task(auth.cwd)) : await task(auth.cwd);
      if (pinGit) await assertAuthorizationCurrent(auth);
      return pathResult;
    }
    const handle = await open(auth.cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let mainHandle = null;
    let gitHandle = null;
    let commonHandle = null;
    try {
      const identity = await handle.stat();
      if (identity.dev !== auth.identity?.dev || identity.ino !== auth.identity?.ino) {
        throw new ApiError(409, 'workspace identity changed at operation commit point');
      }
      if (auth.mainRepoRoot && auth.mainRepoRoot !== auth.cwd) {
        mainHandle = await open(auth.mainRepoRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const mainIdentity = await mainHandle.stat();
        if (mainIdentity.dev !== auth.mainIdentity?.dev || mainIdentity.ino !== auth.mainIdentity?.ino) {
          throw new ApiError(409, 'repository family identity changed at operation commit point');
        }
      }
      const stableCwd = procFdPath(handle);
      let pinned = null;
      if (pinGit && auth.gitBoundary === 'root') {
        const anchoredPath = (targetPath) => {
          const inTarget = relative(auth.cwd, targetPath);
          if (inTarget === '' || (inTarget !== '..' && !inTarget.startsWith(`..${sep}`) && resolve(inTarget) !== inTarget)) {
            return inTarget === '' ? stableCwd : `${stableCwd}/${inTarget}`;
          }
          if (mainHandle) {
            const inMain = relative(auth.mainRepoRoot, targetPath);
            if (inMain === '' || (inMain !== '..' && !inMain.startsWith(`..${sep}`) && resolve(inMain) !== inMain)) {
              return inMain === '' ? procFdPath(mainHandle) : `${procFdPath(mainHandle)}/${inMain}`;
            }
          }
          return targetPath;
        };
        const openGitDirectory = async (path, expected, label) => {
          if (typeof path !== 'string' || path === '') throw new ApiError(409, `${label} is unavailable`);
          const opened = await open(anchoredPath(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const identity = await opened.stat();
          if (identity.dev !== expected?.dev || identity.ino !== expected?.ino) {
            await opened.close().catch(() => {});
            throw new ApiError(409, `${label} identity changed at operation commit point`);
          }
          return opened;
        };
        gitHandle = await openGitDirectory(auth.gitDir, auth.gitDirIdentity, 'Git directory');
        commonHandle = auth.gitCommonDir === auth.gitDir
          ? gitHandle
          : await openGitDirectory(auth.gitCommonDir, auth.gitCommonIdentity, 'Git common directory');
        pinned = {
          GIT_DIR: procFdPath(gitHandle),
          GIT_COMMON_DIR: procFdPath(commonHandle),
          GIT_WORK_TREE: procFdPath(handle),
        };
      }
      const result = pinGit
        ? await withPinnedGitEnvironment(pinned, () => task(stableCwd))
        : await task(stableCwd);
      if (pinGit) await assertAuthorizationCurrent(auth);
      return result;
    } finally {
      if (commonHandle && commonHandle !== gitHandle) await commonHandle.close().catch(() => {});
      await gitHandle?.close().catch(() => {});
      await mainHandle?.close().catch(() => {});
      await handle.close().catch(() => {});
    }
  };
  const authorizeGit = async (res, selector, { allowNonGit = false } = {}) => {
    const result = await authorize(res, selector);
    if (!result) return null;
    if (result.gitBoundary === 'nested') {
      sendJson(res, 403, { ok: false, error: 'git repository root not authorized' });
      return null;
    }
    if (result.gitBoundary === 'none' && !allowNonGit) {
      sendJson(res, 422, { ok: false, error: 'git repository required' });
      return null;
    }
    return result;
  };
  const sseClients = new Set();
  const MAX_SSE_CLIENTS = 32;
  const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
  const writeSse = (res, chunk) => {
    try {
      if (res.destroyed || res.writableEnded || (res.writableLength || 0) > MAX_SSE_BUFFER_BYTES) {
        sseClients.delete(res);
        res.destroy?.();
        return false;
      }
      res.write(chunk);
      if ((res.writableLength || 0) > MAX_SSE_BUFFER_BYTES) {
        sseClients.delete(res);
        res.destroy?.();
        return false;
      }
      return true;
    } catch {
      sseClients.delete(res);
      res.destroy?.();
      return false;
    }
  };
  const heartbeat = setInterval(() => {
    for (const res of sseClients) writeSse(res, ':hb\n\n');
  }, 25000);

  const lifecycle = new AbortController();
  const inflightRequests = new Set();
  let disposed = false;

  const broadcast = (snapshot) => {
    if (disposed || sseClients.size === 0) return;
    let data;
    try {
      data = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    } catch {
      return;
    }
    for (const res of sseClients) writeSse(res, data);
  };

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://dsh.local');
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' });
      return;
    }
    if (disposed) return sendJson(res, 503, { ok: false, error: 'API is stopping' });
    const sub = url.pathname.slice(API_PREFIX.length) || '/';
    const query = url.searchParams;
    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (contentType.split(';', 1)[0].trim() !== 'application/json') {
        return sendJson(res, 415, { ok: false, error: 'application/json required' });
      }
      if (!sameOrigin(req) || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        return sendJson(res, 403, { ok: false, error: 'same-origin request required' });
      }
    }
    let finishRequest;
    const requestCompletion = new Promise((resolve) => { finishRequest = resolve; });
    inflightRequests.add(requestCompletion);
    options.onRequestStart?.(sub);
    const requestAbort = new AbortController();
    const abortQueuedMutation = () => requestAbort.abort();
    const abortOnPrematureClose = () => {
      if (!res.writableEnded) requestAbort.abort();
    };
    req.once('aborted', abortQueuedMutation);
    res.once('close', abortOnPrematureClose);
    lifecycle.signal.addEventListener('abort', abortQueuedMutation, { once: true });
    if (lifecycle.signal.aborted) requestAbort.abort();
    try {
      /* ---------------- discovery ---------------- */
      if (req.method === 'GET' && sub === '/detect') {
        const path = query.get('path');
        if (!path) return sendJson(res, 400, { ok: false, error: 'path required' });
        const auth = await authorizeGit(res, path, { allowNonGit: true });
        if (!auth) return;
        const payload = await withStableRoot(auth, async (stableCwd) => {
          if (auth.gitBoundary === 'none') return { ok: true, isGit: false };
          const [defaultBranch, branchInfo, metadata] = await Promise.all([
            resolveDefaultBranch(stableCwd),
            currentBranchInfo(stableCwd),
            readMetadata(stableCwd).catch(() => null),
          ]);
          return {
            ok: true,
            isGit: true,
            repoRoot: auth.cwd,
            mainRepoRoot: auth.mainRepoRoot,
            isLinkedWorktree: auth.mainRepoRoot !== auth.cwd,
            managed: auth.kind === 'managed-worktree',
            defaultBranch,
            branch: branchInfo.branch,
            ...(metadata && metadata.sourceWorkspaceTitle
              ? { sourceWorkspaceTitle: metadata.sourceWorkspaceTitle }
              : {}),
          };
        }, { pinGit: true });
        return sendJson(res, 200, payload);
      }

      if (req.method === 'GET' && sub === '/branches') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        const payload = await withStableRoot(auth, async (stableCwd) => {
          if (auth.gitBoundary === 'none') return { ok: true, isGit: false, branches: [] };
          const [branches, defaultBranch, branchInfo] = await Promise.all([
            listBranches(stableCwd),
            resolveDefaultBranch(stableCwd),
            currentBranchInfo(stableCwd),
          ]);
          return {
            ok: true,
            isGit: true,
            defaultBranch,
            current: branchInfo.branch,
            branches: branches.map((b) => ({ ...b, current: b.name === branchInfo.branch })),
          };
        }, { pinGit: true });
        return sendJson(res, 200, payload);
      }

      /* ---------------- forge (issue / pull request picker) ---------------- */
      if (req.method === 'GET' && sub === '/pulls') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        const limit = Math.min(Math.max(Number(query.get('limit')) || 20, 1), 50);
        const payload = await withStableRoot(auth, async (stableCwd) => {
          if (auth.gitBoundary === 'none') return { ok: true, isGit: false, items: [], authState: 'no_remote' };
          const identity = await resolveForgeIdentity(stableCwd);
          if (!identity) return { ok: true, isGit: true, items: [], authState: 'no_remote' };
          const result = await listForgeItems({ cwd: stableCwd, identity, query: '', limit, signal: requestAbort.signal });
          return { ok: true, isGit: true, ...result };
        }, { pinGit: true });
        return sendJson(res, 200, payload);
      }

      if (req.method === 'GET' && sub === '/pull') {
        const cwd = query.get('cwd');
        const number = Number(query.get('number'));
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        if (!Number.isSafeInteger(number) || number <= 0) {
          return sendJson(res, 400, { ok: false, error: 'number required' });
        }
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        if (auth.gitBoundary === 'none') return sendJson(res, 422, { ok: false, authState: 'no_remote', message: 'not a git repository' });
        const kindParam = query.get('kind');
        if (kindParam !== null && !['issue', 'change_request'].includes(kindParam)) {
          return sendJson(res, 400, { ok: false, error: 'invalid forge kind' });
        }
        const kind = kindParam || undefined;
        const selectorParts = [query.get('host'), query.get('owner'), query.get('repo')];
        if (selectorParts.some(Boolean) && !selectorParts.every(Boolean)) {
          return sendJson(res, 400, { ok: false, error: 'incomplete repository identity' });
        }
        const response = await withStableRoot(auth, async (stableCwd) => {
          const actualIdentity = await resolveForgeIdentity(stableCwd);
          if (!actualIdentity) return { status: 422, payload: { ok: false, authState: 'no_remote', message: 'GitHub repository identity unavailable' } };
          if (selectorParts.every(Boolean)) {
            const requestedIdentity = { host: selectorParts[0], owner: selectorParts[1], repo: selectorParts[2] };
            if (forgeRepositoryKey(requestedIdentity) !== forgeRepositoryKey(actualIdentity)) {
              return { status: 409, payload: { ok: false, error: 'repository identity changed' } };
            }
          }
          const result = await pullRequestDetail({ cwd: stableCwd, identity: actualIdentity, number, kind, signal: requestAbort.signal });
          if (!result.ok) {
            const status = result.reason === 'not_found'
              ? 404
              : ['cli_missing', 'unauthenticated'].includes(result.authState)
                ? 503
                : 502;
            return { status, payload: { ok: false, authState: result.authState, reason: result.reason, message: result.message } };
          }
          return { status: 200, payload: { ok: true, item: result.item } };
        }, { pinGit: true });
        return sendJson(res, response.status, response.payload);
      }

      if (req.method === 'GET' && sub === '/worktrees') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        if (auth.gitBoundary === 'none') return sendJson(res, 200, { ok: true, isGit: false, items: [] });
        const raw = await withStableRoot(auth, (stableCwd) => listWorktreesRaw(stableCwd), { pinGit: true });
        const result = await listManagedWorktrees(auth.cwd, auth.cwd, { mainRepoRoot: auth.mainRepoRoot, raw });
        const items = [];
        for (const item of result.items) {
          const itemAuth = await authorizer.authorize(item.path);
          if (itemAuth.ok && itemAuth.gitBoundary === 'root') items.push({ ...item, path: itemAuth.cwd });
        }
        const mainAuth = await authorizer.authorize(result.mainRepoRoot);
        await assertAuthorizationCurrent(auth);
        return sendJson(res, 200, {
          ok: true,
          mainRepoRoot: mainAuth.ok && mainAuth.gitBoundary === 'root' ? mainAuth.cwd : null,
          root: mainAuth.ok && mainAuth.gitBoundary === 'root' ? result.root : null,
          items,
        });
      }

      /* ---------------- worktree lifecycle ---------------- */
      if (req.method === 'POST' && sub === '/worktrees') {
        const body = await readBody(req, requestAbort.signal);
        if (typeof body.cwd !== 'string' || body.cwd === '') {
          return sendJson(res, 400, { ok: false, error: 'cwd required', message: 'cwd required' });
        }
        const auth = await authorizeGit(res, body.cwd);
        if (!auth) return;
        if ((body.base !== undefined && typeof body.base !== 'string')
          || (body.branchName !== undefined && typeof body.branchName !== 'string')
          || (body.slug !== undefined && typeof body.slug !== 'string')
          || (body.sourceTitle !== undefined && typeof body.sourceTitle !== 'string')
          || (body.txId !== undefined && !isValidCreationTxId(body.txId))
          || (body.sourceSessionId !== undefined && (typeof body.sourceSessionId !== 'string'
            || !/^[A-Za-z0-9_-]{8,120}$/.test(body.sourceSessionId)))
          || ((body.txId === undefined) !== (body.sourceSessionId === undefined))
          || (body.intent !== undefined && !['checkout', 'branch-off'].includes(body.intent))) {
          return sendJson(res, 400, { ok: false, error: 'invalid worktree request' });
        }
        if (body.pull !== undefined && (!body.pull || !Number.isSafeInteger(body.pull.number)
          || body.pull.number <= 0 || typeof body.pull.host !== 'string' || body.pull.host === ''
          || typeof body.pull.owner !== 'string' || body.pull.owner === ''
          || typeof body.pull.repo !== 'string' || body.pull.repo === ''
          || typeof body.pull.headRef !== 'string' || body.pull.headRef === ''
          || (body.pull.baseRef !== undefined && body.pull.baseRef !== null && typeof body.pull.baseRef !== 'string')
          || (body.pull.forkOwner !== undefined && body.pull.forkOwner !== null && typeof body.pull.forkOwner !== 'string'))) {
          return sendJson(res, 400, { ok: false, error: 'invalid pull request selector' });
        }
        let pull = body.pull
          ? {
              host: body.pull.host,
              owner: body.pull.owner,
              repo: body.pull.repo,
              number: body.pull.number,
              headRef: body.pull.headRef,
              baseRef: typeof body.pull.baseRef === 'string' && body.pull.baseRef !== '' ? body.pull.baseRef : null,
              forkOwner: typeof body.pull.forkOwner === 'string' && body.pull.forkOwner !== '' ? body.pull.forkOwner : null,
            }
          : null;
        const intent = pull ? 'pr-checkout' : body.intent === 'branch-off' ? 'branch-off' : 'checkout';
        const creationTxId = typeof body.txId === 'string' ? body.txId : null;
        const creationFingerprint = creationTxId
          ? createHash('sha256').update(JSON.stringify({
              cwd: auth.cwd,
              base: body.base ?? null,
              branchName: body.branchName ?? null,
              slug: body.slug ?? null,
              sourceTitle: body.sourceTitle ?? null,
              sourceSessionId: body.sourceSessionId ?? null,
              intent,
              pull,
            })).digest('hex')
          : null;
        try {
          validateWorktreeSelectors({ base: body.base, branchName: body.branchName, intent, pull });
        } catch (error) {
          return sendJson(res, 422, {
            ok: false,
            error: error.message,
            ...(creationTxId ? { txId: creationTxId, txState: 'absent' } : {}),
          });
        }
        if (creationTxId && assertCreationSource) {
          try {
            await assertCreationSource(body.sourceSessionId, auth.cwd);
          } catch (error) {
            return sendJson(res, 409, {
              ok: false,
              error: 'creation_source_changed',
              message: String(error?.message ?? error),
              txId: creationTxId,
              txState: 'absent',
            });
          }
        }
        if (creationTxId) {
          const replay = await mutations.run(`git:${auth.mainRepoRoot}`, async () => {
            const current = await assertAuthorizationCurrent(auth);
            return withStableRoot(current, async () => {
              // Adopt a managed root that predates the owner record before
              // resolving the transaction: the resolver verifies ownership
              // without creating, so a legacy root would otherwise be reported
              // as replaced and every txId-carrying creation would 409 forever.
              await prepareManagedRoot(current.mainRepoRoot);
              await recoverPendingTransactions(current.mainRepoRoot);
              const found = await findWorktreeCreation(current.mainRepoRoot, creationTxId, creationFingerprint);
              if (found.status === 'committed') {
                found.result = await ensureCreatedWorkspace(found.result, body.sourceTitle, {
                  mainRepoRoot: current.mainRepoRoot,
                  txId: creationTxId,
                  fingerprint: creationFingerprint,
                });
              } else if (found.status === 'retired' && body.sourceSessionId) {
                await releaseWorktreeCreationSource(
                  current.mainRepoRoot,
                  body.sourceSessionId,
                  creationTxId,
                  creationFingerprint,
                );
              }
              return found;
            });
          }, { signal: requestAbort.signal });
          if (replay.status === 'committed') {
            return sendJson(res, 200, { ok: true, replayed: true, txId: creationTxId, ...replay.result });
          }
          if (replay.status === 'retired') {
            return sendJson(res, 410, {
              ok: false,
              error: 'transaction_retired',
              txState: 'retired',
              txId: creationTxId,
              ...replay.result,
            });
          }
          if (replay.status !== 'absent') {
            return sendJson(res, 409, {
              ok: false,
              error: replay.status === 'pending' ? 'transaction_pending' : 'transaction_conflict',
              txId: creationTxId,
              ...(replay.path ? { path: replay.path } : {}),
              ...(replay.reason ? { reason: replay.reason } : {}),
            });
          }
        }
        if (pull) {
          const actualIdentity = await resolveForgeIdentity(auth.cwd);
          if (!actualIdentity || forgeRepositoryKey(actualIdentity) !== forgeRepositoryKey(pull)) {
            return sendJson(res, 409, {
              ok: false,
              error: 'repository identity changed',
              ...(creationTxId ? { txId: creationTxId, txState: 'absent' } : {}),
            });
          }
          const detail = await resolvePull({ cwd: auth.cwd, identity: actualIdentity, number: pull.number, kind: 'change_request', signal: requestAbort.signal });
          if (!detail?.ok) {
            const status = detail?.reason === 'not_found'
              ? 404
              : ['cli_missing', 'unauthenticated'].includes(detail?.authState)
                ? 503
                : 502;
            return sendJson(res, status, {
              ok: false,
              error: 'pull request verification failed',
              message: detail?.message,
              ...(creationTxId ? { txId: creationTxId, txState: 'absent' } : {}),
            });
          }
          const item = detail.item;
          if (item?.kind !== 'change_request' || item.number !== pull.number
            || typeof item.headRefName !== 'string' || item.headRefName === ''
            || typeof item.fork !== 'boolean'
            || typeof item.headRefOid !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(item.headRefOid)
            || typeof item.host !== 'string' || typeof item.owner !== 'string' || typeof item.repo !== 'string'
            || (item.fork && (typeof item.headOwnerLogin !== 'string' || item.headOwnerLogin === ''))) {
            return sendJson(res, 502, {
              ok: false,
              error: 'forge returned invalid pull request identity',
              ...(creationTxId ? { txId: creationTxId, txState: 'absent' } : {}),
            });
          }
          pull = {
            number: item.number,
            headRef: item.headRefName,
            baseRef: typeof item.baseRefName === 'string' && item.baseRefName !== '' ? item.baseRefName : null,
            forkOwner: item.fork ? item.headOwnerLogin : null,
            headSha: item.headRefOid,
            host: item.host,
            owner: item.owner,
            repo: item.repo,
          };
          try {
            validateWorktreeSelectors({ intent: 'pr-checkout', pull, requireVerifiedPull: true });
          } catch {
            return sendJson(res, 502, {
              ok: false,
              error: 'forge returned unsafe pull request identity',
              ...(creationTxId ? { txId: creationTxId, txState: 'absent' } : {}),
            });
          }
        }
        const verifiedPull = pull;
        const mainRoot = auth.mainRepoRoot;
        try {
          const created = await mutations.run(`git:${mainRoot}`, async () => {
            const current = await assertAuthorizationCurrent(auth);
            return withStableRoot(current, async (stableRoot) => {
              if (creationTxId && body.sourceSessionId) {
                await claimWorktreeCreationSource(
                  current.mainRepoRoot,
                  body.sourceSessionId,
                  creationTxId,
                  creationFingerprint,
                );
              }
              // Give origin refs one bounded freshness attempt while holding
              // both the family gate and the authorized root dirfd.
              try {
                if (await originUrl(stableRoot)) {
                  await runGit(['fetch', 'origin', '--prune'], { cwd: stableRoot, timeout: 4000 });
                }
              } catch {
                /* fetch is best-effort; creation proceeds regardless */
              }
              const createdWorktree = await createWorktree({
                repoRoot: stableRoot,
                base: body.base || undefined,
                intent,
                branchName: body.branchName || undefined,
                slug: body.slug || undefined,
                sourceTitle: typeof body.sourceTitle === 'string' ? body.sourceTitle : undefined,
                pull: verifiedPull,
                creationTxId,
                creationFingerprint,
              });
              return ensureCreatedWorkspace(createdWorktree, body.sourceTitle, creationTxId ? {
                mainRepoRoot: current.mainRepoRoot,
                txId: creationTxId,
                fingerprint: creationFingerprint,
              } : null);
            }, { pinGit: true });
          }, { signal: requestAbort.signal });
          try {
            await assertAuthorizationCurrent(auth);
            await hub.invalidate(auth.cwd);
          } catch {
            /* a rebound selector must not refresh the replacement workspace */
          }
          return sendJson(res, created.replayed ? 200 : 201, {
            ok: true,
            ...(creationTxId ? { txId: creationTxId } : {}),
            ...created,
          });
        } catch (error) {
          if (creationTxId && body.sourceSessionId
            && !['WORKTREE_TX_PENDING', 'WORKTREE_SOURCE_CONFLICT'].includes(error?.code)) {
            try {
              const state = await mutations.run(`git:${mainRoot}`, async () => {
                const current = await assertAuthorizationCurrent(auth);
                await prepareManagedRoot(current.mainRepoRoot);
                const found = await findWorktreeCreation(current.mainRepoRoot, creationTxId, creationFingerprint);
                if (found.status === 'absent') {
                  await releaseWorktreeCreationSource(
                    current.mainRepoRoot,
                    body.sourceSessionId,
                    creationTxId,
                    creationFingerprint,
                  );
                }
                return found.status;
              });
              if (state === 'absent') error.txState = 'absent';
            } catch { /* an uncertain transaction must retain its source claim */ }
          }
          const message = String(error?.message ?? error).slice(0, 600);
          const status = error?.code === 'ABORT_ERR'
            ? 499
            : ['WORKTREE_TX_PENDING', 'WORKTREE_TX_CONFLICT', 'WORKTREE_SOURCE_CONFLICT'].includes(error?.code)
              ? 409
              : /not allowed|does not exist|requires|cannot resolve|not a git repository|did not resolve to a commit/.test(message) ? 422 : 502;
          return sendJson(res, status, {
            ok: false,
            ...(error?.code === 'WORKTREE_TX_PENDING' ? { error: 'transaction_pending', txId: creationTxId } : {}),
            ...(error?.code === 'WORKTREE_TX_CONFLICT' ? { error: 'transaction_conflict', txId: creationTxId } : {}),
            // The admission refusal is typed so the client can render its own
            // copy instead of surfacing this Host text verbatim.
            ...(error?.code === 'WORKTREE_SOURCE_CONFLICT' ? { error: 'source_conflict' } : {}),
            ...(error?.previous ? { previous: error.previous } : {}),
            ...(error?.txState ? { txState: error.txState, txId: creationTxId } : {}),
            message,
          });
        }
      }

      if (req.method === 'POST' && sub === '/worktrees/archive') {
        const body = await readBody(req, requestAbort.signal);
        if (typeof body.path !== 'string' || body.path === '') {
          return sendJson(res, 400, { ok: false, error: 'path required' });
        }
        if (body.force !== undefined && typeof body.force !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'force must be boolean' });
        }
        if (body.deferWorkspaceDelete !== undefined && typeof body.deferWorkspaceDelete !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'deferWorkspaceDelete must be boolean' });
        }
        const auth = await authorizeGit(res, body.path);
        if (!auth) return;
        const workspaceRecord = await workspaceForPath(auth.cwd);
        const workspaceId = workspaceRecord?.workspaceId ?? null;
        const result = await mutations.run(mutationKeyFor(auth), async () => {
          const current = await assertAuthorizationCurrent(auth);
          return withStableRoot(current, async (stableRoot) => {
            const currentWorkspace = await workspaceForPath(current.cwd);
            if ((currentWorkspace?.workspaceId ?? null) !== workspaceId) {
              throw new ApiError(409, 'workspace ownership changed before archive');
            }
            await assertArchiveAllowed(workspaceId, current.cwd);
            const deferred = body.deferWorkspaceDelete === true;
            const deletionJournal = workspaceId !== null
              ? await prepareWorkspaceDeletion(current.mainRepoRoot, stableRoot, workspaceId, {
                  deferred,
                  sessionIds: currentWorkspace?.sessionIds || [],
                })
              : null;
            const archived = await archiveWorktree(stableRoot, {
              force: Boolean(body.force),
              beforeRemove: () => assertArchiveAllowed(workspaceId, current.cwd),
            });
            if (deferred && deletionJournal) {
              if (!archived.ok && !archived.partial) {
                await completeWorkspaceDeletion(deletionJournal);
                return archived;
              }
              return {
                ...archived,
                workspaceId,
                workspaceSessionIds: currentWorkspace?.sessionIds || [],
                workspaceDeletionToken: basename(deletionJournal),
                workspaceDeletionDeferred: true,
              };
            }
            return convergeArchivedWorkspace(archived, workspaceId, deletionJournal, currentWorkspace?.sessionIds);
          });
        }, { signal: requestAbort.signal });
        return sendJson(res, result.ok ? 200 : worktreeFailureStatus(result), result);
      }

      if (req.method === 'GET' && sub === '/worktrees/deferred') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd);
        if (!auth) return;
        if (auth.kind !== 'workspace' || auth.gitBoundary !== 'root' || auth.cwd !== auth.mainRepoRoot) {
          return sendJson(res, 403, { ok: false, error: 'deferred recovery requires the registered main checkout' });
        }
        const items = await mutations.run(mutationKeyFor(auth), async () => {
          const current = await assertAuthorizationCurrent(auth);
          return listDeferredWorkspaceDeletions(current.mainRepoRoot);
        }, { signal: requestAbort.signal });
        return sendJson(res, 200, { ok: true, items });
      }

      if (req.method === 'POST' && sub === '/worktrees/finalize-delete') {
        const body = await readBody(req, requestAbort.signal);
        if (typeof body.cwd !== 'string' || body.cwd === '' || typeof body.token !== 'string' || body.token === '') {
          return sendJson(res, 400, { ok: false, error: 'cwd and token required' });
        }
        const auth = await authorizeGit(res, body.cwd);
        if (!auth) return;
        if (!deleteWorkspace) return sendJson(res, 503, { ok: false, error: 'workspace registry unavailable' });
        if (auth.kind !== 'workspace' || auth.gitBoundary !== 'root' || auth.cwd !== auth.mainRepoRoot) {
          return sendJson(res, 403, { ok: false, error: 'finalization requires the registered main checkout' });
        }
        const result = await mutations.run(mutationKeyFor(auth), async () => {
          const current = await assertAuthorizationCurrent(auth);
          const pending = await deferredWorkspaceDeletion(current.mainRepoRoot, body.token);
          if (!pending) return { ok: false, status: 409, error: 'deferred workspace deletion is unavailable' };
          const deleted = await deleteWorkspace(pending.workspaceId, pending.path, pending.sessionIds);
          await completeWorkspaceDeletion(pending.file);
          return {
            ok: true,
            workspaceId: pending.workspaceId,
            ...(deleted ? { workspaceDeleted: pending.workspaceId } : { workspaceAlreadyAbsent: pending.workspaceId }),
          };
        }, { signal: requestAbort.signal });
        return sendJson(res, result.ok ? 200 : result.status || 409, result);
      }

      if (req.method === 'POST' && sub === '/worktrees/cleanup') {
        const body = await readBody(req, requestAbort.signal);
        if (typeof body.cwd !== 'string' || body.cwd === '') {
          return sendJson(res, 400, { ok: false, error: 'cwd required' });
        }
        if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'dryRun must be boolean' });
        }
        const auth = await authorizeGit(res, body.cwd);
        if (!auth) return;
        if (!cleanup) return sendJson(res, 503, { ok: false, message: 'cleanup unavailable on this host build' });
        const cleanupRoot = auth.mainRepoRoot;
        if (auth.kind !== 'workspace' || cleanupRoot !== auth.cwd) {
          return sendJson(res, 403, { ok: false, error: 'repo-wide cleanup requires the registered main checkout' });
        }
        const report = await cleanup({
          cwd: cleanupRoot,
          dryRun: Boolean(body.dryRun),
          signal: requestAbort.signal,
          capability: auth,
          reauthorize: () => authorizer.authorize(auth.cwd),
        });
        return sendJson(res, report.ok ? 200 : Number.isInteger(report.status) ? report.status : 500, report);
      }

      /* ---------------- snapshots + SSE ---------------- */
      if (req.method === 'POST' && sub === '/snapshots') {
        const body = await readBody(req, requestAbort.signal);
        if (!Array.isArray(body.cwds)) return sendJson(res, 400, { ok: false, error: 'cwds array required' });
        const selectors = body.cwds;
        if (selectors.some((selector) => typeof selector !== 'string' || selector === '')) {
          return sendJson(res, 400, { ok: false, error: 'cwds must contain paths' });
        }
        if (selectors.length > 200) return sendJson(res, 413, { ok: false, error: 'too many workspaces' });
        const authorized = [];
        for (const selector of selectors) {
          const auth = await authorizeGit(res, selector, { allowNonGit: true });
          if (!auth) return;
          authorized.push(auth.cwd);
        }
        const byCwd = await hub.snapshots(authorized);
        return sendJson(res, 200, { ok: true, byCwd });
      }

      if (req.method === 'GET' && sub === '/snapshot') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        // explicit single-target request: always fresh (batch /snapshots keeps the 3 s cache)
        const snapshot = await hub.snapshotFor(auth.cwd, { fresh: true });
        return sendJson(res, 200, { ok: true, snapshot });
      }

      if (req.method === 'GET' && sub === '/events') {
        if (sseClients.size >= MAX_SSE_CLIENTS) return sendJson(res, 503, { ok: false, error: 'too many event streams' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        sseClients.add(res);
        writeSse(res, 'retry: 5000\n:connected\n\n');
        req.on('close', () => sseClients.delete(res));
        req.on('error', () => sseClients.delete(res));
        return; // keep the response open
      }

      /* ---------------- diffs & commits ---------------- */
      if (req.method === 'GET' && sub === '/diff') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd);
        if (!auth) return;
        const modeRaw = query.get('mode');
        if (modeRaw !== null && !['uncommitted', 'session', 'base', 'task'].includes(modeRaw)) {
          return sendJson(res, 422, { ok: false, error: 'invalid diff mode' });
        }
        // Shared-workspace session mode requests the uncommitted superset;
        // the client then filters it by transcript-touched literal paths.
        const mode = modeRaw === 'session' ? 'uncommitted' : modeRaw || 'uncommitted';
        const commit = query.get('commit');
        const path = query.get('path') || undefined;
        const ignoreWhitespace = query.get('w') === '1';
        let result;
        try {
          result = await withStableRoot(auth, async (stableCwd) => {
            if (mode === 'task') {
              const meta = await readMetadata(stableCwd).catch(() => null);
              if (!meta || !meta.baseRef) throw new Error('task-base-missing');
            }
            return commit
              ? commitDiff(stableCwd, commit, { ignoreWhitespace, path })
              : computeDiff(stableCwd, { mode, baseRef: query.get('base') || undefined, ignoreWhitespace, path });
          }, { pinGit: true });
        } catch (error) {
          if (error?.message === 'task-base-missing') return sendJson(res, 409, { ok: false, error: 'task-base-missing' });
          if (error?.message === 'commit oid not found') return sendJson(res, 404, { ok: false, error: error.message });
          if (/^invalid (?:base revision|stored base revision|commit oid|diff path)$/.test(error?.message || '')) {
            return sendJson(res, 422, { ok: false, error: error.message });
          }
          throw error;
        }
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'GET' && sub === '/commits') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd);
        if (!auth) return;
        let payload;
        try {
          payload = await withStableRoot(auth, async (stableCwd) => {
            const refs = await resolveDiffRefs(stableCwd, { mode: 'base', baseRef: query.get('base') || undefined });
            const commitResult = await listCommits(stableCwd, `${refs.baseRef}..HEAD`, 200);
            if (!commitResult.ok) {
              throw new ApiError(500, `git-inspection-failed:commits:${String(commitResult.error || 'git log failed').trim().slice(0, 600)}`);
            }
            const commits = commitResult.commits;
            const branchInfo = await currentBranchInfo(stableCwd);
            let remoteRef = null;
            if (branchInfo.branch) {
              const up = await upstreamInfo(stableCwd, branchInfo.branch);
              if (up.upstreamRef) remoteRef = up.upstreamRef;
              else if (await hasRemoteBranch(stableCwd, branchInfo.branch)) remoteRef = `refs/remotes/origin/${branchInfo.branch}`;
            }
            const unpushed = remoteRef ? await unpushedShas(stableCwd, remoteRef) : null;
            const pushedSet = unpushed && unpushed.ok ? unpushed.shas : null;
            return {
              ok: true,
              base: refs.label,
              baseRef: refs.baseRef,
              remoteRef,
              commits: commits.map((commitItem) => ({
                ...commitItem,
                // Unknown/no remote is conservative: never label a commit pushed.
                unpushed: pushedSet ? pushedSet.has(commitItem.sha) : true,
              })),
              ...(unpushed && !unpushed.ok ? { degraded: ['unpushed'] } : {}),
            };
          }, { pinGit: true });
        } catch (error) {
          if (/^invalid /.test(error?.message || '')) return sendJson(res, 422, { ok: false, error: error.message });
          if (error instanceof ApiError && error.status === 500 && error.message.startsWith('git-inspection-failed:commits:')) {
            return sendJson(res, 500, { ok: false, error: 'git-inspection-failed', stage: 'commits', message: error.message.slice('git-inspection-failed:commits:'.length) });
          }
          throw error;
        }
        return sendJson(res, 200, payload);
      }

      /* ---------------- actions ---------------- */
      if (req.method === 'GET' && sub === '/actions') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd);
        if (!auth) return;
        // the ladder drives destructive buttons — always compute fresh
        const snapshot = await hub.snapshotFor(auth.cwd, { fresh: true });
        const ladder = buildActionLadder(snapshot, { agentRunning: query.get('running') === '1' });
        return sendJson(res, 200, { ok: true, ladder, snapshot });
      }

      if (req.method === 'POST' && sub === '/action') {
        const body = await readBody(req, requestAbort.signal);
        if (typeof body.cwd !== 'string' || body.cwd === '' || typeof body.name !== 'string' || body.name === '') {
          return sendJson(res, 400, { ok: false, error: 'cwd and name required' });
        }
        if (body.params !== undefined && (!body.params || typeof body.params !== 'object' || Array.isArray(body.params))) {
          return sendJson(res, 400, { ok: false, error: 'params must be an object' });
        }
        const auth = await authorizeGit(res, body.cwd);
        if (!auth) return;
        const params = body.params ?? {};
        if (body.name === 'archive' && params.force !== undefined && typeof params.force !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'force must be boolean' });
        }
        if (body.name === 'archive' && params.deferWorkspaceDelete !== undefined && typeof params.deferWorkspaceDelete !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'deferWorkspaceDelete must be boolean' });
        }
        if (body.name === 'archive' && params.path !== undefined) {
          const pathAuth = await authorizer.authorize(params.path);
          if (!pathAuth.ok || pathAuth.cwd !== auth.cwd) {
            return sendJson(res, 403, { ok: false, error: 'archive path does not match authorized cwd' });
          }
        }
        const workspaceRecord = body.name === 'archive' ? await workspaceForPath(auth.cwd) : null;
        const workspaceId = workspaceRecord?.workspaceId ?? null;
        let result = await mutations.run(mutationKeyFor(auth), async () => {
          const current = await assertAuthorizationCurrent(auth);
          return withStableRoot(current, async (stableRoot) => {
            const currentWorkspace = body.name === 'archive' ? await workspaceForPath(current.cwd) : null;
            if (body.name === 'archive' && (currentWorkspace?.workspaceId ?? null) !== workspaceId) {
              throw new ApiError(409, 'workspace ownership changed before archive');
            }
            if (body.name === 'archive') await assertArchiveAllowed(workspaceId, current.cwd);
            const deferred = body.name === 'archive' && params.deferWorkspaceDelete === true;
            const deletionJournal = workspaceId !== null
              ? await prepareWorkspaceDeletion(current.mainRepoRoot, stableRoot, workspaceId, {
                  deferred,
                  sessionIds: currentWorkspace?.sessionIds || [],
                })
              : null;
            const actionResult = await executeAction(hub, stableRoot, body.name, params, {
              sourceMainRoot: current.mainRepoRoot,
              sourceMainIdentity: current.mainIdentity,
              skipInvalidate: true,
              beforeArchiveRemove: body.name === 'archive'
                ? () => assertArchiveAllowed(workspaceId, current.cwd)
                : null,
              authorizeTarget: (candidate) => withoutPinnedGitEnvironment(() => authorizer.authorize(candidate)),
            });
            if (deferred && deletionJournal) {
              if (!actionResult?.ok && !actionResult?.partial) {
                await completeWorkspaceDeletion(deletionJournal);
                return actionResult;
              }
              return {
                ...actionResult,
                workspaceId,
                workspaceSessionIds: currentWorkspace?.sessionIds || [],
                workspaceDeletionToken: basename(deletionJournal),
                workspaceDeletionDeferred: true,
              };
            }
            return convergeArchivedWorkspace(actionResult, workspaceId, deletionJournal, currentWorkspace?.sessionIds);
          }, { pinGit: body.name !== 'archive' });
        }, { signal: requestAbort.signal });
        try {
          await assertAuthorizationCurrent(auth);
          await hub.invalidate(auth.cwd);
          if (typeof result?.mergedInto === 'string' && result.mergedInto !== auth.cwd) {
            const owner = await authorizer.authorize(result.mergedInto);
            if (owner.ok && owner.gitBoundary === 'root' && owner.mainRepoRoot === auth.mainRepoRoot) {
              await hub.invalidate(owner.cwd);
            }
          }
        } catch {
          /* do not retarget a completed mutation's refresh */
        }
        const status = result?.ok ? 200 : result?.reasonKey === 'actions.unknown' ? 400 : actionFailureStatus(body.name, result);
        return sendJson(res, status, result ?? { ok: false });
      }

      /* ---------------- file editor ---------------- */
      if (req.method === 'GET' && sub === '/file') {
        const cwd = query.get('cwd');
        const rel = query.get('path') || '';
        if (!cwd || rel === '') return sendJson(res, 400, { ok: false, error: 'cwd and path required' });
        const auth = await authorize(res, cwd);
        if (!auth) return;
        let rootAnchor;
        try {
          rootAnchor = await openRootAnchor(auth);
        } catch {
          return sendJson(res, 409, { ok: false, error: 'workspace identity changed during read' });
        }
        const anchoredAuth = { ...auth, anchorCwd: rootAnchor.anchorCwd };
        const located = await existingPathWithin(anchoredAuth, rel);
        if (!located.ok) {
          await rootAnchor.release();
          if (located.status === 404) return sendJson(res, 404, { ok: true, kind: 'missing' });
          return sendJson(res, located.status, { ok: false, error: located.error });
        }
        try {
        const file = located.file;
        let opened;
        try {
          opened = await openRegularFile(anchoredAuth, located);
        } catch {
          return sendJson(res, 403, { ok: false, error: 'path unavailable' });
        }
        if (!opened) return sendJson(res, 422, { ok: true, kind: 'not-file' });
        const { handle, stat: fileStat } = opened;
        try {
          const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
          if (IMAGE_EXT.has(ext)) {
            const encoded = rel.split('/').map(encodeURIComponent).join('/');
            return sendJson(res, 200, {
              ok: true,
              kind: 'image',
              size: fileStat.size,
              url: `${API_PREFIX}/raw?cwd=${encodeURIComponent(cwd)}&path=${encoded}`,
            });
          }
          if (fileStat.size > TEXT_MAX_BYTES) {
            return sendJson(res, 413, { ok: true, kind: 'too_large', size: fileStat.size });
          }
          const buffer = await readCapped(handle, TEXT_MAX_BYTES);
          if (!buffer) return sendJson(res, 413, { ok: true, kind: 'too_large', size: fileStat.size });
          const head = buffer.subarray(0, 8000);
          if (head.includes(0)) return sendJson(res, 415, { ok: true, kind: 'binary', size: fileStat.size });
          // sha1 lets the editor's POST /file do compare-and-swap on save
          return sendJson(res, 200, {
            ok: true,
            kind: 'text',
            size: fileStat.size,
            content: buffer.toString('utf8'),
            sha1: createHash('sha1').update(buffer).digest('hex'),
          });
        } finally {
          await handle.close().catch(() => {});
        }
        } finally {
          await rootAnchor.release();
        }
      }

      if (req.method === 'POST' && sub === '/file') {
        const body = await readBody(req, requestAbort.signal);
        const cwd = body && body.cwd;
        const rel = body && body.path;
        const content = body && body.content;
        const baseSha1 = body && body.baseSha1;
        if (!cwd || !rel || typeof content !== 'string') {
          return sendJson(res, 400, {
            ok: false,
            error: 'cwd, path and content required',
            message: 'cwd, path and content required',
          });
        }
        if (content.includes('\0')) {
          return sendJson(res, 415, { ok: false, error: 'binary content rejected', message: 'binary content rejected' });
        }
        const auth = await authorize(res, cwd);
        if (!auth) return;
        let located = await existingPathWithin(auth, rel);
        if (!located.ok) {
          const error = located.status === 404 ? 'existing file required' : located.error;
          return sendJson(res, located.status, { ok: false, error, message: error });
        }
        if (typeof baseSha1 !== 'string' || !/^[0-9a-f]{40}$/i.test(baseSha1)) {
          return sendJson(res, 400, { ok: false, error: 'invalid baseSha1', message: 'invalid baseSha1' });
        }
        let file = located.file;
        let rootAnchor = null;
        let parent = null;
        let unlockMutation = null;
        let unlockFile = null;
        let tempName = null;
        let tempPath = null;
        let tempCleanupIdentity = null;
        let nextIdentity = null;
        let exchanged = false;
        try {
          unlockMutation = await mutations.acquire(mutationKeyFor(auth), { signal: requestAbort.signal });
          const currentAuth = await assertAuthorizationCurrent(auth);
          try {
            rootAnchor = await openRootAnchor(currentAuth);
          } catch {
            throw new ApiError(409, 'workspace identity changed at file commit point');
          }
          const anchoredAuth = { ...currentAuth, anchorCwd: rootAnchor.anchorCwd };
          located = await existingPathWithin(anchoredAuth, rel);
          if (!located.ok) throw new ApiError(409, 'file identity changed while waiting for mutation');
          file = located.file;
          unlockFile = await lockFileMutation(file);
          if (requestAbort.signal.aborted) {
            throw Object.assign(new Error('request aborted'), { code: 'ABORT_ERR', name: 'AbortError' });
          }
          parent = await openAnchoredParent(anchoredAuth, located);
          const name = basename(file);
          const current = await readAnchoredRegular(parent.anchor, name);
          if (!current) {
            return sendJson(res, 404, { ok: false, error: 'existing file required', message: 'existing file required' });
          }
          if (current.stat.size > TEXT_MAX_BYTES || !current.buffer) {
            return sendJson(res, 413, { ok: false, error: 'file too large', message: 'file too large' });
          }
          if (current.buffer.includes(0)) {
            return sendJson(res, 415, { ok: false, error: 'binary file rejected', message: 'binary file rejected' });
          }
          const currentSha1 = createHash('sha1').update(current.buffer).digest('hex');
          if (baseSha1 !== currentSha1) {
            return sendJson(res, 409, {
              ok: false,
              error: 'conflict',
              message: 'file changed on disk since it was loaded',
              sha1: currentSha1,
            });
          }

          const next = Buffer.from(content, 'utf8');
          tempName = `.bw-${randomUUID()}.tmp`;
          tempPath = `${parent.anchor}/${tempName}`;
          const temp = await open(
            tempPath,
            fileCreateFlags(),
            current.stat.mode & 0o777,
          );
          try {
            // win32 chmod only toggles the read-only bit; the create mode
            // above already carried the intended access (ADR 0013).
            if (!isWindows()) await temp.chmod(current.stat.mode & 0o777);
            await temp.writeFile(next);
            await temp.sync();
            nextIdentity = await temp.stat();
            tempCleanupIdentity = nextIdentity;
          } finally {
            await temp.close().catch(() => {});
          }
          if (parent.handle
            ? !(await verifyOpenIdentity(parent.handle, currentAuth, parent.lexicalParent))
            : !(await verifyParentIdentity(currentAuth, dirname(file), parent.lexicalParent))) {
            throw new ApiError(409, 'file path changed during save');
          }
          // Recheck CAS at the commit point after the potentially slow write.
          const latest = await readAnchoredRegular(parent.anchor, name);
          const latestSha1 = latest?.buffer ? createHash('sha1').update(latest.buffer).digest('hex') : null;
          if (!latest || latestSha1 !== baseSha1) {
            const removedTemp = await removeMatchingIdentity(tempPath, tempCleanupIdentity);
            const recovery = removedTemp ? null : tempName;
            tempPath = null;
            return sendJson(res, 409, {
              ok: false,
              error: 'conflict',
              message: 'file changed on disk since it was loaded',
              ...(latestSha1 ? { sha1: latestSha1 } : {}),
              ...(recovery ? { recovery } : {}),
            });
          }
          if (beforeFileExchange) await beforeFileExchange({ cwd: currentAuth.cwd, path: file });
          if (!isFileExchangeSupported()) {
            // Path mode (paseo's file-editor save): the CAS re-check above was
            // the commit decision, and rename() replaces the target in one
            // step. No displaced copy exists to roll back — a failed rename
            // leaves the original untouched and only the temp to clean up.
            await rename(tempPath, file);
            tempPath = null;
            const savedStat = await stat(file);
            await hub.invalidate(auth.cwd);
            return sendJson(res, 200, {
              ok: true,
              sha1: createHash('sha1').update(next).digest('hex'),
              bytes: next.length,
              size: savedStat.size,
            });
          }
          await exchangeAnchored(parent.handle, tempName, name);
          exchanged = true;
          // The displaced target now lives at tempName. Verify the expected
          // value after the atomic exchange; a mismatch swaps it back before
          // returning conflict, so no concurrent pre-commit write is lost.
          const displaced = await readAnchoredRegular(parent.anchor, tempName);
          if (displaced) tempCleanupIdentity = displaced.stat;
          const displacedSha1 = displaced?.buffer ? createHash('sha1').update(displaced.buffer).digest('hex') : null;
          if (!displaced || displacedSha1 !== baseSha1) {
            await exchangeAnchored(parent.handle, tempName, name);
            exchanged = false;
            tempCleanupIdentity = nextIdentity;
            const removedTemp = await removeMatchingIdentity(tempPath, tempCleanupIdentity);
            const recovery = removedTemp ? null : tempName;
            tempPath = null;
            return sendJson(res, 409, {
              ok: false,
              error: 'conflict',
              message: 'file changed on disk during save',
              ...(displacedSha1 ? { sha1: displacedSha1 } : {}),
              ...(recovery ? { recovery } : {}),
            });
          }
          const removedDisplaced = await removeMatchingIdentity(tempPath, tempCleanupIdentity);
          const recovery = removedDisplaced ? null : tempName;
          tempPath = null;
          exchanged = false;
          await parent.handle.sync();
          await hub.invalidate(auth.cwd);
          return sendJson(res, 200, {
            ok: true,
            sha1: createHash('sha1').update(next).digest('hex'),
            bytes: next.length,
            ...(recovery ? { recovery } : {}),
          });
        } catch (error) {
          let failure = error;
          if (exchanged && parent?.handle && tempName) {
            try {
              await exchangeAnchored(parent.handle, tempName, basename(file));
              exchanged = false;
              tempCleanupIdentity = nextIdentity;
            } catch (rollbackError) {
              // tempName contains the displaced original; retain it for manual
              // recovery instead of deleting the only pre-save copy.
              tempPath = null;
              failure = new Error(`${String(error?.message ?? error)}; rollback failed: ${String(rollbackError?.message ?? rollbackError)}`);
            }
          }
          if (tempPath) {
            try {
              if (await removeMatchingIdentity(tempPath, tempCleanupIdentity)) tempPath = null;
            } catch (cleanupError) {
              failure = new Error(
                `${String(failure?.message ?? failure)}; temporary file cleanup failed: ${String(cleanupError?.message ?? cleanupError)}`,
                { cause: failure },
              );
            }
          }
          const status = failure instanceof ApiError
            ? failure.status
            : failure?.code === 'ABORT_ERR'
              ? 499
              : ['ELOOP', 'ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(failure?.code) ? 409 : 500;
          return sendJson(res, status, { ok: false, message: String(failure?.message ?? failure).slice(0, 300) });
        } finally {
          if (tempPath) await removeMatchingIdentity(tempPath, tempCleanupIdentity).catch(() => {});
          if (parent?.handle) await parent.handle.close().catch(() => {});
          await rootAnchor?.release?.();
          unlockFile?.();
          unlockMutation?.();
        }
      }

      if (req.method === 'GET' && sub === '/worktree-workspaces') {
        if (!worktreeWorkspaces) return sendJson(res, 200, { ok: true, items: [] });
        try {
          return sendJson(res, 200, { ok: true, items: await worktreeWorkspaces() });
        } catch (error) {
          return sendJson(res, 503, { ok: false, message: String(error?.message ?? error).slice(0, 300) });
        }
      }

      if (req.method === 'GET' && sub === '/raw') {
        const cwd = query.get('cwd');
        const rel = query.get('path') || '';
        if (!cwd || rel === '') {
          res.writeHead(400).end();
          return;
        }
        const auth = await authorizer.authorize(cwd);
        if (!auth.ok) {
          res.writeHead(auth.status || 403).end();
          return;
        }
        let rootAnchor;
        try {
          rootAnchor = await openRootAnchor(auth);
        } catch {
          res.writeHead(409).end();
          return;
        }
        const anchoredAuth = { ...auth, anchorCwd: rootAnchor.anchorCwd };
        const located = await existingPathWithin(anchoredAuth, rel);
        if (!located.ok) {
          await rootAnchor.release();
          res.writeHead(located.status).end();
          return;
        }
        try {
        const file = located.file;
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
        if (!IMAGE_EXT.has(ext)) {
          res.writeHead(415).end();
          return;
        }
        try {
          const opened = await openRegularFile(anchoredAuth, located);
          if (!opened) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': CONTENT_TYPE[ext] ?? 'application/octet-stream',
            'Content-Length': opened.stat.size,
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'X-Content-Type-Options': 'nosniff',
          });
          const stream = opened.handle.createReadStream();
          await pipeline(stream, res, { signal: requestAbort.signal });
        } catch {
          if (!res.headersSent) res.writeHead(404).end();
          else if (!res.writableEnded) res.destroy();
        }
        } finally {
          await rootAnchor.release();
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: `unknown route ${sub}` });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : error?.code === 'ABORT_ERR' ? 499 : 500;
      if (!res.headersSent) sendJson(res, status, { ok: false, error: String(error?.message ?? error).slice(0, 400) });
      else res.end();
    } finally {
      req.off('aborted', abortQueuedMutation);
      res.off('close', abortOnPrematureClose);
      lifecycle.signal.removeEventListener('abort', abortQueuedMutation);
      inflightRequests.delete(requestCompletion);
      finishRequest();
    }
  };

  const route = { kind: 'prefix', path: API_PREFIX, handler };
  const dispose = async () => {
    if (!disposed) {
      disposed = true;
      lifecycle.abort();
    }
    clearInterval(heartbeat);
    for (const res of sseClients) {
      try {
        res.destroy?.();
        if (!res.destroy) res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    await Promise.allSettled([...inflightRequests]);
  };
  return { route, broadcast, dispose };
}
