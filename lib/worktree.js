/**
 * worktree.js — managed-worktree lifecycle (paseo-inspired).
 *
 * Layout: `${DSH_HOME:-~/.dsh}/worktrees/<8-char base36 sha256(mainRepoRoot)>/<slug>`
 * with collision suffixes `-1`, `-2`, …. Identity/metadata lives at
 * `<worktree-gitdir>/dsh-worktree/worktree.json` (atomic tmp+rename writes):
 * baseRef (exact), baseRefName (display), intent, branch, slug, createdAt.
 * Only paths under our worktrees root WITH a metadata record are "managed"
 * and eligible for archive.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  detectRepo,
  hasLocalBranch,
  hasRemoteBranch,
  listWorktreesRaw,
  originUrl,
  remoteUrl,
  runGit,
  safeRealpath,
  withoutPinnedGitEnvironment,
} from './git.js';
import { fileCreateFlags, fileOpenFlags, isDirfdPinSupported, normalizeGitPath, procFdPath, samePath, syncDirectory } from './stable.js';
import { forgeRepositoryKey, parseGithubRemote } from './forge.js';

export const METADATA_DIR = 'dsh-worktree';
export const METADATA_FILE = 'worktree.json';
export const METADATA_VERSION = 1;
const METADATA_MAX_BYTES = 64 * 1024;
const PENDING_PREFIX = '.pending-';
const PENDING_SUFFIX = '.json';
const REGISTRY_DELETE_PREFIX = '.registry-delete-';
const CREATION_RECEIPT_PREFIX = '.creation-receipt-';
const CREATION_SOURCE_PREFIX = '.creation-source-';
const REPO_OWNER_FILE = '.repo-owner.json';
const CREATION_TX_RE = /^[A-Za-z0-9_-]{16,100}$/;

export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
}

export function worktreesRoot() {
  return join(dshHome(), 'worktrees');
}

/** Paseo's deriveShortAlphanumericHash: first 8 sha256 bytes → BigInt → base36 → 8 chars. */
export function projectHash(mainRepoRoot) {
  const digest = createHash('sha256').update(mainRepoRoot).digest();
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(digest[index] ?? 0);
  }
  return value.toString(36).padStart(13, '0').slice(0, 8);
}

export async function repoWorktreesRoot(mainRepoRoot) {
  const real = await safeRealpath(mainRepoRoot);
  return join(worktreesRoot(), projectHash(real));
}

async function requireDirectDirectory(path, label) {
  try {
    const [info, canonical] = await Promise.all([lstat(path), realpath(path)]);
    // win32 preserves case but does not honor it, so equivalence — not byte
    // equality — proves the path still names the directory it resolved to.
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(canonical, path)) throw new Error('rebound');
  } catch {
    throw new Error(`worktree: ${label} is unavailable or rebound`);
  }
}

/**
 * Bootstrap (or verify) one repository's managed root before any transaction
 * resolution. `verifyRepoOwner(..., { create: true })` adopts a root whose
 * owner record is absent — the state every root created before that record
 * existed is in — while still refusing a root that carries a record of a
 * replaced repository. Callers that only resolve transactions must run this
 * first: `findWorktreeCreation` verifies with `create: false` and would
 * otherwise report such a legacy root as `repo-owner-changed`.
 */
export async function prepareManagedRoot(mainRoot) {
  const canonicalMain = await realpath(mainRoot);
  const globalRoot = worktreesRoot();
  const createdGlobal = await mkdir(globalRoot, { recursive: true });
  if (createdGlobal) await syncDirectory(dirname(globalRoot));
  await requireDirectDirectory(globalRoot, 'managed root');
  const root = await repoWorktreesRoot(canonicalMain);
  let createdRoot = false;
  try {
    await mkdir(root);
    createdRoot = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (createdRoot) await syncDirectory(globalRoot);
  await requireDirectDirectory(root, 'repository managed root');
  if (!(await verifyRepoOwner(canonicalMain, root, { create: true }))) {
    throw new Error('worktree: managed root belongs to a replaced repository');
  }
  return root;
}

async function writeDurableJsonExclusive(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, fileCreateFlags(), 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // A hard link is an atomic no-replace publication: concurrent Hosts can
    // never overwrite one another's transaction claim.
    await link(temp, file);
    await syncDirectory(dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
  return true;
}

async function writePendingJournal(root, transaction) {
  const file = join(root, `${PENDING_PREFIX}${transaction.txId}${PENDING_SUFFIX}`);
  await writeDurableJsonExclusive(file, transaction);
  return file;
}

async function replacePendingJournal(file, transaction) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  let renamed = false;
  try {
    handle = await open(temp, fileCreateFlags(), 0o600);
    await handle.writeFile(JSON.stringify(transaction, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, file);
    renamed = true;
    await syncDirectory(dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await rm(temp, { force: true }).catch(() => {});
  }
}

async function removePendingJournal(file) {
  await rm(file, { force: true });
  await syncDirectory(dirname(file));
}

async function writeDurableJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  let renamed = false;
  try {
    handle = await open(temp, fileCreateFlags(), 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, file);
    renamed = true;
    await syncDirectory(dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await rm(temp, { force: true }).catch(() => {});
  }
}

async function verifyRepoOwner(mainRoot, root, { create = false } = {}) {
  const identity = await stat(mainRoot);
  const file = join(root, REPO_OWNER_FILE);
  const record = await readPendingJournal(file);
  if (!record) {
    let exists = false;
    try { await lstat(file); exists = true; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (exists || !create) return false;
    await writeDurableJson(file, {
      version: 1,
      mainRepoRoot: mainRoot,
      dev: String(identity.dev),
      ino: String(identity.ino),
      createdAt: Date.now(),
    });
    return true;
  }
  return record.version === 1
    && record.mainRepoRoot === mainRoot
    && record.dev === String(identity.dev)
    && record.ino === String(identity.ino);
}

async function readPendingJournal(file) {
  let handle;
  try {
    handle = await open(file, fileOpenFlags());
    const info = await handle.stat();
    if (!info.isFile() || info.size > METADATA_MAX_BYTES) return null;
    const data = await readCapped(handle, METADATA_MAX_BYTES);
    return data ? JSON.parse(data.toString('utf8')) : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function prepareWorkspaceDeletion(mainRepoRoot, path, workspaceId, { deferred = false, sessionIds = [] } = {}) {
  if (typeof workspaceId !== 'string' || workspaceId === '') throw new Error('worktree: workspace deletion requires an ID');
  const mainRoot = await realpath(mainRepoRoot);
  const root = await repoWorktreesRoot(mainRoot);
  await requireDirectDirectory(root, 'repository managed root');
  if (!(await verifyRepoOwner(mainRoot, root, { create: true }))) {
    throw new Error('worktree: managed root belongs to a replaced repository');
  }
  const canonicalPath = await realpath(path);
  if (!pathIsInside(root, canonicalPath)) throw new Error('worktree: workspace deletion path escaped managed root');
  const txId = randomUUID();
  const file = join(root, `${REGISTRY_DELETE_PREFIX}${txId}${PENDING_SUFFIX}`);
  await writeDurableJson(file, {
    version: 1,
    txId,
    mainRepoRoot: mainRoot,
    path: canonicalPath,
    workspaceId,
    sessionIds: Array.isArray(sessionIds) ? sessionIds.map(String) : [],
    deferred: Boolean(deferred),
    createdAt: Date.now(),
  });
  return file;
}

export async function completeWorkspaceDeletion(file) {
  await removePendingJournal(file);
}

export async function pendingWorkspaceDeletions(mainRepoRoot) {
  const mainRoot = await realpath(mainRepoRoot);
  const root = await repoWorktreesRoot(mainRoot);
  try {
    await requireDirectDirectory(root, 'repository managed root');
  } catch {
    return { ready: [], errors: [] };
  }
  if (!(await verifyRepoOwner(mainRoot, root))) {
    return { ready: [], errors: [{ path: mainRoot, stage: 'repo-owner-changed' }] };
  }
  const listed = await runGit(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
  if (!listed.ok) return { ready: [], errors: [{ path: mainRoot, stage: 'registry-row-list' }] };
  const rows = listed.stdout.split(/\n\s*\n/);
  const ready = [];
  const errors = [];
  for (const name of (await readdir(root)).filter((entry) => entry.startsWith(REGISTRY_DELETE_PREFIX) && entry.endsWith(PENDING_SUFFIX))) {
    const file = join(root, name);
    const record = await readPendingJournal(file);
    const valid = record
      && record.version === 1
      && typeof record.txId === 'string'
      && name === `${REGISTRY_DELETE_PREFIX}${record.txId}${PENDING_SUFFIX}`
      && record.mainRepoRoot === mainRoot
      && typeof record.workspaceId === 'string'
      && record.workspaceId !== ''
      && (record.deferred === undefined || typeof record.deferred === 'boolean')
      && typeof record.path === 'string'
      && pathIsInside(root, record.path);
    if (!valid) {
      errors.push({ file, stage: 'registry-journal-invalid' });
      continue;
    }
    let pathGone = false;
    try {
      await lstat(record.path);
    } catch (error) {
      pathGone = error?.code === 'ENOENT';
    }
    const rowRemains = rows.some((row) => worktreeRowHasPath(row, record.path));
    if (pathGone && !rowRemains && record.deferred !== true) ready.push({ ...record, file });
  }
  return { ready, errors };
}

/** Validate one deferred registry tombstone after the Client has retired sessions. */
export async function deferredWorkspaceDeletion(mainRepoRoot, token) {
  if (typeof token !== 'string' || basename(token) !== token
    || !token.startsWith(REGISTRY_DELETE_PREFIX) || !token.endsWith(PENDING_SUFFIX)) return null;
  const mainRoot = await realpath(mainRepoRoot);
  const root = await repoWorktreesRoot(mainRoot);
  await requireDirectDirectory(root, 'repository managed root');
  if (!(await verifyRepoOwner(mainRoot, root))) return null;
  const file = join(root, token);
  const record = await readPendingJournal(file);
  if (!record || record.version !== 1 || record.deferred !== true
    || token !== `${REGISTRY_DELETE_PREFIX}${record.txId}${PENDING_SUFFIX}`
    || record.mainRepoRoot !== mainRoot || typeof record.workspaceId !== 'string' || record.workspaceId === ''
    || (record.sessionIds !== undefined && (!Array.isArray(record.sessionIds)
      || record.sessionIds.some((id) => typeof id !== 'string')))
    || typeof record.path !== 'string' || !pathIsInside(root, record.path)) return null;
  try {
    await lstat(record.path);
    return null;
  } catch (error) {
    if (error?.code !== 'ENOENT') return null;
  }
  const listed = await runGit(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
  if (!listed.ok || listed.stdout.split(/\n\s*\n/).some((row) => worktreeRowHasPath(row, record.path))) return null;
  return { ...record, file };
}

export async function listDeferredWorkspaceDeletions(mainRepoRoot) {
  const mainRoot = await realpath(mainRepoRoot);
  const root = await repoWorktreesRoot(mainRoot);
  try {
    await requireDirectDirectory(root, 'repository managed root');
  } catch {
    return [];
  }
  if (!(await verifyRepoOwner(mainRoot, root))) return [];
  const records = [];
  for (const token of (await readdir(root)).filter((name) => name.startsWith(REGISTRY_DELETE_PREFIX) && name.endsWith(PENDING_SUFFIX))) {
    const record = await deferredWorkspaceDeletion(mainRoot, token);
    if (record) records.push({
      token,
      workspaceId: record.workspaceId,
      path: record.path,
      sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.map(String) : [],
      createdAt: record.createdAt,
    });
  }
  return records;
}

export async function pendingTransactionMainRoots() {
  const globalRoot = worktreesRoot();
  try {
    await requireDirectDirectory(globalRoot, 'managed root');
  } catch {
    return [];
  }
  const roots = new Set();
  for (const group of await readdir(globalRoot)) {
    const groupRoot = join(globalRoot, group);
    try {
      await requireDirectDirectory(groupRoot, 'repository managed root');
    } catch {
      continue;
    }
    for (const name of await readdir(groupRoot)) {
      let recordedMain = null;
      if ((name.startsWith(PENDING_PREFIX) || name.startsWith(REGISTRY_DELETE_PREFIX)) && name.endsWith(PENDING_SUFFIX)) {
        recordedMain = (await readPendingJournal(join(groupRoot, name)))?.mainRepoRoot ?? null;
      } else {
        try {
          const entry = join(groupRoot, name);
          const info = await lstat(entry);
          if (info.isDirectory() && !info.isSymbolicLink()) recordedMain = (await readMetadata(entry))?.mainRepoRoot ?? null;
        } catch {
          /* unrelated or stale directory */
        }
      }
      if (typeof recordedMain !== 'string') continue;
      try {
        const mainRoot = await realpath(recordedMain);
        if ((await repoWorktreesRoot(mainRoot)) === groupRoot) roots.add(mainRoot);
      } catch {
        /* an unavailable root is not authority for recovery */
      }
    }
  }
  return [...roots];
}

/** Replay fsynced create journals while the caller holds this repo's mutation gate. */
function transactionOwnerAlive(transaction) {
  if (!Number.isSafeInteger(transaction?.ownerPid) || transaction.ownerPid <= 0) return false;
  try {
    process.kill(transaction.ownerPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function recoverPendingTransactions(mainRepoRoot) {
  let mainRoot;
  let root;
  try {
    mainRoot = await realpath(mainRepoRoot);
    root = await repoWorktreesRoot(mainRoot);
    await requireDirectDirectory(root, 'repository managed root');
  } catch {
    return { ok: true, recovered: [], errors: [] };
  }
  if (!(await verifyRepoOwner(mainRoot, root))) {
    return { ok: false, recovered: [], errors: [{ path: mainRoot, stage: 'repo-owner-changed' }] };
  }
  const mainIdentity = await stat(mainRoot);
  const names = (await readdir(root)).filter((name) => name.startsWith(PENDING_PREFIX) && name.endsWith(PENDING_SUFFIX));
  const report = { ok: true, recovered: [], errors: [] };
  const temporaryRefs = await runGit([
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/dsh-better-workspaces/pr/',
  ], { cwd: mainRoot });
  if (!temporaryRefs.ok) {
    report.errors.push({ path: mainRoot, stage: 'temporary-ref-list', message: temporaryRefs.stderr.trim().slice(0, 600) });
  } else {
    for (const line of temporaryRefs.stdout.trim().split('\n').filter(Boolean)) {
      const split = line.lastIndexOf(' ');
      const ref = line.slice(0, split);
      const oid = line.slice(split + 1);
      if (!ref.startsWith('refs/dsh-better-workspaces/pr/') || !FULL_OID.test(oid)) {
        report.errors.push({ path: mainRoot, stage: 'temporary-ref-invalid' });
        continue;
      }
      const dropped = await runGit(['update-ref', '-d', ref, oid], { cwd: mainRoot });
      const remains = await runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: mainRoot });
      if (!dropped.ok || remains.ok || typeof remains.code !== 'number') {
        report.errors.push({ path: mainRoot, stage: 'temporary-ref-delete', message: dropped.stderr.trim().slice(0, 600) });
      } else {
        report.recovered.push({ ref, action: 'temporary-ref-removed' });
      }
    }
  }
  for (const name of names) {
    const file = join(root, name);
    const transaction = await readPendingJournal(file);
    const valid = transaction
      && transaction.version === 1
      && typeof transaction.txId === 'string'
      && name === `${PENDING_PREFIX}${transaction.txId}${PENDING_SUFFIX}`
      && transaction.mainRepoRoot === mainRoot
      && transaction.mainIdentity?.dev === String(mainIdentity.dev)
      && transaction.mainIdentity?.ino === String(mainIdentity.ino)
      && typeof transaction.path === 'string'
      && pathIsInside(root, transaction.path)
      && isValidBranchName(transaction.branch)
      && FULL_OID.test(transaction.expectedOid)
      && ['prepared', 'added'].includes(transaction.phase)
      && (transaction.ownerPid === undefined || transaction.ownerPid === null || Number.isSafeInteger(transaction.ownerPid))
      && typeof transaction.ownsBranch === 'boolean'
      && (transaction.phase === 'added' || transaction.ownsBranch === false)
      && (transaction.phase !== 'added' || (
        typeof transaction.gitDir === 'string'
        && typeof transaction.pathIdentity?.dev === 'string'
        && typeof transaction.pathIdentity?.ino === 'string'
        && typeof transaction.gitDirIdentity?.dev === 'string'
        && typeof transaction.gitDirIdentity?.ino === 'string'
      ));
    if (!valid) {
      report.errors.push({ file, stage: 'journal-invalid' });
      continue;
    }
    if (transactionOwnerAlive(transaction)) {
      report.errors.push({ path: transaction.path, stage: 'transaction-owner-live' });
      continue;
    }

    const managed = await validateManagedWorktree(transaction.path, { expectedMainRoot: mainRoot });
    if (managed.ok) {
      await removePendingJournal(file);
      report.recovered.push({ path: transaction.path, action: 'commit-confirmed' });
      continue;
    }

    const beforeList = await runGit(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
    if (!beforeList.ok) {
      report.errors.push({ path: transaction.path, stage: 'worktree-list' });
      continue;
    }
    const row = beforeList.stdout
      .split(/\n\s*\n/)
      .find((entry) => worktreeRowHasPath(entry, transaction.path));
    let pathIdentity = null;
    try {
      pathIdentity = await lstat(transaction.path);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        report.errors.push({ path: transaction.path, stage: 'path-inspect' });
        continue;
      }
    }
    if (transaction.phase === 'prepared' && (row || pathIdentity)) {
      report.errors.push({ path: transaction.path, stage: 'prepared-artifact-unproven' });
      continue;
    }
    if (transaction.phase === 'added' && (row || pathIdentity)) {
      // A crashed Host cannot prove that ignored files or external edits were
      // not added after its last observation. Recovery therefore never removes
      // a path that still exists (nor a row whose path identity is unavailable).
      report.errors.push({
        path: transaction.path,
        stage: 'added-artifact-preserved',
        message: 'manual recovery required; automatic deletion could discard post-crash data',
      });
      continue;
    }
    const afterList = await runGit(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
    let pathGone = false;
    try {
      await lstat(transaction.path);
    } catch (error) {
      pathGone = error?.code === 'ENOENT';
    }
    const rowRemains = afterList.ok && afterList.stdout
      .split(/\n\s*\n/)
      .some((row) => worktreeRowHasPath(row, transaction.path));
    if (!afterList.ok || !pathGone || rowRemains) {
      report.errors.push({ path: transaction.path, stage: 'teardown-postcondition' });
      continue;
    }

    if (transaction.ownsBranch) {
      const current = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${transaction.branch}`], { cwd: mainRoot });
      if (current.ok) {
        if (current.stdout.trim() !== transaction.expectedOid) {
          report.errors.push({ path: transaction.path, stage: 'branch-changed' });
          continue;
        }
        const dropped = await runGit(['update-ref', '-d', `refs/heads/${transaction.branch}`, transaction.expectedOid], { cwd: mainRoot });
        if (!dropped.ok) {
          report.errors.push({ path: transaction.path, stage: 'branch-delete', message: dropped.stderr.trim().slice(0, 600) });
          continue;
        }
        await runGit(['config', '--remove-section', `branch.${transaction.branch}`], { cwd: mainRoot });
      } else if (typeof current.code !== 'number') {
        report.errors.push({ path: transaction.path, stage: 'branch-inspect' });
        continue;
      }
    }
    await removePendingJournal(file);
    report.recovered.push({ path: transaction.path, action: 'rolled-back' });
  }
  report.ok = report.errors.length === 0;
  return report;
}

export function isValidCreationTxId(value) {
  return typeof value === 'string' && CREATION_TX_RE.test(value);
}

function creationResultFromManaged(managed) {
  const metadata = managed.metadata;
  return {
    path: managed.cwd,
    branch: metadata.branch,
    baseRef: metadata.baseRef ?? null,
    baseRefName: metadata.baseRefName ?? null,
    copiedFrom: metadata.copiedFrom ?? null,
    ...(Number.isSafeInteger(metadata.pullNumber) ? { pullNumber: metadata.pullNumber } : {}),
    ...(typeof metadata.prHeadSha === 'string' ? { prHeadSha: metadata.prHeadSha } : {}),
    ...(typeof metadata.upstream === 'string' ? { upstream: metadata.upstream } : {}),
  };
}

function validCreationReceipt(record, txId) {
  return record
    && (record.version === 1 || record.version === 2)
    && record.txId === txId
    && isValidCreationTxId(record.txId)
    && typeof record.requestFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(record.requestFingerprint)
    && record.result
    && typeof record.result.path === 'string'
    && isAbsolute(record.result.path)
    && typeof record.result.branch === 'string'
    && isValidBranchName(record.result.branch)
    && typeof record.result.workspaceId === 'string'
    && record.result.workspaceId !== '';
}

export async function commitWorktreeCreationReceipt(mainRepoRoot, txId, requestFingerprint, result) {
  if (!isValidCreationTxId(txId) || !/^[a-f0-9]{64}$/.test(requestFingerprint)
    || !result || typeof result.path !== 'string' || typeof result.branch !== 'string'
    || typeof result.workspaceId !== 'string') throw new Error('worktree: invalid creation receipt');
  const mainRoot = await realpath(mainRepoRoot);
  const root = await prepareManagedRoot(mainRoot);
  if (!pathIsInside(root, result.path)) throw new Error('worktree: creation receipt path escaped managed root');
  const file = join(root, `${CREATION_RECEIPT_PREFIX}${txId}${PENDING_SUFFIX}`);
  const record = {
    version: 1,
    txId,
    requestFingerprint,
    committedAt: Date.now(),
    result: {
      path: result.path,
      branch: result.branch,
      workspaceId: result.workspaceId,
      baseRef: result.baseRef ?? null,
      baseRefName: result.baseRefName ?? null,
      copiedFrom: result.copiedFrom ?? null,
      ...(Number.isSafeInteger(result.pullNumber) ? { pullNumber: result.pullNumber } : {}),
      ...(typeof result.prHeadSha === 'string' ? { prHeadSha: result.prHeadSha } : {}),
      ...(typeof result.upstream === 'string' ? { upstream: result.upstream } : {}),
    },
  };
  try {
    await writeDurableJsonExclusive(file, record);
    return record.result;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readPendingJournal(file);
    if (!validCreationReceipt(existing, txId) || existing.requestFingerprint !== requestFingerprint
      || !pathIsInside(root, existing.result.path)) {
      const conflict = new Error('worktree: creation receipt conflicts with an existing transaction');
      conflict.code = 'WORKTREE_TX_CONFLICT';
      throw conflict;
    }
    return existing.result;
  }
}

export async function reconcileWorktreeCreationReceipt(mainRepoRoot, txId, requestFingerprint, result) {
  if (!validCreationReceipt({
    version: 2,
    txId,
    requestFingerprint,
    result,
  }, txId)) throw new Error('worktree: invalid reconciled creation receipt');
  const mainRoot = await realpath(mainRepoRoot);
  const root = await prepareManagedRoot(mainRoot);
  if (!pathIsInside(root, result.path)) throw new Error('worktree: creation receipt path escaped managed root');
  const file = join(root, `${CREATION_RECEIPT_PREFIX}${txId}${PENDING_SUFFIX}`);
  const existing = await readPendingJournal(file);
  if (!validCreationReceipt(existing, txId) || existing.requestFingerprint !== requestFingerprint
    || existing.result.path !== result.path) {
    const conflict = new Error('worktree: creation receipt changed before reconciliation');
    conflict.code = 'WORKTREE_TX_CONFLICT';
    throw conflict;
  }
  const record = {
    ...existing,
    version: 2,
    previousWorkspaceId: existing.result.workspaceId,
    reconciledAt: Date.now(),
    result: { ...result },
  };
  await writeDurableJson(file, record);
  return record.result;
}

export async function claimWorktreeCreationSource(mainRepoRoot, sourceSessionId, txId, requestFingerprint) {
  if (typeof sourceSessionId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(sourceSessionId)
    || !isValidCreationTxId(txId) || !/^[a-f0-9]{64}$/.test(requestFingerprint)) {
    throw new Error('worktree: invalid creation source claim');
  }
  const mainRoot = await realpath(mainRepoRoot);
  const root = await prepareManagedRoot(mainRoot);
  const sourceHash = createHash('sha256').update(sourceSessionId).digest('hex');
  const file = join(root, `${CREATION_SOURCE_PREFIX}${sourceHash}${PENDING_SUFFIX}`);
  const record = { version: 1, sourceSessionId, txId, requestFingerprint, ownerPid: process.pid, claimedAt: Date.now() };
  try {
    await writeDurableJsonExclusive(file, record);
    return record;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readPendingJournal(file);
    if (!existing || existing.version !== 1 || existing.sourceSessionId !== sourceSessionId
      || existing.txId !== txId || existing.requestFingerprint !== requestFingerprint) {
      const conflict = new Error('worktree: source session already owns another creation transaction');
      conflict.code = 'WORKTREE_SOURCE_CONFLICT';
      throw conflict;
    }
    if (existing.ownerPid !== process.pid && transactionOwnerAlive(existing)) {
      const pending = new Error('worktree: source creation transaction is active in another Host');
      pending.code = 'WORKTREE_TX_PENDING';
      throw pending;
    }
    if (existing.ownerPid !== process.pid) {
      const adopted = { ...existing, ownerPid: process.pid, adoptedAt: Date.now() };
      await writeDurableJson(file, adopted);
      return adopted;
    }
    return existing;
  }
}

export async function releaseWorktreeCreationSource(mainRepoRoot, sourceSessionId, txId, requestFingerprint) {
  const mainRoot = await realpath(mainRepoRoot);
  const root = await prepareManagedRoot(mainRoot);
  const sourceHash = createHash('sha256').update(sourceSessionId).digest('hex');
  const file = join(root, `${CREATION_SOURCE_PREFIX}${sourceHash}${PENDING_SUFFIX}`);
  const existing = await readPendingJournal(file);
  if (!existing || existing.sourceSessionId !== sourceSessionId || existing.txId !== txId
    || existing.requestFingerprint !== requestFingerprint
    || (existing.ownerPid !== process.pid && transactionOwnerAlive(existing))) return false;
  await rm(file, { force: true });
  await syncDirectory(root);
  return true;
}

/** Resolve one client-supplied creation transaction without creating anything. */
export async function findWorktreeCreation(mainRepoRoot, txId, requestFingerprint) {
  if (!isValidCreationTxId(txId)) return { status: 'absent' };
  let mainRoot;
  let root;
  try {
    mainRoot = await realpath(mainRepoRoot);
    root = await repoWorktreesRoot(mainRoot);
    await requireDirectDirectory(root, 'repository managed root');
  } catch {
    return { status: 'absent' };
  }
  if (!(await verifyRepoOwner(mainRoot, root))) return { status: 'conflict', reason: 'repo-owner-changed' };

  const receiptFile = join(root, `${CREATION_RECEIPT_PREFIX}${txId}${PENDING_SUFFIX}`);
  const receipt = await readPendingJournal(receiptFile);
  if (receipt) {
    if (!validCreationReceipt(receipt, txId) || receipt.requestFingerprint !== requestFingerprint
      || !pathIsInside(root, receipt.result.path)) {
      return { status: 'conflict', reason: 'transaction-receipt-mismatch' };
    }
    const managed = await validateManagedWorktree(receipt.result.path);
    if (!managed.ok) {
      try {
        await lstat(receipt.result.path);
        return { status: 'conflict', reason: 'transaction-target-replaced' };
      } catch (error) {
        if (error?.code === 'ENOENT') return { status: 'retired', result: { ...receipt.result } };
        return { status: 'conflict', reason: 'transaction-target-unreadable' };
      }
    }
    if (managed.metadata.creationTxId !== txId
      || managed.metadata.creationFingerprint !== requestFingerprint) {
      return { status: 'conflict', reason: 'transaction-target-identity-changed' };
    }
    return { status: 'committed', result: { ...receipt.result } };
  }
  try {
    await lstat(receiptFile);
    return { status: 'conflict', reason: 'transaction-receipt-invalid' };
  } catch (error) {
    if (error?.code !== 'ENOENT') return { status: 'conflict', reason: 'transaction-receipt-unreadable' };
  }

  const matches = [];
  const pending = [];
  for (const name of await readdir(root)) {
    const entry = join(root, name);
    if (name.startsWith(PENDING_PREFIX) && name.endsWith(PENDING_SUFFIX)) {
      const transaction = await readPendingJournal(entry);
      if (transaction?.txId === txId) pending.push(transaction);
      continue;
    }
    if (name.startsWith('.')) continue;
    try {
      const info = await lstat(entry);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const managed = await validateManagedWorktree(entry, { expectedMainRoot: mainRoot });
      if (managed.ok && managed.metadata.creationTxId === txId) matches.push(managed);
    } catch {
      /* unrelated or concurrently removed candidate */
    }
  }
  if (matches.length > 1 || pending.length > 1) return { status: 'conflict', reason: 'duplicate-transaction' };
  const fingerprint = matches[0]?.metadata?.creationFingerprint ?? pending[0]?.requestFingerprint;
  if (fingerprint !== requestFingerprint) {
    return matches.length > 0 || pending.length > 0
      ? { status: 'conflict', reason: 'transaction-request-mismatch' }
      : { status: 'absent' };
  }
  if (matches.length === 1) return { status: 'committed', result: creationResultFromManaged(matches[0]) };
  if (pending.length === 1) return { status: 'pending', path: pending[0].path };
  return { status: 'absent' };
}

function slugify(value, fallback = 'wt') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/[/]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** `<worktree-gitdir>/dsh-worktree/worktree.json` path for a worktree cwd. */
export async function metadataPathFor(worktreeCwd) {
  const r = await runGit(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: worktreeCwd });
  if (!r.ok) return null;
  return join(r.stdout.trim(), METADATA_DIR, METADATA_FILE);
}

async function readCapped(handle, maxBytes) {
  const chunks = [];
  let offset = 0;
  while (offset <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - offset));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) return Buffer.concat(chunks, offset);
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return null;
}

export async function readMetadata(worktreeCwd) {
  const file = await metadataPathFor(worktreeCwd);
  if (!file) return null;
  let handle;
  try {
    handle = await open(file, fileOpenFlags());
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > METADATA_MAX_BYTES) return null;
    const data = await readCapped(handle, METADATA_MAX_BYTES);
    return data ? JSON.parse(data.toString('utf8')) : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pathIsInside(root, target) {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Does one `git worktree list --porcelain` row describe the worktree at
 * `path`? Git prints forward slashes on Windows (`worktree C:/Users/…`)
 * while every recorded path uses backslashes, and NTFS ignores case —
 * ownership row matching must go through the platform normalizers
 * (ADR 0013). POSIX hosts keep the exact byte comparison.
 */
export function worktreeRowHasPath(row, path) {
  return String(row ?? '').split('\n').some((line) => line.startsWith('worktree ')
    && samePath(normalizeGitPath(line.slice('worktree '.length)), path));
}

/** Strong ownership proof shared by API authorization, listing, state and cleanup. */
export async function validateManagedWorktree(path, { expectedMainRoot, allowBranchMismatch = false } = {}) {
  let cwd;
  try {
    cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, reason: 'path-unavailable' };
  }
  const detected = await detectRepo(cwd);
  if (!detected.isGit || !detected.isLinkedWorktree) return { ok: false, reason: 'not-linked-worktree' };
  let repoRoot;
  let detectedMain;
  try {
    repoRoot = await realpath(detected.repoRoot);
    detectedMain = await realpath(detected.mainRepoRoot);
  } catch {
    return { ok: false, reason: 'repo-unavailable' };
  }
  if (repoRoot !== cwd) return { ok: false, reason: 'not-worktree-root' };

  const metadata = await readMetadata(cwd).catch(() => null);
  if (!metadata || metadata.version !== METADATA_VERSION) return { ok: false, reason: 'metadata-invalid' };
  if (!isValidBranchName(metadata.branch) || !['branch-off', 'checkout', 'pr-checkout'].includes(metadata.intent)) {
    return { ok: false, reason: 'metadata-invalid' };
  }
  if (metadata.baseRefName !== null && metadata.baseRefName !== undefined && !isValidBranchName(metadata.baseRefName)) {
    return { ok: false, reason: 'metadata-invalid' };
  }
  if (metadata.baseRef !== null && metadata.baseRef !== undefined && !FULL_OID.test(metadata.baseRef)) {
    return { ok: false, reason: 'metadata-invalid' };
  }
  let metadataMain;
  try {
    metadataMain = await realpath(metadata.mainRepoRoot);
  } catch {
    return { ok: false, reason: 'metadata-main-unavailable' };
  }
  if (metadataMain !== detectedMain) return { ok: false, reason: 'metadata-main-mismatch' };
  if (expectedMainRoot) {
    try {
      if ((await realpath(expectedMainRoot)) !== metadataMain) return { ok: false, reason: 'source-not-authorized' };
    } catch {
      return { ok: false, reason: 'source-not-authorized' };
    }
  }
  const globalRoot = worktreesRoot();
  const ownedRoot = await repoWorktreesRoot(metadataMain);
  try {
    const [globalReal, ownedReal, ownedStat] = await Promise.all([
      realpath(globalRoot),
      realpath(ownedRoot),
      lstat(ownedRoot),
    ]);
    if (!samePath(globalReal, globalRoot) || !samePath(ownedReal, ownedRoot) || ownedStat.isSymbolicLink()) {
      return { ok: false, reason: 'managed-root-rebound' };
    }
  } catch {
    return { ok: false, reason: 'managed-root-unavailable' };
  }
  if (!pathIsInside(ownedRoot, cwd)) return { ok: false, reason: 'outside-managed-root' };

  const listed = await listWorktreesRaw(metadataMain);
  for (const entry of listed) {
    try {
      if (!entry.bare && (await realpath(entry.path)) === cwd) {
        if (entry.branch !== metadata.branch && !allowBranchMismatch) {
          return { ok: false, reason: 'metadata-git-branch-mismatch' };
        }
        return { ok: true, cwd, root: cwd, mainRepoRoot: metadataMain, gitDir: detected.gitDir, gitCommonDir: detected.gitCommonDir, metadata, actualBranch: entry.branch };
      }
    } catch {
      /* stale worktree rows are not ownership evidence */
    }
  }
  return { ok: false, reason: 'not-in-git-worktree-list' };
}

async function writeMetadata(worktreeCwd, metadata) {
  const file = await metadataPathFor(worktreeCwd);
  if (!file) throw new Error('worktree: cannot resolve gitdir for metadata');
  const metadataDir = dirname(file);
  const createdMetadataDir = await mkdir(metadataDir, { recursive: true });
  if (createdMetadataDir) await syncDirectory(dirname(metadataDir));
  const tmp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(
      tmp,
      fileCreateFlags(),
      0o600,
    );
    await handle.writeFile(JSON.stringify(metadata, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, file);
    await syncDirectory(metadataDir);
  } finally {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Append `-1`, `-2`, … until refs/heads/<name> does not exist (paseo's resolveUniqueLocalBranchName). */
export async function uniqueLocalBranchName(repoRoot, wanted) {
  let candidate = wanted;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    if (!(await hasLocalBranch(repoRoot, candidate))) return candidate;
    candidate = `${wanted}-${suffix}`;
  }
  throw new Error(`worktree: cannot uniquify branch name ${JSON.stringify(wanted)}`);
}

/** Append `-1`, `-2`, … until the directory does not exist. */
async function uniquePath(base) {
  let candidate = base;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
    candidate = `${base}-${suffix}`;
  }
  throw new Error(`worktree: cannot uniquify path ${JSON.stringify(base)}`);
}

/* paseo createNameId equivalent: adj-noun-hhhh, always a valid branch slug.
 * Mirrors the client-side generator (the bundle cannot import host modules). */
const MNEMONIC_ADJ = ['amber', 'brave', 'calm', 'clever', 'coral', 'cosmic', 'crimson', 'curious', 'daring', 'dusty', 'eager', 'electric', 'emerald', 'fading', 'fierce', 'floating', 'gentle', 'gilded', 'golden', 'hidden', 'hollow', 'humble', 'icy', 'indigo', 'iron', 'ivory', 'jagged', 'jolly', 'keen', 'lively', 'lunar', 'mellow', 'misty', 'molten', 'muted', 'nifty', 'nimble', 'noble', 'pale', 'patient', 'polar', 'proud', 'quiet', 'radiant', 'rapid', 'rustic', 'sage', 'scarlet', 'serene', 'shadow', 'shifting', 'silent', 'silver', 'solar', 'solid', 'somber', 'swift', 'tender', 'tranquil', 'umber', 'vast', 'velvet', 'vivid', 'wandering', 'warm', 'wild', 'winter', 'witty', 'zealous'];
const MNEMONIC_NOUN = ['anchor', 'arrow', 'aurora', 'badger', 'basalt', 'beacon', 'birch', 'blossom', 'brook', 'canyon', 'cedar', 'cinder', 'cipher', 'cliff', 'comet', 'copper', 'creek', 'crest', 'crystal', 'current', 'dawn', 'delta', 'dune', 'ember', 'estuary', 'falcon', 'fen', 'fjord', 'flint', 'forest', 'forge', 'fossil', 'gale', 'galaxy', 'garden', 'geode', 'glacier', 'glade', 'granite', 'grove', 'harbor', 'heron', 'horizon', 'island', 'ivy', 'lagoon', 'lantern', 'larch', 'lava', 'leaf', 'lynx', 'marsh', 'meadow', 'meteor', 'monsoon', 'moss', 'nebula', 'oak', 'oasis', 'opal', 'orbit', 'otter', 'peak', 'pebble', 'pine', 'prairie', 'quartz', 'quill', 'raven', 'reef', 'ridge', 'river', 'rose', 'sable', 'sequoia', 'shoal', 'sparrow', 'spring', 'steppe', 'stone', 'summit', 'talon', 'thicket', 'tide', 'timber', 'tundra', 'vale', 'vine', 'walrus', 'willow', 'wolf', 'wren', 'yarrow'];

export function mnemonicSlug() {
  const adj = MNEMONIC_ADJ[randomInt(MNEMONIC_ADJ.length)];
  const noun = MNEMONIC_NOUN[randomInt(MNEMONIC_NOUN.length)];
  const hex = randomInt(0x10000).toString(16).padStart(4, '0');
  return `${adj}-${noun}-${hex}`;
}

/**
 * Read-modify-write the managed-worktree metadata atomically.
 * No-op (returns false) when the path carries no metadata record.
 */
export async function patchMetadata(worktreeCwd, mutator) {
  const current = await readMetadata(worktreeCwd);
  if (!current) return false;
  const next = mutator(current);
  if (!next || next === current) return false;
  await writeMetadata(worktreeCwd, next);
  return true;
}

/**
 * Create one managed worktree.
 *
 * @param opts.repoRoot   any cwd inside the MAIN repository (worktrees are always cut from the main checkout's refs)
 * @param opts.base       base branch name to cut from (default branch when omitted)
 * @param opts.intent     'checkout' — check out an existing branch (unique copy branch when it is
 *                        already checked out elsewhere; remote-only branches are fetched first);
 *                        'branch-off' — create a NEW branch based on `base`;
 *                        'pr-checkout' — materialize one pull request's head as a local branch
 *                        (paseo's checkout-change-request; `opts.pull` is required).
 * @param opts.branchName for 'checkout': the existing branch; for 'branch-off': desired new branch name
 *                        (uniquified automatically).
 * @param opts.slug       directory slug (derived from branchName when omitted).
 * @param opts.pull       'pr-checkout' only: {number, headRef, baseRef, forkOwner} — the PR to check out.
 *                        `forkOwner` set means a cross-repository (fork) PR: the local branch is
 *                        named `<owner>/<headRef>` and no upstream is configured (paseo parity).
 * @returns {Promise<{path:string, branch:string, baseRef:string, baseRefName:string, copiedFrom:string|null}>}
 */
/**
 * Best-effort base for PR metadata: a syntactically safe branch may disappear
 * without blocking checkout, but arbitrary refs/revision expressions fail.
 */
async function resolveBaseTolerant(mainRoot, rawBase) {
  if (!isValidBaseSelector(rawBase)) throw new Error(`worktree: base ${JSON.stringify(rawBase)} is not allowed`);
  try {
    return await resolveBase(mainRoot, rawBase);
  } catch {
    return { baseName: null, baseRef: null };
  }
}

/**
 * Local branch name one PR head will occupy. paseo's buildPrLocalBranchName:
 * GitHub prefixes the fork owner so a cross-repository head cannot collide
 * with a local branch of the same name. The name is only *chosen* here —
 * `git worktree add -b <name>` creates it — so a taken name uniquifies
 * (`<name>-1`, …) exactly like the branch-off path.
 */
async function anchorLocalBranchName(mainRoot, forkOwner, headRef) {
  const owner = typeof forkOwner === 'string' ? forkOwner.trim().replace(/[^A-Za-z0-9._-]+/g, '-') : '';
  const wanted = owner ? `${owner}/${headRef}` : headRef;
  if (!isValidBranchName(wanted)) {
    throw new Error(`worktree: PR head ${JSON.stringify(headRef)} is not a usable branch name`);
  }
  return uniqueLocalBranchName(mainRoot, wanted);
}

/**
 * git check-ref-format's rules, applied to a branch name we are about to have
 * git create (`git worktree add -b`): a rejected name should surface as our
 * message naming the PR head, not as git's plumbing error.
 */
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function isValidBranchName(name) {
  if (typeof name !== 'string' || name === '' || name === '@' || name.length > 255) return false;
  if (name.startsWith('/') || name.startsWith('-') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (name.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'))) return false;
  // eslint-disable-next-line no-control-regex -- git forbids these bytes in refs
  return !/[\s~^:?*[\]\\\u0000-\u001f\u007f]/.test(name);
}

function isValidBaseSelector(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (FULL_OID.test(value)) return true;
  for (const prefix of ['refs/heads/', 'refs/remotes/origin/']) {
    if (value.startsWith(prefix)) return isValidBranchName(value.slice(prefix.length));
  }
  return isValidBranchName(value);
}

export function validateWorktreeSelectors({ base, branchName, intent = 'checkout', pull, requireVerifiedPull = false } = {}) {
  if (base !== undefined && !isValidBaseSelector(base)) {
    throw new Error(`worktree: base ${JSON.stringify(base)} is not allowed`);
  }
  if (branchName !== undefined && !isValidBranchName(branchName)) {
    throw new Error(`worktree: branch ${JSON.stringify(branchName)} is not allowed`);
  }
  if (intent === 'pr-checkout') {
    if (!pull || !Number.isSafeInteger(pull.number) || pull.number <= 0 || !isValidBranchName(pull.headRef)) {
      throw new Error('worktree: pr-checkout requires a positive pull.number and valid pull.headRef');
    }
    if (pull.baseRef && !isValidBaseSelector(pull.baseRef)) {
      throw new Error(`worktree: base ${JSON.stringify(pull.baseRef)} is not allowed`);
    }
    if (requireVerifiedPull && (!FULL_OID.test(pull.headSha || '') || !forgeRepositoryKey(pull))) {
      throw new Error(`worktree: pr-checkout requires an exact head SHA and repository identity (headSha=${typeof pull.headSha}, repository=${forgeRepositoryKey(pull) || 'missing'})`);
    }
  }
}

/**
 * Materialize one PR head as a local branch (paseo's fetchWorktreeCheckoutRefs):
 * the forge's universal `refs/pull/<N>/head` is the only ref that exists for a
 * fork's contribution, so it is fetched from origin first and upstream second.
 *
 * The head lands in a throwaway ref and its SHA is returned; the caller then
 * creates the local branch through `git worktree add -b <name> <sha>`, so git
 * itself owns branch-name validity and uniqueness (fetching straight into
 * `refs/heads/<name>` raced with the add). `--force` matches paseo: a re-run
 * refreshes a stale copy.
 */
async function fetchPrHead(mainRoot, number, headRef, expected) {
  const remotes = [];
  const expectedRepositoryKey = forgeRepositoryKey(expected);
  for (const remote of ['origin', 'upstream']) {
    const url = await remoteUrl(mainRoot, remote);
    if (url) remotes.push({ remote, identity: parseGithubRemote(url), ref: `refs/pull/${number}/head` });
  }
  const hasForgeIdentity = remotes.some((candidate) => candidate.identity);
  const candidates = hasForgeIdentity
    ? remotes.filter((candidate) => forgeRepositoryKey(candidate.identity) === expectedRepositoryKey)
    : remotes;
  if (candidates.length === 0) {
    throw new Error('worktree: repository has no origin/upstream remote to fetch a pull request from');
  }
  const tempRef = `refs/dsh-better-workspaces/pr/${number}/${randomUUID()}`;
  const failures = [];
  let outcome = null;
  let primaryError = null;
  try {
    for (const candidate of candidates) {
      // Default exit-0 contract: a missing remote ref must reach the failure
      // branch below. Accepting arbitrary non-zero exits once made a stale temp
      // ref from an earlier run look like a fresh fetch.
      const r = await runGit(['fetch', candidate.remote, `+${candidate.ref}:${tempRef}`, '--force'], {
        cwd: mainRoot,
        timeout: 120000,
      });
      if (r.ok) {
        const sha = (await runGit(['rev-parse', '--verify', '--quiet', `${tempRef}^{commit}`], { cwd: mainRoot })).stdout.trim();
        if (FULL_OID.test(sha) && sha.toLowerCase() === expected.headSha.toLowerCase()) {
          outcome = { sha, remote: candidate.remote, ref: candidate.ref };
          break;
        }
        failures.push(`${candidate.remote} ${candidate.ref}: fetched head did not match verified SHA`);
      } else {
        failures.push(`${candidate.remote} ${candidate.ref}: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`);
      }
    }
    if (!outcome) throw new Error(`worktree: unable to fetch pull request #${number} — ${failures.join(' | ')}`.slice(0, 600));
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await runGit(['rev-parse', '--verify', '--quiet', tempRef], { cwd: mainRoot });
    if (!current.ok) {
      if (typeof current.code === 'number') {
        cleanupError = null;
        break;
      }
      cleanupError = current.error || current.stderr.trim() || 'temporary ref inspection failed';
      continue;
    }
    const oid = current.stdout.trim();
    const removed = await runGit(['update-ref', '-d', tempRef, oid], { cwd: mainRoot });
    if (removed.ok) {
      cleanupError = null;
      break;
    }
    cleanupError = removed.stderr.trim() || removed.stdout.trim() || `exit ${removed.code}`;
  }
  const remains = await runGit(['rev-parse', '--verify', '--quiet', tempRef], { cwd: mainRoot });
  if (remains.ok || typeof remains.code !== 'number') {
    const message = `worktree: temporary PR ref cleanup failed: ${cleanupError || remains.error || tempRef}`;
    throw new Error(primaryError ? `${String(primaryError.message || primaryError)}; ${message}` : message, primaryError ? { cause: primaryError } : undefined);
  }
  if (primaryError) throw primaryError;
  return outcome;
}

/** Resolve one base name/ref pair (exact refs verify; bare names prefer origin). */
async function resolveBase(mainRoot, rawBase) {
  // exact refs (the picker sends refs/heads/x or refs/remotes/origin/x —
  // paseo resolveBaseBranchForWorktree parity) verify and are used as-is;
  // bare names keep the origin-first fallback
  let baseName;
  let baseRef;
  if (typeof rawBase === 'string' && FULL_OID.test(rawBase)) {
    const verify = await runGit(['rev-parse', '--verify', '--quiet', `${rawBase}^{commit}`], { cwd: mainRoot });
    if (!verify.ok) throw new Error(`worktree: base oid ${JSON.stringify(rawBase)} does not exist`);
    baseName = rawBase.slice(0, 12);
    baseRef = verify.stdout.trim();
  } else if (typeof rawBase === 'string' && rawBase.startsWith('refs/')) {
    const prefix = rawBase.startsWith('refs/heads/')
      ? 'refs/heads/'
      : rawBase.startsWith('refs/remotes/origin/')
        ? 'refs/remotes/origin/'
        : null;
    if (!prefix || !isValidBranchName(rawBase.slice(prefix.length))) {
      throw new Error(`worktree: base ref ${JSON.stringify(rawBase)} is not allowed`);
    }
    const verify = await runGit(['rev-parse', '--verify', '--quiet', `${rawBase}^{commit}`], { cwd: mainRoot });
    if (!verify.ok) throw new Error(`worktree: base ref ${JSON.stringify(rawBase)} does not exist`);
    baseRef = rawBase;
    baseName = rawBase.slice(prefix.length);
  } else {
    baseName = rawBase;
    if (!isValidBranchName(baseName)) throw new Error(`worktree: base branch ${JSON.stringify(baseName)} is not allowed`);
    if (await hasRemoteBranch(mainRoot, baseName)) baseRef = `refs/remotes/origin/${baseName}`;
    else if (await hasLocalBranch(mainRoot, baseName)) baseRef = `refs/heads/${baseName}`;
    else throw new Error(`worktree: base branch ${JSON.stringify(baseName)} does not exist`);
  }
  return { baseName, baseRef };
}

export async function createWorktree(opts) {
  const {
    repoRoot,
    base,
    intent = 'checkout',
    branchName,
    slug,
    sourceTitle,
    pull,
    creationTxId = null,
    creationFingerprint = null,
    metadataWriter = writeMetadata,
    beforeAdd = null,
  } = opts;
  if (typeof metadataWriter !== 'function') throw new Error('worktree: metadataWriter must be a function');
  if ((creationTxId !== null && !isValidCreationTxId(creationTxId))
    || (creationFingerprint !== null && !/^[a-f0-9]{64}$/.test(creationFingerprint))
    || ((creationTxId === null) !== (creationFingerprint === null))) {
    throw new Error('worktree: invalid creation transaction');
  }
  if (beforeAdd !== null && typeof beforeAdd !== 'function') throw new Error('worktree: beforeAdd must be a function');
  if (!repoRoot) throw new Error('worktree: repoRoot is required');
  validateWorktreeSelectors({ base, branchName, intent, pull, requireVerifiedPull: intent === 'pr-checkout' });
  const detect = await runGit(['rev-parse', '--show-toplevel'], { cwd: repoRoot });
  if (!detect.ok) throw new Error(`worktree: ${repoRoot} is not a git repository`);
  const mainRoot = await mainRepoRootOf(repoRoot);
  const prMode = intent === 'pr-checkout';
  // The PR path derives its base from the pull request itself, not from the
  // caller's branch: the PR's base branch IS the diff baseline (paseo parity).
  const rawBase = prMode ? null : base || (await defaultBranchOf(mainRoot));
  if (!prMode && !rawBase) throw new Error('worktree: cannot resolve a base branch (empty repository?)');
  const resolvedBase = prMode ? { baseName: null, baseRef: null } : await resolveBase(mainRoot, rawBase);
  let baseName = resolvedBase.baseName;
  let baseRef = resolvedBase.baseRef;
  let baseSha = null;
  if (!prMode && baseRef) {
    const resolved = await runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: mainRoot });
    if (!resolved.ok || !FULL_OID.test(resolved.stdout.trim())) throw new Error('worktree: base did not resolve to a commit');
    baseSha = resolved.stdout.trim();
  }

  const root = await prepareManagedRoot(mainRoot);
  const recovery = await withoutPinnedGitEnvironment(() => recoverPendingTransactions(mainRoot));
  if (recovery.errors.some((item) => item.stage === 'repo-owner-changed')) {
    throw new Error('worktree: pending transaction recovery refused a replaced repository');
  }
  // Unproven orphan transactions are quarantined leaks, not a reason to deny
  // every future uniquely-named creation in the same repository.
  const recoveryWarnings = recovery.errors.map((item) => ({
    stage: `recovery-${item.stage}`,
    message: item.message || item.path || 'pending transaction preserved',
  }));
  if (creationTxId) {
    const existing = await findWorktreeCreation(mainRoot, creationTxId, creationFingerprint);
    if (existing.status === 'committed') {
      return {
        ...existing.result,
        replayed: true,
        ...(recoveryWarnings.length > 0 ? { warnings: recoveryWarnings } : {}),
      };
    }
    if (existing.status !== 'absent') {
      const error = new Error(`worktree: creation transaction ${existing.status} (${existing.reason || existing.path || creationTxId})`);
      error.code = existing.status === 'pending' ? 'WORKTREE_TX_PENDING' : 'WORKTREE_TX_CONFLICT';
      throw error;
    }
  }

  let finalBranch;
  let copiedFrom = null;
  let autoNameEligible = false;
  let prHeadSha = null;
  let prUpstream = null;
  let addArgs; // args AFTER `git worktree add <path>`
  const rollbackBranches = [];
  const existing = await listWorktreesRaw(mainRoot);
  const checkedOutBranches = new Set(existing.map((w) => w.branch).filter(Boolean));

  if (intent === 'branch-off') {
    // paseo semantics: placeholder branch cut from the base — seeded by the
    // caller's slug (mnemonic) when no explicit branch name was requested;
    // slugless callers get a server-side mnemonic. Explicit names are final.
    const wanted = branchName || (slug ? slugify(slug) : '') || mnemonicSlug();
    if (!isValidBranchName(wanted)) throw new Error(`worktree: branch ${JSON.stringify(wanted)} is not allowed`);
    autoNameEligible = !branchName;
    finalBranch = await uniqueLocalBranchName(mainRoot, wanted);
    rollbackBranches.push(finalBranch);
    addArgs = ['-b', finalBranch, '--no-track', baseSha];
  } else if (prMode) {
    // PR checkout (paseo's checkout-change-request): the PR's head becomes a
    // local branch, fetched from the forge's universal head ref rather than
    // from the contributor's branch name — that is the only ref that exists
    // for a fork PR. Same-repo PRs track origin/<headRef>; fork PRs get the
    // `<owner>/<headRef>` local name and NO upstream (push semantics stay
    // explicit unless the user asks for a remote).
    const anchor = await anchorLocalBranchName(mainRoot, pull.forkOwner, pull.headRef);
    const pulled = await fetchPrHead(mainRoot, pull.number, anchor, pull);
    finalBranch = anchor;
    rollbackBranches.push(finalBranch);
    addArgs = ['-b', finalBranch, '--no-track', pulled.sha];
    prHeadSha = pulled.sha;
    prUpstream = pulled.remote === 'origin' && !pull.forkOwner ? pull.headRef : null;
    if (pull.baseRef) {
      const resolved = await resolveBaseTolerant(mainRoot, pull.baseRef);
      if (resolved.baseRef) {
        baseName = resolved.baseName;
        baseRef = resolved.baseRef;
        const resolvedOid = await runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: mainRoot });
        baseSha = resolvedOid.ok && FULL_OID.test(resolvedOid.stdout.trim()) ? resolvedOid.stdout.trim() : null;
      }
    }
  } else {
    // checkout intent
    const target = branchName || baseName;
    if (!isValidBranchName(target)) throw new Error(`worktree: branch ${JSON.stringify(target)} is not allowed`);
    if (await hasLocalBranch(mainRoot, target)) {
      if (checkedOutBranches.has(target)) {
        // branch already checked out elsewhere → unique copy branch (paseo behavior)
        copiedFrom = target;
        finalBranch = await uniqueLocalBranchName(mainRoot, target);
        rollbackBranches.push(finalBranch);
        addArgs = ['-b', finalBranch, '--no-track', `refs/heads/${target}`];
      } else {
        finalBranch = target;
        addArgs = [target];
      }
    } else if (await hasRemoteBranch(mainRoot, target)) {
      // Create the local tracking branch atomically as part of worktree add.
      // A check-then-fetch into refs/heads could race another branch creator
      // and make rollback delete a ref this call never owned.
      finalBranch = target;
      rollbackBranches.push(finalBranch);
      addArgs = ['-b', finalBranch, '--track', `refs/remotes/origin/${target}`];
    } else {
      throw new Error(`worktree: branch ${JSON.stringify(target)} exists neither locally nor on origin`);
    }
  }

  const finalPath = await uniquePath(join(root, slugify(slug || finalBranch)));
  const creationSource = addArgs.length === 1 ? `refs/heads/${finalBranch}` : addArgs[addArgs.length - 1];
  const creationCommit = await runGit(['rev-parse', '--verify', `${creationSource}^{commit}`], { cwd: mainRoot });
  if (!creationCommit.ok || !FULL_OID.test(creationCommit.stdout.trim())) {
    throw new Error('worktree: cannot capture immutable creation commit');
  }
  const expectedCreationOid = creationCommit.stdout.trim();
  const mainIdentity = await stat(mainRoot);
  const transaction = {
    version: 1,
    txId: creationTxId || randomUUID(),
    requestFingerprint: creationFingerprint,
    ownerPid: process.pid,
    mainRepoRoot: mainRoot,
    mainIdentity: { dev: String(mainIdentity.dev), ino: String(mainIdentity.ino) },
    path: finalPath,
    branch: finalBranch,
    expectedOid: expectedCreationOid,
    phase: 'prepared',
    ownsBranch: false,
    plansBranchCreation: rollbackBranches.includes(finalBranch),
    createdAt: Date.now(),
  };
  const journalFile = await writePendingJournal(root, transaction);
  let journalWarning = null;
  let added = false;
  let addedOwnership = null;
  let tracked = null;
  const ownedBranchOids = new Map();
  try {
    if (beforeAdd) await beforeAdd({ mainRoot, path: finalPath, branch: finalBranch, expectedOid: expectedCreationOid });
    await requireDirectDirectory(root, 'repository managed root');
    // git worktree add <path> [-b <new> --no-track <base> | <branch>]
    const result = await runGit(['worktree', 'add', finalPath, ...addArgs], {
      cwd: mainRoot,
      timeout: 120000,
      parentGuard: true,
    });
    if (!result.ok) {
      throw new Error(`worktree: git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    added = true;
    for (const branch of new Set(rollbackBranches)) {
      const oid = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: mainRoot });
      if (!oid.ok || !FULL_OID.test(oid.stdout.trim())) throw new Error(`worktree: cannot record ownership of branch ${branch}`);
      ownedBranchOids.set(branch, oid.stdout.trim());
    }
    const [bindingList, bindingHead] = await Promise.all([
      runGit(['worktree', 'list', '--porcelain'], { cwd: mainRoot }),
      withoutPinnedGitEnvironment(() => runGit(['rev-parse', '--verify', 'HEAD'], { cwd: finalPath })),
    ]);
    const bindingRow = bindingList.ok && bindingList.stdout
      .split(/\n\s*\n/)
      .find((row) => worktreeRowHasPath(row, finalPath));
    if (!bindingRow
      || !bindingRow.split('\n').includes(`branch refs/heads/${finalBranch}`)
      || !bindingRow.split('\n').includes(`HEAD ${expectedCreationOid}`)
      || !bindingHead.ok
      || bindingHead.stdout.trim() !== expectedCreationOid) {
      throw new Error('worktree: cannot prove post-add worktree/branch ownership');
    }
    const gitDirResult = await withoutPinnedGitEnvironment(() => runGit(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: finalPath }));
    if (!gitDirResult.ok) throw new Error('worktree: cannot capture post-add gitdir identity');
    const gitDir = await realpath(gitDirResult.stdout.trim());
    const [pathIdentity, gitDirIdentity] = await Promise.all([stat(finalPath), stat(gitDir)]);
    const addedTransaction = {
      ...transaction,
      phase: 'added',
      ownsBranch: ownedBranchOids.has(finalBranch),
      gitDir,
      pathIdentity: { dev: String(pathIdentity.dev), ino: String(pathIdentity.ino) },
      gitDirIdentity: { dev: String(gitDirIdentity.dev), ino: String(gitDirIdentity.ino) },
    };
    await replacePendingJournal(journalFile, addedTransaction);
    addedOwnership = addedTransaction;

  // Same-repo PRs track the head branch's remote-tracking ref (paseo's
  // trackOriginHead); a fork PR keeps an empty upstream on purpose — the
  // contributor's branch is not ours to push to, and a tracking ref named
  // origin/<headRef> would point at the BASE repository's branch of that name
  // rather than at the fork's commit. A same-repo branch tracks only an
  // already-fetched origin ref that resolves to the exact PR head. Never
  // manufacture or overwrite a remote-tracking ref from client metadata.
  if (prUpstream && prHeadSha) {
    const trackRef = `refs/remotes/origin/${prUpstream}`;
    const existingTrack = await runGit(['rev-parse', '--verify', '--quiet', `${trackRef}^{commit}`], { cwd: mainRoot });
    if (existingTrack.ok && existingTrack.stdout.trim() === prHeadSha) {
      const track = await withoutPinnedGitEnvironment(() => runGit(['branch', `--set-upstream-to=origin/${prUpstream}`, finalBranch], {
        cwd: finalPath,
      }));
      if (track.ok) tracked = `origin/${prUpstream}`;
    }
  }

  const metadata = {
    version: METADATA_VERSION,
    baseRef: baseSha,
    baseRefName: baseName,
    intent,
    branch: finalBranch,
    copiedFrom,
    slug: basename(finalPath),
    mainRepoRoot: mainRoot,
    createdAt: Date.now(),
    ...(creationTxId ? { creationTxId, creationFingerprint } : {}),
    // PR provenance remains authoritative even when the local checkout branch
    // is owner-prefixed or uniquified; status and mutations must never infer a
    // PR identity from that local branch name.
    ...(prMode
      ? {
          pullNumber: pull.number,
          pullHeadRef: pull.headRef,
          pullHost: pull.host,
          pullOwner: pull.owner,
          pullRepo: pull.repo,
          ...(pull.forkOwner ? { pullForkOwner: pull.forkOwner } : {}),
          ...(prHeadSha ? { prHeadSha } : {}),
          ...(tracked ? { upstream: tracked } : {}),
        }
      : {}),
    // sidebar-title provenance: the workspace the session was launched from
    ...(typeof sourceTitle === 'string' && sourceTitle.trim()
      ? { sourceWorkspaceTitle: sourceTitle.trim().slice(0, 100) }
      : {}),
    // first-message LLM rename eligibility (ADR 0004): only auto-placeholder
    // branches are rename candidates; user-chosen names are final
    ...(intent === 'branch-off'
      ? {
          autoName: autoNameEligible
            ? { status: 'pending', placeholder: finalBranch }
            : { status: 'ineligible' },
        }
      : {}),
  };
    await requireDirectDirectory(root, 'repository managed root');
    const createdReal = await realpath(finalPath);
    if (!pathIsInside(root, createdReal)) throw new Error('worktree: created path escaped the managed root');
    await withoutPinnedGitEnvironment(() => metadataWriter(finalPath, metadata));
    const committed = await withoutPinnedGitEnvironment(() => validateManagedWorktree(finalPath, { expectedMainRoot: mainRoot }));
    if (!committed.ok || committed.metadata.branch !== finalBranch) {
      throw new Error(`worktree: creation postcondition failed (${committed.reason || 'branch-mismatch'})`);
    }
    const createdHead = await withoutPinnedGitEnvironment(() => runGit(['rev-parse', '--verify', 'HEAD'], { cwd: finalPath }));
    if (!createdHead.ok || !FULL_OID.test(createdHead.stdout.trim())
      || createdHead.stdout.trim() !== expectedCreationOid) {
      throw new Error('worktree: created HEAD does not match the immutable creation commit');
    }
    try {
      await removePendingJournal(journalFile);
    } catch (error) {
      // The managed worktree is fully committed. Preserve a harmless journal
      // for the next replay rather than tearing down a successful creation.
      journalWarning = String(error?.message ?? error);
      await replacePendingJournal(journalFile, { ...(addedOwnership || transaction), ownerPid: null }).catch(() => {});
    }
  } catch (error) {
    const rollbackFailures = [];
    let teardownProven = !added;
    if (added) {
      // Once Git has exposed the path, ignored files or external edits may
      // exist without appearing in ordinary status. Without an exclusive
      // cross-process lease no automatic rollback can safely delete it.
      rollbackFailures.push(
        addedOwnership
          ? 'remove: added worktree preserved for manual recovery'
          : 'remove: post-add ownership could not be proven; worktree preserved',
      );
    }
    if (teardownProven) {
      for (const [branch, ownedOid] of [...ownedBranchOids.entries()].reverse()) {
        const dropped = await runGit(['update-ref', '-d', `refs/heads/${branch}`, ownedOid], { cwd: mainRoot });
        if (!dropped.ok) {
          rollbackFailures.push(`branch ${branch}: changed since creation or could not delete (${dropped.stderr.trim() || dropped.stdout.trim()})`);
          continue;
        }
        const config = await runGit(['config', '--remove-section', `branch.${branch}`], { cwd: mainRoot });
        if (!config.ok && ![1, 5].includes(config.code)) {
          rollbackFailures.push(`branch ${branch}: tracking config cleanup failed (${config.stderr.trim() || config.stdout.trim()})`);
        }
      }
    }
    for (const branch of new Set(rollbackBranches)) {
      if (teardownProven && !ownedBranchOids.has(branch)) rollbackFailures.push(`branch ${branch}: ownership was not recorded; preserved`);
    }
    if (rollbackFailures.length === 0) {
      try {
        await removePendingJournal(journalFile);
      } catch (journalError) {
        rollbackFailures.push(`journal: ${String(journalError?.message ?? journalError)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      try {
        await replacePendingJournal(journalFile, { ...(addedOwnership || transaction), ownerPid: null });
      } catch (journalError) {
        rollbackFailures.push(`journal-release: ${String(journalError?.message ?? journalError)}`);
      }
    }
    const detail = rollbackFailures.length ? `; rollback failed: ${rollbackFailures.join(' | ')}` : '';
    throw new Error(`${String(error?.message ?? error)}${detail}`, { cause: error });
  }
  return {
    path: finalPath,
    branch: finalBranch,
    baseRef: baseSha,
    baseRefName: baseName,
    copiedFrom,
    ...((recoveryWarnings.length > 0 || journalWarning) ? {
      warnings: [
        ...recoveryWarnings,
        ...(journalWarning ? [{ stage: 'journal-cleanup', message: journalWarning }] : []),
      ],
    } : {}),
    ...(prMode ? { pullNumber: pull.number, prHeadSha, upstream: tracked } : {}),
  };
}

/** Main repo root for any cwd inside the repo/worktree family (git-common-dir is `<main>/.git[/worktrees/<name>]`… the shared dir itself). */
export async function mainRepoRootOf(cwd) {
  const common = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (!common.ok) return cwd;
  // Canonical, not the forward-slash form Git prints on Windows: this value is
  // recorded in worktree metadata and creation journals, and every reader
  // compares it against a realpath-derived path (transaction recovery,
  // managed-root ownership) — ADR 0013.
  return safeRealpath(dirname(common.stdout.trim()));
}

async function defaultBranchOf(mainRoot) {
  const sym = await runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    cwd: mainRoot,
  });
  const ref = sym.stdout.trim();
  if (sym.ok && ref) {
    const short = ref.replace(/^refs\/remotes\/origin\//, '');
    return short;
  }
  for (const candidate of ['main', 'master']) {
    if (await hasLocalBranch(mainRoot, candidate)) return candidate;
    if (await hasRemoteBranch(mainRoot, candidate)) return candidate;
  }
  const head = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: mainRoot });
  return head.ok && head.stdout.trim() ? head.stdout.trim() : null;
}

/**
 * List worktrees of a repo, enriched with managed flag + metadata.
 * `currentCwd` marks the entry the caller is standing in.
 */
export async function listManagedWorktrees(repoRoot, currentCwd, options = {}) {
  const mainRoot = options.mainRepoRoot || await mainRepoRootOf(repoRoot);
  const raw = Array.isArray(options.raw) ? options.raw : await listWorktreesRaw(options.gitCwd || mainRoot);
  const root = await repoWorktreesRoot(mainRoot);
  const realCurrent = currentCwd ? await safeRealpath(currentCwd) : null;
  const realMain = await safeRealpath(mainRoot);
  const items = [];
  for (const entry of raw) {
    const real = await safeRealpath(entry.path);
    const managed = await validateManagedWorktree(entry.path, { expectedMainRoot: mainRoot });
    const metadata = managed.ok ? managed.metadata : null;
    let createdAt = null;
    try {
      createdAt = (await stat(entry.path)).mtimeMs;
    } catch {
      /* gone */
    }
    items.push({
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      detached: entry.detached,
      bare: entry.bare,
      managed: managed.ok,
      baseRefName: metadata?.baseRefName ?? null,
      createdAt,
      current: realCurrent !== null && real === realCurrent,
      isMain: real === realMain,
    });
  }
  return { mainRepoRoot: mainRoot, root, items };
}

/**
 * Archive one strongly verified managed worktree. Ownership requires canonical
 * namespace placement, valid metadata/source identity and an exact Git list
 * row. Non-force refuses dirty/unpushed state and lets Git enforce the final
 * race guard; recursive deletion is reserved for explicit force.
 */
export async function archiveWorktree(path, opts = {}) {
  const { force = false, signal, beforeRemove = null } = opts;
  if (beforeRemove !== null && typeof beforeRemove !== 'function') throw new Error('worktree: beforeRemove must be a function');
  if (signal?.aborted) return { ok: false, reason: 'aborted', message: 'archive aborted' };
  if (isDirfdPinSupported() && !opts.stableDirfd && typeof path === 'string' && !/^\/proc\/(?:self|\d+)\/fd\/\d+$/.test(path)) {
    let directory;
    try {
      directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      return { ok: false, reason: 'not-managed', message: `仅托管 worktree 可归档（${String(error?.code || error?.message || error)}）` };
    }
    try {
      return await archiveWorktree(procFdPath(directory), { ...opts, stableDirfd: true });
    } finally {
      await directory.close().catch(() => {});
    }
  }
  const stableSelector = path;
  const managed = await validateManagedWorktree(stableSelector, { allowBranchMismatch: true });
  if (!managed.ok) {
    return { ok: false, reason: 'not-managed', message: `仅托管 worktree 可归档（${managed.reason}）` };
  }
  path = managed.cwd;
  const ownedPathIdentity = await stat(path);
  const metadata = { ...managed.metadata, branch: managed.actualBranch };
  if (!force) {
    if (!metadata.branch) return { ok: false, reason: 'inspect-failed', stage: 'branch', message: 'detached managed worktree requires force' };
    const status = await runGit(['status', '--porcelain'], { cwd: path });
    if (!status.ok) {
      return { ok: false, reason: 'inspect-failed', stage: 'status', message: status.stderr.trim().slice(0, 600) };
    }
    const dirty = status.stdout.trim() !== '';
    const branch = metadata.branch;
    let unpushed = 0;
    if (branch) {
      const remoteRef = (await hasRemoteBranch(path, branch)) ? `refs/remotes/origin/${branch}` : null;
      if (remoteRef) {
        const ahead = await runGit(['rev-list', '--count', `${remoteRef}..HEAD`], { cwd: path });
        if (!ahead.ok) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: ahead.stderr.trim().slice(0, 600) };
        }
        unpushed = Number(ahead.stdout.trim());
        if (!Number.isSafeInteger(unpushed)) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: 'git rev-list returned an invalid count' };
        }
      } else {
        // No same-name remote branch. Counting EVERY commit (old rule) made
        // clean fresh worktrees unarchivable in repos whose origin lacks the
        // branch: count commits no origin ref carries instead; without any
        // origin fall back to the recorded base ref (unique-commit count).
        const hasOrigin = (await originUrl(path)) !== null;
        if (!hasOrigin && !metadata.baseRef) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: 'recorded base commit unavailable' };
        }
        const range = hasOrigin ? ['HEAD', '--not', '--remotes=origin'] : [`${metadata.baseRef}..HEAD`];
        const count = await runGit(['rev-list', '--count', ...range], { cwd: path });
        if (!count.ok) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: count.stderr.trim().slice(0, 600) };
        }
        unpushed = Number(count.stdout.trim());
        if (!Number.isSafeInteger(unpushed)) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: 'git rev-list returned an invalid count' };
        }
      }
    }
    if (dirty || unpushed > 0) {
      const parts = [];
      if (dirty) parts.push('未提交改动');
      if (unpushed > 0) parts.push(`${unpushed} 个未推送提交`);
      return {
        ok: false,
        reason: 'unsafe',
        dirty,
        unpushed,
        message: `worktree 有${parts.join('、')}`,
      };
    }
  }
  const mainRoot = managed.mainRepoRoot;
  if (signal?.aborted) return { ok: false, reason: 'aborted', message: 'archive aborted' };
  // Non-force removal is the final race guard: Git refuses if a file appears
  // after the safety probes above. Only an explicit caller force may bypass it.
  try {
    const [ambient, direct, anchored] = await Promise.all([stat(path), lstat(path), stat(stableSelector)]);
    if (direct.isSymbolicLink()
      || !direct.isDirectory()
      || ambient.dev !== ownedPathIdentity.dev
      || ambient.ino !== ownedPathIdentity.ino
      || anchored.dev !== ownedPathIdentity.dev
      || anchored.ino !== ownedPathIdentity.ino) {
      return { ok: false, reason: 'teardown-failed', stage: 'path-rebound', path };
    }
  } catch (error) {
    return { ok: false, reason: 'teardown-failed', stage: 'path-rebound', path, message: String(error?.message ?? error) };
  }
  if (beforeRemove) {
    try {
      await beforeRemove();
    } catch (error) {
      return { ok: false, reason: 'active-session', stage: 'pre-remove', path, message: String(error?.message ?? error) };
    }
  }
  const dirfdMode = isDirfdPinSupported();
  const removeArgs = ['worktree', 'remove'];
  if (dirfdMode) {
    // Git accepts `remove .` from an anchored worktree cwd. Unlike passing the
    // ambient pathname as argv, this keeps Git attached to the verified inode.
    removeArgs.push('.');
  } else {
    // Path mode must NOT run `remove .`: Git's own working directory would be
    // the directory it has to delete, and Windows refuses to remove a live
    // process's current directory (`failed to delete …: Permission denied`).
    // The verified canonical path is passed instead, with Git running from the
    // main repository; the dev/ino proof above and the postconditions below
    // remain the anchors (ADR 0013).
    removeArgs.push(path);
  }
  if (force) removeArgs.push('--force');
  const removed = await runGit(removeArgs, { cwd: dirfdMode ? stableSelector : mainRoot, timeout: 60000 });
  if (!removed.ok) {
    return {
      ok: false,
      reason: 'teardown-failed',
      stage: 'worktree-remove',
      path,
      message: removed.stderr.trim().slice(0, 600),
    };
  }
  if (!force) {
    try {
      await lstat(path);
      return {
        ok: false,
        partial: true,
        reason: 'teardown-failed',
        stage: 'path-remains',
        path,
        message: 'worktree was unregistered but its path still exists; refusing recursive deletion without force',
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return {
          ok: false,
          partial: true,
          reason: 'teardown-failed',
          stage: 'path-verify',
          path,
          message: String(error.message || error).slice(0, 600),
        };
      }
    }
  } else {
    // Git owns removal of its worktree. A second path-based recursive delete
    // would create an unavoidable replacement TOCTOU, so any surviving entry
    // is preserved for explicit inspection.
    try {
      const direct = await lstat(path);
      const stage = direct.isSymbolicLink() || !direct.isDirectory()
        || direct.dev !== ownedPathIdentity.dev || direct.ino !== ownedPathIdentity.ino
        ? 'path-rebound'
        : 'path-remains';
      return {
        ok: false,
        partial: true,
        reason: 'teardown-failed',
        stage,
        path,
        message: stage === 'path-rebound'
          ? 'worktree path was replaced after Git removal; refusing deletion'
          : 'Git unregistered the worktree but its original directory still exists',
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return {
          ok: false,
          partial: true,
          reason: 'teardown-failed',
          stage: 'path-verify',
          path,
          message: String(error?.message ?? error).slice(0, 600),
        };
      }
    }
  }
  let pathGone = false;
  try {
    await lstat(path);
  } catch (error) {
    pathGone = error?.code === 'ENOENT';
  }
  const listed = await runGit(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
  const rowRemains = listed.ok && listed.stdout
    .split(/\n\s*\n/)
    .some((row) => worktreeRowHasPath(row, path));
  if (!pathGone || !listed.ok || rowRemains) {
    return {
      ok: false,
      partial: true,
      reason: 'teardown-failed',
      stage: 'archive-postcondition',
      path,
      message: !pathGone ? 'worktree path still exists' : !listed.ok ? listed.stderr.trim().slice(0, 600) : 'Git worktree row still exists',
    };
  }
  const pruned = await runGit(['worktree', 'prune'], { cwd: mainRoot });
  return {
    ok: true,
    path,
    branch: metadata.branch,
    ...(pruned.ok ? {} : { warnings: [{ stage: 'worktree-prune', message: pruned.stderr.trim().slice(0, 600) }] }),
  };
}
