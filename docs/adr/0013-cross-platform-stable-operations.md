# ADR 0013：跨平台稳定操作（Windows 支持参照 paseo 路径模型）

- 状态：Accepted
- 日期：2026-09-17

## 背景

用户在 Windows 设备安装本插件后，所有依赖「稳定工作区操作」的接口（worktree 创建、forge 选择器、diff、actions、文件保存）返回 503 `stable workspace operations require Linux dirfd support`。原因是插件把稳定操作硬绑定在两样 Linux 独有的机制上：

1. `/proc/<pid>/fd/<fd>` 目录 fd 锚定（`withStableRoot`、`openAnchoredParent`、state/actions/autoname 的同款流程），非 Linux 直接失败关闭；
2. `/usr/bin/mv --exchange`（renameat2 RENAME_EXCHANGE）承担文件保存的原子交换。

参照系是 paseo（`packages/server/src/utils/worktree.ts`、`file-explorer/service.ts`）：一个在 Windows/macOS/Linux 上同样可用的产品从不打开目录句柄、从不钉扎 GIT_DIR——git 一律用普通 cwd 执行，身份用 `stat` 的 dev/ino 在操作边界核验，保存用「temp + fsync + 版本复查 + `fs.rename` 原子替换」，Windows 上不使用 `O_NOFOLLOW`/`O_DIRECTORY`，路径比较做大小写与分隔符归一（`normalizePathForOwnership`、`areEquivalentPaths`）。

即使撤掉 503 门，Windows 还有三个隐性阻断点：

- **git 输出的正斜杠路径**：Windows 上 `rev-parse --show-toplevel` 与 `worktree list --porcelain` 输出 `C:/Users/...`，与 `realpath` 产出的反斜杠做字符串比较全部失配（gitBoundary 误判 nested、post-add 绑定行验证失败、所有权比较失败）；
- **目录 fsync**：`syncDirectory`（journal/元数据持久化链路）对只读目录句柄调用 `sync()` 在 Windows 上必然失败（FlushFileBuffers 需要写句柄）；
- **大小写**：NTFS/ReFS 保留但区分大小写地存储路径组件，`canonical === path` 这类精确比较会把注册表根/受管根误判为 rebound。

## 决策

1. **平台能力层**：新增 `lib/stable.js` 集中全部平台分支——`isDirfdPinSupported()` / `isFileExchangeSupported()`（仅 Linux）、`isWindows()`、目录/文件打开 flags（win32 去掉 `O_DIRECTORY`/`O_NOFOLLOW`）、`normalizeGitPath`、`samePath`、`verifyStatIdentity(Fields)`、`syncDirectory`（win32 no-op）。平台选择在调用时读取，测试可经 `__setPlatformForTests` 注入模拟平台；CI 上的「模拟 win32」端到端测试因此真实覆盖非 Linux 分支（`normalizeGitPath` 按路径形状转换、`samePath` 大小写折叠、rename 保存、无 env 钉扎，在 POSIX 宿主上语义兼容）。
2. **Linux 零改动**：dirfd 锚定（`/proc` 桥 + GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE 钉扎）与 `mv --exchange` 保存链路（含 displaced-inode 回验与换回回滚）保持字节级不变；没有 `--exchange` 的 Linux 系统保存仍然 503 失败关闭（security 套件的既有断言）。
3. **路径模式（paseo 模型）**：非 Linux 上「稳定工作区操作」不打开目录句柄、不构造 /proc 路径、不设 GIT_* 钉扎——以授权返回的规范路径为锚，任务前用 `stat` dev/ino 核验目标根、主仓库根、worktree Git dir 与 common dir，变更类任务结束后复验授权（`assertAuthorizationCurrent`）；仓库族 FIFO mutation gate 照常生效。适用于 `withStableRoot`（api.js）、`withTargetDirfd`（actions.js 的 merge-to-base 跨 worktree 目标）、autoname 的 `withAuthorizedRoot`、state.js 的快照计算与后台 fetch。
4. **文件保存**：非 Linux 走 paseo file-editor 语义——temp 独占创建（win32 flags 去 O_NOFOLLOW、跳过 chmod）、`fsync`、CAS(sha1) 复查紧贴提交点、`fs.rename` 原子替换、事后 stat。Linux 独有的「交换后验证被换出内容、不符则换回」在路径模式不存在对应物：失败的 rename 不触动原文件，临时文件按 inode 归属清理。
5. **git 输出归一**：`detectRepo` 与 `listWorktreesRaw` 的路径输出经 `normalizeGitPath`（按形状识别盘符/UNC 前缀后把 `/` 转 `\`，与宿主平台无关）；`authorize.js` 的根比较、`worktree.js` 的 `requireDirectDirectory` 与受管根验证在 win32 用 `samePath`（resolve 后大小写不敏感）。
6. **目录 fsync**：win32 下 `syncDirectory` 为 no-op；journal 的 link() 独占发布（NTFS 硬链接）与 O_EXCL 语义保持，非 NTFS 文件系统上创建事务显式失败，不额外兜底。

## 后果

- Windows/macOS 用户获得与 Linux 同构的功能面（创建 worktree、forge 选择器、diff/actions、编辑器、快照、自动改名、归档）；「requires Linux dirfd support」的 503 不复存在。
- 路径模式承认一个有界的操作中 TOCTOU 窗口：边界核验与变更后复验约束两端，仓库族 FIFO gate 消除插件自身的交错；这正是 paseo 在所有平台上的既有取舍。恶意本地进程在窗口内换绑目录的行为在 Linux 上被 dirfd 阻断，在路径模式下会以 409 stale-target/identity-changed 收敛——与「用户在插件外直接运行 Git 不受此门约束」的既有边界一致。
- 路径模式保存的「绝不丢失提交点之前的并发写」弱化为「CAS 复查与 rename 之间不落任何插件写入」；被外部进程无共享删除句柄占用的目标在 Windows 上 rename 报 EPERM/EBUSY，接口以 409 显式失败而不是静默覆盖。
- dev/ino 身份依赖文件系统提供稳定 file id：NTFS/ReFS 满足；FAT 类与部分网络盘可能退化（README 注明）。测试矩阵在 Linux CI 上以模拟平台覆盖非 Linux 分支，Windows 真机行为由与 paseo 相同的原语（普通 cwd git、stat 身份、rename 保存）保证，仍需装机自检（README 运维三步）。

## 修订 1：真机 Windows 暴露的三处 path-mode 缺陷（2026-09-24）

CI 只能在 POSIX 宿主上**模拟**平台分支（Git 仍输出 POSIX 路径形状），下列缺陷在模拟测试下全部隐形，只有 Windows 真机才现形。三处均已修复，并以真机端到端验证（创建 → 归档 → 崩溃恢复）。

1. **porcelain 行的裸字符串比较**（`lib/worktree.js` 六处：创建后的绑定证明、事务恢复的前置/后置、延迟删除、归档后置）。Windows 上 `git worktree list --porcelain` 打印 `worktree C:/Users/…`，而记录路径是 `join()` 生成的 `C:\Users\…`，`` `worktree ${path}` `` 恒不相等：每次创建都在 post-add 证明处失败（`cannot prove post-add worktree/branch ownership`），并因「无法证明未混入新增数据」保留半成品 —— 创建整体不可用。修复：新增 `worktreeRowHasPath(row, path)`，统一经 `normalizeGitPath` + `samePath` 比较；POSIX 仍是字节比较，Linux 行为不变。
2. **`git worktree remove .` 在 path 模式不可用**：Git 自己的 cwd 就是要删除的目录，而 Windows 拒绝删除活动进程的当前目录（`failed to delete …: Permission denied`）→ 归档恒失败、半成品清不掉。修复：dirfd 模式保持 `remove .` + 锚定 cwd；path 模式改传已验证的规范路径、cwd 取主仓库，锚点仍是前后的 dev/ino 证明与后置条件。
3. **`mainRepoRootOf` 返回非规范路径**：它曾直接返回 `dirname(git-common-dir)`（Windows 上正斜杠），该值写入 worktree 元数据与创建事务日志，而所有读取方一律拿 realpath 规范路径比较 → 恢复恒判 `journal-invalid`，崩溃遗留的日志永不回收。修复：返回 `safeRealpath(dirname(…))`（POSIX 上等价）。

新增覆盖：`worktreeRowHasPath` 的合成 Windows 行断言（在 POSIX CI 上以模拟 win32 运行），填补第 1 类的盲区；第 2、3 类由真机端到端验证确认。
