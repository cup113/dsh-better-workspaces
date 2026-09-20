/**
 * Client-bundle smoke test (Node): simulates window.__ModuleLoader__,
 * materializes the factory with transparent structural hook stubs, verifies
 * the project-owned React runtime resolves, runs apply() against a mock ctx,
 * and validates slot registrations + locale parity. Real rendering lives in
 * client-react.mjs; this suite intentionally keeps element trees inspectable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Project-owned exact dev dependencies make this smoke deterministic and
// portable; the separate client-react suite exercises browser effects.
const runtimeRequire = createRequire(import.meta.url);
runtimeRequire('react');
runtimeRequire('react-dom/client');
const structuralReact = {
  createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: Symbol('Fragment'),
};
const factoryRequire = (specifier) => {
  if (specifier === 'react') return structuralReact;
  if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
  return runtimeRequire(specifier);
};

globalThis.window = globalThis;
let loadedEntry = null;
globalThis.__ModuleLoader__ = {
  load(entry) {
    loadedEntry = entry;
  },
};

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
(0, eval)(source);

assert.ok(loadedEntry, 'bundle called __ModuleLoader__.load');
assert.equal(loadedEntry.id, 'dsh-better-workspaces');
assert.equal(typeof loadedEntry.factory, 'function');

const mod = loadedEntry.factory(factoryRequire);
assert.equal(typeof mod.apply, 'function', 'exports.apply');
assert.deepEqual(mod.inject, ['slots', 'locale', 'sessions', 'workspaces']);

/* ---------------- dictionary parity + interpolation ---------------- */
let dictionaries = null;
const registrations = [];
const effects = [];
/* The official right Sidebar is present in this install: the plugin's diff page
   type registers through the service-gated child fiber real cordis starts. */
const tabTypes = [];
const sidebarRightTabs = {
  register(definition) {
    tabTypes.push(definition);
    return () => {};
  },
};
const sidebarRight = { openTab() {} };
/* The trigger pipeline: the forge reference codec registers here. */
const triggerSources = [];
const inputTriggers = {
  registerSource(source) {
    triggerSources.push(source);
    return () => {};
  },
};

/* The session-scope tag. `conversation.input.for(actx)` resolves its session
   through it, so the mock service below can accept the right ctx and reject a
   session binding exactly like the real implementation (`scopeOf` →
   `ctx[kScope]`, undefined for anything untagged). */
const SESSION_SCOPE = Symbol('session-scope');
let sessionSnapshot = { byId: {}, ids: [], current: undefined, phase: 'ready' };

const ctx = {
  // a hard inject would make `sidebarRightTabs` a ctx property inside the fiber
  sidebarRightTabs,
  effect(fn, label) {
    const dispose = fn(ctx);
    effects.push({ label, dispose });
    return dispose;
  },
  get(name) {
    if (name === 'sidebarRightTabs') return sidebarRightTabs;
    if (name === 'sidebarRight') return sidebarRight;
    return undefined;
  },
  inject(deps, callback) {
    assert.ok(
      deps.includes('sidebarRightTabs') || deps.includes('inputTriggers'),
      `unexpected service-gated child fiber: ${deps.join(', ')}`,
    );
    if (deps.includes('inputTriggers')) {
      callback({ ...ctx, inputTriggers });
      return { dispose() {} };
    }
    assert.ok(
      deps.includes('sidebarRightTabs'),
      'the diff page waits for the right Sidebar tab registry instead of injecting it',
    );
    callback(ctx);
    return { dispose() {} };
  },
  locale: {
    register(ns, dicts) {
      dictionaries = { ns, dicts };
      return () => {};
    },
    bind(_ns) {
      return (key, params) => {
        let template = dictionaries.dicts.zh[key] ?? key;
        if (params) {
          template = template.replace(/\{(\w+)\}/g, (match, name) =>
            name in params ? String(params[name]) : match,
          );
        }
        return template;
      };
    },
  },
  slots: {
    inject(slotName, registerFn) {
      const dispose = registerFn();
      registrations.push({ slotName, dispose });
    },
    register(descriptor, component) {
      registrations.push({ descriptor, component });
      return () => {};
    },
  },
  sessions: {
    list: {
      getSnapshot: () => sessionSnapshot,
      subscribe: () => () => {},
    },
    open() {},
    /* `input.for(actx)` resolves the session through a PRIVATE tag the sessions
       service stamps on the ctx it materializes per session; a session binding
       has no such tag. Model both, so a fix that passes the wrong one fails
       here instead of silently doing nothing in the browser (see the insert
       guard below). */
    scope(id) {
      return id === undefined ? undefined : { [SESSION_SCOPE]: id };
    },
    binding(id) {
      return id === undefined ? undefined : { sessionId: id, ctx: { isScope: false } };
    },
  },
  workspaces: { items: [], create: async () => ({ ok: false }) },
};

mod.apply(ctx);

assert.ok(dictionaries, 'locale dictionaries registered');
assert.equal(dictionaries.ns, 'better-workspaces');
const zhKeys = Object.keys(dictionaries.dicts.zh).sort();
const enKeys = Object.keys(dictionaries.dicts.en).sort();
assert.deepEqual(enKeys, zhKeys, 'zh/en key parity');
assert.equal(dictionaries.dicts.zh['view.diff'], 'diff');
assert.equal(dictionaries.dicts.zh['view.files'], undefined, 'the 文件 conversation view is gone');

const descriptors = registrations.filter((r) => r.descriptor).map((r) => r.descriptor);
const views = descriptors.filter((d) => d.name === 'conversation.view');
const docks = descriptors.filter((d) => d.name === 'conversation.input.dock');
assert.equal(views.length, 0, 'the plugin no longer contributes conversation views');
assert.equal(docks.length, 1, 'one dock occupant');
assert.equal(docks[0].id, 'git-diff-pill');
assert.equal(docks[0].order, -100);
for (const r of registrations.filter((x) => x.component)) {
  assert.equal(typeof r.component, 'function', 'component is a function');
}
// every remaining descriptor carries an inject(sessionId) that yields {sessionId}
for (const d of [...docks, ...descriptors.filter((x) => x.name === 'conversation.input.left')]) {
  assert.equal(typeof d.inject, 'function');
  assert.deepEqual(d.inject('s-1'), { sessionId: 's-1' });
  assert.equal(d.locale, 'better-workspaces');
}

/* ---------------- the composer's forge (issue / PR) control ---------------- */
/* ADR 0008: the two native composer controls are hardcoded in the official
   InputBar and are deliberately untouched; this is the ONLY composer addition,
   and it lands in the one additive slot (which renders after them). */
const leftSlots = descriptors.filter((d) => d.name === 'conversation.input.left');
assert.equal(leftSlots.length, 1, 'exactly one additive composer control');
assert.equal(leftSlots[0].id, 'forge-issue-pr');
assert.equal(leftSlots[0].order, 200);
/* the reference source is what makes a chip carry the full paseo text to the
   model while the composer shows only its label — it must ride the plugin's
   own lifetime, or an inserted chip would block every send */
assert.equal(triggerSources.length, 1, 'the forge reference source is registered');
const forgeSource = triggerSources[0];
assert.equal(forgeSource.trigger, '@');
assert.equal(forgeSource.name, 'better-workspaces-forge');
assert.equal(typeof forgeSource.codec, 'object', 'a codec is what turns a chip into model text');
assert.equal(typeof forgeSource.codec.serialize, 'function');
/* The projection the user SEES is "#N", while `trigger` above stays "@" (the
   official TriggerChar union is '/' | '@', and `trigger` is the lexicon's key
   domain). Keeping them different is the fix: an "@N" chip woke the official
   attachment/reference menu on the same keystroke. */
const forgeRef = mod.__bwTest.encodeForgeRef({ host: 'github.com', owner: 'acme', repo: 'widget', kind: 'change_request', number: 7 });
assert.ok(forgeRef.startsWith('bw1'));
assert.deepEqual(mod.__bwTest.decodeForgeRef(forgeRef), {
  version: 1, host: 'github.com', owner: 'acme', repo: 'widget', kind: 'change_request', number: 7,
});
assert.equal(forgeSource.codec.clipboardText(forgeRef), '[[dsh-bw1:https://github.com/acme/widget/pull/7]]');
const issueRef = mod.__bwTest.encodeForgeRef({ host: 'github.com', owner: 'acme', repo: 'widget', kind: 'issue', number: 7 });
const enterpriseRef = mod.__bwTest.encodeForgeRef({ host: 'ghe.example.test', owner: 'acme', repo: 'widget', kind: 'change_request', number: 7 });
assert.notEqual(issueRef, forgeRef, 'issue and PR #7 do not collide');
assert.notEqual(enterpriseRef, forgeRef, 'enterprise and public repositories do not collide');
assert.equal(mod.__bwTest.decodeForgeRef('bw1not-hex'), null, 'malformed versioned refs fail closed');
assert.equal(forgeSource.codec.clipboardText('7'), '#7', 'legacy numeric refs retain their projection');
await assert.rejects(forgeSource.codec.serialize('7'), /Forge|无法读取|Could not read/i,
  'legacy number-only refs fail closed because they carry no repository provenance');
/* NOT `candidates === undefined`: the controller's roster loop calls
   `candidates(...)` synchronously on every `@` hit, so an omitted hook throws
   inside the loop and every source ordered after this one stops answering.
   "No candidates of my own" is an empty list, and it must still be a promise. */
assert.equal(typeof forgeSource.candidates, 'function', 'the @ roster loop calls this hook unconditionally');
assert.deepEqual(await forgeSource.candidates({}, { query: '' }), [], 'this source never contributes @ rows');
/* Replay the controller's roster loop shape: EVERY registered source must
   answer synchronously without throwing. This is the assertion that fails when
   a hook is merely omitted (the real menu then loses every source after it),
   so it must not be replaced by a `=== undefined` check. */
for (const source of triggerSources) {
  const pending = source.candidates({ sessionId: 's-1' }, { query: '', position: 0, drilled: false });
  assert.equal(typeof pending.then, 'function', `${source.name}: candidates must return a promise`);
  assert.ok(Array.isArray(await pending), `${source.name}: candidates must resolve to a list`);
}
assert.equal(typeof forgeSource.onPick, 'function', 'the trigger contract requires onPick');
assert.equal(forgeSource.onPick({}), undefined, 'the picker is the source’s only insertion door');
assert.equal(forgeSource.lexicon, undefined, 'a #N projection cannot be truthfully restored by the @ lexicon scanner');
assert.equal(await forgeSource.codec.serialize('7', { aborted: false }).then(() => 'no', () => 'threw'), 'threw',
  'a ref without a repository fails loudly instead of expanding to nothing');
const originalFetch = globalThis.fetch;
let detailUrl = null;
sessionSnapshot = { byId: { 's-1': { cwd: '/repo-a' } }, ids: ['s-1'], current: 's-1', phase: 'ready' };
mod.__bwTest.forgeItems.set(forgeRef, { title: 'stale list row' });
globalThis.fetch = async (url) => {
  detailUrl = String(url);
  return { json: async () => ({ ok: true, item: {
    host: 'github.com', owner: 'acme', repo: 'widget', kind: 'change_request', number: 7,
    title: 'Fresh PR detail', url: 'https://github.com/acme/widget/pull/7', body: 'fresh body',
    baseRefName: 'main', headRefName: 'feature',
  } }) };
};
try {
  const modelText = await forgeSource.codec.serialize(forgeRef, { aborted: false });
  assert.match(modelText, /Fresh PR detail/);
  assert.match(modelText, /Base: main/);
  assert.match(modelText, /Head: feature/);
  assert.match(modelText, /fresh body/);
  assert.match(detailUrl, /cwd=%2Frepo-a/);
  assert.match(detailUrl, /kind=change_request/);
  assert.match(detailUrl, /host=github\.com/);
  assert.match(detailUrl, /owner=acme/);
  assert.match(detailUrl, /repo=widget/);
} finally {
  globalThis.fetch = originalFetch;
  sessionSnapshot = { byId: {}, ids: [], current: undefined, phase: 'ready' };
}

sessionSnapshot = {
  byId: { notes: { cwd: '/notes' }, owner: { cwd: '/repo-a' } },
  ids: ['notes', 'owner'], current: 'notes', phase: 'ready',
};
const triedCwds = [];
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url), 'http://local');
  const cwd = parsed.searchParams.get('cwd');
  triedCwds.push(cwd);
  return { json: async () => cwd === '/repo-a'
    ? ({ ok: true, item: { host: 'github.com', owner: 'acme', repo: 'widget', kind: 'change_request', number: 7,
        title: 'Owner Session PR', url: 'https://github.com/acme/widget/pull/7', body: '', baseRefName: 'main', headRefName: 'feature' } })
    : ({ ok: false, authState: 'no_remote', message: 'not a git repository' }) };
};
try {
  assert.match(await forgeSource.codec.serialize(forgeRef, { aborted: false }), /Owner Session PR/);
  assert.deepEqual(triedCwds, ['/notes', '/repo-a'], 'a non-Forge current Session does not mask the owning repository');
} finally {
  globalThis.fetch = originalFetch;
  sessionSnapshot = { byId: {}, ids: [], current: undefined, phase: 'ready' };
}
assert.equal(dictionaries.dicts.zh['forge.addIssuePr'], '添加 issue 或 PR');

/* ---------------- the composer control actually MOUNTS ---------------- */
/* ADR 0009: registering the control is not the same as it rendering. The
   first cut called `props.useInput()` with no argument, but the slot's
   snapshot hook is `<S>(sel, eq?) => S` — the selector is REQUIRED, so the
   component threw inside render and React unmounted it while its registration
   stayed in the slot table (the live page showed `active: false` and no DOM).
   This mounts it for real and drives every slot hook, so any hook signature
   drift fails here instead of silently in the browser. */
{
  // Keep this white-box contract walker independent of React's opaque element
  // internals. Real reconciliation/effects are mandatory in client-react.mjs.
  const { ForgeAttachControl } = mod.__bwTest;
  assert.equal(typeof ForgeAttachControl, 'function', 'the control is exported for this suite');
  // the control asks the session list for its cwd and renders nothing without
  // one (that guard is deliberate), so give the mock a session that has one
  sessionSnapshot = { ...sessionSnapshot, byId: { ...sessionSnapshot.byId, 's-1': { cwd: '/tmp' } } };
  const hooks = [];
  const useInput = (selector) => {
    hooks.push(['useInput', typeof selector]);
    assert.equal(typeof selector, 'function', 'useInput needs its required selector');
    return selector({ draft: 'hello', draftRev: 3, occurrences: [] });
  };
  const props = {
    sessionId: 's-1',
    useInput,
    // the framework hands the session-scope actions alongside the hooks
    inputActions: { setDraft() {} },
  };
  const tree = ForgeAttachControl(props);
  assert.deepEqual(hooks, [['useInput', 'function']], 'the control reads the draft through the slot hook');
  // walk the element tree the control returned, so the assertion holds for both
  // the rendered string and the direct call
  const seen = [];
  const types = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return;
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (typeof node === 'object') {
      // a child element with no props of its own (the icon glyph) still counts
      if (typeof node.type === 'string' || typeof node.type === 'function') types.push(node.type);
      const nodeProps = node.props ?? {};
      if (typeof nodeProps.className === 'string') seen.push(nodeProps.className);
      if (typeof nodeProps['aria-label'] === 'string') seen.push(nodeProps['aria-label']);
      walk(node.children);
      walk(nodeProps.children);
    }
  };
  walk(tree);
  const flat = `${String(tree)} ${seen.join(' ')}`;
  assert.match(flat, /dsh-bw-forge/, 'the control returns its wrapper element');
  assert.match(flat, /dsh-bw-forge-btn/, 'the forge button is in the returned tree');
  assert.match(flat, /添加 issue 或 PR/, 'and carries its localized aria-label');
  assert.ok(types.filter((type) => typeof type === 'function').length >= 1,
    'the GitHub mark glyph component is part of the subtree');
  assert.ok(types.includes('button'), 'the control renders a real button element');

  /* ---- the pick path: selecting a row must actually reach the composer ----
     Two live bugs hid behind this, both silent:
       1. `conversation.input.for(actx)` resolves the session via a private
          scope tag, so handing it a session BINDING throws — and the catch
          turned that into "nothing happens";
       2. the insertion span was rebuilt by hand from occurrence offsets, but
          those `length`s are CLIPBOARD coordinates while a chip occupies zero
          detect characters, so the span overshot the draft end.
     Driving the real element tree covers both: the resolution must land on the
     scope ctx, and the span must be the shell's own caretSpan(). */
  const forgeButton = (() => {
    let found = null;
    const seek = (node) => {
      if (found || node === null || node === undefined) return;
      if (Array.isArray(node)) { for (const child of node) seek(child); return; }
      if (typeof node !== 'object') return;
      if (node.props?.className === 'dsh-bw-forge-btn') { found = node; return; }
      seek(node.children);
      seek(node.props?.children);
    };
    seek(tree);
    return found;
  })();
  assert.ok(forgeButton, 'the forge button is walkable in the returned tree');

  /* ---- the pick path: a chosen row must actually reach the composer ----
     Two live bugs hid here, both silent:
       1. `conversation.input.for(actx)` resolves the session through a private
          scope tag, so handing it a session BINDING throws — and the catch in
          the pick handler turned that into "nothing happens at all";
       2. the insertion span was rebuilt by hand from `occurrences`, whose
          `length` is a CLIPBOARD length while a chip occupies zero detect
          characters — so the span overshot the draft end.
     Drive the exported path directly (the control calls the same function), and
     assert the resolution target, the span, and the reference payload. */
  const console_ = ctx.__bwAppCtx;
  assert.equal(console_, ctx, 'the entry exposed its own app ctx for this suite');
  const sessionInput = {};
  let resolvedWith = 'never called';
  const conversation = {
    input: {
      for(actx) {
        resolvedWith = actx[SESSION_SCOPE];
        assert.equal(resolvedWith, 's-1',
          'input.for must receive the session SCOPE ctx, never a session binding');
        return sessionInput;
      },
    },
  };
  /* The resolver asks for the "conversation" SERVICE. The official plugin also
     registers an unrelated class under `uiConversation` that has no `input`
     member — asking for that key is exactly the bug that made every attach a
     silent no-op, so the mock answers `undefined` for it and wires only the real
     key. `get` answers undefined for anything else, which also proves the
     resolver tolerates a not-yet-available service. */
  const originalGet = ctx.get?.bind(ctx);
  ctx.get = (name) => (name === 'conversation' ? conversation : originalGet ? originalGet(name) : undefined);

  const item = { host: 'github.com', owner: 'acme', repo: 'widget', number: 7, kind: 'change_request', title: 'wire up the picker', state: 'OPEN' };
  const detectEnd = mod.__bwTest.referenceDetectEnd;

  // (a) the projection contract: occurrence ranges are CLIPBOARD coordinates,
  // while every real chip contributes exactly one U+FFFC to detect text.
  assert.equal(detectEnd({ draft: '', occurrences: [] }), 0, 'an empty composer ends at zero');
  assert.equal(detectEnd({
    draft: '#803 ',
    occurrences: [{ offset: 0, length: 4 }],
  }), 2, 'one chip plus its trailing space occupies two detect characters');
  assert.equal(detectEnd({
    draft: '#803 #777 ',
    occurrences: [{ offset: 0, length: 4 }, { offset: 5, length: 4 }],
  }), 4, 'two chips produce detect end 4 — the third-pick regression boundary');
  assert.equal(detectEnd({
    draft: 'pre #7\n#1200 tail',
    occurrences: [
      { offset: 4, length: 2 },
      { offset: 7, length: 5, invalid: true },
    ],
  }), 12, 'plain text, newlines, variable-width and invalid chips preserve exact conversion');
  for (const malformed of [
    { draft: '#7', occurrences: [{ offset: 0, length: 0 }] },
    { draft: '#7', occurrences: [{ offset: 0, length: 3 }] },
    { draft: '#7#8', occurrences: [{ offset: 0, length: 2 }, { offset: 1, length: 2 }] },
    { draft: '#7', occurrences: [{ offset: 0.5, length: 2 }] },
  ]) assert.equal(detectEnd(malformed), null, 'malformed projections never manufacture a span');

  // (b) a binding is NOT a session scope: it must resolve to null, not throw.
  assert.equal(
    mod.__bwTest.resolveForgeSessionInput({ scope: (id) => ({ [SESSION_SCOPE]: id }) }, 's-1'),
    sessionInput,
    'the resolver lands the scope ctx that `input.for` accepts',
  );
  assert.equal(
    mod.__bwTest.resolveForgeSessionInput({ scope: () => undefined }, 's-1'),
    null,
    'and degrades to null when the session has no scope',
  );

  // (c) exact regression: three consecutive picks update a live shell. Before
  // this fix the first two succeeded by accident; the third used clipboard end
  // 10 as a detect span against a document whose real end was 4, was refused,
  // then expanded into model-form plain text.
  let multiState = { draft: '', draftRev: 0, phase: 'plain', occurrences: [] };
  const multiSpans = [];
  let multiSetDraftCalls = 0;
  let multiNotices = 0;
  const multiShell = {
    rev: 0,
    get snapshot() { return multiState; },
    caretSpan() {
      const at = detectEnd(multiState);
      return { start: at, end: at };
    },
    insertReference(ref, span) {
      const at = detectEnd(multiState);
      multiSpans.push({ ...span });
      if (span.start !== at || span.end !== at || span.draftRev !== this.rev) return false;
      const offset = multiState.draft.length;
      this.rev += 1;
      multiState = {
        draft: multiState.draft + ref.clipboardText + ' ',
        draftRev: this.rev,
        phase: 'plain',
        occurrences: multiState.occurrences.concat({
          occurrenceId: this.rev,
          source: ref.source,
          ref: ref.ref,
          offset,
          length: ref.clipboardText.length,
          label: ref.label,
          clipboardText: ref.clipboardText,
        }),
      };
      return true;
    },
    setDraft() { multiSetDraftCalls += 1; },
    notify() { multiNotices += 1; },
  };
  const three = [803, 777, 42].map((number) => mod.__bwTest.attachForgeReference({
    item: { host: 'github.com', owner: 'acme', repo: 'widget', number, kind: 'issue', title: `issue ${number}` },
    sessionInput: multiShell,
    fallbackInput: null,
  }));
  assert.deepEqual(three, [true, true, true], 'all three picks land as real chips');
  assert.deepEqual(multiSpans, [
    { start: 0, end: 0, draftRev: 0 },
    { start: 2, end: 2, draftRev: 1 },
    { start: 4, end: 4, draftRev: 2 },
  ], 'each pick uses the exact live detect end, including the third');
  assert.equal(multiState.draft, multiState.occurrences.map((entry) => entry.clipboardText + ' ').join(''),
    'all three stay in self-identifying chip persistence form');
  assert.deepEqual(multiState.occurrences.map((entry) => mod.__bwTest.decodeForgeRef(entry.ref).number), [803, 777, 42]);
  assert.equal(multiState.occurrences.length, 3, 'all three are real chip occurrences');
  assert.equal(multiSetDraftCalls, 0, 'the attach path never expands the draft through setDraft');
  assert.equal(multiNotices, 0, 'successful inserts stay quiet');

  // (d) one ordinary successful chip: live rev wins over render-time state.
  sessionInput.rev = 9;
  sessionInput.caretSpan = () => ({ start: 5, end: 5 });
  sessionInput.snapshot = { draft: 'hello', draftRev: 9, phase: 'plain', occurrences: [] };
  let setDraftCalls = 0;
  let notified = null;
  sessionInput.notify = (level, text) => { notified = { level, text }; };
  sessionInput.setDraft = () => { setDraftCalls += 1; };
  sessionInput.insertReference = (ref, span) => {
    assert.equal(resolvedWith, 's-1', 'the reference resolves before insertion');
    assert.deepEqual(span, { start: 5, end: 5, draftRev: 9 },
      'the span carries the shell’s live rev (a stale render-time rev would fail the CAS)');
    assert.equal(ref.source, 'better-workspaces-forge', 'the reference names our trigger source');
    assert.deepEqual(mod.__bwTest.decodeForgeRef(ref.ref), {
      version: 1, host: 'github.com', owner: 'acme', repo: 'widget', kind: 'change_request', number: 7,
    }, 'and carries the full immutable forge identity');
    assert.equal(ref.clipboardText, '[[dsh-bw1:https://github.com/acme/widget/pull/7]]', 'persistence carries a readable canonical identity without using the @ trigger');
    assert.ok(ref.label.includes('#7'), `the chip label names the item: ${ref.label}`);
    return true;
  };
  assert.equal(mod.__bwTest.attachForgeReference({
    item, sessionInput, fallbackInput: { draft: 'stale', draftRev: 0, occurrences: [] },
  }), true, 'the picked row lands a reference chip');
  assert.equal(setDraftCalls, 0, 'the atomic chip path never mutates the draft as plain text');
  assert.equal(notified, null, 'and a successful attach stays quiet');

  // (e) a persisted clipboard projection is rebound to the exact canonical ref.
  const sidecarStorage = new Map();
  const priorLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => sidecarStorage.get(key) ?? null,
    setItem: (key, value) => sidecarStorage.set(key, value),
    removeItem: (key) => sidecarStorage.delete(key),
  };
  try {
    const ref = mod.__bwTest.encodeForgeRef(item);
    const projection = mod.__bwTest.forgeClipboardText(ref);
    assert.equal(mod.__bwTest.embeddedForgeDraft(projection + ',').references[0].ref, ref,
      'adjacent punctuation stays outside the canonical URL identity');
    assert.equal(mod.__bwTest.embeddedForgeDraft('[[dsh-bw1:https://github.com/acme/widget/pull/nope]]').invalid, true);
    assert.equal(mod.__bwTest.embeddedForgeDraft('[[dsh-bw1:https://github.com/acme/widget/issues/').invalid, true);
    assert.equal(mod.__bwTest.embeddedForgeDraft('https://github.com/acme/widget/issues/'), null,
      'ordinary pasted Forge URLs are never claimed by this source');
    const malformedProjection = '[[dsh-bw1:https://github.com/acme/widget/pull/nope]]';
    const malformedRecord = mod.__bwTest.embeddedForgeDraft(malformedProjection);
    assert.equal(mod.__bwTest.forgeClipboardText(malformedRecord.references[0].ref), malformedProjection,
      'a malformed owner marker can become a deletable invalid chip without losing its text');
    const liveInput = { draft: projection, draftRev: 1, occurrences: [{
      source: 'better-workspaces-forge', ref, offset: 0, length: projection.length,
      label: 'PR #7 wire up the picker', clipboardText: projection,
    }] };
    mod.__bwTest.writeForgeDraftSidecar('persisted', liveInput);
    const invalidRef = malformedRecord.references[0].ref;
    const mixedStoredDraft = projection + ' ' + malformedProjection;
    mod.__bwTest.writeForgeDraftSidecar('mixed-stored', {
      draft: mixedStoredDraft,
      occurrences: [
        liveInput.occurrences[0],
        { source: 'better-workspaces-forge', ref: invalidRef, offset: projection.length + 1,
          length: malformedProjection.length, label: 'broken', clipboardText: malformedProjection },
      ],
    });
    assert.equal(mod.__bwTest.readForgeDraftSidecar('mixed-stored').references.length, 2,
      'sidecar persistence retains invalid owned chips alongside valid references');
    sessionInput.snapshot = { draft: projection, draftRev: 2, phase: 'plain', occurrences: [] };
    let rebound = null;
    const reboundShell = {
      rev: 2,
      insertReference: (reference, span) => { rebound = { reference, span }; return true; },
    };
    assert.equal(mod.__bwTest.settleForgeDraftSidecar('persisted', {
      draft: projection, draftRev: 2, occurrences: [],
    }, reboundShell), true);
    assert.equal(rebound.reference.ref, ref);
    assert.equal(rebound.reference.clipboardText, projection);
    assert.deepEqual(rebound.span, { start: 0, end: projection.length, draftRev: 2 });

    rebound = null;
    sidecarStorage.clear();
    assert.equal(mod.__bwTest.settleForgeDraftSidecar('transferred', {
      draft: projection, draftRev: 3, occurrences: [],
    }, reboundShell), true, 'a Workspace-transferred canonical URL restores without a source-Session sidecar');
    assert.equal(rebound.reference.ref, ref);

    rebound = null;
    assert.equal(mod.__bwTest.settleForgeDraftSidecar('malformed', {
      draft: malformedProjection, draftRev: 4, occurrences: [],
    }, reboundShell), true, 'a malformed owned marker is rebound as an invalid, user-deletable chip');
    assert.match(rebound.reference.ref, /^bwi/);
    assert.equal(rebound.reference.clipboardText, malformedProjection);

    const issueItem = { ...item, kind: 'issue', number: 8, url: 'https://github.com/acme/widget/issues/8' };
    const issueRef = mod.__bwTest.encodeForgeRef(issueItem);
    const issueProjection = mod.__bwTest.forgeClipboardText(issueRef);
    const mixedDraft = projection + ' ' + issueProjection;
    rebound = null;
    assert.equal(mod.__bwTest.settleForgeDraftSidecar('mixed', {
      draft: mixedDraft, draftRev: 5, occurrences: [{
        source: 'better-workspaces-forge', ref, offset: 0, length: projection.length,
        label: 'PR #7 wire up the picker', clipboardText: projection,
      }],
    }, reboundShell), true, 'plain owned markers are reconciled even when another Forge chip is already live');
    assert.equal(rebound.reference.ref, issueRef);
    assert.deepEqual(rebound.span, { start: 2, end: 2 + issueProjection.length, draftRev: 5 });

    const fileProjection = '/tmp/very-long-file.txt';
    rebound = null;
    assert.equal(mod.__bwTest.settleForgeDraftSidecar('cross-source', {
      draft: fileProjection + ' ' + projection, draftRev: 6, occurrences: [{
        source: 'files', ref: '/tmp/very-long-file.txt', offset: 0, length: fileProjection.length,
        label: 'very-long-file.txt', clipboardText: fileProjection,
      }],
    }, reboundShell), true, 'all reference sources participate in clipboard-to-detect coordinate shrink');
    assert.deepEqual(rebound.span, { start: 2, end: 2 + projection.length, draftRev: 6 });
  } finally {
    if (priorLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorLocalStorage;
  }

  // (f) a refused chip is atomic: draft unchanged, no setDraft, visible notice.
  sessionInput.insertReference = () => false;
  notified = null;
  assert.equal(mod.__bwTest.attachForgeReference({ item, sessionInput, fallbackInput: null }), false,
    'a refused attach reports failure');
  assert.equal(setDraftCalls, 0, 'a refused chip never expands into plain text');
  assert.ok(notified, 'the refusal surfaces on the composer notice channel');
  assert.equal(notified.level, 'error', 'as an error notice');
  assert.ok(notified.text.startsWith(dictionaries.dicts.zh['forge.attachFailed'].split('{reason}')[0]),
    `with the localized template: ${notified.text}`);
  assert.ok(notified.text.includes(dictionaries.dicts.zh['forge.attachFailedRejected']),
    `and the retryable rejection reason: ${notified.text}`);

  // (f) an exception carries its underlying reason and is still atomic.
  sessionInput.insertReference = () => { throw new Error('composer locked'); };
  notified = null;
  assert.equal(mod.__bwTest.attachForgeReference({ item, sessionInput, fallbackInput: null }), false,
    'a thrown attach reports failure');
  assert.equal(setDraftCalls, 0, 'an exception never writes model-form text either');
  assert.match(notified.text, /composer locked/, 'the notice carries the underlying reason');

  // (g) malformed live projection: do not even call insertReference.
  let insertCalls = 0;
  sessionInput.rev = 10;
  sessionInput.snapshot = {
    draft: '#7', draftRev: 10, phase: 'plain',
    occurrences: [{ offset: 0, length: 0 }],
  };
  sessionInput.insertReference = () => { insertCalls += 1; return true; };
  notified = null;
  assert.equal(mod.__bwTest.attachForgeReference({ item, sessionInput, fallbackInput: null }), false,
    'an inconsistent projection is rejected');
  assert.equal(insertCalls, 0, 'no guessed span reaches the editor');
  assert.equal(setDraftCalls, 0, 'and the malformed state leaves the draft untouched');
  assert.ok(notified, 'the malformed projection is visible to the user');

  // (h) no shell at all: return false; the caller keeps the picker open.
  assert.equal(mod.__bwTest.attachForgeReference({
    item, sessionInput: null,
    fallbackInput: { draft: '', draftRev: 0, phase: 'plain', occurrences: [] },
  }), false, 'a missing shell cannot claim success');

  // (i) a caret parked mid-text must not split the draft: append at exact end.
  sessionInput.rev = 11;
  sessionInput.snapshot = { draft: 'hello', draftRev: 11, phase: 'plain', occurrences: [] };
  sessionInput.caretSpan = () => ({ start: 2, end: 2 });
  let chipSpan = null;
  sessionInput.insertReference = (ref, span) => { chipSpan = span; return true; };
  assert.equal(mod.__bwTest.attachForgeReference({ item, sessionInput, fallbackInput: null }), true,
    'a mid-text caret still permits an append');
  assert.deepEqual(chipSpan, { start: 5, end: 5, draftRev: 11 },
    'a mid-text caret falls back to the exact draft end instead of splitting text');

  // (j) a caret beyond the computed end is invalid too. The old `>=` test
  // accepted it as "at end" and handed an out-of-range span to the editor.
  sessionInput.caretSpan = () => ({ start: 6, end: 6 });
  chipSpan = null;
  assert.equal(mod.__bwTest.attachForgeReference({ item, sessionInput, fallbackInput: null }), true,
    'an over-end caret is normalized rather than refused');
  assert.deepEqual(chipSpan, { start: 5, end: 5, draftRev: 11 },
    'an over-end caret must also fall back to the exact detect end');
}

/* The resolver's shape is a contract, not an implementation detail: a session
   BINDING has no scope tag, so `binding.ctx` must never come back. */
assert.ok(
  !/binding\.ctx/.test(source),
  'the forge resolver never hands a session binding to `conversation.input.for`',
);
/* And the service key is a contract too: the resolver must ask for
   "conversation" (the class that carries `input`), never "uiConversation" (an
   unrelated class with no `input` member). Asking for the wrong key returns
   undefined and turns every pick into a silent no-op. Comments are stripped
   first, because the code documents the wrong key by name. */
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
assert.ok(
  !/\.get\(\s*["']uiConversation["']\s*\)/.test(codeOnly),
  'the forge path resolves the "conversation" service, not the uiConversation class',
);
assert.match(
  codeOnly,
  /\.get\(\s*["']conversation["']\s*\)/,
  'and it actually asks for that service',
);

/* The chip LABEL remains "#N", never "@N". Its clipboard/persistence form is
   a readable canonical Forge URL so DSH's plain-text store and Workspace draft
   transfer cannot erase identity, without waking the @ trigger. */
assert.match(codeOnly, /const route = identity\.kind/, 'the codec derives a kind-specific URL route');
assert.match(codeOnly, /https:\/\/\$\{identity\.host\}/, 'canonical persistence refs retain the Forge host');
assert.ok(
  !/clipboardText:\s*["']@["']/.test(codeOnly),
  'no reference projection may start with "@" again',
);
assert.match(
  codeOnly,
  /trigger:\s*["']@["']/,
  'while `trigger` stays "@" (the official TriggerChar union is only "/" | "@")',
);

/* Reference insertion is atomic: a refusal keeps the picker open and never
   mutates the draft into the model form. The direct cases above prove the
   attach function; these source-shape guards cover the control's close policy
   and prevent the old coordinate formula from being reintroduced elsewhere. */
assert.match(
  codeOnly,
  /if\s*\(landed\)\s*\{[^}]*setOpen\(false\)/,
  'the picker closes only after a chip actually lands',
);
assert.ok(
  !/offset\s*\+\s*Math\.max\(draft\.length\s*-\s*label/.test(codeOnly),
  'the old clipboard/detect-mixing draft-end formula is gone',
);
const attachStart = codeOnly.indexOf('function attachForgeReference');
const attachEnd = codeOnly.indexOf('function renderForgeReferenceText', attachStart);
assert.ok(attachStart >= 0 && attachEnd > attachStart, 'the attach function is isolatable for source guards');
assert.ok(
  !/\.setDraft\s*\(/.test(codeOnly.slice(attachStart, attachEnd)),
  'the attach function has no plain-text draft fallback',
);

/* ---------------- diff as an official right-Sidebar page type ---------------- */
assert.equal(tabTypes.length, 1, 'exactly one right-Sidebar tab type');
const diffType = tabTypes[0];
assert.equal(diffType.id, 'dsh-better-workspaces/diff');
assert.equal(diffType.kind, 'bw-diff');
assert.equal(diffType.priority, 'extension');
assert.equal(diffType.title('sidebar://bw-diff'), 'diff');
// the guide entry is what offers diff beside the official 工作区文件 capsule —
// and it is also what flips defaultSeed to the 开始 chooser, because the seed
// only lands on a type while exactly one guide entry exists (ADR 0006
// Amendment 1)
assert.equal(Array.isArray(diffType.guide), true, 'exactly one guide entry');
assert.equal(diffType.guide.length, 1);
assert.deepEqual(
  Object.keys(diffType.guide[0]).sort(),
  ['description', 'icon', 'order', 'title'],
);
assert.equal(diffType.guide[0].order, 20);
assert.equal(diffType.guide[0].title(), '代码变更');
assert.equal(diffType.guide[0].description(), '查看本会话的代码变更，并提交 / 推送 / 建 PR');
assert.equal(typeof diffType.guide[0].icon, 'function', 'the page glyph doubles as the capsule icon');

const sidebarSlots = registrations.filter(
  (r) => r.descriptor && String(r.descriptor.name).startsWith('sidebar.right.pane.tab'),
);
assert.deepEqual(
  sidebarSlots.map((r) => [r.descriptor.name, r.descriptor.key]).sort(),
  [
    ['sidebar.right.pane.tab', 'dsh-better-workspaces/diff'],
    ['sidebar.right.pane.tab.title', 'dsh-better-workspaces/diff'],
  ].sort(),
  'body and chip title register under the definition id',
);

/* ---------------- first-send interception helpers (pure) ---------------- */
const T = mod.__bwTest;
assert.ok(T, '__bwTest helpers exported');
assert.equal(/blocks\.set\([^\n]+, null\)/.test(source), false,
  'composer blocks are cleared with undefined; null is still a live crashing block');
assert.ok(/\.filter\(\(entry\) => entry\.id !== "archive"\)/.test(source),
  'manual physical archive remains hidden until DSH provides a cross-page retiring lease');

assert.equal(T.failureMessage({ message: 'm' }), 'm');
assert.equal(T.failureMessage({ ok: false, error: 'cwd required' }), 'cwd required');
assert.equal(T.failureMessage({ ok: false, error: { message: 'deep' } }), 'deep');
assert.equal(T.failureMessage({ ok: false }), null);
assert.equal(T.basenameOf('/a/b/repo/'), 'repo');
assert.equal(T.basenameOf('/a/b/repo'), 'repo');
assert.match(T.mnemonicSlug(), /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);

// the retired file view left no icon plumbing behind
assert.equal(T.getFileIconSvg, undefined, 'vendored material icon table removed');
assert.equal(T.desaturateHexColor, undefined, 'Oklab helpers removed with it');
// the page's identity is exported so the definition and the slot keys can be cross-checked
assert.equal(T.SIDEBAR_DIFF_ID, diffType.id);
assert.equal(T.SIDEBAR_DIFF_KIND, diffType.kind);

// the pill is the diff page's only door: it must stay put for every git state
const tr = dictionaries.dicts.zh;
const label = (snapshot) => T.pillLabel(snapshot, (key, params) =>
  (tr[key] ?? key).replace(/\{(\w+)\}/g, (m, name) => (params && name in params ? String(params[name]) : m)));
const statLabel = label({ diffStat: { additions: 3, deletions: 1 }, dirty: true });
assert.equal(statLabel.children[0].props.className, 'dsh-bw-green');
assert.equal(statLabel.children[1], ' ');
assert.equal(statLabel.children[2].props.className, 'dsh-bw-red');
assert.equal(
  label({ diffStat: { additions: 0, deletions: 0 }, dirty: true, changedFileCount: 4 }).children[0],
  '4 个文件有改动',
);
assert.equal(
  label({ diffStat: { additions: 0, deletions: 0 }, dirty: false, upstream: { ahead: 2 } }).children[0],
  '↑2 未推送',
  'a clean tree with unpushed commits still reports them',
);
assert.equal(
  label({ diffStat: { additions: 0, deletions: 0 }, dirty: false, upstream: { ahead: 0 } }).children[0],
  'diff',
  'a clean, pushed tree keeps the pill with the bare page name',
);
const staleSnapshot = {
  dirty: true,
  changedFileCount: 4,
  diffStat: { additions: 9, deletions: 3 },
  upstream: { ahead: 2 },
  gitKnown: { head: false, status: false, aheadBehind: false, originDelta: false, diffStat: false },
};
assert.equal(label(staleSnapshot).children[0], 'diff', 'stale Git facts never masquerade as current pill facts');
assert.equal(T.snapshotMutationKnown(staleSnapshot), false, 'stale head/status cannot expose direct commit controls');
assert.equal(T.snapshotMutationKnown({ dirty: true }), true, 'legacy snapshots remain readable');

// new picker/editor dict keys
assert.equal(dictionaries.dicts.zh['hero.localSuffix'], '（本地）');
assert.equal(dictionaries.dicts.en['hero.localSuffix'], ' (local)');
assert.equal(dictionaries.dicts.en['files.conflict'], 'File changed on disk since load');
assert.equal(dictionaries.dicts.zh['diff.editFile'], '编辑');
assert.equal(dictionaries.dicts.zh['diff.modeSession'], '本会话');
assert.equal(dictionaries.dicts.en['diff.modeTask'], 'Task');
assert.equal(dictionaries.dicts.zh['files.pickHint'], undefined, 'file-tree copy removed');
assert.equal(dictionaries.dicts.zh['files.edit'], undefined, 'file-tree copy removed');
assert.equal(dictionaries.dicts.zh['files.save'], '保存', 'the shared editor copy stays');

// per-session touched-path extraction helpers
const found = new Set();
T.collectTouched([{ type: 'tool_use', name: 'Edit', input: { file_path: '/ws/a/b.txt' } }, { type: 'tool_use', name: 'bash', input: { command: 'rm x' } }], found, 0);
assert.deepEqual([...found], ['/ws/a/b.txt']);
const norm = T.normalizeTouchedPaths(new Set(['/ws/a/b.txt', 'rel/c.txt', '/other/d.txt']), '/ws');
assert.deepEqual([...norm].sort(), ['a/b.txt', 'rel/c.txt']);

/* ---------------- hero mode menu (UI regression) ---------------- */
const fakeT = (key) => dictionaries.dicts.zh[key] ?? key;
assert.deepEqual(T.heroModeItems(false, fakeT), [
  { id: 'local', label: '本地', active: true },
  { id: 'new', label: '新建 worktree', active: false },
], 'local mode: 本地 is offered and active, 新建 worktree is offered');
assert.deepEqual(T.heroModeItems(true, fakeT), [
  { id: 'local', label: '本地', active: false },
  { id: 'new', label: '新建 worktree', active: true },
], 'staging mode: the 本地 escape hatch stays selectable');

/* ---------------- cwd-tagged detection (cross-workspace rename) ---------------- */
const detectValue = { ok: true, isGit: true, isLinkedWorktree: true, managed: true };
assert.equal(T.liveDetect(null, '/a'), null, 'no detection yet');
assert.equal(T.liveDetect(undefined, '/a'), null, 'no detection yet');
assert.equal(T.liveDetect({ cwd: '/a', value: detectValue }, '/a'), detectValue, 'same-cwd detection is readable');
// the reported bug: switching sessions rendered the NEW cwd with the OLD
// detection, whose sourceWorkspaceTitle then renamed an unrelated workspace
assert.equal(T.liveDetect({ cwd: '/a', value: detectValue }, '/b'), null, 'a detection never crosses cwd');
assert.equal(T.liveDetect({ cwd: '/a', value: detectValue }, null), null, 'no cwd → no detection');
assert.equal(T.liveDetect({ cwd: null, value: detectValue }, '/a'), null, 'untagged detection is unusable');

/* ---------------- request ownership + draft handoff transactions ---------------- */
const requestOwner = T.createRequestOwner();
const firstRead = requestOwner.begin('read');
const unrelated = requestOwner.begin('save');
const latestRead = requestOwner.begin('read');
assert.equal(requestOwner.owns(firstRead), false, 'new same-domain request supersedes the prior one');
assert.equal(requestOwner.owns(unrelated), true, 'independent domains do not cancel each other');
assert.equal(requestOwner.owns(latestRead), true);
requestOwner.reset();
assert.equal(requestOwner.owns(unrelated), false, 'resource reset invalidates every outstanding request');
assert.equal(requestOwner.owns(latestRead), false);
const releaseMutation = T.acquireWorkspaceMutation('/workspace/a');
assert.equal(typeof releaseMutation, 'function');
assert.equal(T.acquireWorkspaceMutation('/workspace/a'), null, 'same-workspace mutation is synchronously single-flight');
const releaseOtherMutation = T.acquireWorkspaceMutation('/workspace/b');
assert.equal(typeof releaseOtherMutation, 'function', 'unrelated workspaces can mutate independently');
releaseMutation();
const releaseAgain = T.acquireWorkspaceMutation('/workspace/a');
assert.equal(typeof releaseAgain, 'function', 'lease is released after settlement');
releaseAgain();
releaseOtherMutation();

function draftInput(initial, noop = false, attachmentIds = [], occurrences = []) {
  let state = { draft: initial, draftRev: 1, phase: 'plain', attachmentIds: [...attachmentIds], occurrences };
  return {
    state: { getSnapshot: () => state },
    setDraft(text) {
      if (!noop) state = { ...state, draft: text, draftRev: state.draftRev + 1 };
    },
    addAttachments(ids) {
      if (noop) return false;
      state = { ...state, attachmentIds: [...state.attachmentIds, ...ids] };
      return true;
    },
    setPhase(phase) { state = { ...state, phase }; },
    removeAttachment(id) {
      const next = state.attachmentIds.filter((candidate) => candidate !== id);
      if (next.length === state.attachmentIds.length) return false;
      state = { ...state, attachmentIds: next };
      return true;
    },
  };
}
function draftSessions(source, target, open = () => {}) {
  const byId = { source, target };
  const conversation = { input: { for: (scope) => byId[scope.id] } };
  return {
    scope: (id) => ({ id, get: (name) => name === 'conversation' ? conversation : undefined }),
    open,
  };
}
const sourceDraft = draftInput('carry me');
const targetDraft = draftInput('');
const opened = [];
const sessionsForDraft = draftSessions(sourceDraft, targetDraft, (id) => opened.push(id));
const capturedDraft = T.readSessionDraft(sessionsForDraft, 'source');
assert.equal(T.sessionsHaveEmptyDrafts(sessionsForDraft, ['target']), true);
assert.equal(T.sessionsHaveEmptyDrafts(sessionsForDraft, ['source', 'target']), false,
  'Workspace archive preflight includes sibling session drafts');
assert.equal(T.transferSessionDraft(sessionsForDraft, 'source', 'target', capturedDraft), true);
assert.equal(sourceDraft.state.getSnapshot().draft, '');
assert.equal(targetDraft.state.getSnapshot().draft, 'carry me');
assert.deepEqual(opened, ['target'], 'target opens only after verified draft transfer');

const changedSource = draftInput('old');
const changedTarget = draftInput('');
const changedSessions = draftSessions(changedSource, changedTarget, () => { throw new Error('must not open'); });
const staleDraft = T.readSessionDraft(changedSessions, 'source');
changedSource.setDraft('new');
assert.equal(T.transferSessionDraft(changedSessions, 'source', 'target', staleDraft), false);
assert.equal(changedSource.state.getSnapshot().draft, 'new', 'draftRev CAS preserves a newer source draft');
assert.equal(changedTarget.state.getSnapshot().draft, '');
const claimedSource = draftInput('claim');
const claimedTarget = draftInput('');
const claimedSessions = draftSessions(claimedSource, claimedTarget, () => { throw new Error('must not open'); });
const claimedCapture = T.readSessionDraft(claimedSessions, 'source');
claimedSource.setPhase('claimed');
assert.equal(T.transferSessionDraft(claimedSessions, 'source', 'target', claimedCapture), false,
  'a phase transition fences draft transfer even when text/revision are unchanged');

const detachedSource = draftInput('detached');
const replacementSource = draftInput('live replacement');
const detachedTarget = draftInput('');
let liveSourceInput = detachedSource;
const detachedConversation = { input: { for: (scope) => scope.id === 'source' ? liveSourceInput : detachedTarget } };
const detachedSessions = {
  scope: (id) => ({ id, get: (name) => name === 'conversation' ? detachedConversation : undefined }),
  open: () => { throw new Error('must not open'); },
};
const detachedCapture = T.readSessionDraft(detachedSessions, 'source');
liveSourceInput = replacementSource;
assert.equal(T.transferSessionDraft(detachedSessions, 'source', 'target', detachedCapture), false,
  'a rematerialized live session facade supersedes the captured shell');
assert.equal(replacementSource.state.getSnapshot().draft, 'live replacement');

const reentrantSource = draftInput('captured');
const reentrantTarget = draftInput('');
const originalTargetSetDraft = reentrantTarget.setDraft.bind(reentrantTarget);
reentrantTarget.setDraft = (text) => {
  originalTargetSetDraft(text);
  if (text === 'captured') reentrantSource.setDraft('newer during target write');
};
const reentrantSessions = draftSessions(reentrantSource, reentrantTarget, () => { throw new Error('must not open'); });
assert.equal(T.transferSessionDraft(reentrantSessions, 'source', 'target', T.readSessionDraft(reentrantSessions, 'source')), false);
assert.equal(reentrantSource.state.getSnapshot().draft, 'newer during target write',
  'second CAS failure never rolls the source back over a newer draft');
assert.equal(reentrantTarget.state.getSnapshot().draft, '');

const guardedSource = draftInput('valuable');
const noopTarget = draftInput('', true);
const guardedSessions = draftSessions(guardedSource, noopTarget, () => { throw new Error('must not open'); });
assert.equal(T.transferSessionDraft(guardedSessions, 'source', 'target', T.readSessionDraft(guardedSessions, 'source')), false);
assert.equal(guardedSource.state.getSnapshot().draft, 'valuable', 'unconfirmed target write never clears source');

const rollbackSource = draftInput('restore');
const rollbackTarget = draftInput('');
const rollbackSessions = draftSessions(rollbackSource, rollbackTarget, () => { throw new Error('open failed'); });
assert.throws(
  () => T.transferSessionDraft(rollbackSessions, 'source', 'target', T.readSessionDraft(rollbackSessions, 'source')),
  /open failed/,
);
assert.equal(rollbackSource.state.getSnapshot().draft, 'restore');
assert.equal(rollbackTarget.state.getSnapshot().draft, '');

const attachmentSource = draftInput('', false, ['attachment-1']);
const attachmentTarget = draftInput('');
const attachmentRebinds = [];
const attachmentSessions = draftSessions(attachmentSource, attachmentTarget, (id) => opened.push(id));
assert.equal(T.transferSessionDraft(
  attachmentSessions,
  'source',
  'target',
  T.readSessionDraft(attachmentSessions, 'source'),
  { rebindDraftFiles: (sessionId, ids) => attachmentRebinds.push([sessionId, [...ids]]) },
), true, 'attachment-only draft is handed off instead of being stranded');
assert.deepEqual(attachmentSource.state.getSnapshot().attachmentIds, []);
assert.deepEqual(attachmentTarget.state.getSnapshot().attachmentIds, ['attachment-1']);
assert.deepEqual(attachmentRebinds, [['target', ['attachment-1']]]);

const reentrantAttachmentSource = draftInput('attachment draft', false, ['attachment-a', 'attachment-b']);
const reentrantAttachmentTarget = draftInput('');
const originalRemoveAttachment = reentrantAttachmentSource.removeAttachment.bind(reentrantAttachmentSource);
let attachmentRemovals = 0;
reentrantAttachmentSource.removeAttachment = (id) => {
  attachmentRemovals += 1;
  if (attachmentRemovals === 1) {
    const removed = originalRemoveAttachment(id);
    reentrantAttachmentSource.setDraft('newer during attachment removal');
    return removed;
  }
  return false;
};
const reentrantAttachmentSessions = draftSessions(reentrantAttachmentSource, reentrantAttachmentTarget, () => {});
assert.equal(T.transferSessionDraft(
  reentrantAttachmentSessions,
  'source',
  'target',
  T.readSessionDraft(reentrantAttachmentSessions, 'source'),
  { rebindDraftFiles() {} },
), false);
assert.equal(reentrantAttachmentSource.state.getSnapshot().draft, 'newer during attachment removal');
assert.deepEqual([...reentrantAttachmentSource.state.getSnapshot().attachmentIds].sort(), ['attachment-a', 'attachment-b']);
assert.deepEqual(reentrantAttachmentTarget.state.getSnapshot().attachmentIds, [],
  'rollback restores transaction-owned attachments without overwriting newer source text');

const referenceSource = draftInput('@issue', false, [], [{ source: 'forge', ref: 'issue:1' }]);
const referenceTarget = draftInput('');
const referenceSessions = draftSessions(referenceSource, referenceTarget, () => { throw new Error('must not open'); });
assert.equal(T.transferSessionDraft(
  referenceSessions,
  'source',
  'target',
  T.readSessionDraft(referenceSessions, 'source'),
  { rebindDraftFiles() {} },
), false, 'structured references fail closed because setDraft cannot preserve chips');
assert.equal(referenceSource.state.getSnapshot().draft, '@issue');

const persistedA = T.heroCreationRequest('source-tx', { cwd: '/a', base: 'main' }, () => ({ slug: 'stable' }));
const persistedB = T.heroCreationRequest('source-tx', { cwd: '/a', base: 'main' }, () => ({ slug: 'wrong' }));
assert.equal(persistedB.txId, persistedA.txId);
assert.equal(persistedB.targetSessionId, `session-${persistedA.txId}`,
  'target Session identity is deterministic across lost create responses');
assert.deepEqual(persistedB.body, { slug: 'stable' }, 'retry keeps the exact request body and slug');
const persistedConflict = T.heroCreationRequest('source-tx', { cwd: '/a', base: 'other' }, () => ({ slug: 'duplicate' }));
assert.equal(persistedConflict.txId, persistedA.txId, 'unresolved receipt converges before a changed selection can mint another tx');
assert.deepEqual(persistedConflict.body, { slug: 'stable' });
T.clearHeroCreationTx('source-tx', persistedA.txId);

// staging dictionary keys present in both locales
assert.equal(dictionaries.dicts.zh['hero.stageHint'], '选定基分支即创建并跳转，草稿随迁');
assert.equal(dictionaries.dicts.zh['hero.blockReason'], '正在创建隔离 Worktree…');
assert.equal(dictionaries.dicts.en['hero.stageCreateFallback'], 'Create now');
assert.equal(dictionaries.dicts.zh['hero.modeWorktreePick'], undefined, 'two-item menu: pick variant removed');
assert.equal(dictionaries.dicts.zh['hero.stageAttachWarn'], undefined, 'attach warning removed with the intercept');
assert.equal(dictionaries.dicts.zh['hero.modeLocal'], '本地');
assert.equal(dictionaries.dicts.en['hero.modeLocal'], 'Local');
assert.equal(dictionaries.dicts.zh['hero.modeWorktree'], '新建 worktree');
assert.equal(dictionaries.dicts.en['hero.modeWorktree'], 'New worktree');

console.log('CLIENT SMOKE: ALL PASS');
process.exit(0);
