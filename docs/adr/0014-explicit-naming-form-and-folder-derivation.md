# ADR 0014：显式命名表单、目录名派生，以及移除自动改名

- 状态：Accepted
- 日期：2026-09-24
- 部分取代：[ADR 0004](./0004-worktree-branch-semantics.md) 的 Phase B（首条消息 LLM 改名）、Amendment 2 的触发集合（create-on-arm）、Amendment 6.A（命名调用的输出预算）

## 背景

hero 暂存态的旧形态是「选基分支即创建」（ADR 0004 Amendment 2 的 create-on-arm）：选基分支、选 PR 行、确认显式分支名、点「立即创建」四个动作都立刻创建并跳转。为解释这段非自明交互，hero 行常驻一句提示「选定基分支即创建并跳转，草稿随迁」。

两个现场问题促成改版：

1. **目录名与分支名无关。** 客户端在**每次**创建请求里都新摇一个助记 slug（`slug: mnemonicSlug()`）作为目录名种子，因此用户显式命名分支时，目录名仍是与分支毫无关系的 `calm-heron-4f2a`。而托管根的分组目录是不可读的仓库哈希，浏览 `~/.dsh/worktrees/<hash>/` 时既看不出哪个目录属于哪个仓库，也看不出对应哪条分支。
2. **首条消息自动改名机制本身有问题且实用性不大。** 它需要一整套元数据状态机（`pending`/`attempted`/`renamed`）、一次性 attempted 语义、推理模型的输出预算修补（Amendment 6.A 把 64 改成 512）、失败补偿回滚与多层守卫链；而收益只是让占位分支在首条消息后变成一个任务派生名。显式命名的分支本就 `ineligible`，骰子路径又是最常见的入口。

## 决策

1. **暂存态改为显式表单**：`[分支名输入框][骰子][基于: <ref> ▾][创建]`。名称**必填**（空值禁用「创建」），骰子一键填入 `adj-noun-hhhh`。选定基分支或 PR 行**不再创建任何东西**；「创建」是唯一触发点。旧提示句与「立即创建」按钮随之删除，面板内的「＋ 新建分支…」两步输入也由表单取代。
2. **分支名永久定格**：删除 `lib/autoname.js` 与它在 `index.js` 的装配；`worktree.json` 不再写 `autoName`。显式名与骰子名一律终局；`checkout` / `pr-checkout` 意图的既有行为不变。
3. **目录名派生移到宿主**：新增 `deriveWorktreeLeaf(mainRoot, branch)` = `slugify(basename(mainRoot)).slice(0,24) + '-' + slugify(branch).slice(0,40)`（≤65 字符，`uniquePath` 继续负责 `-1/-2` 冲突）。仓库名保留完整形态直到 24 字符：被截断的**词尾**恰是区分两个仓库的部分（`dsh-plugin-pyrun` 与 `dsh-persist-reasoning` 前十字符相同），因此既不做首截，也不用首字母缩写——首字母方案还需要一张对照表。
4. **客户端不再发送 `slug`**：目录名由宿主派生，客户端摇出的助记名只作为分支名的来源。宿主仍接受只给 `slug` 的旧式请求作为分支名兜底（API 兼容），但它不再影响目录名。

## 后果

- 目录名自解释：`dsh-better-workspaces-feature-login`；分支名保留用户输入的大小写与 `/`（叶子做小写 slug 化）。
- 每个 worktree 都有一个人选或一钮摇出的名字，无意义的占位助记名不再可能成为默认结果。
- 插件从此**零 LLM 调用**：会话标题回到 DSH 原生 titler（ADR 0004 Phase B 偏差 1 本就主张标题归 DSH）。`inject` 无需改动——原先的 llm / agentDefaultModel 就是 `ctx.get` 懒取。
- 一次性 machinery 一并消失：`lib/autoname.js` 整模块、9 个宿主测试块、5 条 hero 文案、`autoName` 元数据字段写入。
- **取舍**：失去「分支名随任务收敛」的能力。要恢复需按 ADR 0004 重写整套 metadata 状态机；ADR 0004 Phase B 就是那份完整规格。
- 目录名在创建瞬间定格：会话 cwd 不可迁移（ADR 0004 Amendment 2），因此事后手工 `git branch -m` 不会改目录名（旧行为亦然，只是旧目录名本就不含分支语义）。
- 叶子带前缀后路径变长，故设 65 字符预算；仓库名若不含任何路径安全字符（例如全中文）则退化为 `wt-<branch>`。

## 被取代的 ADR 0004 段落

- **Phase B 全部**：占位分支的 `pending`/`ineligible` 语义、`autoname.js` 的守卫链与补偿。
- **Amendment 2 的触发集合**：由「选基分支 / 确认名字 / 立即创建即创建」改为「仅点创建」。Amendment 2 的其余论证（`Session.header` 深冻结、persistence 的 cwd 一致性校验，因此会话 cwd 只能在创建时选定）继续有效，并且正是「没有拦截首条消息的替代方案」的原因。
- **Amendment 6.A**：命名调用的输出预算，相关代码已删除；保留其排查记录以备将来重启该能力。
- Amendment 6.B（workspace 标题跟随每个会话标题）不受影响，仍然有效。
