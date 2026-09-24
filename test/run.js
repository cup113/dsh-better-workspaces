/**
 * Standalone smoke test for the host layer — runs against a scratch repo in
 * a temp dir with DSH_HOME redirected, no harness needed. `npm test`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, statSync, renameSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-bw-test-'));
process.env.DSH_HOME = join(scratch, 'dshhome');
mkdirSync(process.env.DSH_HOME, { recursive: true });

const { detectRepo, resolveDefaultBranch, listBranches, diffStat, porcelainStatus, aheadBehind, runGit, withPinnedGitEnvironment, listCommits, unpushedShas } = await import('../lib/git.js');
const { createWorktree, listManagedWorktrees, readMetadata, patchMetadata, archiveWorktree, prepareWorkspaceDeletion, pendingWorkspaceDeletions, completeWorkspaceDeletion, recoverPendingTransactions, repoWorktreesRoot, worktreesRoot, validateManagedWorktree, worktreeRowHasPath, deriveWorktreeLeaf } = await import('../lib/worktree.js');
const { computeDiff, commitDiff } = await import('../lib/diff.js');
const { commitAction, pullAction, pushAction, discardAction, updateFromBaseAction, createPrAction, buildActionLadder } = await import('../lib/actions.js');
const { createGitStateHub } = await import('../lib/state.js');
const { createApi, API_PREFIX } = await import('../lib/api.js');
const { listForgeItems, pullRequestDetail, invalidateGhAuth, invalidateForgeList, ghAvailable, parseGithubRemote, prStatus, prStatusBatch, invalidatePr, createPullRequest, mergePullRequest, disableAutoMerge } = await import('../lib/forge.js');
const { createCleanupScheduler, createCreationSourceGuard, createExactWorkspaceDelete, createWorkspaceArchiveGuard } = await import('../lib/index.js');
const { hostMutationCoordinator } = await import('../lib/mutation.js');
const { createWorkspaceAuthorizer } = await import('../lib/authorize.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function verifiedPull(repoRoot, pull) {
  let headSha = 'a'.repeat(40);
  try {
    if (git(repoRoot, 'remote').split(/\s+/).includes('origin')) {
      headSha = git(repoRoot, 'ls-remote', 'origin', `refs/pull/${pull.number}/head`).trim().split(/\s+/)[0] || headSha;
    }
  } catch { /* missing-ref tests use a non-matching verified OID */ }
  return { host: 'github.com', owner: 'test-owner', repo: 'test-repo', headSha, ...pull };
}

const results = [];
async function test(label, fn) {
  try {
    await fn();
    results.push(`PASS ${label}`);
  } catch (error) {
    const detail = typeof error?.stack === 'string' ? error.stack : String(error?.message ?? error);
    results.push(`FAIL ${label}: ${detail}`);
    process.exitCode = 1;
  }
}

/* ---------------- fixture repo ---------------- */
const repo = join(scratch, 'main-repo');
mkdirSync(repo);
git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.email', 'test@dsh.local');
git(repo, 'config', 'user.name', 'DSH Test');
writeFileSync(join(repo, 'a.txt'), 'alpha\nbeta\n');
writeFileSync(join(repo, 'b.txt'), 'one\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-m', 'initial');
git(repo, 'branch', 'feature');

await test('detectRepo', async () => {
  const d = await detectRepo(repo);
  assert.equal(d.isGit, true);
  assert.equal(d.repoRoot, repo);
  assert.equal(d.isLinkedWorktree, false);
  const outside = await detectRepo(scratch);
  assert.equal(outside.isGit, false);
});

await test('branches + default branch', async () => {
  assert.equal(await resolveDefaultBranch(repo), 'main');
  const branches = await listBranches(repo);
  const names = branches.map((b) => b.name).sort();
  assert.deepEqual(names, ['feature', 'main']);
  assert.equal(branches.every((b) => b.hasLocal), true);
});

await test('runGit accepted exits never hide process failures', async () => {
  const missing = await runGit(['rev-parse', '--verify', 'refs/heads/missing'], { cwd: repo });
  assert.equal(missing.ok, false);
  assert.notEqual(missing.code, 0);

  const ordinary = await runGit(['diff', '--no-index', '--', '/dev/null', 'a.txt'], { cwd: repo });
  assert.equal(ordinary.code, 1);
  assert.equal(ordinary.ok, false, 'exit 1 is a failure unless the caller explicitly accepts it');
  const expectedDifference = await runGit(['diff', '--no-index', '--', '/dev/null', 'a.txt'], {
    cwd: repo,
    acceptedExitCodes: [0, 1],
  });
  assert.equal(expectedDifference.code, 1);
  assert.equal(expectedDifference.ok, true, 'diff --no-index is the sole exit-1 success');

  const missingExecutable = await runGit(['status'], { cwd: repo, env: { PATH: '' }, acceptedExitCodes: [0, 1] });
  assert.equal(missingExecutable.ok, false, 'ENOENT string codes must never alias accepted numeric exit 1');
  assert.equal(missingExecutable.code, 'ENOENT');

  const timedOut = await runGit(['-c', 'alias.wait=!sleep 1', 'wait'], { cwd: repo, timeout: 20, acceptedExitCodes: [0, 1] });
  assert.equal(timedOut.ok, false, 'killed/time-limited processes always fail');
  assert.equal(timedOut.timedOut, true);

  const priorCommonDir = process.env.GIT_COMMON_DIR;
  process.env.GIT_COMMON_DIR = '/definitely/not/a/git/common/dir';
  const ambientCommon = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: repo });
  if (priorCommonDir === undefined) delete process.env.GIT_COMMON_DIR;
  else process.env.GIT_COMMON_DIR = priorCommonDir;
  assert.equal(ambientCommon.ok, true, 'ambient GIT_COMMON_DIR must not retarget repository discovery');

  const guarded = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: repo, parentGuard: true });
  assert.equal(guarded.ok, true, guarded.stderr);
});

await test('runGit limiter preserves each caller pinned environment', async () => {
  const blockers = Array.from({ length: 8 }, () => runGit(['-c', 'alias.pause=!sleep .15', 'pause'], { cwd: repo }));
  const pinned = withPinnedGitEnvironment({ GIT_DIR: join(repo, '.git'), GIT_WORK_TREE: repo }, () =>
    runGit(['rev-parse', '--show-toplevel'], { cwd: scratch }));
  const result = await pinned;
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout.trim(), repo);
  await Promise.all(blockers);
});

await test('parent-guarded Git cannot outlive a killed Host worker', async () => {
  const bin = join(scratch, 'parent-guard-bin');
  const started = join(scratch, 'parent-guard-started');
  const finished = join(scratch, 'parent-guard-finished');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" config --includes --show-scope --name-only -z --get-regexp "*) exec /usr/bin/git "$@" ;;\nesac\necho started > ${JSON.stringify(started)}\nsleep 2\necho finished > ${JSON.stringify(finished)}\nexec /usr/bin/git "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const worker = spawn(process.execPath, ['test/git-parent-worker.mjs', repo, bin], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  const deadline = Date.now() + 3000;
  while (!existsSync(started) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(existsSync(started), true, 'guarded Git fixture started');
  worker.kill('SIGKILL');
  await new Promise((resolveExit) => worker.once('exit', resolveExit));
  await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
  assert.equal(existsSync(finished), false, 'orphaned Git process group was killed before side effects');
});

await test('read-only Git ignores repository fsmonitor executables', async () => {
  const marker = join(scratch, 'fsmonitor-ran');
  const payload = join(scratch, 'fsmonitor-payload');
  writeFileSync(payload, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
  chmodSync(payload, 0o755);
  git(repo, 'config', 'core.fsmonitor', payload);
  try {
    const status = await porcelainStatus(repo);
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(existsSync(marker), false);
  } finally {
    git(repo, 'config', '--unset', 'core.fsmonitor');
  }
});

await test('git observation failures are explicit unknowns', async () => {
  const status = await porcelainStatus(scratch);
  assert.equal(status.ok, false);
  assert.equal(status.dirty, null);
  const delta = await aheadBehind(repo, 'refs/heads/definitely-missing');
  assert.equal(delta.ok, false);
  assert.equal(delta.ahead, null);
  assert.equal(delta.behind, null);
  const unpushed = await unpushedShas(repo, 'refs/remotes/origin/definitely-missing');
  assert.equal(unpushed.ok, false);
  assert.equal(unpushed.shas, null);
  const commits = await listCommits(repo, 'refs/heads/definitely-missing..HEAD');
  assert.equal(commits.ok, false);
  assert.equal(commits.commits, null);
});

await test('broken HEAD is not misclassified as unborn', async () => {
  const broken = join(scratch, 'broken-head');
  mkdirSync(broken);
  git(broken, 'init', '-b', 'main');
  git(broken, 'config', 'user.email', 'test@dsh.local');
  git(broken, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(broken, 'tracked.txt'), 'committed\n');
  git(broken, 'add', '-A');
  git(broken, 'commit', '-m', 'initial');
  writeFileSync(join(broken, '.git', 'refs', 'heads', 'main'), 'bad\n');
  writeFileSync(join(broken, 'untracked.txt'), 'must not look like a new repository\n');
  const stat = await diffStat(broken, null);
  assert.equal(stat.ok, false);
  assert.equal(stat.additions, null);
  await assert.rejects(() => computeDiff(broken, { mode: 'uncommitted' }), /HEAD|reference|resolve/i);
  const hub = createGitStateHub({ emit: () => {} });
  try {
    const snapshot = await hub.snapshotFor(broken);
    assert.equal(snapshot.gitKnown.head, false);
    assert.equal(snapshot.gitKnown.aheadBehind, false);
    assert.ok(snapshot.degraded.some((entry) => entry.stage === 'head'));
    const ladder = buildActionLadder(snapshot);
    const enabledMutations = ladder.filter((entry) => !entry.readOnly && entry.kind !== 'link' && !entry.disabled);
    assert.deepEqual(enabledMutations, []);
    const discarded = await discardAction(broken, {});
    assert.equal(discarded.ok, false);
    assert.equal(discarded.stage, 'head');
    assert.equal(readFileSync(join(broken, 'untracked.txt'), 'utf8'), 'must not look like a new repository\n');
    const committed = await commitAction(broken, { message: 'must not stage' });
    assert.equal(committed.ok, false);
    assert.equal(committed.stage, 'head');
    assert.equal(git(broken, 'ls-files', '--cached', '--', 'untracked.txt').trim(), '');
  } finally {
    await hub.dispose();
  }
});

await test('porcelain -z preserves special and rename paths; no-newline text counts one line', async () => {
  const special = join(scratch, 'special-paths');
  mkdirSync(special);
  git(special, 'init', '-b', 'main');
  git(special, 'config', 'user.email', 'test@dsh.local');
  git(special, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(special, 'old name.txt'), 'old\nkeep\nstay\n');
  mkdirSync(join(special, 'contains b'));
  writeFileSync(join(special, 'contains b', 'tracked.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(special, 'contains b', 'deleted.txt'), 'delete\nme\n');
  const astralPath = 'emoji-😀\nfile.txt';
  writeFileSync(join(special, astralPath), 'before\n');
  git(special, 'add', '-A');
  git(special, 'commit', '-m', 'initial');
  git(special, 'mv', 'old name.txt', 'new "name".txt');
  writeFileSync(join(special, 'new "name".txt'), 'old\nkeep\nstay\nchanged\n');
  writeFileSync(join(special, 'contains b', 'tracked.txt'), 'one\ntwo\nthree\nfour\n');
  rmSync(join(special, 'contains b', 'deleted.txt'));
  writeFileSync(join(special, astralPath), 'before\nafter\n');
  const names = ['space name.txt', 'back\\slash.txt', 'unicodé.txt', 'line\nbreak.txt', 'bell\u0007.txt', 'vertical\u000b.txt'];
  for (const name of names) writeFileSync(join(special, name), 'one line without newline');
  const status = await porcelainStatus(special);
  assert.equal(status.ok, true);
  for (const name of names) assert.ok(status.entries.some((entry) => entry.path === name), `lossless path: ${JSON.stringify(name)}`);
  const renamed = status.entries.find((entry) => /R/.test(entry.code));
  assert.equal(renamed.path, 'new "name".txt');
  assert.equal(renamed.oldPath, 'old name.txt');
  const stat = await diffStat(special, 'HEAD');
  assert.equal(stat.ok, true);
  assert.equal(stat.additions, names.length + 3, 'no-newline files and all tracked edits count');
  const diff = await computeDiff(special, { mode: 'uncommitted' });
  for (const name of names) assert.ok(diff.files.some((entry) => entry.path === name), `diff path: ${JSON.stringify(name)}`);
  const renamedDiff = diff.files.find((entry) => entry.path === 'new "name".txt');
  assert.equal(renamedDiff.oldPath, 'old name.txt', 'rename paths stay lossless');
  assert.ok(renamedDiff.hunks.some((hunk) => hunk.lines.some((line) => line.type === 'add' && line.content === 'changed')),
    'quoted rename path still joins its parsed patch');
  const ambiguousDiff = diff.files.find((entry) => entry.path === 'contains b/tracked.txt');
  assert.ok(ambiguousDiff.hunks.some((hunk) => hunk.lines.some((line) => line.type === 'add' && line.content === 'four')),
    'an unquoted header containing the ` b/` delimiter still joins its parsed patch');
  const astralDiff = diff.files.find((entry) => entry.path === astralPath);
  assert.ok(astralDiff.hunks.some((hunk) => hunk.lines.some((line) => line.type === 'add' && line.content === 'after')),
    'astral Unicode plus a quoted newline survives C-path decoding');
  const deletedDiff = diff.files.find((entry) => entry.path === 'contains b/deleted.txt');
  assert.ok(deletedDiff.hunks.some((hunk) => hunk.lines.some((line) => line.type === 'del' && line.content === 'delete')),
    'deleted path uses its exact old marker as the patch key');
});

await test('discard handles a true unborn repository without a fake reset failure', async () => {
  const unborn = join(scratch, 'unborn-discard');
  mkdirSync(unborn);
  git(unborn, 'init', '-b', 'main');
  git(unborn, 'config', 'user.email', 'test@dsh.local');
  git(unborn, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(unborn, 'only-untracked.txt'), 'temporary\n');
  git(unborn, 'add', 'only-untracked.txt');
  const orphanTree = git(unborn, 'write-tree').trim();
  const orphanCommit = git(unborn, 'commit-tree', orphanTree, '-m', 'prefix child').trim();
  git(unborn, 'update-ref', 'refs/heads/main/topic', orphanCommit);
  git(unborn, 'rm', '--cached', 'only-untracked.txt');
  const unbornStat = await diffStat(unborn, null);
  assert.equal(unbornStat.ok, true);
  assert.equal(unbornStat.additions, 1);
  const unbornDiff = await computeDiff(unborn, { mode: 'uncommitted' });
  assert.ok(unbornDiff.files.some((entry) => entry.path === 'only-untracked.txt'));
  const result = await discardAction(unborn, {});
  assert.equal(result.ok, true);
  assert.equal(result.partial, undefined);
  assert.equal(existsSync(join(unborn, 'only-untracked.txt')), false, 'unborn discard cleans untracked files');
});

await test('host commit ignores repository hooks', async () => {
  const hooked = join(scratch, 'hooked-commit');
  mkdirSync(hooked);
  git(hooked, 'init', '-b', 'main');
  git(hooked, 'config', 'user.email', 'test@dsh.local');
  git(hooked, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(hooked, 'file.txt'), 'before\n');
  git(hooked, 'add', '-A');
  git(hooked, 'commit', '-m', 'initial');
  const hook = join(hooked, '.git', 'hooks', 'pre-commit');
  const marker = join(scratch, 'hook-ran');
  writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(hooked, 'file.txt'), 'after\n');
  const result = await commitAction(hooked, { message: 'hook-neutralized' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(existsSync(marker), false);
  assert.equal(git(hooked, 'rev-list', '--count', 'HEAD').trim(), '2');
});

await test('host commit refuses repository-defined clean filters', async () => {
  const filtered = join(scratch, 'filtered-commit');
  mkdirSync(filtered);
  git(filtered, 'init', '-b', 'main');
  git(filtered, 'config', 'user.email', 'test@dsh.local');
  git(filtered, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(filtered, 'tracked.txt'), 'one\n');
  git(filtered, 'add', '-A');
  git(filtered, 'commit', '-m', 'initial');
  const marker = join(scratch, 'clean-filter-ran');
  const payload = join(scratch, 'clean-filter');
  writeFileSync(payload, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`);
  chmodSync(payload, 0o755);
  git(filtered, 'config', 'filter.hostile.clean', payload);
  writeFileSync(join(filtered, '.gitattributes'), '* filter=hostile\n');
  writeFileSync(join(filtered, 'tracked.txt'), 'two\n');
  const result = await commitAction(filtered, { message: 'must be refused' });
  assert.equal(result.ok, false);
  assert.match(result.message, /executable Git config.*filter\.hostile\.clean/i);
  assert.equal(existsSync(marker), false);
});

await test('Git-derived branch names cannot become push options', async () => {
  const optionRepo = join(scratch, 'option-branch');
  const optionRemote = join(scratch, 'option-remote.git');
  const marker = join(scratch, 'receive-pack-option-ran');
  const payload = join(scratch, 'receive-pack-option');
  mkdirSync(optionRepo);
  git(optionRepo, 'init', '-b', 'main');
  git(optionRepo, 'config', 'user.email', 'test@dsh.local');
  git(optionRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(optionRepo, 'tracked.txt'), 'one\n');
  git(optionRepo, 'add', '-A');
  git(optionRepo, 'commit', '-m', 'initial');
  mkdirSync(optionRemote);
  git(optionRemote, 'init', '--bare');
  git(optionRepo, 'remote', 'add', 'origin', optionRemote);
  writeFileSync(payload, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
  chmodSync(payload, 0o755);
  const branch = `--exec=${payload}`;
  git(optionRepo, 'update-ref', `refs/heads/${branch}`, 'HEAD');
  git(optionRepo, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  const pushed = await pushAction(optionRepo);
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(existsSync(marker), false);
});

await test('pull never aborts a pre-existing merge', async () => {
  const merging = join(scratch, 'preexisting-merge');
  mkdirSync(merging);
  git(merging, 'init', '-b', 'main');
  git(merging, 'config', 'user.email', 'test@dsh.local');
  git(merging, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(merging, 'conflict.txt'), 'base\n');
  git(merging, 'add', '-A');
  git(merging, 'commit', '-m', 'base');
  git(merging, 'checkout', '-b', 'side');
  writeFileSync(join(merging, 'conflict.txt'), 'side\n');
  git(merging, 'commit', '-am', 'side');
  git(merging, 'checkout', 'main');
  writeFileSync(join(merging, 'conflict.txt'), 'main\n');
  git(merging, 'commit', '-am', 'main');
  const conflict = await runGit(['merge', 'side'], { cwd: merging });
  assert.equal(conflict.ok, false);
  writeFileSync(join(merging, 'conflict.txt'), 'carefully resolved\n');
  const result = await pullAction(merging);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'merge-in-progress');
  assert.equal(readFileSync(join(merging, 'conflict.txt'), 'utf8'), 'carefully resolved\n');
  assert.equal((await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: merging })).ok, true);
  git(merging, 'merge', '--abort');
});

await test('pull pins merge mode and preserves conflicts for explicit recovery', async () => {
  const local = join(scratch, 'pull-local');
  const remote = join(scratch, 'pull-remote.git');
  const peer = join(scratch, 'pull-peer');
  mkdirSync(local);
  git(local, 'init', '-b', 'main');
  git(local, 'config', 'user.email', 'test@dsh.local');
  git(local, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(local, 'conflict.txt'), 'base\n');
  git(local, 'add', '-A');
  git(local, 'commit', '-m', 'base');
  git(scratch, 'clone', '--bare', local, remote);
  git(local, 'remote', 'add', 'origin', remote);
  git(local, 'push', '-u', 'origin', 'main');
  git(scratch, 'clone', remote, peer);
  git(peer, 'config', 'user.email', 'peer@dsh.local');
  git(peer, 'config', 'user.name', 'Peer');
  writeFileSync(join(peer, 'conflict.txt'), 'remote\n');
  git(peer, 'commit', '-am', 'remote');
  git(peer, 'push');
  writeFileSync(join(local, 'conflict.txt'), 'local\n');
  git(local, 'commit', '-am', 'local');
  git(local, 'config', 'pull.rebase', 'true');
  const result = await pullAction(local);
  assert.equal(result.ok, false);
  assert.equal(result.partial, true, JSON.stringify(result));
  assert.equal(result.stage, 'merge-conflict-preserved');
  assert.ok(tryGit(local, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'));
  assert.notEqual(git(local, 'status', '--porcelain').trim(), '');
  assert.equal(existsSync(join(local, '.git', 'rebase-merge')), false);
  assert.equal(existsSync(join(local, '.git', 'rebase-apply')), false);
  git(local, 'merge', '--abort');
  assert.equal(readFileSync(join(local, 'conflict.txt'), 'utf8'), 'local\n');
});

let wt1;
let wt2;
await test('createWorktree branch-off', async () => {
  wt1 = await createWorktree({ repoRoot: repo, base: 'main', intent: 'branch-off', branchName: 'feature-x' });
  assert.ok(wt1.path.startsWith(worktreesRoot()), `path under worktrees root: ${wt1.path}`);
  assert.equal(wt1.branch, 'feature-x');
  const meta = await readMetadata(wt1.path);
  assert.equal(meta.baseRefName, 'main');
  assert.equal(meta.intent, 'branch-off');
  // the leaf carries the repo name so it is identifiable on its own (ADR 0014)
  assert.equal(meta.slug, deriveWorktreeLeaf(repo, 'feature-x'));
  assert.equal('autoName' in meta, false, 'no rename machinery is recorded any more');
});

await test('startup recovery removes abandoned temporary PR refs', async () => {
  const leakedRef = 'refs/dsh-better-workspaces/pr/injected-crash-ref';
  git(repo, 'update-ref', leakedRef, 'HEAD');
  const recovered = await recoverPendingTransactions(repo);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.ok(recovered.recovered.some((entry) => entry.ref === leakedRef));
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/dsh-better-workspaces/pr/').trim(), '');
});

await test('createWorktree preserves post-add failures for manual recovery', async () => {
  const expectedPath = join(await repoWorktreesRoot(repo), deriveWorktreeLeaf(repo, 'metadata-failure'));
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.secret\n');
  await assert.rejects(
    createWorktree({
      repoRoot: repo,
      base: 'main',
      intent: 'branch-off',
      branchName: 'metadata-failure',
      slug: 'metadata-failure',
      metadataWriter: async (path) => {
        writeFileSync(join(path, 'valuable.secret'), 'preserve me\n');
        throw new Error('injected metadata failure');
      },
    }),
    /injected metadata failure.*preserved for manual recovery/,
  );
  assert.equal(readFileSync(join(expectedPath, 'valuable.secret'), 'utf8'), 'preserve me\n');
  assert.equal((await runGit(['show-ref', '--verify', '--quiet', 'refs/heads/metadata-failure'], { cwd: repo })).ok, true);
  git(repo, 'worktree', 'remove', '--force', expectedPath);
  assert.equal((await recoverPendingTransactions(repo)).ok, true);
  assert.equal((await runGit(['show-ref', '--verify', '--quiet', 'refs/heads/metadata-failure'], { cwd: repo })).ok, false);

  const noOpPath = join(await repoWorktreesRoot(repo), deriveWorktreeLeaf(repo, 'metadata-noop'));
  await assert.rejects(
    createWorktree({
      repoRoot: repo,
      base: 'main',
      intent: 'branch-off',
      branchName: 'metadata-noop',
      slug: 'metadata-noop',
      metadataWriter: async () => {},
    }),
    /creation postcondition failed.*preserved for manual recovery/,
  );
  assert.equal(existsSync(noOpPath), true);
  assert.equal((await runGit(['show-ref', '--verify', '--quiet', 'refs/heads/metadata-noop'], { cwd: repo })).ok, true);
  git(repo, 'worktree', 'remove', '--force', noOpPath);
  assert.equal((await recoverPendingTransactions(repo)).ok, true);
  assert.equal((await runGit(['show-ref', '--verify', '--quiet', 'refs/heads/metadata-noop'], { cwd: repo })).ok, false);

  const preservedPath = join(await repoWorktreesRoot(repo), deriveWorktreeLeaf(repo, 'rollback-remove-failure'));
  await assert.rejects(
    createWorktree({
      repoRoot: repo,
      base: 'main',
      intent: 'branch-off',
      branchName: 'rollback-remove-failure',
      slug: 'rollback-remove-failure',
      metadataWriter: async () => { throw new Error('metadata failed after worktree add'); },
    }),
    /rollback failed: remove: added worktree preserved for manual recovery/,
  );
  assert.equal(existsSync(preservedPath), true, 'failed teardown preserves the worktree path');
  assert.equal((await runGit(['show-ref', '--verify', '--quiet', 'refs/heads/rollback-remove-failure'], { cwd: repo })).ok, true, 'failed teardown preserves its checked-out branch');
  const preservedRecovery = await recoverPendingTransactions(repo);
  assert.equal(preservedRecovery.ok, false, JSON.stringify(preservedRecovery));
  assert.equal(preservedRecovery.errors[0].stage, 'added-artifact-preserved');
  assert.equal(existsSync(preservedPath), true, 'startup recovery never deletes a surviving path');
  git(repo, 'worktree', 'remove', '--force', preservedPath);
  const recovered = await recoverPendingTransactions(repo);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.deepEqual(recovered.recovered, [{ path: preservedPath, action: 'rolled-back' }]);
  assert.equal((await runGit(['show-ref', '--verify', '--quiet', 'refs/heads/rollback-remove-failure'], { cwd: repo })).ok, false);

  await assert.rejects(
    createWorktree({
      repoRoot: repo,
      base: 'main',
      intent: 'branch-off',
      branchName: 'prepared-journal-victim',
      beforeAdd: async ({ expectedOid }) => {
        git(repo, 'update-ref', 'refs/heads/prepared-journal-victim', expectedOid);
        throw new Error('crash before worktree add');
      },
    }),
    /crash before worktree add/,
  );
  const preparedRecovery = await recoverPendingTransactions(repo);
  assert.equal(preparedRecovery.ok, true, JSON.stringify(preparedRecovery));
  assert.equal((await runGit(['show-ref', '--verify', '--quiet', 'refs/heads/prepared-journal-victim'], { cwd: repo })).ok, true, 'prepared journal must not claim a future same-name branch');
  git(repo, 'branch', '-D', 'prepared-journal-victim');
});

await test('recovery refuses a same-path replacement main repository', async () => {
  const ownerRepo = join(scratch, 'owner-identity-repo');
  const movedRepo = join(scratch, 'owner-identity-repo-old');
  mkdirSync(ownerRepo);
  git(ownerRepo, 'init', '-b', 'main');
  git(ownerRepo, 'config', 'user.email', 'test@dsh.local');
  git(ownerRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(ownerRepo, 'base.txt'), 'base\n');
  git(ownerRepo, 'add', '-A');
  git(ownerRepo, 'commit', '-m', 'base');
  const orphanPath = join(await repoWorktreesRoot(ownerRepo), deriveWorktreeLeaf(ownerRepo, 'owner-orphan'));
  await assert.rejects(createWorktree({
    repoRoot: ownerRepo,
    intent: 'branch-off',
    branchName: 'owner-orphan',
    metadataWriter: async () => { throw new Error('leave owner journal'); },
  }), /preserved for manual recovery/);
  git(ownerRepo, 'worktree', 'remove', '--force', orphanPath);
  renameSync(ownerRepo, movedRepo);
  cloneRepo(movedRepo, ownerRepo);
  git(ownerRepo, 'branch', 'owner-orphan', 'HEAD');
  const recovery = await recoverPendingTransactions(ownerRepo);
  assert.equal(recovery.ok, false, JSON.stringify(recovery));
  assert.equal(recovery.errors[0].stage, 'repo-owner-changed');
  assert.equal((await runGit(['show-ref', '--verify', '--quiet', 'refs/heads/owner-orphan'], { cwd: ownerRepo })).ok, true);
  rmSync(await repoWorktreesRoot(ownerRepo), { recursive: true, force: true });
});

await test('update-from-base preserves conflicts and never aborts external recovery', async () => {
  const mergeRepo = join(scratch, 'owned-merge-repo');
  mkdirSync(mergeRepo);
  git(mergeRepo, 'init', '-b', 'main');
  git(mergeRepo, 'config', 'user.email', 'test@dsh.local');
  git(mergeRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(mergeRepo, 'conflict.txt'), 'base\n');
  git(mergeRepo, 'add', '-A');
  git(mergeRepo, 'commit', '-m', 'base');
  const task = await createWorktree({ repoRoot: mergeRepo, base: 'main', intent: 'branch-off', branchName: 'owned-conflict' });
  try {
    writeFileSync(join(task.path, 'conflict.txt'), 'task\n');
    git(task.path, 'commit', '-am', 'task');
    writeFileSync(join(mergeRepo, 'conflict.txt'), 'main\n');
    git(mergeRepo, 'commit', '-am', 'main');
    const before = git(task.path, 'rev-parse', 'HEAD').trim();
    const result = await updateFromBaseAction(task.path);
    assert.equal(result.ok, false);
    assert.equal(result.reasonKey, 'actions.merge.conflict');
    assert.equal(result.partial, true, JSON.stringify(result));
    assert.equal(result.stage, 'merge-conflict-preserved');
    assert.equal(git(task.path, 'rev-parse', 'HEAD').trim(), before);
    assert.ok(tryGit(task.path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'));
    git(task.path, 'merge', '--abort');
    assert.equal(git(task.path, 'status', '--porcelain').trim(), '');

    let foreignFailed = false;
    try {
      execFileSync('git', ['merge', '--no-edit', 'main'], { cwd: task.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      foreignFailed = true;
    }
    assert.equal(foreignFailed, true, 'fixture must leave a pre-existing conflicting merge');
    const mergeHead = tryGit(task.path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD');
    assert.ok(mergeHead);
    const guarded = await updateFromBaseAction(task.path);
    assert.equal(guarded.ok, false);
    assert.equal(tryGit(task.path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')?.trim(), mergeHead.trim());
    git(task.path, 'merge', '--abort');
  } finally {
    await archiveWorktree(task.path, { force: true });
  }
});

await test('branch-off uses the immutable base OID across a moving branch', async () => {
  const movingRepo = join(scratch, 'moving-base-repo');
  mkdirSync(movingRepo);
  git(movingRepo, 'init', '-b', 'main');
  git(movingRepo, 'config', 'user.email', 'test@dsh.local');
  git(movingRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(movingRepo, 'base.txt'), 'one\n');
  git(movingRepo, 'add', '-A');
  git(movingRepo, 'commit', '-m', 'base one');
  let capturedOid = null;
  const task = await createWorktree({
    repoRoot: movingRepo,
    base: 'main',
    intent: 'branch-off',
    branchName: 'immutable-cut',
    beforeAdd: async ({ expectedOid }) => {
      capturedOid = expectedOid;
      writeFileSync(join(movingRepo, 'base.txt'), 'two\n');
      git(movingRepo, 'commit', '-am', 'base moved');
    },
  });
  assert.notEqual(git(movingRepo, 'rev-parse', 'main').trim(), capturedOid);
  assert.equal(git(task.path, 'rev-parse', 'HEAD').trim(), capturedOid);
  assert.equal((await readMetadata(task.path)).baseRef, capturedOid);
  await archiveWorktree(task.path, { force: true });
});

await test('branch-off slug fallback + repo-prefixed leaf', async () => {
  const wt = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'amber-otter-1234' });
  assert.equal(wt.branch, 'amber-otter-1234');
  const meta = await readMetadata(wt.path);
  assert.equal(meta.slug, deriveWorktreeLeaf(repo, 'amber-otter-1234'));
  assert.equal(meta.baseRefName, 'main'); // default base
  // slugless branch-off falls back to a server-side mnemonic
  const wt2 = await createWorktree({ repoRoot: repo, intent: 'branch-off' });
  assert.match(wt2.branch, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  assert.equal((await readMetadata(wt2.path)).slug, deriveWorktreeLeaf(repo, wt2.branch));
});

await test('createWorktree checkout + duplicate copy branch', async () => {
  wt2 = await createWorktree({ repoRoot: repo, intent: 'checkout', branchName: 'feature' });
  assert.equal(wt2.branch, 'feature');
  const dup = await createWorktree({ repoRoot: repo, intent: 'checkout', branchName: 'feature' });
  assert.equal(dup.copiedFrom, 'feature');
  assert.match(dup.branch, /^feature-\d+$/);
  await archiveWorktree(dup.path, { force: true });
});

/* ---------------- directory leaf derivation (ADR 0014) ---------------- */

await test('deriveWorktreeLeaf: repo-prefixed, budgeted, deterministic', async () => {
  assert.equal(deriveWorktreeLeaf('/x/cuplivo', 'fix-login'), 'cuplivo-fix-login');
  // a branch path flattens into the leaf; the slug rule keeps the characters it
  // already allowed (underscore) and folds the rest (space)
  assert.equal(deriveWorktreeLeaf('/x/cuplivo', 'feature/login'), 'cuplivo-feature-login');
  assert.equal(deriveWorktreeLeaf('/x/society_choosing', 'b'), 'society_choosing-b');
  assert.equal(deriveWorktreeLeaf('/x/my repo', 'b'), 'my-repo-b');
  // the repo half keeps its full text up to 24 characters: a truncated tail is
  // exactly the part that tells two repositories apart
  assert.equal(deriveWorktreeLeaf('/x/dsh-better-workspaces', 'fix-login'), 'dsh-better-workspaces-fix-login');
  assert.equal(deriveWorktreeLeaf(`/x/${'r'.repeat(40)}`, 'b'), `${'r'.repeat(24)}-b`);
  assert.equal(deriveWorktreeLeaf(`/x/${'a'.repeat(23)}-zzz`, 'b'), `${'a'.repeat(23)}-b`,
    'a cut landing on the separator never leaves a doubled hyphen');
  // the branch half is capped at 40, keeping a leaf inside a Windows-safe budget
  assert.equal(deriveWorktreeLeaf('/x/repo', 'b'.repeat(60)), `repo-${'b'.repeat(40)}`);
  assert.ok(deriveWorktreeLeaf(`/x/${'r'.repeat(24)}`, 'b'.repeat(40)).length <= 65);
  // a name with no path-safe characters degrades to the slug fallback
  assert.equal(deriveWorktreeLeaf('/x/中文仓库', 'fix-login'), 'wt-fix-login');
  assert.equal(deriveWorktreeLeaf('/x/repo', ''), 'repo-wt');
});

await test('createWorktree: a named branch-off keeps its picked base and records no rename state', async () => {
  git(repo, 'branch', 'form-base', 'main');
  const wt = await createWorktree({
    repoRoot: repo,
    intent: 'branch-off',
    branchName: 'form-named',
    base: 'refs/heads/form-base',
  });
  assert.equal(wt.branch, 'form-named');
  assert.equal(wt.baseRefName, 'form-base', 'the picked base travels with the name (ADR 0014)');
  assert.equal(wt.baseRef, git(repo, 'rev-parse', 'refs/heads/form-base').trim());
  const meta = await readMetadata(wt.path);
  assert.equal(meta.slug, deriveWorktreeLeaf(repo, 'form-named'));
  assert.equal('autoName' in meta, false, 'the rename machinery is gone, not merely disabled');
  await archiveWorktree(wt.path, { force: true });
  git(repo, 'branch', '-D', 'form-base');
});

await test('listManagedWorktrees', async () => {
  const list = await listManagedWorktrees(repo, wt1.path);
  assert.equal(list.items.length >= 3, true); // main + wt1 + wt2
  const main = list.items.find((i) => i.isMain);
  assert.ok(main);
  assert.equal(main.managed, false);
  const w1 = list.items.find((i) => i.path === wt1.path);
  assert.equal(w1.managed, true);
  assert.equal(w1.current, true);
  assert.equal(w1.baseRefName, 'main');
});

await test('diffStat + porcelain + computeDiff (uncommitted)', async () => {
  writeFileSync(join(wt1.path, 'a.txt'), 'alpha\nbeta\ngamma\n');
  writeFileSync(join(wt1.path, 'new.txt'), 'fresh\nfile\n');
  const status = await porcelainStatus(wt1.path);
  assert.equal(status.ok, true);
  assert.equal(status.dirty, true);
  const stat = await diffStat(wt1.path, 'main');
  assert.equal(stat.ok, true);
  assert.equal(stat.additions, 3); // 1 modified line + 2 untracked lines
  assert.equal(stat.deletions, 0);
  const diff = await computeDiff(wt1.path, { mode: 'uncommitted' });
  const paths = diff.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.txt', 'new.txt']);
  const a = diff.files.find((f) => f.path === 'a.txt');
  assert.equal(a.status, 'modified');
  assert.equal(a.hunks.length, 1);
  const added = a.hunks[0].lines.filter((l) => l.type === 'add').map((l) => l.content);
  assert.deepEqual(added, ['gamma']);
  const n = diff.files.find((f) => f.path === 'new.txt');
  assert.equal(n.untracked, true);
  assert.equal(n.status, 'added');
});

await test('commitAction + aheadBehind + base diff + commitDiff', async () => {
  const r = await commitAction(wt1.path, { message: 'wip: gamma + new' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ab = await aheadBehind(wt1.path, 'main');
  assert.equal(ab.ok, true);
  assert.equal(ab.ahead, 1);
  assert.equal(ab.behind, 0);
  const diff = await computeDiff(wt1.path, { mode: 'base' });
  assert.equal(diff.files.length, 2);
  const sha = git(wt1.path, 'rev-parse', 'HEAD').trim();
  const cd = await commitDiff(wt1.path, sha);
  assert.equal(cd.files.length, 2);
  assert.equal(cd.isMerge, false);
});

await test('hub supports an authorized root with a separate Git directory', async () => {
  const work = join(scratch, 'separate-work');
  const gitDir = join(scratch, 'separate-git');
  mkdirSync(work);
  git(scratch, 'init', '--separate-git-dir', gitDir, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  writeFileSync(join(work, 'tracked.txt'), 'separate\n');
  git(work, 'add', 'tracked.txt');
  git(work, 'commit', '-m', 'separate root');
  git(work, 'branch', '-M', 'main');
  const authorizer = createWorkspaceAuthorizer({ workspaceRoots: () => [work] });
  const hub = createGitStateHub({ authorizeTarget: (cwd) => authorizer.authorize(cwd) });
  try {
    const snapshot = await hub.snapshotFor(work, { fresh: true });
    assert.equal(snapshot.isGit, true);
    assert.equal(snapshot.branch, 'main');
    assert.equal(snapshot.repoRoot, work);
  } finally {
    await hub.dispose();
  }
});

await test('hub snapshotFor + fingerprint + invalidate', async () => {
  const emitted = [];
  const hub = createGitStateHub({ onChange: (s) => emitted.push(s) });
  try {
    const snap = await hub.snapshotFor(wt1.path);
    assert.equal(snap.isGit, true);
    assert.equal(snap.branch, 'feature-x');
    assert.equal(snap.managed, true);
    assert.equal(snap.baseRefName, 'main');
    assert.equal(snap.aheadBehind.ahead, 1);
    assert.equal(snap.dirty, false);
    assert.equal(snap.diffStat.additions, 3);
    assert.deepEqual(snap.gitKnown, { head: true, status: true, aheadBehind: true, originDelta: true, diffStat: true });
    assert.deepEqual(snap.degraded, []);
    assert.equal(snap.forgeAuth, 'no_remote');
    assert.equal(snap.pr, null);
    const neg = await hub.snapshotFor(scratch);
    assert.equal(neg.isGit, false);
    // mutate → invalidate → dirty snapshot emitted via SSE path
    writeFileSync(join(wt1.path, 'b.txt'), 'one\ntwo\n');
    hub.invalidate(wt1.path);
    await new Promise((r) => setTimeout(r, 800));
    const snap2 = await hub.snapshotFor(wt1.path);
    assert.equal(snap2.dirty, true);
    assert.ok(emitted.length >= 1, 'onChange emitted at least once');
    git(wt1.path, 'checkout', '--', 'b.txt');
  } finally {
    await hub.dispose();
  }
});

await test('hub falls back to immutable base when its branch name disappears', async () => {
  const orphanedBase = await createWorktree({ repoRoot: repo, base: 'main', intent: 'branch-off', branchName: 'orphaned-base' });
  writeFileSync(join(orphanedBase.path, 'base-fallback.txt'), 'task\n');
  git(orphanedBase.path, 'add', '-A');
  git(orphanedBase.path, 'commit', '-m', 'task commit');
  const metadata = await readMetadata(orphanedBase.path);
  git(repo, 'branch', '-m', 'main', 'relocated-main');
  const hub = createGitStateHub({ emit: () => {} });
  try {
    const snapshot = await hub.snapshotFor(orphanedBase.path);
    assert.equal(snapshot.baseRefName, 'main');
    assert.equal(snapshot.baseRef, metadata.baseRef);
    assert.equal(snapshot.gitKnown.aheadBehind, true);
    assert.equal(snapshot.aheadBehind.ahead, 1);
    assert.ok(snapshot.diffStat.additions >= 1);
  } finally {
    await hub.dispose();
    git(repo, 'branch', '-m', 'relocated-main', 'main');
    await archiveWorktree(orphanedBase.path, { force: true });
  }
});

await test('hub dispose fences an in-flight target detection', async () => {
  const slowBin = join(scratch, 'slow-git-bin');
  mkdirSync(slowBin);
  writeFileSync(join(slowBin, 'git'), '#!/bin/sh\nsleep 0.15\nexec /usr/bin/git "$@"\n');
  chmodSync(join(slowBin, 'git'), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${slowBin}:${originalPath}`;
  const emitted = [];
  const hub = createGitStateHub({ onChange: (snapshot) => emitted.push(snapshot) });
  try {
    const computing = hub.snapshotFor(repo);
    const disposing = hub.dispose();
    const [snapshot] = await Promise.all([computing, disposing]);
    assert.equal(snapshot.isGit, false, 'disposed generation must not publish a late target');
    assert.deepEqual(emitted, []);
    assert.equal(hub.isKnownGit(repo), false);
  } finally {
    process.env.PATH = originalPath;
    await hub.dispose();
  }
});

await test('hub background compute drops a revoked Workspace capability', async () => {
  const wt = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'hub-auth-revoke' });
  const identity = statSync(wt.path);
  const mainIdentity = statSync(repo);
  let allowed = true;
  let markRevokedCheck;
  const revokedCheck = new Promise((resolveCheck) => { markRevokedCheck = resolveCheck; });
  const emitted = [];
  const hub = createGitStateHub({
    onChange: (snapshot) => emitted.push(snapshot),
    authorizeTarget: async (cwd) => {
      if (!allowed) {
        markRevokedCheck();
        return { ok: false, reason: 'unauthorized' };
      }
      return { ok: true, cwd, root: cwd, mainRepoRoot: repo, gitBoundary: 'root', identity: { dev: identity.dev, ino: identity.ino }, mainIdentity: { dev: mainIdentity.dev, ino: mainIdentity.ino } };
    },
  });
  try {
    const initial = await hub.snapshotFor(wt.path, { fresh: true });
    assert.equal(initial.isGit, true);
    const emittedBefore = emitted.length;
    allowed = false;
    writeFileSync(join(wt.path, 'revoked-change.txt'), 'must not publish\n');
    hub.refreshActive();
    let revokeTimeout;
    await Promise.race([
      revokedCheck,
      new Promise((_, reject) => { revokeTimeout = setTimeout(() => reject(new Error('background compute did not reauthorize')), 3000); }),
    ]);
    clearTimeout(revokeTimeout);
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(hub.peek(wt.path), null);
    assert.equal(hub.isKnownGit(wt.path), false);
    assert.equal(emitted.length, emittedBefore);
  } finally {
    await hub.dispose();
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('hub fences an older authorize result after a concurrent revocation', async () => {
  const wt = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'hub-auth-inverse' });
  const identity = statSync(wt.path);
  const mainIdentity = statSync(repo);
  const capability = { ok: true, cwd: wt.path, root: wt.path, mainRepoRoot: repo, gitBoundary: 'root', identity: { dev: identity.dev, ino: identity.ino }, mainIdentity: { dev: mainIdentity.dev, ino: mainIdentity.ino } };
  let deferred = false;
  const checks = [];
  const hub = createGitStateHub({
    authorizeTarget: async () => {
      if (!deferred) return capability;
      return new Promise((resolveCheck) => checks.push(resolveCheck));
    },
  });
  try {
    assert.equal((await hub.snapshotFor(wt.path, { fresh: true })).isGit, true);
    deferred = true;
    const older = hub.snapshotFor(wt.path);
    const revoke = hub.snapshotFor(wt.path);
    while (checks.length < 2) await new Promise((resolveTurn) => setImmediate(resolveTurn));
    checks[1]({ ok: false, reason: 'unauthorized' });
    assert.equal((await revoke).isGit, false);
    checks[0](capability);
    assert.equal((await older).isGit, false);
    assert.equal(hub.isKnownGit(wt.path), false);
  } finally {
    for (const resolveCheck of checks) resolveCheck({ ok: false, reason: 'unauthorized' });
    await hub.dispose();
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('action ladder (synthetic snapshots)', async () => {
  const clean = {
    branch: 'feature-x', dirty: false, remote: 'git@github.com:o/r.git', github: { owner: 'o', repo: 'r' },
    aheadBehind: { ahead: 2, behind: 1 }, upstream: { ref: 'refs/remotes/origin/feature-x', ahead: 1, behind: 1 },
    originDelta: null, pr: null, managed: true, baseRefName: 'main',
  };
  let ladder = buildActionLadder(clean);
  let ids = ladder.filter((e) => !e.disabled).map((e) => e.id);
  assert.equal(ids[0], 'pull'); // behind > 0 outranks push
  assert.ok(ids.includes('push'));
  assert.ok(ids.includes('createPr'));
  assert.equal(ladder.find((e) => e.id === 'commit').reasonKey, 'actions.commit.clean');
  const unpublished = { ...clean, upstream: null, originDelta: null, aheadBehind: { ahead: 1, behind: 0 } };
  assert.equal(buildActionLadder(unpublished).find((entry) => entry.id === 'push').disabled, false,
    'an ordinary branch with commits ahead of its base can publish to origin');
  const untrackedPrPush = buildActionLadder({ ...unpublished, prHeadRef: 'contributor-change', originDelta: { ahead: 2, behind: 0 } })
    .find((entry) => entry.id === 'push');
  assert.equal(untrackedPrPush.disabled, true,
    'a PR checkout without a verified upstream never infers a push target from base or a coincidental origin ref');
  assert.equal(untrackedPrPush.reasonKey, 'actions.push.prCheckout');
  assert.equal(buildActionLadder({
    ...unpublished,
    prHeadRef: 'contributor-change',
    upstream: { ref: 'refs/remotes/origin/contributor-change', ahead: 1, behind: 0 },
  }).find((entry) => entry.id === 'push').disabled, false,
  'a same-repo PR checkout with the exact verified origin upstream can push');
  assert.equal(buildActionLadder({ ...unpublished, prPollingDisabled: true })
    .find((entry) => entry.id === 'push').disabled, true,
  'malformed or legacy PR provenance keeps push fail-closed');
  assert.equal(buildActionLadder({ ...unpublished, prHeadRef: 'contributor-change', pr: { state: 'closed' } })
    .some((entry) => entry.id === 'createPr'), false,
  'a closed PR checkout is not offered a second Create PR path');
  // agentRunning disables mutations but not readOnly
  ladder = buildActionLadder(clean, { agentRunning: true });
  assert.equal(ladder.find((e) => e.id === 'push').disabled, true);
  assert.equal(ladder.find((e) => e.id === 'push').reasonKey, 'actions.disabled.agentRunning');
  assert.equal(ladder.find((e) => e.id === 'fetch').disabled, false);
  ladder = buildActionLadder({ ...clean, dirty: true });
  assert.equal(ladder.find((entry) => entry.id === 'pull').disabled, true, 'dirty state cannot offer pull');
  // open PR promotes mergePr
  const withPr = { ...clean, pr: { number: 7, state: 'open', url: 'https://x/7', isDraft: false, mergeable: 'MERGEABLE', checks: { status: 'success', completed: 3, total: 3 } } };
  ladder = buildActionLadder(withPr);
  ids = ladder.filter((e) => !e.disabled).map((e) => e.id);
  assert.equal(ids[0], 'pull');
  assert.ok(ids.includes('mergePr'));
  assert.ok(!ids.includes('createPr'));
  assert.equal(buildActionLadder({ ...clean, prPollingDisabled: true }).some((entry) => entry.id === 'createPr'), false,
    'unbound legacy PR provenance never offers a duplicate Create PR path');

  const unknown = {
    ...clean,
    dirty: false,
    gitKnown: { head: false, status: false, aheadBehind: false, originDelta: false, diffStat: false },
  };
  ladder = buildActionLadder(unknown);
  for (const id of ['commit', 'discard', 'pull', 'push', 'mergeToBase', 'updateFromBase', 'archive']) {
    assert.equal(ladder.find((entry) => entry.id === id)?.disabled, true, `${id} fails closed on unknown Git state`);
  }
  assert.equal(ladder.some((entry) => entry.id === 'createPr'), false, 'unknown ahead state cannot offer create PR');
  const revisionUnknown = {
    ...clean,
    gitKnown: { head: true, status: true, aheadBehind: false, originDelta: true, diffStat: true },
  };
  ladder = buildActionLadder(revisionUnknown);
  assert.equal(ladder.find((entry) => entry.id === 'archive').disabled, true, 'archive requires a known revision comparison');
});

await test('archive guards + archive', async () => {
  writeFileSync(join(wt2.path, 'dirty.txt'), 'x\n');
  const refused = await archiveWorktree(wt2.path, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'unsafe');
  const forced = await archiveWorktree(wt2.path, { force: true });
  assert.equal(forced.ok, true);
  const list = await listManagedWorktrees(repo, repo);
  assert.equal(list.items.some((i) => i.path === wt2.path), false);
  const notManaged = await archiveWorktree(repo, { force: true });
  assert.equal(notManaged.ok, false);
  assert.equal(notManaged.reason, 'not-managed');
});

await test('archive rejects corrupt safety metadata', async () => {
  const guarded = await createWorktree({ repoRoot: repo, base: 'main', intent: 'branch-off', branchName: 'guarded-archive' });
  const originalBase = (await readMetadata(guarded.path)).baseRef;
  await patchMetadata(guarded.path, (metadata) => ({ ...metadata, baseRef: 'refs/heads/definitely-missing' }));
  const refused = await archiveWorktree(guarded.path, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not-managed');
  assert.equal(existsSync(guarded.path), true, 'invalid ownership metadata preserves the directory');
  await patchMetadata(guarded.path, (metadata) => ({ ...metadata, baseRef: originalBase }));
  const forced = await archiveWorktree(guarded.path, { force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
});

await test('archive reports locked worktree removal instead of false success', async () => {
  const locked = await createWorktree({ repoRoot: repo, base: 'main', intent: 'branch-off', branchName: 'locked-archive' });
  git(repo, 'worktree', 'lock', locked.path);
  const refused = await archiveWorktree(locked.path, { force: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'teardown-failed');
  assert.equal(refused.stage, 'worktree-remove');
  assert.equal(existsSync(locked.path), true);
  git(repo, 'worktree', 'unlock', locked.path);
  const removed = await archiveWorktree(locked.path, { force: true });
  assert.equal(removed.ok, true, JSON.stringify(removed));
});

await test('non-force archive closes the inspect/remove race', async () => {
  const raced = await createWorktree({ repoRoot: repo, base: 'main', intent: 'branch-off', branchName: 'raced-archive' });
  const wrapperDir = join(scratch, 'git-race-wrapper');
  mkdirSync(wrapperDir);
  const wrapper = join(wrapperDir, 'git');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(wrapper, `#!/bin/sh\nseen=\nprev=\nlast=\nfor arg do [ "$prev" = worktree ] && [ "$arg" = remove ] && seen=1; prev="$arg"; last="$arg"; done\nif [ "$seen" = 1 ]; then printf late > "$last/late.txt"; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${wrapperDir}:${originalPath}`;
    const refused = await archiveWorktree(raced.path, {});
    assert.equal(refused.ok, false);
    assert.equal(refused.stage, 'worktree-remove');
    assert.equal(existsSync(join(raced.path, 'late.txt')), true, 'late data survives the refused remove');
  } finally {
    process.env.PATH = originalPath;
  }
  const removed = await archiveWorktree(raced.path, { force: true });
  assert.equal(removed.ok, true, JSON.stringify(removed));
});

/* ---------------- PR checkout (the forge's refs/pull/<N>/head) ---------------- */

/** git that answers null instead of throwing — for expected-failure probes. */
function tryGit(cwd, ...args) {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

/** git that MUST fail: returns git's stderr (captured, so the log stays clean). */
function gitFailure(cwd, ...args) {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return String(error.stderr || error.message);
  }
  throw new Error(`expected git ${args.join(' ')} to fail`);
}

function cloneRepo(from, to) {
  return execFileSync('git', ['clone', '--quiet', from, to], {
    cwd: scratch,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const prRemote = join(scratch, 'pr-remote.git');
const prRepo = join(scratch, 'pr-clone');
const prForkRemote = join(scratch, 'pr-fork-remote.git');
const prForkRepo = join(scratch, 'pr-fork-clone');
mkdirSync(prRemote);
git(prRemote, 'init', '--bare', '-b', 'main');
cloneRepo(prRemote, prRepo);
git(prRepo, 'config', 'user.email', 'test@dsh.local');
git(prRepo, 'config', 'user.name', 'DSH Test');
writeFileSync(join(prRepo, 'base.txt'), 'base\n');
git(prRepo, 'add', '-A');
git(prRepo, 'commit', '-m', 'base commit');
git(prRepo, 'push', '--quiet', 'origin', 'main');

/**
 * One PR head that exists ONLY as refs/pull/<N>/head on the bare remote — the
 * real forge layout: the contributor's branch is deleted again, so nothing
 * else (no local branch, no origin branch) can supply the commit.
 */
function pushPrHead(number, branch, file, content) {
  git(prRepo, 'checkout', '--quiet', '-b', branch);
  writeFileSync(join(prRepo, file), content);
  git(prRepo, 'add', '-A');
  git(prRepo, 'commit', '-m', `${branch} commit`);
  const sha = git(prRepo, 'rev-parse', 'HEAD').trim();
  git(prRepo, 'push', '--quiet', 'origin', `HEAD:refs/pull/${number}/head`);
  git(prRepo, 'checkout', '--quiet', 'main');
  git(prRepo, 'branch', '-D', branch);
  assert.equal(tryGit(prRepo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`), null, 'head branch deleted again');
  return sha;
}

const prSameRepoHead = pushPrHead(12, 'pr-same-repo', 'pr.txt', 'from the pr\n');
const prForkHead = pushPrHead(9, 'dark-mode', 'dark.txt', 'dark mode\n');
const prPostHead = pushPrHead(21, 'pr-post', 'post.txt', 'from the http route\n');
const prLockedHead = pushPrHead(33, 'pr-locked', 'locked.txt', 'locked\n');

// a contributor's fork clone: origin is the fork (no refs/pull/*), the base
// repository — the one that does carry them — is `upstream`
mkdirSync(prForkRemote);
git(prForkRemote, 'init', '--bare', '-b', 'main');
git(prRepo, 'push', '--quiet', prForkRemote, 'main:main');
cloneRepo(prForkRemote, prForkRepo);
git(prForkRepo, 'remote', 'add', 'upstream', prRemote);

// local main diverges from origin/main so origin-first base resolution is observable
writeFileSync(join(prRepo, 'local-only.txt'), 'never pushed\n');
git(prRepo, 'add', '-A');
git(prRepo, 'commit', '-m', 'local main commit (never pushed)');
const prOriginMain = git(prRepo, 'rev-parse', 'refs/remotes/origin/main').trim();
assert.notEqual(git(prRepo, 'rev-parse', 'refs/heads/main').trim(), prOriginMain);

await test('pr-checkout: same-repo PR head without forged tracking ref', async () => {
  // only the forge ref carries this commit: no local branch, no origin branch
  assert.equal(tryGit(prRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pr-same-repo'), null);
  assert.equal(tryGit(prRepo, 'merge-base', '--is-ancestor', prSameRepoHead, 'main'), null, 'PR head is not on main');

  const wt = await createWorktree({
    repoRoot: prRepo,
    intent: 'pr-checkout',
    pull: verifiedPull(prRepo, { number: 12, headRef: 'pr-same-repo', baseRef: 'main' }),
    sourceTitle: 'PR 12',
  });
  try {
    assert.equal(wt.branch, 'pr-same-repo');
    assert.equal(wt.copiedFrom, null);
    assert.equal(wt.pullNumber, 12);
    assert.equal(wt.prHeadSha, prSameRepoHead);
    assert.equal(wt.upstream, null);
    assert.equal(wt.baseRefName, 'main');
    assert.equal(wt.baseRef, prOriginMain, 'the base is origin/main, not the newer local main');
    // the worktree really holds the PR head, not the base
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prSameRepoHead);
    assert.equal(readFileSync(join(wt.path, 'pr.txt'), 'utf8'), 'from the pr\n');
    // the fetch ref is transaction-scoped and removed after its SHA is read
    assert.equal(git(prRepo, 'for-each-ref', '--format=%(refname)', 'refs/dsh-better-workspaces/pr/').trim(), '');
    // A missing remote branch stays missing: PR metadata must never
    // manufacture a remote-tracking ref from the fetched PR SHA.
    const seeded = tryGit(prRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pr-same-repo');
    assert.equal(seeded, null);
    assert.match(gitFailure(wt.path, 'rev-parse', '--abbrev-ref', '@{upstream}'), /no upstream|unknown revision/i);

    const meta = await readMetadata(wt.path);
    assert.equal(meta.intent, 'pr-checkout');
    assert.equal(meta.branch, 'pr-same-repo');
    assert.equal(meta.pullNumber, 12);
    assert.equal(meta.pullHeadRef, 'pr-same-repo');
    assert.equal(meta.prHeadSha, prSameRepoHead);
    assert.equal(meta.upstream, undefined);
    assert.equal(meta.baseRefName, 'main');
    assert.equal(meta.baseRef, prOriginMain);
    assert.equal(meta.sourceWorkspaceTitle, 'PR 12');
    assert.equal('pullForkOwner' in meta, false);
    assert.equal('autoName' in meta, false, 'a PR checkout is never an auto-rename candidate');
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('pr-checkout never overwrites a mismatched remote-tracking ref', async () => {
  const before = git(prRepo, 'rev-parse', 'refs/remotes/origin/main').trim();
  const wt = await createWorktree({
    repoRoot: prRepo,
    intent: 'pr-checkout',
    pull: verifiedPull(prRepo, { number: 12, headRef: 'main', baseRef: 'main' }),
  });
  try {
    assert.equal(git(prRepo, 'rev-parse', 'refs/remotes/origin/main').trim(), before);
    assert.equal(wt.upstream, null);
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('pr-checkout: a taken local branch name uniquifies (-1, -2)', async () => {
  // the first checkout left refs/heads/pr-same-repo behind (archive keeps branches)
  assert.ok(git(prRepo, 'rev-parse', '--verify', '--quiet', 'refs/heads/pr-same-repo').trim());
  const pull = verifiedPull(prRepo, { number: 12, headRef: 'pr-same-repo', baseRef: 'main' });
  const wt = await createWorktree({ repoRoot: prRepo, intent: 'pr-checkout', pull });
  const wt2 = await createWorktree({ repoRoot: prRepo, intent: 'pr-checkout', pull });
  try {
    assert.equal(wt.branch, 'pr-same-repo-1');
    assert.equal(wt2.branch, 'pr-same-repo-2');
    for (const created of [wt, wt2]) {
      assert.equal(created.prHeadSha, prSameRepoHead);
      assert.equal(git(created.path, 'rev-parse', 'HEAD').trim(), prSameRepoHead);
      assert.equal((await readMetadata(created.path)).pullHeadRef, 'pr-same-repo');
    }

    // A trusted same-repo checkout may have a uniquified local branch while
    // tracking the verified, non-uniquified origin head. Push must use an
    // explicit origin refspec rather than push.default=simple.
    const originBefore = git(prRepo, 'remote', 'get-url', 'origin').trim();
    try {
      git(prRepo, 'update-ref', 'refs/remotes/origin/pr-same-repo', prSameRepoHead);
      git(wt.path, 'branch', '--set-upstream-to=origin/pr-same-repo', wt.branch);
      git(prRepo, 'remote', 'set-url', 'origin', 'https://github.com/test-owner/test-repo.git');
      git(prRepo, 'config', 'remote.origin.pushurl', prRemote);
      writeFileSync(join(wt.path, 'same-repo-push.txt'), 'next\n');
      git(wt.path, 'add', '-A');
      git(wt.path, 'commit', '-m', 'same-repo follow-up');
      const pushedSha = git(wt.path, 'rev-parse', 'HEAD').trim();
      const pushed = await pushAction(wt.path);
      assert.equal(pushed.ok, true, JSON.stringify(pushed));
      assert.equal(git(prRemote, 'rev-parse', 'refs/heads/pr-same-repo').trim(), pushedSha);
      assert.equal(tryGit(prRemote, 'rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`), null,
        'the uniquified local branch name is never published');
    } finally {
      git(prRepo, 'remote', 'set-url', 'origin', originBefore);
      tryGit(prRepo, 'config', '--unset-all', 'remote.origin.pushurl');
      tryGit(prRemote, 'update-ref', '-d', 'refs/heads/pr-same-repo');
      tryGit(prRepo, 'update-ref', '-d', 'refs/remotes/origin/pr-same-repo');
    }
  } finally {
    for (const created of [wt, wt2]) await archiveWorktree(created.path, { force: true });
  }
});

await test('pr-checkout: fork PR → owner-prefixed branch, no upstream', async () => {
  const wt = await createWorktree({
    repoRoot: prRepo,
    intent: 'pr-checkout',
    pull: verifiedPull(prRepo, { number: 9, headRef: 'dark-mode', baseRef: 'main', forkOwner: 'alice' }),
  });
  try {
    assert.equal(wt.branch, 'alice/dark-mode');
    assert.equal(wt.prHeadSha, prForkHead);
    assert.equal(wt.upstream, null);
    assert.equal(wt.baseRefName, 'main');
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prForkHead);
    assert.match(gitFailure(wt.path, 'rev-parse', '@{upstream}'), /no upstream configured/, 'a fork head must not track origin/dark-mode');
    const meta = await readMetadata(wt.path);
    assert.equal(meta.pullNumber, 9);
    assert.equal(meta.pullHeadRef, 'dark-mode');
    assert.equal(meta.pullForkOwner, 'alice');
    assert.equal('upstream' in meta, false);
    assert.equal('autoName' in meta, false);
    // the head landed in the PR's own throwaway ref (named after the anchor)
    assert.equal(git(prRepo, 'for-each-ref', '--format=%(refname)', 'refs/dsh-better-workspaces/pr/').trim(), '');
    // and nothing was synthesized as the BASE repo's origin/dark-mode
    assert.equal(tryGit(prRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/dark-mode'), null);
    const pushed = await pushAction(wt.path);
    assert.equal(pushed.ok, false);
    assert.equal(pushed.reasonKey, 'actions.push.prCheckout');
    assert.equal(tryGit(prRemote, 'rev-parse', '--verify', '--quiet', 'refs/heads/alice/dark-mode'), null,
      'direct Push must not publish a fork PR branch into the base origin');
    const secondPr = await createPrAction(wt.path, { title: 'must not publish' });
    assert.equal(secondPr.ok, false);
    assert.equal(secondPr.reasonKey, 'actions.pr.checkout');
    assert.equal(tryGit(prRemote, 'rev-parse', '--verify', '--quiet', 'refs/heads/alice/dark-mode'), null,
      'direct Create PR must not preliminarily publish a fork PR branch into the base origin');
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('pr-checkout: origin is tried first, upstream is the fallback', async () => {
  // this clone's origin is the fork: it has no refs/pull/*, only upstream does
  assert.equal(tryGit(prForkRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pr-same-repo'), null);
  const wt = await createWorktree({
    repoRoot: prForkRepo,
    intent: 'pr-checkout',
    pull: verifiedPull(prRepo, { number: 12, headRef: 'pr-same-repo', baseRef: 'main' }),
  });
  try {
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prSameRepoHead, 'the head came from upstream');
    assert.equal(wt.prHeadSha, prSameRepoHead);
    assert.equal(wt.upstream, null, 'a head fetched from upstream never tracks origin');
    assert.equal(wt.baseRefName, 'main');
    assert.match(gitFailure(wt.path, 'rev-parse', '@{upstream}'), /no upstream configured/);
    const meta = await readMetadata(wt.path);
    assert.equal(meta.pullNumber, 12);
    assert.equal(meta.pullHeadRef, 'pr-same-repo');
    assert.equal('upstream' in meta, false);
    assert.equal(tryGit(prForkRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pr-same-repo'), null);
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('pr-checkout refuses a same-number upstream head with the wrong verified SHA', async () => {
  await assert.rejects(
    createWorktree({
      repoRoot: prForkRepo,
      intent: 'pr-checkout',
      pull: { host: 'github.com', owner: 'test-owner', repo: 'test-repo', headSha: 'b'.repeat(40), number: 12, headRef: 'pr-same-repo', baseRef: 'main' },
    }),
    /did not match verified SHA/,
  );
});

await test('pr-checkout: an unseedable tracking ref must not fake an upstream', async () => {
  // hold the loose-ref lock so `git update-ref refs/remotes/origin/<headRef>`
  // fails deterministically: the checkout must still succeed, but it must
  // report NO upstream instead of one that `@{upstream}` cannot resolve
  const lock = join(prRepo, '.git', 'refs', 'remotes', 'origin', 'pr-locked.lock');
  mkdirSync(join(prRepo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  writeFileSync(lock, '');
  let wt;
  try {
    wt = await createWorktree({
      repoRoot: prRepo,
      intent: 'pr-checkout',
      pull: verifiedPull(prRepo, { number: 33, headRef: 'pr-locked', baseRef: 'main' }),
    });
  } finally {
    rmSync(lock, { force: true });
  }
  try {
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prLockedHead, 'creation is not blocked by the tracking failure');
    assert.equal(wt.prHeadSha, prLockedHead);
    assert.equal(wt.upstream, null);
    const meta = await readMetadata(wt.path);
    assert.equal(meta.pullNumber, 33);
    assert.equal('upstream' in meta, false);
    assert.match(gitFailure(wt.path, 'rev-parse', '@{upstream}'), /no upstream configured/);
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('pr-checkout: guards + tolerant base', async () => {
  // a number the forge does not have: the message names every attempted remote
  // ref AND the reason git gave, not a generic "did not resolve"
  await assert.rejects(
    createWorktree({ repoRoot: prForkRepo, intent: 'pr-checkout', pull: verifiedPull(prForkRepo, { number: 999, headRef: 'nope', baseRef: 'main' }) }),
    (error) => {
      assert.match(error.message, /#999/);
      assert.match(error.message, /origin refs\/pull\/999\/head/);
      assert.match(error.message, /upstream refs\/pull\/999\/head/);
      assert.match(error.message, /couldn't find remote ref refs\/pull\/999\/head/);
      return true;
    },
  );
  // headRef is what names the local branch: it is mandatory
  await assert.rejects(createWorktree({ repoRoot: prRepo, intent: 'pr-checkout', pull: { number: 12 } }), /pull\.headRef/);
  // no remote to fetch a pull request from at all
  await assert.rejects(
    createWorktree({ repoRoot: repo, intent: 'pr-checkout', pull: verifiedPull(repo, { number: 12, headRef: 'pr-same-repo' }) }),
    /no origin\/upstream remote/,
  );
  // a base the forge cannot resolve still yields a worktree (tolerant resolution)
  const wt = await createWorktree({
    repoRoot: prRepo,
    intent: 'pr-checkout',
    pull: verifiedPull(prRepo, { number: 12, headRef: 'pr-same-repo', baseRef: 'no-such-base' }),
  });
  try {
    assert.match(wt.branch, /^pr-same-repo-\d+$/);
    assert.equal(wt.baseRefName, null);
    assert.equal(wt.baseRef, null);
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prSameRepoHead);
    const meta = await readMetadata(wt.path);
    assert.equal(meta.baseRefName, null);
    assert.equal(meta.baseRef, null);
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('api: POST /worktrees with pull → pr-checkout', async () => {
  const hub = createGitStateHub({ onChange: () => {} });
  const api = createApi(hub, {
    workspaceRoots: () => [prRepo],
    resolveForgeIdentity: async () => ({ host: 'github.com', owner: 'test-owner', repo: 'test-repo' }),
    resolvePull: async ({ number }) => ({
      ok: true,
      item: {
        kind: 'change_request',
        number,
        headRefName: 'pr-post',
        baseRefName: 'main',
        headOwnerLogin: null,
        headRefOid: prPostHead,
        host: 'github.com',
        owner: 'test-owner',
        repo: 'test-repo',
        fork: false,
      },
    }),
  });
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  try {
    const stale = await fetch(`${base}/worktrees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin },
      body: JSON.stringify({ cwd: prRepo, pull: { host: 'ghe.example.test', owner: 'other', repo: 'other', number: 21, headRef: 'main' } }),
    });
    assert.equal(stale.status, 409, 'a selected PR cannot retarget after the repository identity changes');

    const res = await fetch(`${base}/worktrees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin },
      body: JSON.stringify({ cwd: prRepo, pull: { host: 'github.com', owner: 'test-owner', repo: 'test-repo', number: 21, headRef: 'main', baseRef: 'evil', forkOwner: 'attacker' }, sourceTitle: 'PR 21' }),
    });
    const created = await res.json();
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.branch, 'pr-post');
    assert.equal(created.pullNumber, 21);
    assert.equal(created.prHeadSha, prPostHead);
    assert.equal(created.upstream, null);
    assert.equal(readFileSync(join(created.path, 'post.txt'), 'utf8'), 'from the http route\n');
    const meta = await readMetadata(created.path);
    assert.equal(meta.intent, 'pr-checkout');
    assert.equal(meta.pullNumber, 21);
    assert.equal(meta.pullHeadRef, 'pr-post');
    assert.equal(meta.prHeadSha, prPostHead);
    assert.equal(meta.sourceWorkspaceTitle, 'PR 21');
    await archiveWorktree(created.path, { force: true });
  } finally {
    api.dispose();
    server.close();
    await hub.dispose();
  }
});

await test('creation source guard binds the Host Session identity to cwd', async () => {
  const sessions = {
    list: async () => [{ id: 'session-source-guard', header: { cwd: '/repo/source' } }],
  };
  const guard = createCreationSourceGuard({ get: (name) => name === 'sessions' ? sessions : undefined });
  await guard('session-source-guard', '/repo/source');
  await assert.rejects(guard('session-source-guard', '/repo/rebound'), /no longer owns cwd/);
  await assert.rejects(guard('session-other', '/repo/source'), /no longer owns cwd/);
  const unavailable = createCreationSourceGuard({ get: () => undefined });
  await assert.rejects(unavailable('session-source-guard', '/repo/source'), /unavailable/);
});

await test('production archive guard disables physical deletion without a retiring lease', async () => {
  const guard = createWorkspaceArchiveGuard();
  await assert.rejects(guard('workspace-visible', '/repo/worktree'), /physical archive is disabled/);
  await assert.rejects(guard(null, '/repo/unregistered-worktree'), /physical archive is disabled/,
    'unregistered managed worktrees cannot bypass the Session/Agent admission fence');
});

await test('exact Workspace deletion is session-safe, target-only, and retry-idempotent', async () => {
  const target = { id: 'delete-target', path: '/managed/target', sessionIds: ['session-target'] };
  const unrelated = { id: 'delete-unrelated', path: '/managed/unrelated', sessionIds: ['session-unrelated'] };
  const rows = [target, unrelated];
  const registry = {
    archivedSessionIds: [],
    list: () => rows,
    async delete(id) {
      const at = rows.findIndex((row) => row.id === id);
      if (at < 0) return false;
      rows.splice(at, 1);
      return true;
    },
  };
  const removeExact = createExactWorkspaceDelete(registry);
  await assert.rejects(removeExact(target.id, target.path, ['session-target']), /unarchived session/);
  assert.deepEqual(rows, [target, unrelated]);
  registry.archivedSessionIds = ['session-target'];
  await assert.rejects(removeExact(target.id, '/replacement', ['session-target']), /no longer matches/);
  await assert.rejects(removeExact(target.id, target.path, ['session-target']), /raw durable membership/,
    'an existing historical row is retained because captured membership may be incomplete');
  assert.deepEqual(rows, [target, unrelated], 'unrelated Workspace identity and grouping are untouched');
  rows.splice(rows.indexOf(target), 1);
  assert.equal(await removeExact(target.id, target.path, ['session-target']), false,
    'replay after an already-committed registry deletion is a no-op');
});

await test('api creation tx replays one durable Workspace and defers destructive registry deletion', async () => {
  const txRepo = join(scratch, 'creation-tx-repo');
  mkdirSync(txRepo);
  git(txRepo, 'init', '-b', 'main');
  git(txRepo, 'config', 'user.email', 'test@dsh.local');
  git(txRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(txRepo, 'base.txt'), 'base\n');
  git(txRepo, 'add', '-A');
  git(txRepo, 'commit', '-m', 'base');
  const unrelatedPath = join(scratch, 'creation-tx-unrelated');
  mkdirSync(unrelatedPath);
  const unrelated = { workspaceId: 'ws-unrelated', path: unrelatedPath, title: 'Unrelated', sessionIds: ['session-unrelated'] };
  const rows = [{ workspaceId: 'ws-tx-main', path: txRepo, title: 'tx main', sessionIds: [] }, unrelated];
  let nextWorkspace = 1;
  const deleted = [];
  const hub = createGitStateHub({ onChange: () => {} });
  const api = createApi(hub, {
    workspaceRoots: () => rows.map((row) => row.path),
    workspaceRows: () => rows,
    worktreeWorkspaces: async () => rows.filter((row) => row.path !== txRepo),
    createWorkspace: async (path, title) => {
      const existing = rows.find((row) => row.path === path);
      if (existing) return existing;
      const row = { workspaceId: `ws-tx-${nextWorkspace++}`, path, title, sessionIds: [] };
      rows.push(row);
      return row;
    },
    deleteWorkspace: async (workspaceId, expectedPath) => {
      const at = rows.findIndex((row) => row.workspaceId === workspaceId && row.path === expectedPath);
      if (at < 0) return false;
      rows.splice(at, 1);
      deleted.push(workspaceId);
      return true;
    },
  });
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const endpoint = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  const post = (path, body) => fetch(endpoint + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(endpoint).origin },
    body: JSON.stringify(body),
  });
  const request = {
    cwd: txRepo,
    intent: 'branch-off',
    branchName: 'tx-replay',
    slug: 'tx-replay',
    sourceTitle: 'Tx source',
    sourceSessionId: 'session-create-tx-source',
    txId: 'client-create-tx-0001',
  };
  try {
    const firstResponse = await post('/worktrees', request);
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 201, JSON.stringify(first));
    assert.equal(first.ok, true);
    assert.equal(first.workspaceId, 'ws-tx-1');
    const secondResponse = await post('/worktrees', request);
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 200, JSON.stringify(second));
    assert.equal(second.replayed, true);
    assert.equal(second.path, first.path);
    assert.equal(second.workspaceId, first.workspaceId);
    assert.equal(rows.filter((row) => row.path === first.path).length, 1);

    const conflictResponse = await post('/worktrees', { ...request, branchName: 'different-request' });
    const conflict = await conflictResponse.json();
    assert.equal(conflictResponse.status, 409, JSON.stringify(conflict));
    assert.equal(conflict.error, 'transaction_conflict');
    const duplicateTabResponse = await post('/worktrees', { ...request, txId: 'client-create-tx-0002' });
    const duplicateTab = await duplicateTabResponse.json();
    assert.equal(duplicateTabResponse.status, 409, JSON.stringify(duplicateTab));
    assert.match(duplicateTab.message, /source session already owns another creation transaction/,
      'two browser realms cannot mint two worktrees for one launcher');

    const archiveResponse = await post('/action', {
      cwd: first.path,
      name: 'archive',
      params: { force: true, deferWorkspaceDelete: true },
    });
    const archived = await archiveResponse.json();
    assert.equal(archiveResponse.status, 200, JSON.stringify(archived));
    assert.equal(archived.workspaceDeletionDeferred, true);
    assert.equal(deleted.length, 0, 'registry row remains until client has moved/archived sessions');
    assert.ok(rows.some((row) => row.workspaceId === first.workspaceId));
    const pendingResponse = await fetch(`${endpoint}/worktrees/deferred?cwd=${encodeURIComponent(txRepo)}`);
    const pending = await pendingResponse.json();
    assert.equal(pendingResponse.status, 200, JSON.stringify(pending));
    assert.deepEqual(pending.items.map((item) => item.token), [archived.workspaceDeletionToken],
      'a lost response token remains discoverable from the authorized main checkout');

    rows.splice(rows.findIndex((row) => row.workspaceId === first.workspaceId), 1);
    const finalizedResponse = await post('/worktrees/finalize-delete', {
      cwd: txRepo,
      token: archived.workspaceDeletionToken,
    });
    const finalized = await finalizedResponse.json();
    assert.equal(finalizedResponse.status, 200, JSON.stringify(finalized));
    assert.equal(finalized.workspaceAlreadyAbsent, first.workspaceId,
      'retry after registry commit is idempotent and only completes the tombstone');
    assert.deepEqual(deleted, []);
    assert.equal(rows.some((row) => row.workspaceId === first.workspaceId), false);
    assert.equal(rows.find((row) => row.workspaceId === unrelated.workspaceId), unrelated,
      'deleting one managed worktree preserves every unrelated Workspace row and grouping');

    const archivedReplayResponse = await post('/worktrees', request);
    const archivedReplay = await archivedReplayResponse.json();
    assert.equal(archivedReplayResponse.status, 410, JSON.stringify(archivedReplay));
    assert.equal(archivedReplay.error, 'transaction_retired');
    assert.equal(archivedReplay.path, first.path);
    assert.equal(archivedReplay.workspaceId, first.workspaceId);
    assert.equal(existsSync(first.path), false, 'a committed tx never recreates after explicit archive');
    const afterRetiredResponse = await post('/worktrees', {
      ...request,
      txId: 'client-create-tx-0003',
      branchName: 'tx-after-retired',
      slug: 'tx-after-retired',
    });
    const afterRetired = await afterRetiredResponse.json();
    assert.equal(afterRetiredResponse.status, 201, JSON.stringify(afterRetired));
    const afterRetiredArchive = await post('/worktrees/archive', {
      path: afterRetired.path,
      force: true,
      workspaceId: afterRetired.workspaceId,
    });
    assert.equal(afterRetiredArchive.status, 200, JSON.stringify(await afterRetiredArchive.json()));

    const staleSelection = {
      cwd: txRepo,
      sourceTitle: 'Stale selector',
      sourceSessionId: 'session-stale-selector',
      txId: 'client-stale-tx-0001',
      base: 'refs/heads/does-not-exist',
      intent: 'branch-off',
      slug: 'stale-base',
    };
    const staleResponse = await post('/worktrees', staleSelection);
    const stale = await staleResponse.json();
    assert.equal(staleResponse.status, 422, JSON.stringify(stale));
    assert.equal(stale.txState, 'absent', 'post-claim failures prove absence and release source admission');
    const rotatedResponse = await post('/worktrees', {
      ...staleSelection,
      txId: 'client-stale-tx-0002',
      base: 'main',
      slug: 'valid-base',
    });
    const rotated = await rotatedResponse.json();
    assert.equal(rotatedResponse.status, 201, JSON.stringify(rotated));
    const rotatedArchive = await post('/worktrees/archive', {
      path: rotated.path,
      force: true,
      workspaceId: rotated.workspaceId,
    });
    assert.equal(rotatedArchive.status, 200, JSON.stringify(await rotatedArchive.json()));
  } finally {
    await api.dispose();
    await new Promise((resolveClose) => server.close(resolveClose));
    await hub.dispose();
  }
});

await test('api creation adopts a managed root that predates the owner record', async () => {
  const legacyRepo = join(scratch, 'legacy-root-repo');
  mkdirSync(legacyRepo);
  git(legacyRepo, 'init', '-b', 'main');
  git(legacyRepo, 'config', 'user.email', 'test@dsh.local');
  git(legacyRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(legacyRepo, 'base.txt'), 'base\n');
  git(legacyRepo, 'add', '-A');
  git(legacyRepo, 'commit', '-m', 'base');
  // A root that exists without an owner record is exactly the state every
  // repository managed before that record was introduced is left in; the
  // transaction pre-check must adopt it instead of reporting it as replaced.
  const legacyRoot = await repoWorktreesRoot(legacyRepo);
  mkdirSync(legacyRoot, { recursive: true });
  const ownerFile = join(legacyRoot, '.repo-owner.json');
  assert.equal(existsSync(ownerFile), false, 'the fixture starts as a legacy root');
  const rows = [{ workspaceId: 'ws-legacy-main', path: legacyRepo, title: 'legacy main', sessionIds: [] }];
  const hub = createGitStateHub({ onChange: () => {} });
  const api = createApi(hub, {
    workspaceRoots: () => rows.map((row) => row.path),
    workspaceRows: () => rows,
    worktreeWorkspaces: async () => rows.filter((row) => row.path !== legacyRepo),
    createWorkspace: async (path, title) => {
      const row = { workspaceId: `ws-legacy-${rows.length}`, path, title, sessionIds: [] };
      rows.push(row);
      return row;
    },
    deleteWorkspace: async () => true,
  });
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const endpoint = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  const post = (path, body) => fetch(endpoint + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(endpoint).origin },
    body: JSON.stringify(body),
  });
  try {
    const response = await post('/worktrees', {
      cwd: legacyRepo,
      intent: 'branch-off',
      branchName: 'legacy-adopted',
      slug: 'legacy-adopted',
      sourceTitle: 'Legacy source',
      sourceSessionId: 'session-legacy-root-source',
      txId: 'client-legacy-root-0001',
    });
    const created = await response.json();
    assert.equal(response.status, 201, JSON.stringify(created));
    assert.equal(created.ok, true);
    assert.equal(existsSync(ownerFile), true, 'adoption writes the owner record');
    const record = JSON.parse(readFileSync(ownerFile, 'utf8'));
    const identity = statSync(realpathSync(legacyRepo));
    assert.deepEqual(
      { version: record.version, mainRepoRoot: record.mainRepoRoot, dev: record.dev, ino: record.ino },
      { version: 1, mainRepoRoot: realpathSync(legacyRepo), dev: String(identity.dev), ino: String(identity.ino) },
    );
    const replayResponse = await post('/worktrees', {
      cwd: legacyRepo,
      intent: 'branch-off',
      branchName: 'legacy-adopted',
      slug: 'legacy-adopted',
      sourceTitle: 'Legacy source',
      sourceSessionId: 'session-legacy-root-source',
      txId: 'client-legacy-root-0001',
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200, JSON.stringify(replay));
    assert.equal(replay.replayed, true, 'the adopted root still replays one committed transaction');
    const archiveResponse = await post('/worktrees/archive', {
      path: created.path,
      force: true,
      workspaceId: created.workspaceId,
    });
    assert.equal(archiveResponse.status, 200, JSON.stringify(await archiveResponse.json()));
  } finally {
    await api.dispose();
    await new Promise((resolveClose) => server.close(resolveClose));
    await hub.dispose();
  }
});

await test('api serializes same-repo worktree creation and actions', async () => {
  const parallelRepo = join(scratch, 'parallel-api-repo');
  mkdirSync(parallelRepo);
  git(parallelRepo, 'init', '-b', 'main');
  git(parallelRepo, 'config', 'user.email', 'test@dsh.local');
  git(parallelRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(parallelRepo, 'tracked.txt'), 'one\n');
  git(parallelRepo, 'add', '-A');
  git(parallelRepo, 'commit', '-m', 'initial');
  const hub = createGitStateHub({ onChange: () => {} });
  const registered = [];
  const deleted = [];
  let observeMutation = null;
  let observeRequest = null;
  const observedMutations = {
    acquire(key, options) {
      observeMutation?.(key);
      return hostMutationCoordinator.acquire(key, options);
    },
    run(key, task, options) {
      observeMutation?.(key);
      return hostMutationCoordinator.run(key, task, options);
    },
  };
  const api = createApi(hub, {
    workspaceRoots: () => [parallelRepo, ...registered.map((workspace) => workspace.path)],
    worktreeWorkspaces: async () => registered,
    deleteWorkspace: async (workspaceId) => { deleted.push(workspaceId); return true; },
    mutations: observedMutations,
    onRequestStart: (sub) => observeRequest?.(sub),
  });
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const endpoint = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  const post = (path, body) => fetch(endpoint + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(endpoint).origin },
    body: JSON.stringify(body),
  });
  const created = [];
  try {
    const responses = await Promise.all([0, 1].map(() => post('/worktrees', {
      cwd: parallelRepo,
      intent: 'branch-off',
      branchName: 'parallel-task',
      slug: 'parallel-task',
    })));
    assert.deepEqual(responses.map((response) => response.status), [201, 201]);
    created.push(...await Promise.all(responses.map((response) => response.json())));
    assert.equal(new Set(created.map((item) => item.path)).size, 2);
    assert.equal(new Set(created.map((item) => item.branch)).size, 2);
    for (const item of created) assert.equal((await validateManagedWorktree(item.path)).ok, true);

    writeFileSync(join(parallelRepo, 'tracked.txt'), 'two\n');
    const before = Number(git(parallelRepo, 'rev-list', '--count', 'HEAD').trim());
    const commits = await Promise.all([0, 1].map(() => post('/action', {
      cwd: parallelRepo,
      name: 'commit',
      params: { message: 'parallel commit' },
    })));
    assert.deepEqual(commits.map((response) => response.status).sort(), [200, 409]);
    assert.equal(Number(git(parallelRepo, 'rev-list', '--count', 'HEAD').trim()), before + 1);

    git(created[0].path, 'branch', '-m', 'parallel-task-renamed-manually');
    registered.push({ workspaceId: 'registered-created-1', path: created[0].path });
    const repoKey = `git:${parallelRepo}`;
    const releaseRepo = await hostMutationCoordinator.acquire(repoKey);
    let markArchiveQueued;
    const archiveQueued = new Promise((resolveQueued) => { markArchiveQueued = resolveQueued; });
    observeMutation = (key) => {
      if (key === repoKey) markArchiveQueued();
    };
    const archivedRequest = post('/worktrees/archive', { path: created[0].path, force: true });
    let archiveTimeout;
    await Promise.race([
      archiveQueued,
      new Promise((_, reject) => { archiveTimeout = setTimeout(() => reject(new Error('archive did not reach mutation gate')), 3000); }),
    ]);
    clearTimeout(archiveTimeout);
    observeMutation = null;
    assert.equal(existsSync(created[0].path), true);
    releaseRepo();
    const archivedResponse = await archivedRequest;
    assert.equal(archivedResponse.status, 200);
    const archived = await archivedResponse.json();
    assert.equal(archived.workspaceDeleted, 'registered-created-1');
    assert.deepEqual(deleted, ['registered-created-1']);

    const releaseForDispose = await hostMutationCoordinator.acquire(repoKey);
    let markDisposeQueued;
    const disposeQueued = new Promise((resolveQueued) => { markDisposeQueued = resolveQueued; });
    observeMutation = (key) => {
      if (key === repoKey) markDisposeQueued();
    };
    const cancelledArchive = post('/worktrees/archive', { path: created[1].path, force: true });
    let disposeTimeout;
    await Promise.race([
      disposeQueued,
      new Promise((_, reject) => { disposeTimeout = setTimeout(() => reject(new Error('dispose archive did not reach mutation gate')), 3000); }),
    ]);
    clearTimeout(disposeTimeout);
    observeMutation = null;
    const largeImage = join(created[1].path, 'paused.png');
    writeFileSync(largeImage, Buffer.alloc(16 * 1024 * 1024, 1));
    let pausedResponse;
    const pausedRaw = new Promise((resolvePaused) => {
      const request = http.get(`${endpoint}/raw?cwd=${encodeURIComponent(created[1].path)}&path=paused.png`, (response) => {
        response.pause();
        pausedResponse = response;
        resolvePaused();
      });
      request.on('error', () => resolvePaused());
    });
    await pausedRaw;

    let markSlowTracked;
    const slowTracked = new Promise((resolveTracked) => { markSlowTracked = resolveTracked; });
    observeRequest = (sub) => {
      if (sub === '/snapshots') markSlowTracked();
    };
    const slowRequest = http.request(`${endpoint}/snapshots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: new URL(endpoint).origin,
        'Content-Length': '1',
      },
    });
    slowRequest.on('error', () => {});
    slowRequest.flushHeaders();
    await slowTracked;
    observeRequest = null;
    const disposeStarted = Date.now();
    const disposedApi = api.dispose();
    const cancelledResponse = await cancelledArchive;
    await disposedApi;
    assert.ok(Date.now() - disposeStarted < 1000, 'dispose drains stalled request bodies and raw streams promptly');
    pausedResponse?.destroy();
    slowRequest.destroy();
    releaseForDispose();
    assert.equal(cancelledResponse.status, 499);
    assert.equal(existsSync(created[1].path), true, 'dispose cancels a queued destructive mutation');

    const deletionJournal = await prepareWorkspaceDeletion(parallelRepo, created[1].path, 'crash-window-workspace');
    assert.equal((await archiveWorktree(created[1].path, { force: true })).ok, true);
    assert.deepEqual(
      (await pendingWorkspaceDeletions(parallelRepo)).ready.map((entry) => entry.workspaceId),
      ['crash-window-workspace'],
    );
    const { createCleanup } = await import('../lib/cleanup.js');
    const replayedDeletes = [];
    const recoveryCleanup = createCleanup({
      get(name) {
        if (name === 'sessions') return { list: async () => [] };
        if (name === 'workspaceRegistry') {
          return {
            list: () => [{ workspaceId: 'crash-window-workspace', path: created[1].path }],
            delete: async (workspaceId) => { replayedDeletes.push(workspaceId); return true; },
          };
        }
        return undefined;
      },
    });
    const replay = await recoveryCleanup({ cwd: parallelRepo, dryRun: false });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.deepEqual(replayedDeletes, ['crash-window-workspace']);
    assert.deepEqual((await pendingWorkspaceDeletions(parallelRepo)).ready, []);
    await completeWorkspaceDeletion(deletionJournal).catch(() => {});
  } finally {
    for (const item of created) await archiveWorktree(item.path, { force: true });
    await api.dispose();
    await new Promise((resolveClose) => server.close(resolveClose));
    await hub.dispose();
  }
});

/* ---------------- HTTP layer ---------------- */
await test('api routes over real HTTP', async () => {
  const hub = createGitStateHub({ onChange: () => {} });
  let exchangeRace = null;
  const api = createApi(hub, {
    workspaceRoots: () => [repo, scratch],
    worktreeWorkspaces: async () => [{ workspaceId: 'ws-provider-x', path: '/tmp/provider-x' }],
    beforeFileExchange: async (target) => exchangeRace?.(target),
  });
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  try {
    const get = async (path) => (await fetch(base + path)).json();
    const post = async (path, body) =>
      (await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin },
        body: JSON.stringify(body),
      })).json();

    // 400 shapes must carry `message` so the client never shows a generic fallback
    const bad = await post('/worktrees', {});
    assert.equal(bad.ok, false);
    assert.equal(bad.message, 'cwd required');

    const detect = await get(`/detect?path=${encodeURIComponent(repo)}`);
    assert.equal(detect.ok, true);
    assert.equal(detect.isGit, true);
    assert.equal(detect.defaultBranch, 'main');

    const branches = await get(`/branches?cwd=${encodeURIComponent(wt1.path)}`);
    assert.equal(branches.current, 'feature-x');
    assert.ok(branches.branches.length >= 3);

    // worktree-workspaces echoes the provider
    const wws = await get('/worktree-workspaces');
    assert.equal(wws.ok, true);
    assert.deepEqual(wws.items, [{ workspaceId: 'ws-provider-x', path: '/tmp/provider-x' }]);

    // task mode requires managed-worktree metadata
    const taskPlain = await get(`/diff?cwd=${encodeURIComponent(repo)}&mode=task`);
    assert.equal(taskPlain.ok, false);
    assert.equal(taskPlain.error, 'task-base-missing');
    const taskWt = await get(`/diff?cwd=${encodeURIComponent(wt1.path)}&mode=task`);
    assert.equal(taskWt.ok, true);
    assert.ok(taskWt.refs.label.startsWith('task:'));

    // POST /file: CAS write with guards
    const editable = join(repo, 'editable.txt');
    writeFileSync(editable, 'one\n');
    const baseSha = createHash('sha1').update(Buffer.from('one\n')).digest('hex');
    const casConflict = await post('/file', { cwd: repo, path: 'editable.txt', content: 'two\n', baseSha1: '0000000000000000000000000000000000000000' });
    assert.equal(casConflict.ok, false);
    assert.equal(casConflict.error, 'conflict');
    assert.equal(readFileSync(editable, 'utf8'), 'one\n', 'conflict must not write');
    const writeOk = await post('/file', { cwd: repo, path: 'editable.txt', content: 'two\n', baseSha1: baseSha });
    if (writeOk.ok) {
      assert.equal(readFileSync(editable, 'utf8'), 'two\n');
      exchangeRace = () => writeFileSync(editable, 'external-race\n');
      let racedSave;
      try {
        racedSave = await post('/file', {
          cwd: repo,
          path: 'editable.txt',
          content: 'must-not-win\n',
          baseSha1: createHash('sha1').update(Buffer.from('two\n')).digest('hex'),
        });
      } finally {
        exchangeRace = null;
      }
      assert.equal(racedSave.ok, false);
      assert.equal(racedSave.error, 'conflict');
      assert.equal(racedSave.message, 'file changed on disk during save');
      assert.equal('recovery' in racedSave, false, 'owned temporary file was removed before the conflict response');
      assert.equal(readFileSync(editable, 'utf8'), 'external-race\n', 'the concurrent writer remains authoritative');
      assert.equal(readdirSync(repo).some((name) => name.startsWith('.bw-') && name.endsWith('.tmp')), false);
    } else {
      assert.match(String(writeOk.error || writeOk.message || JSON.stringify(writeOk)), /atomic file exchange unavailable/);
      assert.equal(readFileSync(editable, 'utf8'), 'one\n', 'an unavailable exchange primitive fails closed');
      assert.equal(readdirSync(repo).some((name) => name.startsWith('.bw-') && name.endsWith('.tmp')), false,
        'a failed exchange removes its owned temporary file');
    }
    const writeEscape = await post('/file', { cwd: repo, path: '../escape.txt', content: 'x' });
    assert.equal(writeEscape.ok, false);
    assert.equal(writeEscape.error, 'path escapes workspace');
    const writeMissing = await post('/file', { cwd: repo, path: 'definitely-missing.txt', content: 'x' });
    assert.equal(writeMissing.ok, false);
    assert.equal(writeMissing.error, 'existing file required');
    const writeBinary = await post('/file', { cwd: repo, path: 'editable.txt', content: 'a\u0000b' });
    assert.equal(writeBinary.ok, false);
    assert.equal(writeBinary.error, 'binary content rejected');
    rmSync(editable, { force: true });

    // GET /file text carries sha1 for the editor CAS
    const shaFile = join(repo, 'sha-probe.txt');
    writeFileSync(shaFile, 'probe\n');
    const fileGet = await get(`/file?cwd=${encodeURIComponent(repo)}&path=sha-probe.txt`);
    assert.equal(fileGet.kind, 'text');
    assert.equal(fileGet.sha1, createHash('sha1').update(Buffer.from('probe\n')).digest('hex'));
    rmSync(shaFile, { force: true });

    const wts = await get(`/worktrees?cwd=${encodeURIComponent(wt1.path)}`);
    assert.ok(wts.items.some((i) => i.path === wt1.path && i.managed));

    const snap = await get(`/snapshot?cwd=${encodeURIComponent(wt1.path)}`);
    assert.equal(snap.snapshot.branch, 'feature-x');

    const batch = await post('/snapshots', { cwds: [wt1.path, repo, scratch] });
    assert.equal(batch.byCwd[wt1.path].isGit, true);
    assert.equal(batch.byCwd[scratch].isGit, false);

    writeFileSync(join(wt1.path, 'http.txt'), 'via http\n');
    const diff = await get(`/diff?cwd=${encodeURIComponent(wt1.path)}&mode=uncommitted`);
    assert.ok(diff.files.some((f) => f.path === 'http.txt' && f.status === 'added'));

    const commits = await get(`/commits?cwd=${encodeURIComponent(wt1.path)}`);
    assert.equal(commits.commits.length, 1);
    assert.equal(commits.commits[0].subject, 'wip: gamma + new');
    assert.equal(commits.commits[0].unpushed, true); // no remote → unpushed
    const missingCommits = await get(`/commits?cwd=${encodeURIComponent(wt1.path)}&base=refs%2Fheads%2Fdefinitely-missing`);
    assert.equal(missingCommits.ok, false);
    assert.equal(missingCommits.error, 'invalid base revision');

    const actions = await get(`/actions?cwd=${encodeURIComponent(wt1.path)}`);
    assert.ok(actions.ladder.some((e) => e.id === 'commit' && !e.disabled));

    const acted = await post('/action', { cwd: wt1.path, name: 'commit', params: { message: 'http commit' } });
    assert.equal(acted.ok, true, JSON.stringify(acted));

    const file = await get(`/file?cwd=${encodeURIComponent(wt1.path)}&path=a.txt`);
    assert.equal(file.kind, 'text');
    assert.match(file.content, /gamma/);

    const escape = await get(`/file?cwd=${encodeURIComponent(wt1.path)}&path=../../etc/passwd`);
    assert.equal(escape.ok, false);

    // SSE: first payload contains the connected comment
    const controller = new AbortController();
    const events = await fetch(`${base}/events`, { signal: controller.signal });
    assert.equal(events.headers.get('content-type').includes('text/event-stream'), true);
    const reader = events.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /:connected/);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    api.dispose();
    server.close();
    await hub.dispose();
  }
});

/* ---------------- forge: the gh CLI, /pulls + /pull ---------------- */

const forgeIdentity = { host: 'github.com', owner: 'acme', repo: 'widget' };

// `lib/forge.js` shells out to the real `gh`, so the CLI itself is the fixture:
// a fake executable EARLY in PATH whose JSON mirrors `gh --json` exactly
// (label objects included, so the flattening is provable). Every call is
// logged as "<cwd>\t<args>" so the tests can show what the host layer passed.
const fakeGHDir = join(scratch, 'fake-gh');
const fakeGHLog = join(fakeGHDir, 'gh.log');
const fakeGH = String.raw`#!/bin/sh
printf '%s\t%s\n' "$(pwd)" "$*" >> "$FAKE_GH_DIR/gh.log"

case "$1" in
  --version)
    echo "gh version 9.9.9-fake (dsh test)"
    exit 0
    ;;
esac

# the unauthenticated fixture: gh exists, but every command (auth status
# included) fails the way an expired login does
if [ "$FAKE_GH_UNAUTH" = "1" ]; then
  echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2
  exit 1
fi

# the disabled-issues fixture: the PR list works, the issue list answers
# exactly the way a repository with its issue tracker turned off does
if [ "$FAKE_GH_ISSUES_DISABLED" = "1" ] && [ "$1 $2" = "issue list" ]; then
  echo "the 'acme/widget' repository has disabled issues" >&2
  exit 1
fi

# an issue-side transport failure — NOT the disabled-issues shape, so the
# merged listing must stay partial and name the issue side
if [ "$FAKE_GH_ISSUES_FAIL" = "1" ] && [ "$1 $2" = "issue list" ]; then
  echo "gh: connection reset by peer" >&2
  exit 1
fi

if [ "$FAKE_GH_PULLS_FAIL" = "1" ] && [ "$1 $2" = "pr list" ]; then
  echo "gh: connection reset by peer" >&2
  exit 1
fi

case "$1 $2" in
  "auth status")
    echo "github.com"
    echo "  Logged in to github.com account dsh-tester (oauth_token)"
    exit 0
    ;;
  "pr list")
    cat <<'JSON'
[
  {
    "number": 12,
    "title": "Fix the flaky login test",
    "url": "https://github.com/acme/widget/pull/12",
    "state": "OPEN",
    "body": "Closes #31",
    "labels": [{"name": "bug"}, {"name": "ready"}],
    "baseRefName": "main",
    "headRefName": "fix-login",
    "headRepositoryOwner": {"login": "acme"},
    "isCrossRepository": false,
    "updatedAt": "2024-05-02T10:00:00Z"
  },
  {
    "number": 9,
    "title": "Add dark mode",
    "url": "https://github.com/acme/widget/pull/9",
    "state": "MERGED",
    "body": "opened from a fork",
    "labels": [{"name": "ui"}],
    "baseRefName": "main",
    "headRefName": "dark-mode",
    "headRepositoryOwner": {"login": "alice-dev"},
    "isCrossRepository": true,
    "updatedAt": "2024-05-01T09:00:00Z"
  },
  {
    "number": 5,
    "title": "Refactor the parser",
    "url": "https://github.com/acme/widget/pull/5",
    "state": "CLOSED",
    "body": null,
    "labels": ["legacy-string"],
    "baseRefName": "develop",
    "headRefName": "parser",
    "headRepositoryOwner": {"login": "acme"},
    "isCrossRepository": false,
    "updatedAt": "2024-04-20T08:00:00Z"
  }
]
JSON
    exit 0
    ;;
  "api --hostname")
    host="$3"
    number=12
    [ "$host" = "ghe.example.test" ] && number=77
    printf '{"data":{"repository":{"pullRequests":{"nodes":[{"number":%s,"url":"https://%s/acme/widget/pull/%s","title":"status","state":"OPEN","isDraft":false,"baseRefName":"main","headRefName":"fix-login","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRepositoryOwner":{"login":"acme"},"mergedAt":null,"mergeable":"MERGEABLE","reviewDecision":"APPROVED","statusCheckRollup":{"state":"SUCCESS","contexts":{"nodes":[]}}}]}},"t0":{"pullRequests":{"nodes":[{"number":%s,"url":"https://%s/acme/widget/pull/%s","title":"status","state":"OPEN","isDraft":false,"baseRefName":"main","headRefName":"fix-login","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRepositoryOwner":{"login":"acme"},"mergedAt":null,"mergeable":"MERGEABLE","reviewDecision":"APPROVED","statusCheckRollup":{"state":"SUCCESS","contexts":{"nodes":[]}}}]}}}}\n' "$number" "$host" "$number" "$number" "$host" "$number"
    exit 0
    ;;
  "issue list")
    cat <<'JSON'
[
  {
    "number": 31,
    "title": "Login page 500s on Safari",
    "url": "https://github.com/acme/widget/issues/31",
    "state": "OPEN",
    "body": "steps to reproduce",
    "labels": [{"name": "bug"}],
    "updatedAt": "2024-05-03T12:00:00Z"
  },
  {
    "number": 21,
    "title": "Add dark mode",
    "url": "https://github.com/acme/widget/issues/21",
    "state": "CLOSED",
    "body": "wishlist",
    "labels": [],
    "updatedAt": "2024-04-25T07:00:00Z"
  }
]
JSON
    exit 0
    ;;
esac

case "$1 $2 $3" in
  "pr view 12")
    cat <<'JSON'
{"number":12,"title":"Fix the flaky login test","url":"https://github.com/acme/widget/pull/12","state":"OPEN","body":"Closes #31","labels":[{"name":"bug"},{"name":"ready"}],"baseRefName":"main","headRefName":"fix-login","headRepositoryOwner":{"login":"acme"},"isCrossRepository":false,"updatedAt":"2024-05-02T10:00:00Z"}
JSON
    exit 0
    ;;
  "pr view 9")
    cat <<'JSON'
{"number":9,"title":"Add dark mode","url":"https://github.com/acme/widget/pull/9","state":"MERGED","body":"opened from a fork","labels":[{"name":"ui"}],"baseRefName":"main","headRefName":"dark-mode","headRepositoryOwner":{"login":"alice-dev"},"isCrossRepository":true,"updatedAt":"2024-05-01T09:00:00Z"}
JSON
    exit 0
    ;;
  "issue view 12")
    cat <<'JSON'
{"number":12,"title":"Issue twelve","url":"https://github.com/acme/widget/issues/12","state":"OPEN","body":"issue body","labels":[],"updatedAt":"2024-05-04T12:00:00Z"}
JSON
    exit 0
    ;;
  "issue view 31")
    cat <<'JSON'
{"number":31,"title":"Login page 500s on Safari","url":"https://github.com/acme/widget/issues/31","state":"OPEN","body":"steps to reproduce","labels":[{"name":"bug"}],"updatedAt":"2024-05-03T12:00:00Z"}
JSON
    exit 0
    ;;
esac

# anything else: the non-zero exit a real gh uses for "nothing matched", so the
# host layer must fall back (pr view → issue view) instead of failing
echo "no pull requests or issues matched: $*" >&2
exit 1
`;
mkdirSync(fakeGHDir, { recursive: true });
writeFileSync(join(fakeGHDir, 'gh'), fakeGH, { mode: 0o755 });
process.env.FAKE_GH_DIR = fakeGHDir;
// before any real gh installation on this machine
process.env.PATH = `${fakeGHDir}:${process.env.PATH}`;

await test('forge: canonical remote parsing covers GitHub and enterprise URL forms', async () => {
  const expected = { host: 'ghe.example.test', owner: 'Acme', repo: 'Widget' };
  assert.deepEqual(parseGithubRemote('https://ghe.example.test/Acme/Widget.git'), expected);
  assert.deepEqual(parseGithubRemote('git@ghe.example.test:Acme/Widget.git'), expected);
  assert.deepEqual(parseGithubRemote('ssh://git@ghe.example.test:2222/Acme/Widget.git/'), expected);
  assert.deepEqual(parseGithubRemote('git://ghe.example.test/Acme/Widget.GIT'), expected);
  assert.deepEqual(parseGithubRemote('ssh://git@ssh.github.com:443/Acme/Widget.git'), { host: 'github.com', owner: 'Acme', repo: 'Widget' });
  assert.equal(parseGithubRemote('https://github.com/acme/widget/tree/main'), null);
  assert.equal(parseGithubRemote('not a remote'), null);
});

await test('forge: PR status isolates host auth, GraphQL calls, and caches', async () => {
  rmSync(fakeGHLog, { force: true });
  invalidateGhAuth();
  invalidatePr('');
  const common = { owner: 'acme', repo: 'widget', headRef: 'fix-login', headSha: 'a'.repeat(40) };
  const publicResult = await prStatus({ host: 'github.com', ...common });
  const enterpriseResult = await prStatus({ host: 'ghe.example.test', ...common });
  assert.equal(publicResult.pr.number, 12);
  assert.equal(enterpriseResult.pr.number, 77);
  const before = readFileSync(fakeGHLog, 'utf8');
  assert.match(before, /auth status --hostname github\.com/);
  assert.match(before, /auth status --hostname ghe\.example\.test/);
  assert.match(before, /api --hostname github\.com graphql/);
  assert.match(before, /api --hostname ghe\.example\.test graphql/);
  await prStatus({ host: 'github.com', ...common });
  assert.equal(readFileSync(fakeGHLog, 'utf8'), before, 'the exact host-qualified status is cached');
  await prStatus({ host: 'github.com', ...common, pullNumber: 88 });
  assert.match(readFileSync(fakeGHLog, 'utf8'), /pullRequest\(number:88\)/, 'managed PR worktrees query their recorded number, not a renamed local branch');

  invalidatePr('');
  const batched = await prStatusBatch([
    { key: 'public', host: 'github.com', ...common, headRef: 'batch-public' },
    { key: 'enterprise', host: 'ghe.example.test', ...common, headRef: 'batch-enterprise' },
  ]);
  assert.equal(batched.get('public').pr.number, 12);
  assert.equal(batched.get('enterprise').pr.number, 77);

  await createPullRequest({ host: 'ghe.example.test', owner: 'acme', repo: 'widget', base: 'main', head: 'feature', title: 'title', body: '' });
  await mergePullRequest({ host: 'ghe.example.test', owner: 'acme', repo: 'widget', number: 77 });
  await disableAutoMerge({ host: 'ghe.example.test', owner: 'acme', repo: 'widget', number: 77 });
  const mutationLog = readFileSync(fakeGHLog, 'utf8');
  assert.match(mutationLog, /pr create --repo ghe\.example\.test\/acme\/widget/);
  assert.match(mutationLog, /pr merge 77 --repo ghe\.example\.test\/acme\/widget/);
});

await test('forge: gh missing from PATH → cli_missing', async () => {
  // `ghAvailable` caches "installed" for the whole process, so the missing-gh
  // case gets its own module instance instead of poisoning the shared one
  const isolated = await import('../lib/forge.js?gh-missing');
  const emptyBin = join(scratch, 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });
  const withFakeGH = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    assert.equal(await isolated.ghAvailable(), false);
    assert.deepEqual(await isolated.listForgeItems({ cwd: prRepo, identity: forgeIdentity }), { items: [], authState: 'cli_missing', repository: forgeIdentity });
    assert.deepEqual(await isolated.pullRequestDetail({ cwd: prRepo, identity: forgeIdentity, number: 12 }), {
      ok: false,
      authState: 'cli_missing',
      repository: forgeIdentity,
      message: 'gh CLI not installed',
    });
  } finally {
    process.env.PATH = withFakeGH;
  }
});

await test('forge: auth states + gh JSON flattening (list + detail)', async () => {
  assert.equal(await ghAvailable(), true, 'the process-wide probe must find the fake gh');

  // gh exists but `gh auth status` fails
  process.env.FAKE_GH_UNAUTH = '1';
  invalidateGhAuth();
  assert.deepEqual(await listForgeItems({ cwd: prRepo, identity: forgeIdentity }), { items: [], authState: 'unauthenticated', repository: forgeIdentity });
  assert.deepEqual(await pullRequestDetail({ cwd: prRepo, identity: forgeIdentity, number: 12 }), {
    ok: false,
    authState: 'unauthenticated',
    repository: forgeIdentity,
    message: 'gh is not authenticated for this host',
  });
  delete process.env.FAKE_GH_UNAUTH;
  invalidateGhAuth();

  // both subcommands answer with JSON → issues + PRs merged newest-first
  invalidateForgeList();
  const listed = await listForgeItems({ cwd: prRepo, identity: forgeIdentity });
  assert.equal(listed.authState, 'authenticated');
  assert.deepEqual(listed.items.map((i) => i.number), [31, 12, 9, 21, 5], 'merged and sorted by updatedAt');
  assert.deepEqual(listed.items.map((i) => i.kind), ['issue', 'change_request', 'change_request', 'issue', 'change_request']);
  assert.deepEqual(listed.items.find((i) => i.number === 12), {
    kind: 'change_request',
    host: 'github.com',
    owner: 'acme',
    repo: 'widget',
    number: 12,
    title: 'Fix the flaky login test',
    url: 'https://github.com/acme/widget/pull/12',
    state: 'open',
    body: 'Closes #31',
    labels: ['bug', 'ready'],
    updatedAt: '2024-05-02T10:00:00Z',
    baseRefName: 'main',
    headRefName: 'fix-login',
    headOwnerLogin: 'acme',
    fork: false,
  });
  assert.equal(listed.items.find((i) => i.number === 9).fork, true);
  /* A fork PR must carry its head owner in the LIST response too: the hero
     checks the fork's branch out as `<owner>/<headRef>`, so a list row without
     it would be handled as a same-repo PR and get an origin upstream. */
  assert.equal(
    listed.items.find((i) => i.number === 9).headOwnerLogin,
    'alice-dev',
    'a fork row names the owner its local branch will be prefixed with',
  );
  assert.equal(listed.items.find((i) => i.number === 9).state, 'merged', 'gh states are lowercased');
  assert.equal(listed.items.find((i) => i.number === 5).body, null);
  assert.deepEqual(listed.items.find((i) => i.number === 5).labels, ['legacy-string'], 'string labels still flatten');
  const issueRow = listed.items.find((i) => i.number === 31);
  assert.equal(issueRow.kind, 'issue');
  assert.deepEqual(issueRow.labels, ['bug']);
  assert.equal('baseRefName' in issueRow, false, 'issue rows carry no PR fields');
  assert.equal('headOwnerLogin' in issueRow, false, 'issue rows carry no PR fields');

  // one item in full: `gh pr view` for a PR…
  const detail = await pullRequestDetail({ cwd: prRepo, identity: forgeIdentity, number: 12, kind: 'change_request' });
  assert.equal(detail.ok, true);
  assert.equal(detail.item.kind, 'change_request');
  assert.equal(detail.item.state, 'open');
  assert.equal(detail.item.baseRefName, 'main');
  assert.equal(detail.item.headRefName, 'fix-login');
  assert.equal(detail.item.fork, false);
  assert.equal(detail.item.headOwnerLogin, 'acme');
  assert.deepEqual(detail.item.labels, ['bug', 'ready']);
  // …and the fork flavour of it
  const forkDetail = await pullRequestDetail({ cwd: prRepo, identity: forgeIdentity, number: 9 });
  assert.equal(forkDetail.item.fork, true);
  assert.equal(forkDetail.item.headOwnerLogin, 'alice-dev');
  // an issue number: `gh pr view` fails, `gh issue view` is the fallback
  const asIssue = await pullRequestDetail({ cwd: prRepo, identity: forgeIdentity, number: 31 });
  assert.equal(asIssue.ok, true);
  assert.equal(asIssue.item.kind, 'issue');
  assert.equal(asIssue.item.title, 'Login page 500s on Safari');
  const explicit = await pullRequestDetail({ cwd: prRepo, identity: forgeIdentity, number: 12, kind: 'change_request' });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.item.number, 12);
  const explicitIssue = await pullRequestDetail({ cwd: prRepo, identity: forgeIdentity, number: 12, kind: 'issue' });
  assert.equal(explicitIssue.ok, true);
  assert.equal(explicitIssue.item.kind, 'issue');
  assert.equal(explicitIssue.item.title, 'Issue twelve');
  const ambiguousLegacy = await pullRequestDetail({ cwd: prRepo, identity: forgeIdentity, number: 12 });
  assert.equal(ambiguousLegacy.ok, false);
  assert.equal(ambiguousLegacy.reason, 'ambiguous');
  // a number neither subcommand knows
  const missing = await pullRequestDetail({ cwd: prRepo, identity: forgeIdentity, number: 404 });
  assert.equal(missing.ok, false);
  assert.equal(missing.authState, 'error');
  assert.equal(missing.reason, 'not_found');
  assert.match(missing.message, /no pull requests or issues matched/);
});

await test('forge: a repository with disabled issues keeps the pull request list intact', async () => {
  process.env.FAKE_GH_ISSUES_DISABLED = '1';
  invalidateForgeList();
  let listed;
  try {
    listed = await listForgeItems({ cwd: prRepo, identity: forgeIdentity });
  } finally {
    delete process.env.FAKE_GH_ISSUES_DISABLED;
    invalidateForgeList();
  }
  // the issue tracker being off is not a listing failure: no error banner, and
  // the PR side is complete (regression: this surfaced as "Pull request list
  // unavailable: … repository has disabled issues")
  assert.equal(listed.authState, 'authenticated', JSON.stringify(listed));
  assert.equal(listed.error, undefined);
  assert.deepEqual(listed.items.map((i) => i.kind), ['change_request', 'change_request', 'change_request']);
  assert.deepEqual(listed.items.map((i) => i.number), [12, 9, 5]);
});

await test('forge: a partial listing names the failing side', async () => {
  process.env.FAKE_GH_PULLS_FAIL = '1';
  invalidateForgeList();
  let pullsFailed;
  try {
    pullsFailed = await listForgeItems({ cwd: prRepo, identity: forgeIdentity });
  } finally {
    delete process.env.FAKE_GH_PULLS_FAIL;
    invalidateForgeList();
  }
  assert.equal(pullsFailed.authState, 'partial');
  assert.equal(pullsFailed.partialSide, 'pulls');
  assert.deepEqual(pullsFailed.items.map((i) => i.kind), ['issue', 'issue']);

  process.env.FAKE_GH_ISSUES_FAIL = '1';
  invalidateForgeList();
  let issuesFailed;
  try {
    issuesFailed = await listForgeItems({ cwd: prRepo, identity: forgeIdentity });
  } finally {
    delete process.env.FAKE_GH_ISSUES_FAIL;
    invalidateForgeList();
  }
  assert.equal(issuesFailed.authState, 'partial');
  assert.equal(issuesFailed.partialSide, 'issues');
  assert.deepEqual(issuesFailed.items.map((i) => i.kind), ['change_request', 'change_request', 'change_request']);
});

await test('api: /pulls + /pull over real HTTP (fake gh)', async () => {
  rmSync(fakeGHLog, { force: true });
  const hub = createGitStateHub({ onChange: () => {} });
  const api = createApi(hub, { workspaceRoots: () => [prRepo, scratch], resolveForgeIdentity: async () => forgeIdentity });
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  try {
    const get = async (path) => (await fetch(base + path)).json();

    // 400s
    const noCwd = await fetch(`${base}/pulls`);
    assert.equal(noCwd.status, 400);
    assert.equal((await noCwd.json()).error, 'cwd required');
    for (const number of ['abc', '0', '1.5', '9007199254740993', '']) {
      const bad = await fetch(`${base}/pull?cwd=${encodeURIComponent(prRepo)}&number=${number}`);
      assert.equal(bad.status, 400, `number=${JSON.stringify(number)}`);
      assert.equal((await bad.json()).error, 'number required');
    }
    assert.equal((await fetch(`${base}/pull?cwd=${encodeURIComponent(prRepo)}`)).status, 400);

    // a non-git cwd never reaches the forge
    assert.deepEqual(await get(`/pulls?cwd=${encodeURIComponent(scratch)}`), {
      ok: true,
      isGit: false,
      items: [],
      authState: 'no_remote',
    });
    const outsidePull = await get(`/pull?cwd=${encodeURIComponent(scratch)}&number=12`);
    assert.equal(outsidePull.ok, false);
    assert.equal(outsidePull.authState, 'no_remote');

    // the listing: merged issues+PRs, newest first, limit forwarded to gh
    const pulls = await get(`/pulls?cwd=${encodeURIComponent(prRepo)}&limit=7`);
    assert.equal(pulls.ok, true);
    assert.equal(pulls.isGit, true);
    assert.equal(pulls.authState, 'authenticated');
    assert.deepEqual(pulls.items.map((i) => i.number), [31, 12, 9, 21, 5]);
    const logLines = readFileSync(fakeGHLog, 'utf8').trim().split('\n');
    const prList = logLines.find((line) => line.includes('\tpr list '));
    assert.ok(prList, `gh pr list was invoked: ${logLines.join(' | ')}`);
    assert.ok(prList.startsWith(`${prRepo}\t`), `gh ran in the repo cwd: ${prList}`);
    assert.ok(prList.endsWith('--limit 7'), `the limit is forwarded: ${prList}`);
    /* The `--json` field list is a contract, not decoration: the fork's head
       owner is what names a fork PR's local branch, so dropping it from the
       request silently resolves the fork flag to null and checks the PR out
       under the wrong branch name with a bogus origin upstream. */
    assert.ok(prList.includes('headRepositoryOwner'), `the fork head owner is requested: ${prList}`);
    assert.ok(prList.includes('isCrossRepository'), `the fork flag is requested: ${prList}`);
    assert.ok(logLines.some((line) => line.includes('\tissue list ') && line.endsWith('--limit 7')));

    // one PR
    const pull = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=12&kind=change_request`);
    assert.equal(pull.ok, true);
    assert.equal(pull.item.kind, 'change_request');
    assert.equal(pull.item.number, 12);
    assert.equal(pull.item.state, 'open');
    assert.equal(pull.item.baseRefName, 'main');
    assert.equal(pull.item.headRefName, 'fix-login');
    assert.equal(pull.item.fork, false);
    assert.deepEqual(pull.item.labels, ['bug', 'ready']);
    assert.equal(pull.item.url, 'https://github.com/acme/widget/pull/12');
    const explicitPull = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=12&kind=issue&host=github.com&owner=acme&repo=widget`);
    assert.equal(explicitPull.item.kind, 'issue', 'the versioned selector never falls through to the PR of the same number');
    const mismatched = await fetch(`${base}/pull?cwd=${encodeURIComponent(prRepo)}&number=12&kind=issue&host=ghe.example.test&owner=acme&repo=widget`);
    assert.equal(mismatched.status, 409, 'a stale ref cannot silently retarget after the repository changes');

    // a fork PR reports its origin
    const forkPull = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=9`);
    assert.equal(forkPull.ok, true);
    assert.equal(forkPull.item.fork, true);
    assert.equal(forkPull.item.headOwnerLogin, 'alice-dev');

    // an issue number: `gh pr view` fails first, `gh issue view` answers
    const issue = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=31`);
    assert.equal(issue.ok, true);
    assert.equal(issue.item.kind, 'issue');
    assert.equal(issue.item.title, 'Login page 500s on Safari');
    assert.equal('baseRefName' in issue.item, false);
    const issueExplicit = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=31&kind=issue`);
    assert.equal(issueExplicit.ok, true);
    assert.equal(issueExplicit.item.kind, 'issue');

    // a number gh does not know: a plain answer, never a 500
    const goneResponse = await fetch(`${base}/pull?cwd=${encodeURIComponent(prRepo)}&number=404`);
    assert.equal(goneResponse.status, 404);
    const gone = await goneResponse.json();
    assert.equal(gone.ok, false);
    assert.equal(gone.authState, 'error');
    assert.equal(gone.reason, 'not_found');
    assert.match(gone.message, /no pull requests or issues matched/);

    // the route reports the auth state it got from the forge
    process.env.FAKE_GH_UNAUTH = '1';
    invalidateGhAuth();
    const gate = await get(`/pulls?cwd=${encodeURIComponent(prRepo)}`);
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.items, []);
    assert.equal(gate.authState, 'unauthenticated');
    delete process.env.FAKE_GH_UNAUTH;
    invalidateGhAuth();
  } finally {
    api.dispose();
    server.close();
    await hub.dispose();
  }
});

await test('cleanup scheduler is single-flight and drains on dispose', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const controller = new AbortController();
  const scheduler = createCleanupScheduler(async ({ abandoned, signal }) => {
    calls += 1;
    assert.equal(abandoned, true);
    assert.equal(signal, controller.signal);
    await gate;
  }, {
    start: false,
    signal: controller.signal,
    onStop: () => controller.abort(),
  });
  const first = scheduler.sweep();
  const second = scheduler.sweep();
  assert.equal(first, second);
  assert.equal(calls, 1);
  let drained = false;
  const disposing = scheduler.dispose().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(controller.signal.aborted, true);
  assert.equal(drained, false, 'dispose must await the committed sweep');
  release();
  await Promise.all([first, disposing]);
  assert.equal(calls, 1);
  assert.equal(scheduler.sweep(), null);
});

await test('cleanup revalidates its queued repository capability', async () => {
  const identity = statSync(repo);
  const capability = { ok: true, cwd: repo, root: repo, mainRepoRoot: repo, identity: { dev: identity.dev, ino: identity.ino } };
  let allowed = true;
  let markQueued;
  const queued = new Promise((resolveQueued) => { markQueued = resolveQueued; });
  const observed = {
    run(key, task, options) {
      markQueued();
      return hostMutationCoordinator.run(key, task, options);
    },
    acquire: (...args) => hostMutationCoordinator.acquire(...args),
  };
  const { createCleanup } = await import('../lib/cleanup.js');
  const cleanup = createCleanup({
    get(name) {
      if (name === 'sessions') return { list: async () => [] };
      if (name === 'workspaceRegistry') return { list: () => [], delete: async () => true };
      return undefined;
    },
  }, { mutations: observed });
  const release = await hostMutationCoordinator.acquire(`git:${repo}`);
  const running = cleanup({
    cwd: repo,
    capability,
    reauthorize: async () => allowed ? capability : { ok: false, reason: 'unauthorized' },
  });
  await queued;
  allowed = false;
  release();
  const report = await running;
  assert.equal(report.ok, false);
  assert.match(report.error, /capability changed/);
  assert.equal(existsSync(wt1.path), true);
});

await test('cleanup sweep: dry-run, guards, archive + workspace delete', async () => {
  const { createCleanup } = await import('../lib/cleanup.js');
  const deleted = [];
  const wsEntities = [];
  const registryMock = {
    list: () => wsEntities.slice(),
    delete: async (id) => {
      await new Promise((resolveDelete) => setTimeout(resolveDelete, 5));
      deleted.push(id);
      return true;
    },
  };
  const sessionsMock = (cwds) => ({
    list: () => ({ ids: cwds.map((c, i) => `s${i}`), byId: Object.fromEntries(cwds.map((c, i) => [`s${i}`, { header: { cwd: c } }])) }),
  });
  const mockCtx = {
    get(name) {
      if (name === 'sessions') return sessionsMock([]);
      if (name === 'workspaceRegistry') return registryMock;
      return undefined;
    },
  };
  const cleanup = createCleanup(mockCtx);

  const wtClean = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'clean-sweep-0001' });
  const wtDirty = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'dirty-sweep-0002' });
  const wtUnknown = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'unknown-sweep-0003' });
  const unknownBase = (await readMetadata(wtUnknown.path)).baseRef;
  await patchMetadata(wtUnknown.path, (metadata) => ({ ...metadata, baseRef: 'refs/heads/definitely-missing' }));
  writeFileSync(join(wtDirty.path, 'junk.txt'), 'x\n');
  wsEntities.push(
    { path: wtClean.path, workspaceId: 'ws-clean-sweep-0001' },
    { path: wtDirty.path, workspaceId: 'ws-dirty-sweep-0002' },
    { path: wtUnknown.path, workspaceId: 'ws-unknown-sweep-0003' },
  );

  const dry = await cleanup({ dryRun: true });
  assert.equal(dry.ok, false, JSON.stringify(dry));
  assert.ok(dry.archived.some((a) => a.path === wtClean.path && a.dryRun === true));
  assert.ok(dry.skipped.some((s) => s.path === wtDirty.path && s.reason === 'dirty'));
  assert.ok(dry.errors.some((entry) => entry.path === wtUnknown.path && /ownership: metadata-invalid/.test(entry.message)), JSON.stringify(dry.errors));
  assert.ok(existsSync(wtClean.path), 'dry run must not remove anything');
  assert.ok(existsSync(wtUnknown.path), 'unknown safety state is fail-closed even in discovery');

  const live = await cleanup({});
  assert.ok(live.archived.some((a) => a.path === wtClean.path && !a.dryRun), JSON.stringify(live));
  assert.ok(live.skipped.some((s) => s.path === wtDirty.path));
  assert.ok(!existsSync(wtClean.path), 'archived worktree dir removed');
  assert.ok(deleted.includes('ws-clean-sweep-0001'), JSON.stringify(deleted));
  assert.ok(existsSync(wtDirty.path), 'dirty worktree untouched');
  assert.ok(existsSync(wtUnknown.path), 'failed revision inspection must preserve worktree');
  assert.ok(!deleted.includes('ws-unknown-sweep-0003'), 'failed inspection must preserve registry row');
  // wt1 (committed + unpushed) must never be swept
  assert.ok(live.skipped.some((s) => s.path === wt1.path), 'committed worktree guarded');

  // live session cwd → skipped 'session'
  const wtSession = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'session-sweep-0003' });
  wsEntities.push({ path: wtSession.path, workspaceId: 'ws-session-sweep-0003' });
  const liveSubdir = join(wtSession.path, 'active-session-subdir');
  mkdirSync(liveSubdir);
  const guarded = await createCleanup({
    get(name) {
      if (name === 'sessions') return { list: () => [{ id: 'live-host-session', header: { cwd: liveSubdir }, seq: 1 }] };
      if (name === 'workspaceRegistry') return registryMock;
      return undefined;
    },
  })({});
  assert.ok(guarded.skipped.some((s) => s.path === wtSession.path && s.reason === 'session'));
  assert.ok(existsSync(wtSession.path));

  // A session that starts after the initial snapshot is rechecked at the
  // destructive boundary and must still prevent archival.
  const raceRepo = join(scratch, 'cleanup-session-race-repo');
  mkdirSync(raceRepo);
  git(raceRepo, 'init', '-b', 'main');
  git(raceRepo, 'config', 'user.email', 'test@dsh.local');
  git(raceRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(raceRepo, 'tracked.txt'), 'one\n');
  git(raceRepo, 'add', '-A');
  git(raceRepo, 'commit', '-m', 'initial');
  const wtRaceSession = await createWorktree({ repoRoot: raceRepo, intent: 'branch-off', slug: 'session-race' });
  let sessionReads = 0;
  const raceGuarded = await createCleanup({
    get(name) {
      if (name === 'sessions') return {
        list: () => (++sessionReads === 1 ? [] : [{ id: 'late-session', header: { cwd: wtRaceSession.path }, seq: 1 }]),
      };
      if (name === 'workspaceRegistry') return registryMock;
      return undefined;
    },
  })({ cwd: raceRepo });
  assert.ok(raceGuarded.skipped.some((s) => s.path === wtRaceSession.path && s.reason === 'session'), JSON.stringify(raceGuarded));
  assert.ok(existsSync(wtRaceSession.path));
  await archiveWorktree(wtRaceSession.path, { force: true });

  // session guard unavailable without opt-in → refuse
  const refused = await createCleanup({ get: () => undefined })({});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /allowNoSessionGuard/);

  // archive guard fix: clean fresh worktree (no origin branch) archives non-force
  const plainArchive = await archiveWorktree(wtSession.path, {});
  assert.equal(plainArchive.ok, true, JSON.stringify(plainArchive));
  assert.ok(!existsSync(wtSession.path));

  await archiveWorktree(wtDirty.path, { force: true });
  await patchMetadata(wtUnknown.path, (metadata) => ({ ...metadata, baseRef: unknownBase }));
  await archiveWorktree(wtUnknown.path, { force: true });
});

await test('cleanup abandoned sweep: unreferenced+old only', async () => {
  const { createCleanup } = await import('../lib/cleanup.js');
  const { patchMetadata } = await import('../lib/worktree.js');
  const deleted = [];
  const wsEntities = [];
  const registryMock = {
    list: () => wsEntities.slice(),
    delete: async (id) => {
      await new Promise((resolveDelete) => setTimeout(resolveDelete, 5));
      deleted.push(id);
      return true;
    },
  };
  const mkCtx = (byId) => ({
    get(name) {
      if (name === 'sessions') {
        return {
          list: () => Object.entries(byId).map(([id, summary]) => ({
            id,
            header: summary.header,
            seq: summary.blank ? 0 : 1,
          })),
        };
      }
      if (name === 'workspaceRegistry') return registryMock;
      return undefined;
    },
  });
  const wtOld = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'abandon-old-0001' });
  const wtFresh = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'abandon-fresh-0002' });
  const wtBusy = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'abandon-busy-0003' });
  wsEntities.push(
    { path: wtOld.path, workspaceId: 'ws-abandon-old-0001' },
    { path: wtFresh.path, workspaceId: 'ws-abandon-fresh-0002' },
    { path: wtBusy.path, workspaceId: 'ws-abandon-busy-0003' },
  );
  const aged = Date.now() - 3600000;
  for (const target of [wtOld.path, wtBusy.path]) await patchMetadata(target, (m) => ({ ...m, createdAt: aged }));
  const byId = {
    s2: { header: { cwd: wtFresh.path }, blank: true },
    s3: { header: { cwd: wtBusy.path }, blank: false },
  };
  const report = await createCleanup(mkCtx(byId))({ abandoned: true, minAgeMs: 60000 });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.ok(report.archived.some((a) => a.path === wtOld.path), JSON.stringify(report));
  assert.ok(report.workspacesDeleted.includes('ws-abandon-old-0001'), JSON.stringify(report.workspacesDeleted));
  assert.ok(report.skipped.some((s) => s.path === wtFresh.path && s.reason === 'young'));
  assert.ok(report.skipped.some((s) => s.path === wtBusy.path && s.reason === 'session'));
  assert.ok(!existsSync(wtOld.path));
  assert.ok(existsSync(wtFresh.path) && existsSync(wtBusy.path));

  const abandonedRaceRepo = join(scratch, 'cleanup-abandoned-race-repo');
  mkdirSync(abandonedRaceRepo);
  git(abandonedRaceRepo, 'init', '-b', 'main');
  git(abandonedRaceRepo, 'config', 'user.email', 'test@dsh.local');
  git(abandonedRaceRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(abandonedRaceRepo, 'tracked.txt'), 'one\n');
  git(abandonedRaceRepo, 'add', '-A');
  git(abandonedRaceRepo, 'commit', '-m', 'initial');
  const wtLateBusy = await createWorktree({ repoRoot: abandonedRaceRepo, intent: 'branch-off', slug: 'late-busy' });
  await patchMetadata(wtLateBusy.path, (metadata) => ({ ...metadata, createdAt: aged }));
  let abandonedSessionReads = 0;
  const lateBusy = await createCleanup({
    get(name) {
      if (name === 'sessions') return {
        list: () => [{ id: 'late-busy-session', header: { cwd: wtLateBusy.path }, seq: ++abandonedSessionReads === 1 ? 0 : 1 }],
      };
      if (name === 'workspaceRegistry') return registryMock;
      return undefined;
    },
  })({ cwd: abandonedRaceRepo, abandoned: true, minAgeMs: 60000 });
  assert.ok(lateBusy.skipped.some((item) => item.path === wtLateBusy.path && item.reason === 'session'), JSON.stringify(lateBusy));
  assert.ok(existsSync(wtLateBusy.path));
  await archiveWorktree(wtLateBusy.path, { force: true });

  for (const target of [wtFresh.path, wtBusy.path]) await archiveWorktree(target, { force: true });
});

/* ---------------- platform anchoring (ADR 0013) ---------------- */

await test('platform anchoring helpers', async () => {
  const stable = await import('../lib/stable.js');
  try {
    // Git path normalization is shape-driven, independent of the host platform
    assert.equal(stable.normalizeGitPath('C:/Users/x/repo'), 'C:\\Users\\x\\repo');
    assert.equal(stable.normalizeGitPath('//server/share/repo'), '\\\\server\\share\\repo');
    assert.equal(stable.normalizeGitPath('C:\\Users\\x\\repo'), 'C:\\Users\\x\\repo');
    assert.equal(stable.normalizeGitPath('/tmp/plain/repo'), '/tmp/plain/repo');
    assert.equal(stable.normalizeGitPath('relative/path'), 'relative/path');
    // win32 folds case in equivalence; POSIX stays strict
    stable.__setPlatformForTests('win32');
    assert.equal(stable.isDirfdPinSupported(), false);
    assert.equal(stable.isFileExchangeSupported(), false);
    assert.equal(stable.isWindows(), true);
    assert.equal(stable.samePath('/a/B/c', '/A/b/C'), true);
    assert.equal(stable.samePath('/a/B/c', '/a/B/d'), false);
    // ownership rows: git prints forward-slash paths on Windows while every
    // recorded path uses backslashes, so the row match must normalize first
    // (a raw `worktree ${path}` comparison made every create fail post-add)
    const winRow = 'worktree C:/Users/x/.dsh/worktrees/ab12cd34/wt-1\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/wt-1';
    assert.equal(worktreeRowHasPath(winRow, 'C:\\Users\\x\\.dsh\\worktrees\\ab12cd34\\wt-1'), true);
    assert.equal(worktreeRowHasPath(winRow, 'C:\\Users\\X\\.dsh\\worktrees\\ab12cd34\\WT-1'), true);
    assert.equal(worktreeRowHasPath(winRow, 'C:\\Users\\x\\.dsh\\worktrees\\ab12cd34\\other'), false);
    assert.equal(worktreeRowHasPath('branch refs/heads/wt-1\nHEAD 1111', 'C:\\Users\\x\\.dsh\\worktrees\\ab12cd34\\wt-1'), false);
    stable.__setPlatformForTests(null);
    assert.equal(stable.isDirfdPinSupported(), process.platform === 'linux');
    assert.equal(stable.isFileExchangeSupported(), process.platform === 'linux');
    assert.equal(stable.isWindows(), process.platform === 'win32');
    // case folding is a win32 semantic, not a POSIX one: after the simulation
    // is restored the real platform decides, so Windows stays usable as a host
    assert.equal(stable.samePath('/a/B/c', '/A/b/C'), process.platform === 'win32');
    assert.equal(stable.samePath('/a/b/c', '/a/b/c'), true);
    // a POSIX-shaped row keeps matching through the same helper
    assert.equal(worktreeRowHasPath('worktree /tmp/a/wt\nbranch refs/heads/wt', '/tmp/a/wt'), true);
    assert.equal(worktreeRowHasPath('worktree /tmp/a/wt\nbranch refs/heads/wt', '/tmp/a/wt-2'), false);
    // stat identity verification is the path-mode anchor proof
    const info = statSync(repo);
    assert.equal(await stable.verifyStatIdentity(repo, { dev: info.dev, ino: info.ino }), true);
    assert.equal(await stable.verifyStatIdentity(repo, { dev: info.dev, ino: info.ino + 1 }), false);
    assert.equal(await stable.verifyStatIdentity(join(repo, 'missing-anchor'), { dev: info.dev, ino: info.ino }), false);
    assert.equal(await stable.verifyStatIdentity(repo, null), false);
  } finally {
    stable.__setPlatformForTests(null);
  }
});

await test('path mode (simulated win32): discovery, worktree creation, picker, editor save', async () => {
  const stable = await import('../lib/stable.js');
  const pathRepo = join(scratch, 'path-mode-repo');
  mkdirSync(pathRepo);
  git(pathRepo, 'init', '-b', 'main');
  git(pathRepo, 'config', 'user.email', 'test@dsh.local');
  git(pathRepo, 'config', 'user.name', 'DSH Test');
  writeFileSync(join(pathRepo, 'edit-me.txt'), 'before\n');
  git(pathRepo, 'add', '-A');
  git(pathRepo, 'commit', '-m', 'initial');
  const hub = createGitStateHub({ onChange: () => {} });
  const api = createApi(hub, {
    workspaceRoots: () => [pathRepo],
    resolveForgeIdentity: async () => ({ host: 'github.com', owner: 'test-owner', repo: 'test-repo' }),
  });
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  const originHeaders = { 'Content-Type': 'application/json', Origin: new URL(base).origin };
  let created = null;
  let stateHub = null;
  try {
    stable.__setPlatformForTests('win32');
    // the composer GitHub picker's data source used to 503 off Linux
    const pulls = await (await fetch(`${base}/pulls?cwd=${encodeURIComponent(pathRepo)}`)).json();
    assert.equal(pulls.ok, true, JSON.stringify(pulls));
    assert.equal(pulls.isGit, true);
    const detect = await (await fetch(`${base}/detect?path=${encodeURIComponent(pathRepo)}`)).json();
    assert.equal(detect.ok, true, JSON.stringify(detect));
    assert.equal(detect.isGit, true);
    assert.equal(detect.isLinkedWorktree, false);
    const branches = await (await fetch(`${base}/branches?cwd=${encodeURIComponent(pathRepo)}`)).json();
    assert.ok(branches.ok, JSON.stringify(branches));
    assert.ok(branches.branches.some((branch) => branch.name === 'main' && branch.current));
    // hero dropdown worktree creation — journal, link publication, add,
    // postcondition and metadata all run in path mode
    const create = await fetch(`${base}/worktrees`, {
      method: 'POST',
      headers: originHeaders,
      body: JSON.stringify({ cwd: pathRepo, base: 'main', intent: 'branch-off', slug: 'path-mode-wt' }),
    });
    assert.equal(create.status, 201);
    created = await create.json();
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(existsSync(join(created.path, 'edit-me.txt')));
    const meta = await readMetadata(created.path);
    assert.equal(meta.intent, 'branch-off');
    assert.match(meta.branch, /^path-mode-wt/);
    const worktreesListed = await (await fetch(`${base}/worktrees?cwd=${encodeURIComponent(created.path)}`)).json();
    assert.ok(worktreesListed.items.some((item) => item.path === created.path && item.managed));
    // task diff out of the managed worktree
    const diff = await (await fetch(`${base}/diff?cwd=${encodeURIComponent(created.path)}&mode=task`)).json();
    assert.equal(diff.ok, true, JSON.stringify(diff));
    // editor save: fsync + CAS + rename replace (no exchange primitive off Linux)
    const before = await (await fetch(`${base}/file?cwd=${encodeURIComponent(created.path)}&path=edit-me.txt`)).json();
    assert.equal(before.kind, 'text');
    const saved = await fetch(`${base}/file`, {
      method: 'POST',
      headers: originHeaders,
      body: JSON.stringify({ cwd: created.path, path: 'edit-me.txt', content: 'after\n', baseSha1: before.sha1 }),
    });
    assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
    assert.equal(readFileSync(join(created.path, 'edit-me.txt'), 'utf8'), 'after\n');
    assert.equal(readdirSync(created.path).some((name) => name.startsWith('.bw-') && name.endsWith('.tmp')), false,
      'a path-mode save leaves no temporary file behind');
    const conflict = await fetch(`${base}/file`, {
      method: 'POST',
      headers: originHeaders,
      body: JSON.stringify({ cwd: created.path, path: 'edit-me.txt', content: 'clobber\n', baseSha1: before.sha1 }),
    });
    assert.equal(conflict.status, 409, 'stale CAS bases are rejected in path mode too');
    assert.equal(readFileSync(join(created.path, 'edit-me.txt'), 'utf8'), 'after\n');
    // hub snapshots compute through the path-mode anchor (stat identity, no pinning)
    const pathModeAuthorizer = createWorkspaceAuthorizer({ workspaceRoots: () => [pathRepo] });
    stateHub = createGitStateHub({
      authorizeTarget: (cwd) => pathModeAuthorizer.authorize(cwd),
      mutations: hostMutationCoordinator,
      onChange: () => {},
    });
    const snapshot = await stateHub.snapshotFor(created.path, { fresh: true });
    assert.equal(snapshot.branch, created.branch, JSON.stringify(snapshot));
    assert.equal(snapshot.managed, true);
    // archive also runs in path mode (no dirfd wrapper off Linux)
    const archived = await archiveWorktree(created.path, { force: true });
    assert.equal(archived.ok, true, JSON.stringify(archived));
    assert.ok(!existsSync(created.path));
    created = null;
    // the real platform is restored and unaffected (dirfd mode back on Linux)
    stable.__setPlatformForTests(null);
    assert.equal(stable.currentPlatform(), process.platform);
    const restoredDetect = await (await fetch(`${base}/detect?path=${encodeURIComponent(pathRepo)}`)).json();
    assert.equal(restoredDetect.ok, true, JSON.stringify(restoredDetect));
    assert.equal(restoredDetect.isGit, true);
  } finally {
    stable.__setPlatformForTests(null);
    if (created) await archiveWorktree(created.path, { force: true }).catch(() => {});
    await stateHub?.dispose().catch(() => {});
    api.dispose();
    server.close();
    await hub.dispose();
  }
});

rmSync(scratch, { recursive: true, force: true });
console.log(results.join('\n'));
if (process.exitCode) {
  console.log('SMOKE: FAILED');
} else {
  console.log('SMOKE: ALL PASS');
}
