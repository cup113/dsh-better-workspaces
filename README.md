# dsh-better-workspaces

Git workspace enhancements for the DeepSeek Harness Web GUI, inspired by
[Paseo](https://github.com/getpaseo/paseo)'s worktree/diff/PR model.

## What it adds

1. **Hero worktree staging** — when the current (blank) session's workspace is
   a git repo, a mode dropdown appears in the hero row between the workspace
   chip and the 模式 control; it offers `本地` (the workspace root IS the
   repository checkout — the default) and `新建 worktree`, which reveals the
   base-branch picker. Picking `本地` again leaves staging with no side effect,
   so the picker is never a dead end, and the trigger label always shows the
   active mode. **The picker speaks exact refs (paseo parity)**: the
   `origin/<name>` row comes first because it IS the default base — cutting
   from `refs/remotes/origin/<name>` starts at the true GitHub head even when
   the local branch lags; diverged locals appear as `<name>（本地）` rows with
   `+N −M` facts. **Staging is a form**: a required branch-name input, a dice
   button that rolls a mnemonic (`amber-otter-3f2a`), the base picker and a
   Create button. Picking a base or a PR row is side-effect free — only Create
   creates and jumps (ADR 0014) — and the chosen name is final: the plugin
   never renames a branch after creation. Creation gives origin refs a
   bounded 4 s `git fetch --prune` head start (on top of the 180 s background
   fetch — paseo itself never fetches at create time), cuts the named branch,
   registers a Workspace titled
   `<source workspace> · <branch>` (renamed as the very next call after
   registration), creates the target session, migrates the
   typed draft through the official conversation-input API, opens it and
   retires the blank launcher — with full rollback on any failure. The
   workspace title follows every session title
   as `<source> · <session title>` — only ever for the workspace owning the
   current session's cwd, since every git detection result is tagged with the
   cwd it was resolved for. **The same picker also lists open pull requests**,
   after a rule: PR rows read `#N title` with a `→ base` hint and a `fork`
   marker, and picking one checks the PR's HEAD out instead of cutting a branch
   (paseo's `checkout-change-request`). The head comes from the forge's
   `refs/pull/<N>/head` — the only ref a fork's contribution has — the local
   branch is `<headRef>`, or `<owner>/<headRef>` for a fork, and the PR's own
   base branch becomes the diff baseline rather than whatever the picker was
   pointed at. A same-repo PR tracks `origin/<headRef>` only when that existing
   remote-tracking ref already resolves to the verified PR head; it never
   manufactures or overwrites the ref. A fork PR deliberately gets no upstream, so the unpushed count and the pull/push ladder stay explicit
   instead of aiming at the wrong branch. PR worktrees take their branch
   name from the pull request itself. Inside a worktree
   workspace the hero control hides entirely, and the sidebar row trades its
   folder icon for a branch icon. Abandoned staging leftovers are swept
   automatically (boot + hourly) or via `POST /worktrees/cleanup`.
2. **Sidebar git badges** — session rows stretch vertically; below the title:
   `branch · #PR (green open / purple merged / red closed) · checks pie ring ·
   +N/−N · ↑a↓b (only when non-zero)`. Missing items are omitted.
3. **Diff pill + right-sidebar page** — a `±` pill above the composer opens the
   diff view as a page tab in dsh's official right Sidebar (the column expands,
   and an already-open tab is revealed rather than duplicated). The page also
   carries a guide entry, so the sidebar's `开始` page lists it as a `代码变更`
   card beside the official `工作区文件` one; because the seed only jumps
   straight to a type while exactly one guide entry exists, a session whose
   right column has no stored layout now opens on `开始` instead (ADR 0006
   Amendment 1). The pill stays
   put for every git session — `+N −N` when there is a diffstat, the changed
   file count when only the tree is dirty, `↑N 未推送` when only unpushed
   commits exist, and the bare `diff` otherwise — because the conversation no
   longer carries a diff tab of its own. In the sidebar the file list sits
   above the diff pane so the 300 px panel stays readable.
   The old `文件`/`diff` conversation tabs are gone: dsh 0.1.5 shipped the
   right Sidebar's own `文件` panel, which supersedes the plugin's file view.
4. **Diff view** — four modes with paseo-parity defaults: `未提交` (working
   tree incl. untracked vs HEAD), `本会话` (default in shared workspaces: the
   uncommitted diff filtered to files this session wrote, attributed from its
   paged session log — git state is per-cwd, the log is the only per-session
   signal), `任务` (default in managed worktree sessions: merge-base(base,
   HEAD) vs the working tree incl. untracked = everything this worktree
   accumulated, i.e. paseo's worktree diff), and `对比基线` (merge-base(base,
   HEAD) vs HEAD) — all with commit list, per-file hunks, whitespace/wrap
   toggles, plus the paseo action ladder:
   Commit / Pull / Push / Create PR / Merge PR (squash|merge|rebase, auto) /
   Merge-to-base / Update-from-base / Discard. Manual physical Archive is
   intentionally withheld until DSH exposes a cross-page draft + Agent-admission
   retiring lease; production Host archive endpoints and destructive cleanup
   also fail closed rather than risking ungrouped sessions. Every disabled action carries a precise
   localized reason. PR + checks come from one
   batched `gh` GraphQL call (30 s TTL, last-good fallback); PRs poll
   adaptively (20 s pending / 120 s idle). Each editable file head carries
   an `编辑` button opening the shared **file editor**: monospace textarea,
   dirty marker, Ctrl/Cmd+S, saved through `POST /file` with sha1
   compare-and-swap (concurrent on-disk change → 409 conflict + reload,
   never a silent overwrite; containment/size/binary guards, atomic
   exchange with displaced-inode verification).
5. **Composer GitHub control** — a GitHub-mark button beside the composer's
   native `+` (commands) and paperclip (files). Those two are hardcoded in the
   official InputBar and are left untouched; the plugin only adds a third
   control in the one additive slot of that row (ADR 0008). It opens a centered
   picker of one `gh` page of open PRs + issues (20 per kind, newest first,
   local filtering only — no server-side search), and picking a row attaches a
   **reference chip**: the draft shows one small `PR #N title` / `Issue #N title`
   block, while the chip's codec expands it at submit time into the full text
   the model receives (`GitHub PR #N: title`, URL, `Base`/`Head`, body; issues
   without the base/head lines). The chip rides the official `@`
   reference-source seam — a codec plus a lexicon limited to the references this
   session actually attached, and no candidate list of its own (the picker is
   its only door) — and the source stays registered for the
   plugin's lifetime, because a chip whose source has no serializer makes the
   send fail loudly instead of silently degrading. If the
   official `insertReference` revision CAS refuses the write, the plugin leaves
   the draft unchanged and keeps the picker open so the user can retry or
   cancel; it never substitutes a lossy plain-text token. Missing `gh` / not signed in / no usable remote are
   surfaced in the picker rather than handled.

## Architecture

- **Host** (`lib/index.js` → `git.js`, `worktree.js`,
  `cleanup.js`, `forge.js`, `diff.js`, `actions.js`, `state.js`, `api.js`,
  with `stable.js` as the platform-anchoring layer):
  git-CLI primitives behind an 8-way concurrency scheduler; managed worktrees under
  `~/.dsh/worktrees/<8-char base36 sha256(mainRepoRoot)>/<repo>-<branch>` —
  the leaf carries the repository name so it is identifiable on its own, and
  both halves are budgeted to keep it ≤65 characters — with
  `<gitdir>/dsh-worktree/worktree.json` metadata and three creation intents —
  `branch-off` (cut from a base), `checkout`, and `pr-checkout` (fetch the
  forge's `refs/pull/<N>/head` from origin/upstream, create the local branch
  with `git worktree add -b … --no-track <sha>`, take the PR's own base as the
  diff baseline, and track `origin/<headRef>` for same-repo PRs only);
  the leaf derives from `<repo>-<branch>` on the host, so the client sends no
  directory slug and the plugin makes no LLM calls of its own; snapshot
  hub with fs watchers (1 s debounce, degraded 5 s polling), 180 s background
  fetch and
  fingerprint-deduped SSE; `forge.js` serves both the batched PR/checks GraphQL
  and the picker's issue/PR pages (`GET /pulls`, `GET /pull`) through the user's
  `gh` CLI (30 s cache, never tokens); HTTP+SSE API on the harness webServer under
  `/better-workspaces/api`.
- **Client** (`lib/client.js`, hand-written `__ModuleLoader__` bundle):
  slot-registered right-Sidebar diff page + dock pill + composer forge control
  (`conversation.input.left`) with its `@` reference source/codec for issue/PR
  chips; DOM injection
  (MutationObserver + React portals + anchor self-check with silent
  degradation, ADR 0001) for the hero dropdown and sidebar badges, which have
  no fine-grained slots.

See `CONTEXT.md` for the glossary and `docs/adr/` for the design records.

## Install (web profile)

Prerequisites: `dsh` ≥ 0.1.5 with the `web` profile, Node.js ≥ 20.19,
`pnpm` on `PATH`, `git` ≥ 2.31, and a supported platform — Linux, Windows
10+/Server 2016+ (Git for Windows), or macOS 13+. Platform anchoring is
layered (ADR 0013): **Linux** pins every repository mutation and file save
to verified dirfds through `/proc` and commits saves with
`renameat2(RENAME_EXCHANGE)` (GNU coreutils `mv --exchange`; a Linux system
without it still fails closed with HTTP 503 rather than weakening the
exchange guarantee); **Windows and macOS** run the paseo path model —
canonical paths for Git discovery, stat dev/ino identity checks at every
operation boundary plus re-authorization after mutations, and file saves
through fsync + sha1 compare-and-swap + atomic rename (paseo's file-editor
semantics; the displaced-inode exchange rollback is a Linux-only extra).
`gh` (authenticated) is optional — it enables the PR/checks features and the
composer's issue/PR picker and PR checkout, and degrades gracefully when
absent.

**One command installs and mounts the plugin** (plain JS, no build step):

```bash
dsh plugin --profile web add github:Pheobe-Southwood/dsh-better-workspaces
```

Then restart `dsh --profile web` once. There is no second step: this package is
a **bundle** (it declares `dsh.bundle.patch` next to `dsh.client`), so the dsh
CLI's reconcile step appends it to the profile's `dsh.profile.bundles`
automatically, and its own `cordis.patch.yml` becomes a patch layer that
carries the plugin row. **Do not hand-edit the profile's
`cordis.patch.yml`** — the package already ships that row.

Self-check:

```bash
# the composed tree shows the package's own layer and exactly one row
dsh --profile web --dump-config | grep -A 1 '== dsh-better-workspaces'
#   # == dsh-better-workspaces
#   - id: better-workspaces
#     name: dsh-better-workspaces

curl -s http://127.0.0.1:3080/better-workspaces/api/worktree-workspaces
#   expected {"ok":true,...}; 404 means the row did not activate
```

Uninstall is symmetric — reconcile also drops the bundle from
`dsh.profile.bundles`:

```bash
dsh plugin --profile web remove dsh-better-workspaces
```

### Upgrading from a pre-bundle install (0.0.1)

Versions before 0.1.0 declared only `dsh.client`, so mounting meant
hand-writing this row into the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: better-workspaces
      name: dsh-better-workspaces
```

That row must now be **deleted** (re-run the `add` command above first so
reconcile lists the bundle). Two sources for one row is not a harmless
duplicate: the include inserts rows verbatim and the Loader rejects a repeated
entry id, so the next boot fails loudly with

```
duplicate loader entry id: better-workspaces
```

Delete the hand-written insert block (leave every other entry in that file,
such as the `authorization` row, untouched) and the package's own layer takes
over.

### Developing from a local checkout

Use a `link:` spec; only the spec differs, the mount is the same:

```bash
dsh plugin --profile web add link:/path/to/dsh-better-workspaces
```

Host code edits need a `dsh` restart (Node's ESM cache survives patch reloads —
ADR 0003); client-bundle edits hot-rebuild in the module graph and only need a
page refresh. The package's `cordis.patch.yml` is composed at boot, so editing
*that* file needs a restart too. The row declares hard injects for `webServer` and `workspaceRegistry`,
so cold boot waits for both the HTTP surface and the registry-backed authorization
source instead of racing either one (ADRs 0005 and 0010) — if the UI
is missing after a restart, run the self-check in the ops section below.

### Reverse proxy and Cloudflare Tunnel

The API's POST gate is same-origin by design (ADR 0012): an `Origin` must match
the `Host` header and the scheme the *browser* used. A TLS-terminating tunnel
(Cloudflare Tunnel, or any `https` reverse proxy) speaks plain HTTP to this
server, so the browser-visible scheme can only come from the proxy itself:

- run the tunnel client on the same host, point it at `http://127.0.0.1:3080`,
  and leave the `Host` header untouched (cloudflared's default — do **not** pass
  `--http-host-header`);
- the Cloudflare edge supplies `X-Forwarded-Proto: https`, which the plugin
  honours **only for loopback peers**; a request arriving from a non-loopback
  address can never vouch for its own scheme or host;
- if a proxy rewrites `Host`, it must also state the browser-visible name in
  `X-Forwarded-Host`.

Requests without an `Origin`, opaque (`Origin: null`) ones, and any request whose
`Sec-Fetch-Site` is not `same-origin` stay rejected — embedding the GUI in a
cross-site frame is not supported.

## Development and quality gates

Repository development uses npm and the committed lockfile; `pnpm` above is a
DSH installer/runtime prerequisite, not this repository's package manager.
React and ReactDOM are supplied to the browser half by the DSH module graph;
matching React 18 versions are development-only dependencies for deterministic
real lifecycle tests.

```bash
npm ci
npm run check
```

`npm run check` runs ESLint, scratch-repository Host tests, security and
mutation suites, the fast client contract smoke test, a real React + JSDOM
effect/focus/cleanup suite, mount checks, and an npm-pack allowlist test that
requires NOTICE plus all third-party licenses. CI repeats the same gate on the
latest Node 20 and Node 22 releases on Ubuntu.

## Third-party attribution

Original project code is MIT-licensed; modified or independently adapted
third-party portions retain their notices from Paseo (Apache-2.0) and
dsh-git-worktree (MIT). Exact audited revisions,
modification notices and complete license texts ship in `NOTICE` and
`LICENSES/`.


## 运维：冷启动挂载与重启自检

**模块解析事实**：dsh 加载器通过 Node 内部 ESM loader 按 **profile 目录**解析
裸包名，所以 `link:` 依赖装在 `$DSH_HOME/profiles/web/node_modules` 即可，
不需要其他锚点（曾误判为「共享锚点」，见 ADR 0005）。

**曾经的冷启动故障**（ADR 0005）：宿主行过去声明 `inject = []`，冷启动时该行
在 web app 提供 `webServer` 服务**之前**就激活，`ctx.get('webServer')` 落空，
走 dormant 分支且永不重试——路由与客户端 bundle 全部 404，GUI 里
hero/徽章/tab 整体消失；而 `patchReload: live` 的热插入发生在 webServer
已就绪的运行中进程里，所以一直正常。修复：`export const inject = ['webServer']`，
Cordis 会等服务出现后再激活该行。

**行从哪来**：本包声明 `dsh.bundle.patch`，所以那一行由**包自带的
`cordis.patch.yml` 层**提供（`dsh plugin add` 负责把包写进
`dsh.profile.bundles`）。profile 自己的 patch 层里**不该**再有同一个 id 的行：
include 的 `insert` 是原样追加、不按 id 去重，loader 见到重复 id 直接抛
`duplicate loader entry id: better-workspaces`，fail-loud 让整个 web 起不来。

重启后自检三步：

1. `dsh --profile web --dump-config | grep -A 1 '== dsh-better-workspaces'` ——
   出现包自带层且 `id: better-workspaces` **恰好一行**（多行 = profile 层里还留着
   手写行，删掉它）；
2. `curl -s http://127.0.0.1:3080/better-workspaces/api/worktree-workspaces` ——
   期望 `{"ok":true,...}`（404 = 行未激活：确认 profile `node_modules` 的
   link 依赖存在，且 `lib/index.js` 的 inject 仍同时含 `webServer` 与
   `workspaceRegistry`）；
3. 刷新 GUI：非 worktree 工作区出现「本地」hero 控制，worktree 工作区隐藏且行图标为分支。

`npm test` 含 `test/mount-check.mjs`：断言 `inject` 同时含 `webServer` 与
`workspaceRegistry`（防回归，后者提供授权根）、
断言包声明 `dsh.bundle.patch` 且自带的 patch 恰好贡献一行（`name` = 包名、
`id` = 宿主半导出的 `name`，并随 `files` 发布）——没有这些声明，
`dsh plugin add` 只会把包装成普通依赖、静默不挂载；同时以最小假 ctx 跑遍宿主
模块 import 与 apply（dormant + webServer 两条路径），用于在不动 dsh 进程的
前提下暴露挂载期抛错。
