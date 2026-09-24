# dsh-better-workspaces 上下文

DSH Web GUI 的 git 增强插件：为新会话做 worktree 预备、在侧栏呈现每个会话的 git 徽章、在官方右侧栏提供一个 diff 页签，并让会话可以直接引用 forge 上的 issue 与 PR。本文件是项目领域语言的术语表。

## 会话与工作区

**工作区（Workspace）**：
DSH 的持久实体，以一个根目录路径归组会话。本插件让每个受管 git 工作树恰好对应一个工作区。
_Avoid_: 项目、目录

**会话工作目录（cwd）**：
会话不可变的根目录，继承自绑定的工作区；创建后不能更换（harness 硬约束）。在宿主接口里它只负责选择目标，不自行证明调用者有权操作该目录。
_Avoid_: 工作路径、授权路径

**工作区能力边界（Workspace capability boundary）**：
一次宿主操作可触及的规范目录根：普通工作区必须精确对应当前持久工作区根，托管 worktree 必须能证明其创建来源和 Git 归属。注册仓库内的子目录只授予该子目录下的文件能力，不授予祖先仓库的 pull/reset/worktree 等仓库级能力；相对文件路径也不能通过软链接越出边界（取舍见 ADR 0010）。
_Avoid_: cwd 校验、路径白名单

**预备区（hero）**：
空白会话在首条消息之前的暂存状态：在此选定工作区、worktree 策略与 agent 预设。worktree 下拉仅出现在这里；选定模式本身不产生任何副作用，选定基分支或 PR 行只是填写暂存表单（见命名式创建）。
_Avoid_: 首页、欢迎页

**命名式创建（named create）**：
暂存态是一个显式表单：必填的分支名输入框（右侧骰子一键摇出助记名）、基分支选择器、以及「创建」。**点「创建」是唯一触发点**——此后创建 worktree 与工作区并跳转新会话，会话诞生于 worktree 内，首轮工具即落在新目录（会话 cwd 创建后不可迁移，见 ADR 0004 Amendment 2）。打开菜单、浏览分支、选定基分支或 PR 行全部零副作用（ADR 0014）；被遗弃的产物可由显式 abandoned 清理回收。定时任务在宿主尚无 Session lease 时只做崩溃事务恢复，不自动归档。
_Avoid_: 择基创建、create-on-arm（均为旧触发集合）

**草稿交接（draft handoff）**：
命名式创建从源会话切到目标会话时对草稿的条件转移：先记住源草稿、附件顺序及修订，验证源未被继续改写后把文本与附件写入目标、重绑文件上传并读回确认，随后才清空源并打开目标；任一步失败都保留或恢复源草稿。公开接口不能重建结构化引用 chip，因此检测到 chip 时失败关闭、绝不把它悄悄扁平化成文本。
_Avoid_: 草稿复制、localStorage 迁移

**本地检出（「本地」）**：
工作区根目录就是仓库自身工作副本（而非链接 worktree）的状态；worktree 模式菜单的两项之一，默认选中、且随时可选回（选中即退出暂存态，与「新建 worktree」互斥）。
_Avoid_: 主目录、原目录

**托管 worktree**：
由本插件在对应来源仓库的专属 worktrees 根下创建、元数据与 Git worktree 清单都能证明其归属的链接工作树；只有托管 worktree 才有资格进入归档生命周期。单有目录名或元数据文件不构成托管身份。
_Avoid_: 临时目录、副本

**仓库族变更门（repo-family mutation gate）**：
同一主仓库及其全部 linked worktree 共享的宿主 FIFO 变更序列，键为授权阶段固定的规范主仓库根。create、archive、action、后台 fetch 和 Git 工作区文件保存都经此门；锁内同时复验目标根、主仓库根、worktree Git dir 与 common dir 的设备号/inode，Linux 上再以 dirfd 锚定读取和跨多条命令的目标（见平台锚定），固定顺序是仓库门→文件 mutex。不同仓库仍可并行，Agent 或用户在插件外直接运行 Git 不受此门约束。
_Avoid_: 全局锁、worktree 锁

**平台锚定（platform anchoring）**：
稳定工作区操作的平台能力层（ADR 0013）：Linux 用目录 dirfd 经 `/proc/<pid>/fd` 锚定 Git 调用与文件写入，文件保存以 RENAME_EXCHANGE 原子交换并回验被换出的 inode；Windows/macOS 走 paseo 路径模式——以规范路径作锚、操作边界用 stat 设备号/inode 核验身份并在变更后复验授权，Git 从工作树正常发现，保存为 fsync + sha1 CAS + rename 原子替换。选择在运行时按平台读取（`lib/stable.js`），测试可注入模拟平台。
_Avoid_: 跨平台降级（那是能力分层，不是功能删减）、Windows 特例

**创建事务日志（create journal）**：
仓库专属受管根先以 fsync owner record 绑定 main repo dev/inode；`git worktree add` 前再写入 fsync pending，包含 txId、路径、分支和不可变创建 OID。prepared 阶段不声称拥有未来分支；仅在 Git row/branch/HEAD 与 path/gitdir inode 全部证明后升级 added。元数据提交成功后清除；进程若在中间退出，自动恢复绝不删除仍存在的 path 或 row（普通 status 看不见 ignored/事后文件），只在两者都已由人工移除后按 OID CAS 删除本次拥有的分支；证据不足宁可保留，也会清扫插件专属 PR 临时 ref。owner record 缺失只说明这是一个**遗留受管根**（早于该记录诞生的根），解析事务前必须先经 `prepareManagedRoot` 认领；只有记录存在但 dev/inode 不符才是「仓库被替换」，必须拒绝。
_Avoid_: worktree 元数据、操作日志

**创建请求收据（creation receipt）**：
一次命名式创建的稳定身份。相同请求重试只会指向同一个托管 worktree 及其唯一工作区；同一身份若被拿来表示另一项请求则冲突失败。收到成功答复意味着这些实体都已可按收据找回，即使先前答复在途中丢失也不靠删除补偿。
_Avoid_: 点击防抖、客户端请求 ID

**注册表删除墓碑（registry deletion tombstone）**：
托管 worktree 的物理归档与工作区取消注册之间的持久承诺，始终绑定归档前捕获的 Workspace ID，绝不按可复用路径重新选择目标。只有工作区已由别的权威操作删除时才幂等完成墓碑；工作区仍在时宁可保留它与墓碑，也不能因不完整的历史成员快照让其中会话突然变成「未分组」或波及无关工作区。
_Avoid_: 路径清理队列、warning-only 删除

**活动会话守卫**：
清理把 cwd 等于托管 worktree 根或位于其任意子目录的会话都视为占用；普通与 abandoned 清理遇到任何活动会话（包括空白会话）都跳过，会话源不可读时失败关闭。没有跨页面草稿所有权和 Session/Agent 接纳租约时，可见工作区的手工物理归档不属于安全操作。
_Avoid_: 仅根目录会话、启动时快照

**基线（base）**：
托管 worktree 的比较起点：元数据把创建时解析出的完整提交 OID 作为不可变边界，另存分支名只供显示和刷新提示。已提交 diff、任务 diff、超前/落后与安全清理优先使用该精确提交；PR 检出则取该 PR 自身的目标分支所解析出的提交。没有可证明的基线提交时，破坏性判断失败关闭。
_Avoid_: 上游（那是另一个概念）、可移动分支名

**基线分支（base branch）**：
创建时用来解析基线提交、之后也作为 Merge-to-base 目标的分支名称。它可以移动、改名或消失，因此不能单独充当归档、清理或差异安全判断的证据。
_Avoid_: 基线提交、上游

**基分支选择**：
hero 下拉的语义按行一分为二：分支行只作为切出的基（base），「新建 worktree」切出一个新分支、从不检出既有分支（paseo 语义）；PR 行不是基，而是检出目标（见 PR 检出）。两种选择都只填写暂存表单，创建由「创建」按钮触发（见命名式创建）。
_Avoid_: 分支切换

**PR 检出（pr-checkout）**：
一种 worktree 创建意图：不切新分支，而是把某个 PR 的 head 取到本地检出（paseo 的 checkout-change-request）。本地分支名对同仓 PR 就是该 PR 的 head 分支名，对 fork PR 是 `<owner>/<分支名>`，被占用时自动加后缀。该 worktree 的基是这个 PR 自己的目标分支，分支名直接来自该 PR，因此不经过命名表单。
_Avoid_: PR 分支、合并 PR

**PR 上游跟踪**：
PR 检出 worktree 的上游规则：同仓 PR 仅在已有 `origin/<head 分支名>` 精确指向该 PR head 时跟踪它；远端分支缺失或提交不符时不伪造、不覆盖跟踪 ref。fork PR 一律不设上游——那是贡献者的分支，不归我们推送。没有可信上游时「未推送」等状态显式为「无」，而不是拿同名远端分支凑数。
_Avoid_: 上游分支（歧义：见上游）

**worktree 模式菜单**：
hero 行上「本地 / 新建 worktree」二选一的下拉（ADR 0002）：选中「新建 worktree」进入暂存态并展开基分支选择器，重新选中「本地」退出暂存态、不产生任何副作用；触发器标签始终显示当前模式。
_Avoid_: 工作目录下拉（那是原生控件）

**分支名（branch name）**：
一次创建的终局分支名：来自暂存表单的输入框——用户手输，或点骰子摇出的助记名（形容词-名词-4位hex，如 amber-otter-3f2a）。创建后**永不自动改名**（ADR 0014）。宿主仍接受只给 slug 的旧式请求作为兜底，但那只用于命名分支，不再决定目录名。
_Avoid_: 占位分支（已废弃）、临时分支

**目录名（worktree leaf）**：
托管 worktree 的目录叶子名，由宿主按 `<仓库目录名>-<分支名>` 派生（两半各自 slug 化并分别截到 24 / 40 字符，整体 ≤65，碰撞追加 -1/-2）。仓库名让叶子单独可辨——父级分组是不可读的仓库哈希；仓库名保留完整形态直到 24 字符，因为被截掉的词尾恰是区分两个仓库的部分。创建瞬间定格：会话 cwd 不可迁移，之后手工改分支名不会改目录名。
_Avoid_: slug（旧称：客户端摇出的目录种子）

**上游（upstream）**：
当前分支配置的远端跟踪分支；决定「未推送」计数与 pull/push 目标。PR 检出的情形见 PR 上游跟踪。
_Avoid_: 基线、远端

**默认分支**：
仓库默认分支：origin/HEAD 可解析时用之，否则 main，否则 master。

## Git 状态

**未提交变更（uncommitted diff）**：
工作树对 HEAD 的差异，含未跟踪文件；不区分已暂存/未暂存。
_Avoid_: 脏 diff

**已提交变更（committed diff）**：
merge-base(基线分支, HEAD) 对 HEAD 的差异，即 PR 视角的分支全量变更。
_Avoid_: 已推送 diff

**超前/落后（ahead/behind，↑a↓b）**：
当前 HEAD 与比较基线之间双方独有提交的数量。

**未推送（unpushed）**：
上游（或 origin/<当前分支>）上尚不存在的提交状态；驱动 Push 动作晋升与归档风险提示。

**脏（dirty）**：
git status --porcelain 非空的状态；驱动 Commit 动作晋升与归档警告。

**DiffStat（+N/−N）**：
按当前比较范围合并统计的绿色新增行数与红色删除行数（compact 数字格式）。

**Checks（CI 状态）**：
PR 的 CI 状态汇总，fail-fast 折叠：任一 failure→失败；否则任一 pending→运行中（含完成度）；否则成功。徽章呈四格 pie 环，完成度向下取整到四分之一。

**PR 状态**：
open（绿）/ merged（紫）/ closed（红）三态；序号自 PR URL 解析。

**Forge**：
通过其官方 CLI 访问的代码托管平台（GitHub 经 gh）；认证状态即 CLI 登录状态，本插件不持有 token。既是 PR/checks 徽章的数据源，也是 forge 选择器与 PR 检出的数据源。

**forge 点位（forge item）**：
一个可被引用的 issue 或 PR 条目：选择器里的一行、hero 基列表里的一行、引用 chip 指向的对象都是它。编号在 issue 与 PR 之间共享，同一个编号只对应其中一个。
_Avoid_: 卡片、条目

**forge 认证状态（authState）**：
读取 forge 数据时的状态分档：已登录（正常）、未装 gh CLI、gh 未登录、仓库没有可用的 GitHub 远端、gh 调用失败。插件不代管认证，只把状态说清楚，缺 forge 时其余功能照常。
_Avoid_: 登录状态

**git 快照**：
按工作区根目录折叠出的最小 git 状态（分支、脏、超前/落后、DiffStat、PR、checks），供徽章行与各视图消费；指纹相同的快照不重复下发。

## 界面词汇

**徽章行**：
侧栏会话标题下方的一行 git 徽章：分支名（超长省略号）· #PR号 · checks · +N/−N · ↑a↓b；缺失项整个不显示，数值项为零不显示。
_Avoid_: 状态栏、标签行

**diff pill**：
输入框上方的 DiffStat 胶囊；点击在官方右侧栏打开（或展开并定位到）diff 页签；无任何变更时仍显示，标签退化为「diff」。
_Avoid_: diff 按钮

**forge 控件**：
composer 附着控件行里排在官方「+」（命令菜单）与回形针（文件选择）之后的 GitHub 圆标按钮：点开 forge 选择器。官方两个原生附着控件保持原样，不被合并、替换或改写。
_Avoid_: 附件按钮

**forge 选择器（picker）**：
forge 控件打开的居中对话框：一页 issue 与 PR（各取一页，合并后按更新时间新→旧），带一个本地筛选框；选中一行即挂上引用 chip 并关闭。没有服务端搜索，也没有翻页。
_Avoid_: 搜索面板

**引用 chip**：
草稿里的一个 forge 点位引用：界面上只占一个「PR #N 标题」或「Issue #N 标题」样式的小片，发送时展开为完整文段（标题、链接、正文，PR 另带基线与 head）交给模型。标签是挂上那一刻算好的缓存，正文与元数据在发送时才重新取。
_Avoid_: 附件、提及

**diff 页签**：
官方右侧栏里的一个 page 类型（kind `bw-diff`），并注册一个 guide 条目：右侧栏「开始」页上以「代码变更」卡片与官方「工作区文件」并列。因 guide 条目不再唯一，没有历史布局的会话首次打开右侧栏会落在「开始」选择页；无需选页时仍可只走 diff pill（取舍见 ADR 0006 Amendment 1）。
_Avoid_: diff tab（那是已删除的会话视图）

**文件编辑器**：
diff 视图内的文本编辑面板：等宽 textarea、脏标记、Ctrl/Cmd+S；保存走 POST /file 的 sha1 条件写入。同一宿主实例内按规范文件路径串行提交；Linux 以原子交换后的旧 inode 再验预期内容并支持换回回滚，其余平台按平台锚定用 CAS 复查加 rename 原子替换；冲突返回 409，临时文件仅在 inode 仍属本事务时删除。非协作的外部写者不共享这把锁，因此协议承诺以宿主 API 写入的线性化与冲突检测为边界。会话「文件」视图随官方右侧栏「文件」面板下线后，本编辑器只服务 diff 视图。
_Avoid_: 在线 IDE

**任务 diff（task diff）**：
受管 worktree 会话的默认 diff 模式：merge-base(元数据基, HEAD) 对比工作区（含未跟踪），即该 worktree 自基以来积累的全部变更——Paseo「会话 diff」在 1:1 worktree 模型下的等价物。
_Avoid_: 会话 diff（歧义：见本会话 diff）

**本会话 diff**：
共享工作区内的 per-session 近似：未提交 diff 按该会话转录中写文件工具（edit/write/multiedit…）的路径过滤；bash 间接改动不归因（按钮 hint 注明）。git 状态按 cwd 共享，转录是唯一 per-session 信号。
_Avoid_: 会话 diff（歧义：见任务 diff）

**origin 默认基**：
基分支选择器的 paseo 语义：origin 行在前且为默认基（refs/remotes/origin/<name>，精确 ref 直切远端头），本地分叉行以「<名>（本地）」+ +N −M 分叉数呈现；裸名 base 仍按 origin 优先回退解析。
_Avoid_: 本地默认基

**源工作区前缀**：
worktree 工作区标题的出处标记：创建时取发起会话所属工作区的标题（存入元数据 sourceWorkspaceTitle），标题形如「<源工作区> · <分支>」，会话每次改题都跟随为「<源工作区> · <会话标题>」（只改写本插件自己组装过的标题，人手改过的一律不覆盖）。标题只写给「当前会话 cwd 所属的那个工作区」，且所用 git 检测结果必须与 cwd 绑定（检测值带 cwd 标签，跨 cwd 一律视为无效）——否则会话切换时会把前缀写到别的工作区上。
_Avoid_: 仓库名前缀

**diff 视图**：
官方右侧栏 diff 页签承载的内容：未提交/已提交两模式 diff、commit 列表与操作面板；窄面板下文件列表在 diff 之上纵向排布。

**操作阶梯**：
diff 视图主操作按状态晋升的顺序：Commit（脏时）→ Pull（落后上游时）→ Push（未推送时）→ Merge PR → auto-merge → Create PR → Merge-to-base → Update-from-base → Archive；未晋升者入溢出菜单，禁用项必须携带精确原因文案。
_Avoid_: 按钮组

**Merge-to-base / Update-from-base**：
把当前分支合入基线分支（基线被其他 worktree 检出时在其 worktree 内执行）/ 把最超前的基线合入当前分支（要求干净工作树）。合并前把来源解析成完整 OID；冲突后一律保留 MERGE_HEAD 与工作树并返回 partial recovery，由用户显式解决或 abort，避免插件撤销已经被外部用户/Agent 接管的冲突现场。

## 安装与挂载

**组合包（bundle package）**：
在 `package.json` 的 `dsh.bundle.patch` 里指向自带 patch 文件的 npm 包；其 patch 成为挂载它的 profile 的一层。`dsh plugin --profile <名> add` 在 pnpm 之后会 reconcile，把这类包自动追加进 `dsh.profile.bundles` —— 这就是「一条命令装完即可用」的全部机制，用户不需要手改 profile 层。
_Avoid_: npm 包（那是更宽的概念）

**双半包**：
同一个包同时提供宿主半（`main` → `lib/index.js`，作为 loader 行被挂载）与浏览器半（`exports["./client"]` → `lib/client.js`，由 `dsh.client` 声明、经 `dsh-client-modules` 扫描宿主行后注入页面）。本包既是双半包也声明 `dsh.bundle`：`dsh.bundle` 与 `dsh.client` 是两个独立键，互不冲突。

**挂载行（mount row）**：
本包自带 `cordis.patch.yml` 里那一行 insert，是插件出现在组合树里的唯一入口。两条一致性约束：`name` 必须是包名（loader 据此从 profile 的 `node_modules` 解析代码），`id` 必须是宿主半导出的 `name`（一行 = 一个插件实例）；`test/mount-check.mjs` 有守卫。

**迁移清理（migration cleanup）**：
从只声明 `dsh.client` 的旧版本升级时，必须删掉 profile 层里手写的那一行挂载行。`insert` 是原样追加、不按 id 去重，重复 id 由 loader 抛 `duplicate loader entry id` 并 fail-loud —— 两个来源不是「无害的重复」，而是起不来。
_Avoid_: 兼容处理

**回环受信代理（loopback-trusted reverse proxy）**：
在浏览器与本插件之间终止 TLS 的本机反代（如 cloudflared）。POST 同源门禁 `sameOrigin` 先按 socket 事实直接比对 `Origin` 与 `Host`/协议；仅当直接比对失败、TCP 对端属于 `127.0.0.0/8` 或 `::1`、且请求至少带一个 `X-Forwarded-Proto`/`X-Forwarded-Host` 时，才用转发头补出浏览器所见协议与主机名再比对。远端对端、无转发头的回环直连、以及 `X-Forwarded-*` 与 `Origin` 不一致的请求一律维持拒绝。浏览器按 Fetch 规范禁设 `X-Forwarded-*`（forbidden header name），因此该信任不扩大 CSRF 攻击面（ADR 0012）。
_Avoid_: 无条件信任 `X-Forwarded-*`、用 `X-Forwarded-For` 判断信任（那是客户端可伪造的链）

