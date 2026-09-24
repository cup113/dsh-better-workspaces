/**
 * dsh-better-workspaces — host half.
 *
 * Wires the git-state hub to the harness webServer (HTTP + SSE under
 * /better-workspaces/api) and to host activity events so snapshots stay
 * fresh while agents run. `webServer` and the Workspace registry are hard
 * dependencies, so routes cannot race cold boot or mount without their
 * authorization source (ADR 0005, ADR 0010). Optional integrations still
 * degrade gracefully: non-git Workspace → {isGit:false}; no gh CLI → flags.
 */
import { createApi } from './api.js';
import { createCleanup } from './cleanup.js';
import { validateManagedWorktree } from './worktree.js';
import { createGitStateHub } from './state.js';
import { createWorkspaceAuthorizer } from './authorize.js';
import { hostMutationCoordinator } from './mutation.js';

export const name = 'better-workspaces';

export function createCleanupScheduler(cleanupFn, options = {}) {
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  let stopped = false;
  let sweeping = null;
  const sweep = () => {
    if (stopped || sweeping) return sweeping;
    sweeping = Promise.resolve(cleanupFn({ abandoned: true, automatic: true, signal: options.signal }))
      .catch(() => {})
      .finally(() => { sweeping = null; });
    return sweeping;
  };
  const boot = options.start === false ? null : setTimeoutFn(sweep, options.bootDelayMs ?? 5000);
  const hourly = options.start === false ? null : setIntervalFn(sweep, options.intervalMs ?? 60 * 60 * 1000);
  return {
    sweep,
    async dispose() {
      if (!stopped) {
        stopped = true;
        options.onStop?.();
        if (boot !== null) clearTimeoutFn(boot);
        if (hourly !== null) clearIntervalFn(hourly);
      }
      await sweeping;
    },
  };
}

// `webServer` and `workspaceRegistry` are hard dependencies: without the
// first there is no surface; without the second cwd would have no authority
// source. Cordis waits and re-activates after both appear (ADR 0005/0010).
export const inject = ['webServer', 'workspaceRegistry'];

export function createWorkspaceArchiveGuard() {
  // DSH currently has no lease shared by Workspace membership, Session create,
  // Agent wake and browser draft ownership. Snapshot checks cannot make
  // physical deletion safe, including for unregistered managed worktrees.
  return async () => {
    throw new Error('physical archive is disabled until DSH provides a Session/Agent retiring lease');
  };
}

export function createCreationSourceGuard(ctx) {
  return async (sourceSessionId, expectedCwd) => {
    const sessions = ctx.get('sessions');
    if (!sessions || typeof sessions.list !== 'function') {
      throw new Error('creation source session is unavailable');
    }
    const snapshot = await sessions.list();
    const summaries = Array.isArray(snapshot)
      ? snapshot
      : Array.isArray(snapshot?.items) ? snapshot.items
        : Array.isArray(snapshot?.ids) && snapshot?.byId ? snapshot.ids.map((id) => snapshot.byId[id]) : null;
    if (!summaries) throw new Error('creation source session is unreadable');
    const source = summaries.find((item) => String(item?.id ?? item?.sessionId ?? '') === sourceSessionId);
    const cwd = source?.header?.cwd ?? source?.cwd;
    if (cwd !== expectedCwd) throw new Error('creation source session no longer owns cwd');
  };
}

export function createExactWorkspaceDelete(registry) {
  return async (workspaceId, expectedPath, capturedSessionIds) => {
    const target = registry.list().find((workspace) => (workspace.workspaceId ?? workspace.id) === workspaceId);
    if (!target) return false;
    if (target.path !== expectedPath) throw new Error('workspace deletion target no longer matches the archived path');
    if (!Array.isArray(capturedSessionIds)) {
      throw new Error('workspace deletion refused without captured durable Session membership');
    }
    const archived = new Set((registry.archivedSessionIds || []).map(String));
    const unarchived = capturedSessionIds.map(String).filter((sessionId) => !archived.has(sessionId));
    if (unarchived.length > 0) {
      throw new Error(`workspace deletion refused with ${unarchived.length} unarchived session(s)`);
    }
    // A pre-policy tombstone may omit a Session attached after its snapshot,
    // while WorkspaceEntity.sessionIds hides dead-cwd durable members after
    // physical removal. Without a raw-membership/retiring lease, retaining the
    // exact row is the only provably safe outcome. An already-absent row above
    // remains idempotently completable.
    throw new Error('workspace deletion is disabled until raw durable membership can be proven');
  };
}

export function apply(ctx) {
  let broadcast = null;
  const lifecycle = new AbortController();
  const mutations = hostMutationCoordinator;
  const registry = ctx.get('workspaceRegistry');
  const workspaceRows = () => registry.list();
  const assertWorkspaceArchivable = createWorkspaceArchiveGuard(ctx, registry);
  const deleteWorkspace = createExactWorkspaceDelete(registry);
  const workspaceRoots = () => workspaceRows().map((workspace) => workspace.path);
  const authorizer = createWorkspaceAuthorizer({ workspaceRoots });
  const hub = createGitStateHub({
    mutations,
    authorizeTarget: (cwd) => authorizer.authorize(cwd),
    onChange: (snapshot) => {
      if (broadcast) broadcast(snapshot);
    },
  });
  // Register ownership immediately so any later apply failure rolls timers and
  // watchers back with the Cordis fiber.
  ctx.effect(
    () => () => hub.dispose(),
    'better-workspaces: hub',
  );
  ctx.effect(
    () => () => lifecycle.abort(),
    'better-workspaces: lifecycle abort',
  );

  // Boot/hourly jobs replay durable recovery records only. Destructive
  // abandoned cleanup stays explicit until Session exposes an atomic lease.
  const cleanupFn = createCleanup(ctx, {
    mutations,
    signal: lifecycle.signal,
    recoveryOnly: true,
    deleteWorkspace,
  });
  ctx.effect(
    () => {
      const scheduler = createCleanupScheduler(cleanupFn, {
        signal: lifecycle.signal,
        onStop: () => lifecycle.abort(),
      });
      return () => scheduler.dispose();
    },
    'better-workspaces: abandoned sweep',
  );

  const webServer = ctx.get('webServer');
  if (webServer) {
    // workspace rows whose path is a managed worktree (sidebar icon injector)
    const worktreeWorkspaces = async () => {
      if (!registry || typeof registry.list !== 'function') return [];
      const items = [];
      for (const ws of registry.list()) {
        const path = ws && ws.path;
        if (typeof path !== 'string' || path === '') continue;
        const managed = await validateManagedWorktree(path);
        if (managed.ok) items.push({ workspaceId: ws.workspaceId ?? ws.id, path: managed.cwd });
      }
      return items;
    };
    const api = createApi(hub, {
      cleanup: cleanupFn,
      workspaceRoots,
      worktreeWorkspaces,
      workspaceRows,
      createWorkspace: (path, title) => registry.create(path, title),
      assertCreationSource: createCreationSourceGuard(ctx),
      assertWorkspaceArchivable,
      deleteWorkspace,
      mutations,
    });
    broadcast = api.broadcast;
    ctx.effect(
      () => {
        let unregister;
        try {
          unregister = webServer.register(api.route);
        } catch (error) {
          api.dispose();
          throw error;
        }
        return async () => {
          unregister();
          await api.dispose();
        };
      },
      'better-workspaces: api routes',
    );
  } else {
    // Unreachable safety net: inject above keeps the row waiting until the
    // route and authorization services exist.
    ctx.logger?.warn?.('[better-workspaces] webServer unexpectedly absent despite inject — plugin dormant');
  }

  // Agent activity → throttled recompute of every active target (5 s floor
  // inside the hub; cheap because snapshots are fingerprint-deduped).
  ctx.on('tools/result', () => hub.refreshActive());
  ctx.on('api-session/status', () => hub.refreshActive());

}
