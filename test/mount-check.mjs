/* mount-check.mjs — reproduce the cordis host mount outside dsh.
 *
 * Cold-boot mounts have failed silently once (row rolled back, routes 404);
 * the loader swallows the throw from stdout. This script imports every host
 * module and runs apply() against a minimal fake ctx — first dormant (no
 * webServer), then with a fake webServer — printing any throw verbatim so
 * the exact cold-boot failure mode is visible without restarting dsh.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MODULES = [
  '../lib/git.js',
  '../lib/diff.js',
  '../lib/worktree.js',
  '../lib/cleanup.js',
  '../lib/state.js',
  '../lib/actions.js',
  '../lib/forge.js',
  '../lib/api.js',
  '../lib/index.js',
];

for (const spec of MODULES) {
  try {
    await import(spec);
    console.log(`import ok: ${spec}`);
  } catch (e) {
    console.log(`IMPORT FAIL: ${spec}\n${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

function fakeCtx({ withWebServer, registerThrows = false }) {
  const effects = [];
  const logs = [];
  const webServer = withWebServer
    ? {
        register(route) {
          assert.equal(route.kind, 'prefix');
          assert.equal(route.path, '/better-workspaces/api');
          if (registerThrows) throw new Error('duplicate route');
          return () => {};
        },
        registerFallback() {
          return () => {};
        },
        tapIndex(fn) {
          assert.equal(typeof fn, 'function');
          return () => {};
        },
      }
    : undefined;
  return {
    ctx: {
      get(name) {
        if (name === 'webServer') return webServer;
        if (name === 'workspaceRegistry') return { list: () => [] };
        return undefined; // every optional service absent → dormant/degraded paths
      },
      on() {
        return () => {};
      },
      effect(fn, label) {
        effects.push({ label, factory: fn });
        return () => {};
      },
      logger: {
        warn: (...a) => logs.push(['warn', ...a]),
        error: (...a) => logs.push(['error', ...a]),
        info: (...a) => logs.push(['info', ...a]),
      },
    },
    effects,
    logs,
  };
}

const plugin = await import('../lib/index.js');

// Cold-boot/security regression guard: routes need both the server and the
// durable Workspace registry. Without either hard dependency the plugin could
// mount dormant or authorize against an empty/fail-open source.
assert.deepEqual(
  [...(plugin.inject ?? [])],
  ['webServer', 'workspaceRegistry'],
  'host plugin must wait for webServer and its authorization registry',
);

/* ---------------- bundle wiring: `dsh plugin add` is the whole install --------
 * The package must declare `dsh.bundle.patch`, or the dsh CLI installs it as a
 * plain profile dependency, prints a warning, and never lists it in
 * `dsh.profile.bundles` — the row never reaches the composition, so every GUI
 * surface silently disappears (the ADR 0005 failure mode, one layer earlier).
 * The row the patch contributes must name this package (module resolution
 * anchors on it) and carry the id the host half exports (one plugin, one row).
 */
const packageRoot = new URL('..', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));

const declaredPatch = manifest.dsh?.bundle?.patch;
assert.ok(
  declaredPatch,
  'package.json must declare dsh.bundle.patch or `dsh plugin --profile <p> add` only installs a plain dependency (no row, no mount)',
);
assert.ok(
  manifest.files?.includes(declaredPatch.replace(/^\.\//, '')),
  `package.json files must ship ${declaredPatch}: an npm publish would otherwise drop the only mount row`,
);

const patchSource = readFileSync(new URL(declaredPatch, packageRoot), 'utf8');
assert.match(patchSource, /^\s*-\s*insert:/m, `${declaredPatch} must contribute a top-level insert list`);

/* Exactly one row, and it must not be a second copy of a row a profile layer
 * already carries: the include inserts verbatim and the Loader throws on a
 * repeated entry id, so "bundle layer + hand-written row" is a boot failure
 * rather than a harmless duplicate. */
const rows = [...patchSource.matchAll(/^\s*-\s*id:\s*(\S+)\s*\n\s*name:\s*(\S+)\s*$/gm)].map((match) => ({
  id: match[1],
  name: match[2],
}));
assert.equal(rows.length, 1, `${declaredPatch} must contribute exactly one row, found ${rows.length}`);
assert.equal(rows[0].name, manifest.name, 'the row must mount this package by name');
assert.equal(rows[0].id, plugin.name, 'the row id must match the name the host half exports');

const readme = readFileSync(new URL('README.md', packageRoot), 'utf8');
assert.match(
  readme,
  /duplicate loader entry id/,
  'README must document the pre-bundle upgrade cleanup and its duplicate-id symptom',
);

for (const withWebServer of [false, true]) {
  const { ctx, effects, logs } = fakeCtx({ withWebServer });
  try {
    const dispose = plugin.apply(ctx);
    // run every registered effect body (timers, sweeps, route registration),
    // then its disposer so no boot timer keeps the process alive
    for (const entry of effects) {
      let disposer = null;
      try {
        disposer = entry.factory();
      } catch (e) {
        console.log(`EFFECT FAIL [${entry.label}] webServer=${withWebServer}\n${e && e.stack ? e.stack : e}`);
        process.exit(1);
      }
      if (typeof disposer === 'function') {
        try {
          await disposer();
        } catch (e) {
          console.log(`EFFECT DISPOSE FAIL [${entry.label}]\n${e && e.stack ? e.stack : e}`);
          process.exit(1);
        }
      }
    }
    if (typeof dispose === 'function') dispose();
    console.log(`apply ok (webServer=${withWebServer}); effects=${effects.length}; logs=${JSON.stringify(logs)}`);
  } catch (e) {
    console.log(`APPLY FAIL (webServer=${withWebServer})\n${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

// A duplicate route must dispose the API heartbeat immediately; the simulated
// Cordis rollback then disposes effects registered before the failing one.
{
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Set();
  globalThis.setInterval = () => {
    const token = {};
    intervals.add(token);
    return token;
  };
  globalThis.clearInterval = (token) => {
    intervals.delete(token);
  };
  try {
    const { ctx, effects } = fakeCtx({ withWebServer: true, registerThrows: true });
    plugin.apply(ctx);
    const disposers = [];
    let failure = null;
    for (const entry of effects) {
      try {
        const disposer = entry.factory();
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (error) {
        failure = error;
        break;
      }
    }
    assert.match(String(failure?.message || failure), /duplicate route/);
    for (const disposer of disposers.reverse()) await disposer();
    assert.equal(intervals.size, 0, 'failed registration cannot leak hub/API intervals');
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

console.log('MOUNT CHECK: ALL PASS');
