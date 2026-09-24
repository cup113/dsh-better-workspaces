# 0004. Worktree branch semantics: base selection, mnemonic placeholder, first-message LLM rename

Date: 2025-09-08 (v1, after first browser acceptance)

> **Partly superseded by [ADR 0014](./0014-explicit-naming-form-and-folder-derivation.md)** (2026-09-24): the first-message LLM branch rename (Phase B, Amendment 6.A) and the create-on-arm trigger set (Amendment 2) are gone — staging is now an explicit name + base form and the branch name is final. Phase A's branch semantics, Amendment 3 (base = remote head), Amendment 4 (diff modes), Amendment 5 and Amendment 6.B still stand.

## Context

The v1 hero flow let the user pick a branch and treated the pick as a
**checkout target**, and creation only fired when the user re-opened the
branch dropdown and clicked an item. The staging trigger's default label
(`分支: main`) looked like a completed choice, so users started chatting in
the *original* session — cwd unchanged — and every session on that working
tree saw the same diff. Two design errors compounded:

1. **Dead-end staging**: a visible "selection" that triggers nothing.
2. **Wrong branch semantics**: checking out the picked branch conflicts with
   git's one-worktree-per-branch rule exactly for the default choice (the
   default branch is checked out in the primary worktree), and does not match
   the reference implementation users compare against.

Paseo's verified behavior (reference source, `packages/server`):

- `resolve-worktree-creation-intent.ts`: no explicit action ⇒ **branch-off**;
  `refName` is the *base*, `branchName ?? worktreeSlug ?? "worktree"` is the
  new branch — a picked branch is never a checkout in the default flow.
- `worktree-core.ts` + app UI: the placeholder branch name is a mnemonic id
  (`createNameId()` from `mnemonic-id`), generated **client-side** and sent
  with the creation request.
- `workspace-auto-name.ts` / `paseo-worktree-service.ts` /
  `worktree-branch-name-generator.ts`: the session's **first agent context**
  triggers one LLM call producing `{title, branch}`; guards are metadata
  `firstAgentBranchAutoName.status === 'pending'` (v2 metadata, written at
  creation for branch-off), current branch still equals the recorded
  placeholder, and a one-shot `attempted` mark written *before* the model
  call; success applies `git branch -m` and notifies git mutation.
- `protocol/branch-slug.ts`: branch slugs are `[a-z0-9-/]`, ≤100, no
  leading/trailing/consecutive hyphens; collisions take `-2..-50` suffixes.

DSH-side capability check (all verified against the live deployment):
`ctx.llm.stream(options)` is callable from host plugins (the
`dsh-session-title-llm` package is the canonical call pattern:
`{provider, model, messages, system, maxTokens, sessionId, purpose, signal}`
→ chunks `text-delta`/`finish`); `ctx.agentDefaultModel.currentSelection()`
yields `{provider, model}`; `ctx.on('session/event', (session, event))`
carries genuine human messages as `event.type === 'user/message'` with
`event.data.source.kind === 'user'` and text blocks in `event.data.content`;
`session.header.cwd` gives the directory.

## Decision

Adopt paseo semantics in two phases.

**Phase A (client, hot-reloaded):**

- Mode menu: `本地` / `新建 worktree` (creates **immediately** from the
  default base) / `新建 worktree（选基分支）…` (staging).
- Branch-list picks are **bases**: always `intent: 'branch-off'`; the UI no
  longer sends `checkout` (the host API keeps the capability).
- The client generates the mnemonic slug (`adj-noun-hhhh`, embedded word
  lists — the bundle cannot import host modules) and sends it with every
  creation; it seeds the worktree directory and, on new-enough hosts, the
  placeholder branch.
- Staging trigger relabeled `基于: {branch}` — no false "selected" state.

**Phase B (host, effective after the next `dsh` restart — ADR 0003):**

- `createWorktree` branch-off without an explicit `branchName` cuts the
  placeholder from the slug (server-side mnemonic fallback) and records
  `autoName: {status: 'pending', placeholder}` in `worktree.json` (additive
  field, metadata stays version 1; explicit names record `ineligible`).
- `autoname.js` subscribes to `session/event` and runs the ported guard
  chain: genuine first user message, non-subagent session, cwd under the
  worktrees root, `pending` status, current branch still == placeholder.
  The `attempted` mark is written **before** the model call (one-shot even on
  failure, paseo parity). Naming uses `llm.stream` with the
  `agentDefaultModel` route, a 20 s budget, 64 max tokens, a ported
  branch-slug contract prompt (prompt-as-material-only, English output), and
  a hand-rolled delta collector. Output goes through `cleanBranchName` →
  `validateBranchSlug` → `findAvailableBranchName` (`-2..-50`) →
  `git branch -m` → metadata `renamed` → `hub.invalidate(cwd)`, so SSE
  refreshes badges/hero live.

**Deviations from paseo (deliberate):**

1. No title generation — DSH owns session titles natively (`sessionTitle`);
   only the branch is renamed.
2. Explicitly-named branches are `ineligible` — paseo marks every fresh
   branch-off pending; respecting an explicit user-chosen name is the saner
   reading of intent.
3. Migration window: worktrees created before the Phase B restart carry no
   `autoName` field and keep their placeholder (`main-wt` era names included)
   forever; no retroactive renaming.
4. v1 UI exposes no PR-checkout entry (host `checkout` intent remains for a
   future PR flow).

## Consequences

- The dead-end is gone: every terminal UI action creates a worktree and
  jumps to its session; chatting always happens in the intended directory.
- Placeholder names are valid slugs by construction; rename failures degrade
  to keeping them (best-effort, never blocks the session).
- The rename costs one auxiliary LLM call per worktree session lifetime.
- Guard placement (path-prefix gate + metadata check before any git call)
  keeps the per-message overhead negligible for non-worktree sessions.
- Tests pin the semantics: placeholder/pending metadata, explicit-name
  ineligibility, end-to-end rename through the subscription, manual-rename /
  invalid-output / collision / subagent / non-worktree guards, slug rules.

## Amendment 1 (same release): deferred creation on first send

The Phase A menu still created the worktree at click time (immediately, or on
branch pick). Browser acceptance exposed two failures of that shape:

1. Exploratory clicks registered a Workspace + blank session per click — the
   sidebar filled with mnemonic-named rows the user never asked for (the
   client `workspaces.create` hardcodes the title to the directory basename,
   i.e. the mnemonic slug).
2. `openWorkspaceFor` raced the push-synced workspace list snapshot:
   `uiWorkspace.connectWorkspace` reads that snapshot synchronously and
   threw `unknown workspace …` right after a successful create — worktree
   and workspace existed, the jump never happened, and the hero showed a
   red error.

Paseo's actual shape (re-verified against `new-workspace-screen`): the
creation request is submitted **together with the first agent context** —
selection alone creates nothing. DSH cannot attach creation to session
spawn (the blank session already exists with an immutable cwd), so the
client now intercepts the composer's first send instead:

- capture-phase `keydown` (Enter) / `click` (send-button candidate:
  enabled, svg-bearing, geometrically bottom-right button of the composer
  block) listeners, gated on staging armed + blank session + non-empty
  draft + no attachment chips;
- on intercept: create (mnemonic placeholder, staged base or explicit
  name) → poll the workspace snapshot (3 s) → connect/create session →
  open → `workspaces.rename` the workspace title from the first prompt
  line (paseo-style prompt-derived titles; `-2` on name conflict) →
  `conversation.sendSession(newSessionId, text, [])` delivers the
  intercepted message into the new session;
- degradation matrix: attachment chips in the draft → intercept skipped,
  panel warns and offers the always-present `立即创建 / Create now`
  fallback button; composer anchors absent → same fallback button; any
  async failure → exact `{message}|{error}` text in the hero, draft
  preserved for retry.

Consequences: zero side effects from selection alone; the sidebar row is
titled from the prompt from the first second; the first message runs in
the worktree session, which also feeds the first-message auto-rename.
A maintenance sweep (`POST /worktrees/cleanup`, host restart required)
retires worktrees abandoned by the pre-amendment flow: clean + 0 ahead of
base + 0 unpushed + not any session cwd, with `dryRun` reporting and an
explicit opt-in when the session guard is unreadable. The sweep also
motivated fixing `archiveWorktree`'s unpushed count (no same-name origin
branch used to mean "every commit is unpushed", blocking non-force
archive of clean fresh worktrees).

## Amendment 2 (same release): create-on-arm; cwd migration proven impossible

Amendment 1's first-send DOM intercept failed in the field (the send never
got intercepted on the acceptance machine — composer text projection or
send-control shape differs), and deeper investigation showed the intercept
could never have achieved the real goal anyway:

1. `Session.header` is detached, deep-frozen creation metadata
   (`dsh-session` :1237, :1315); no move/relocate API exists.
2. Persistence enforces identity: track/adopt throws when
   `meta.cwd !== session.header.cwd` (`dsh-session-persistence` :1436, :1472);
   the jsonl header line fixes cwd at creation
   (`dsh-session-persistence-jsonl` :47).
3. `dsh-api-session-controller.ensureSession` throws `ApiSessionCwdConflict`
   on cwd mismatch (:265, :418).
4. Tool cwd is bound at agent composition: bash runs
   `request.workdir ?? config.cwd ?? process.cwd()` (`dsh-bash-local` :170)
   with `config.cwd` from the per-agent spawn config
   (`dsh-agent-loop` :1096-1097). The system prompt's `cwd` variable IS live
   (`dsh-agent-loop` :1095) — changing only the prompt would tell the model
   one directory while tools write another.
5. Therefore the only point where a session's cwd can be chosen is session
   creation. Paseo's submit-time creation works because its session is born
   with the first prompt; DSH's blank session pre-exists, so the DSH
   equivalent of "submit" is the user's explicit base-branch pick.

Final shape:

- **Create-on-arm**: choosing a base branch, confirming an explicit branch
  name, or pressing `立即创建 / Create now` creates the worktree immediately
  and jumps. Opening the menu or browsing branches stays side-effect-free.
- The workspace row is titled `<repo> · <branch>` at creation and follows
  the session title afterwards (client `workspaces.rename`), so sidebar
  rows are meaningful from the first second.
- **One LLM call names both**: the first-message autoname prompt returns a
  single `{title, branch}` JSON object (paseo's generator contract); the
  branch goes through the existing rename chain, the title through
  `sessionTitle.rename` — whose supersede semantics make our call the single
  title source. Prose replies degrade to branch-only.
- **Abandoned sweep**: staging leftovers (clean, 0 ahead, 0 unpushed, no
  non-blank session, older than 30 min) are archived and their workspace
  rows deleted once 5 s after boot and hourly (`cleanup.js` abandoned mode,
  `POST /worktrees/cleanup` unchanged for manual/dryRun use).

Consequences: zero DOM-dependence in the creation path; turn 1 always runs
inside the worktree (session born there); the accepted trade-off is that a
staged-but-abandoned pick creates one short-lived worktree, retired by the
sweep instead of living forever.


## Amendment 3 (same release): the base is the remote head

Field observation (confirmed against paseo source): even when the local
`master` lags the remote by dozens of commits, paseo worktrees start from
the newest remote commit. The mechanism is NOT a create-time fetch —
paseo never fetches during creation (`worktree-core.ts` contains no fetch;
its freshness comes from `BACKGROUND_GIT_FETCH_INTERVAL_MS = 180_000` plus
an immediate fetch when repo observation starts, `workspace-git-service.ts
:79,:1826`). The mechanism is the picker: *"The origin row goes first
because it is the default base"* (`new-workspace-picker-item.ts:96`) — the
default choice sends `refName: refs/remotes/origin/<name>`, and
`resolveBaseBranchForWorktree` (`utils/worktree.ts`) verifies exact
`refs/...` values with `rev-parse` and cuts `git worktree add -b <slug>
--no-track refs/remotes/origin/<name>`. Diverged locals surface as a
second `<name> (local)` row with `+N −M` divergence labels.

Adopted in full:

- `/branches` entries carry per-side oids plus `localAhead/localBehind`
  (only diverged pairs pay a `rev-list --left-right --count`).
- The client picker renders the origin row first as the default base and
  `<name>（本地）` rows with divergence facts; selections and the default
  are exact refs. `createWorktree` verifies `refs/...` bases as-is; bare
  names keep the origin-first fallback (old-client compatibility).
- Beyond paseo: creation additionally gives `git fetch origin --prune` a
  bounded 4 s head start when a remote exists (120 s command cap, raced as a
  best-effort refresh; a failed fetch is recorded as failed but never blocks creation), so the default base is the remote head
  as of *now*, not as of the last background cycle.

`git fetch` cannot cause merge conflicts by construction: it only downloads
objects and moves `origin/*` tracking refs — working tree, index, and local
branches are untouched (ours runs with `GIT_OPTIONAL_LOCKS=0` and
`GIT_TERMINAL_PROMPT=0`, same as paseo's `READ_ONLY_GIT_ENV`).


## Amendment 4 (same release): session-scoped diff modes

Paseo's diff tab is per-session because its sessions are 1:1 with worktrees:
the tab shows that worktree's accumulation since its base. DSH additionally
allows several sessions per workspace, where git state is shared and cannot
attribute changes per session. We therefore ship four modes with
paseo-parity defaults:

- `task` (default in managed worktree sessions): `merge-base(metadata.baseRef,
  HEAD)` vs the working tree including untracked files — exactly the
  worktree's accumulation, commits and edits alike. Host route
  `GET /diff?mode=task`; missing metadata base ref answers
  `{ok:false,error:"task-base-missing"}` and the client falls back with a
  localized banner.
- `session` (default in shared workspaces when non-empty): the uncommitted
  diff client-side filtered to paths this session wrote, attributed by
  paging the official session log (`binding(id).session.readPage`) and
  collecting `edit/write/multiedit/…` tool inputs. Bash-mediated edits are
  not attributed (stated in the button hint); the mode disables itself when
  the log cannot be paged.
- `uncommitted` and `base` as before.

The attribution walker is shape-defensive (depth-capped, name+input scan) so
transcript encoding changes degrade to "mode unavailable" instead of errors.


## Amendment 5 (field bugfix): the 本地 escape hatch and cwd-tagged detection

Two client defects surfaced in daily use; both are now invariants.

**A. The mode menu must carry `本地`.** ADR 0002 and Phase A above both specify a
two-item menu (`本地` / `新建 worktree`), but v1 shipped a single item: once
`新建 worktree` was picked the user sat in the base picker with no way back to
the local checkout, and the trigger always read `本地` even while staging. The
menu is again `本地` (default-selected) / `新建 worktree`, selecting `本地`
resets staging with zero side effects, and the trigger label mirrors the active
mode. `heroModeItems(staging, t)` is the pure, unit-tested contract.

**B. A git detection result is only valid for the cwd it was resolved for.**
`/detect` is async per path, and the session switch renders with the NEW cwd
together with the OLD detection (the detect-reset and title-sync effects run in
the same commit; the reset only lands on the next render). The title-sync
effect then combined the old worktree's `sourceWorkspaceTitle` prefix with the
new session's title and renamed the workspace sitting at the new cwd — observed
as workspace `dsh-simple-codex-login` becoming
`dsh-better-workspaces · <new session title>` after merely switching sessions.
Every detection result is now tagged `{cwd, value}` and read through
`liveDetect(entry, cwd)`, which returns the value only on a cwd match; the
same-cwd tagging also covers the one-render window in which the hero control
would otherwise decide on the wrong repo. Unit-tested.

**C. Provenance rename moves to the very next call after registration.**
`workspaces.create` accepts `{path}` only (the Remote request carries no title,
and the Host passes only `request.path` to the registry), so the row is born
with `defaultWorkspaceTitle(path)` — the placeholder branch name — and used to
keep it through session create, draft migration, open and archive before the
`<source> · <branch>` rename landed (the reported "branch name first, prefix
later" flash). The rename now runs immediately after `workspaces.create`
resolves, leaving a single RPC round-trip as the only remaining window; a
host-side titled-create route is the only way to close it completely and is
deliberately out of scope.

## Amendment 6 (field bugfix): the naming budget vs. a reasoning model, and the workspace title that stopped at the fallback

**A. The auxiliary naming call needs an output budget that survives a reasoning
prelude.** `LLM_MAX_TOKENS` was 64 ("a slug never needs more"), the call ran on
the session's own route, and reasoning tokens arrive as `reasoning-delta` chunks
*before* any `text-delta` exists. On deepseek-flash / effort high the reply spent
all 64 tokens on reasoning, emitted no text and finished `max-tokens`;
`generateBranchName` accumulated only text, so it returned null and the guarded
attempt returned in silence with `autoName.status = 'attempted'` already written
(one-shot by design) — the placeholder branch survived forever. Reproduced in the
live process by replaying the exact call four ways: 64 tokens with and without
the plugin's `purpose` string → `max-tokens`, no text; 512 tokens → `stop` with a
valid `{title, branch}` JSON; 64 tokens with `purpose: 'session-title'` → no
reasoning at all. dsh's own title call is immune for exactly that last reason,
and a plugin cannot borrow the policy by naming its purpose differently. The
budget is now 512, and every remaining bail path logs a warning carrying the
numbers that identify this failure (finish kind, reasoning-chunk count, text
length) instead of returning in silence.

**B. The worktree workspace title follows every session title, not just the
first.** dsh publishes a fallback title derived from the prompt text immediately
and the model's title about a second later. The one-shot `titleSynced` latch in
the sidebar-provenance effect consumed the *fallback* and never looked again, so
managed-worktree rows froze on it (observed:
`dsh-better-workspaces · 请给dsh-better-workspaces开个中文P` while the session row
showed its real title). The effect now re-syncs on every title change, remembers
the last title it attempted, and only rewrites a title it composed itself
(`<prefix> · …`) so a human's workspace rename is never clobbered. Together with
the branch rename from the same LLM reply (`sessionTitle.rename` +
`git branch -m`), one first message now names the session, the branch and the
workspace.
