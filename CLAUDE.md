# CLAUDE.md

本文件给进入 `ccus` 仓库工作的 Claude / Claude Code 使用，目标是让新会话能快速理解项目边界、数据契约和修改注意事项。

## 语言要求

- 所有回答、分析、计划、思考过程（thinking/reasoning）必须使用**中文**。
- 代码标识符（变量名、方法名、类名）保持英文。

## 1. 项目是什么

`ccus` 是一个本地优先的 Claude Code statusline 使用率采集 CLI，主要能力有：

- 一键把 statusLine 命令写进 Claude Code 的 `settings.json`（`ccus install`）
- 读取 Claude Code statusline 传入的 JSON payload
- 输出一行 statusline 文本，并把原始 payload 以本地日志形式落盘
- 基于本地日志生成 dashboard（build / open / serve）
- 导出当前周 bundle JSON（原始事件 + 周汇总 + 按天汇总）
- 聚合同一目录下多人导出的 bundle，生成 `detail.csv` / `daily.csv` / `weekly.csv`

## 2. 当前最重要的契约

### 2.1 statusline 官方契约

- `stdin`：Claude Code 传入 JSON
- `stdout`：返回 statusline 文本

不要把这个命令改成读取参数或输出多行日志到 stdout。

`ccus statusline emit` 支持 `--no-store`（别名 `--no-log`）：照常解析 payload 并输出单行状态文本，但**跳过事件落盘**。该选项只影响是否写本地日志，不改变 stdin/stdout 契约，也不改变状态行内容。

导出（`ccus export`）默认输出**紧凑 JSON**（无缩进），仅展示层格式变化，字段集合不变、不 bump schemaVersion，`ccus aggregate` 用 `JSON.parse` 读取不受影响。

导出默认还会把这份紧凑 JSON **gzip 压缩**后写成 `.json.gz`（`src/lib/export.ts` 的 `writeGzipFile`）。gzip 只是存储/传输层压缩，解压后字节与未压缩导出完全一致，字段集合不变、**不 bump schemaVersion**。用 `--out` 指定一个非 `.gz` 结尾的路径时退回明文 JSON（`writeTextFile`）。`ccus aggregate` / `aggregate serve` 读取时按扩展名判断：`.gz` 先 gunzip 再 `JSON.parse`，明文 `.json` 照旧，两者都接受。

### 2.2 原始日志契约

持久化事件模型是 raw-first：

- `schemaVersion`（当前 statusline 事件写入版本为 `3`）
- `timestamp`
- `gitUserName`
- `gitUserEmail`
- `gitUserAccount`（email `@` 前的规范化用户名，仅在 statusline 落盘时写入；读旧日志时若缺失会从 email 派生）
- `rawPayload`

分析字段不直接持久化，而是在读时从 `rawPayload` 重新计算。

### 2.3 事件级语义

`StatuslineEvent` 是读时计算视图，不是最终导出契约。

- `usagePct`：Claude 的 **5 小时额度使用率**，来源 `rate_limits.five_hour.used_percentage`
- `sevenDayUsagePct`：Claude 的 **7 天额度使用率**，来源 `rate_limits.seven_day.used_percentage`
- `contextWindowPct` / `contextUsed` / `contextMax`：上下文窗口相关指标，不等于 5h usage

注意：

- 事件级仍使用 `usagePct` / `sevenDayUsagePct`
- 不要把对外导出字段名和事件级字段名混为一谈

### 2.4 当前导出契约（非常重要）

`ccus export` 当前默认导出 **bundle JSON**，不是 jsonl。

顶层结构：

- `schemaVersion`
- `generatedAt`
- `range`
- `identity`
- `rawEvents`
- `weeklySummary`
- `dailySummaries`

当前导出契约版本：

- `schemaVersion: 8`

当前对外 usage 字段（Claude 额度，只算 `source!="codex"` 的事件）：

- `weeklySummary.statusline.fiveHourLatestUsagePct`
- `weeklySummary.statusline.fiveHourPeakUsagePct`
- `weeklySummary.statusline.sevenDayLatestUsagePct`
- `weeklySummary.statusline.sevenDayPeakUsagePct`
- `dailySummaries[].fiveHourLatestUsagePct`
- `dailySummaries[].fiveHourPeakUsagePct`
- `dailySummaries[].sevenDayLatestUsagePct`
- `dailySummaries[].sevenDayPeakUsagePct`

Codex 统计（与 Claude 字段单列）：

- `weeklySummary.codex`：`{ userMessageCount, apiRequestCount, inputTokens, outputTokens, cacheReadInputTokens, fiveHourPeakUsagePct, fiveHourLatestUsagePct, sevenDayPeakUsagePct, sevenDayLatestUsagePct }`
- `dailySummaries[].codex`：同结构，每天一条
- token/消息来自 Codex sessions rollout（累加）；额度（5h/7d peak/latest）从 `source="codex"` 事件重算（快照，v8 起单列）

`averageUsagePct` 已从对外汇总/导出契约中移除。
旧的 `sevenDayUsagePct` 单字段已在 schemaVersion 6 拆成 `sevenDayPeakUsagePct` + `sevenDayLatestUsagePct`，不要再合回去。

如果再改这些字段名或字段集合，必须把导出 `schemaVersion` 再往上 bump，并同步测试和 README。

### 2.5 aggregate 输入契约

`ccus aggregate` 当前接受：

- `schemaVersion: 6/7/8` 的 bundle JSON（v8 含 codex 额度字段；v7 codex 无额度、读时按 null；v6 无 codex 子结构、读时回退零值）
- 通过 `ccus export` 导出的 `.json.gz`（gzip 压缩，默认）或明文 `.json` 文件，`.gz` 读取时自动 gunzip

schemaVersion 6/7/8 以外的 bundle 会被明确拒绝，不再静默读取。
不支持把 raw-event jsonl 直接作为 `aggregate` 输入。

### 2.6 aggregate 输出契约

三个 CSV 共用一个 `personKey` —— 来源于 `gitUserEmail` 在 `@` 前的规范化用户名（小写、清洗特殊字符），落到不出现真实 email 的导出列里。

**同一个人多台电脑导出多个 bundle 的合并语义（很重要）：**

同一个人（同 personKey）可能在多台电脑上各自 `ccus export`，目录里会出现多份覆盖同一周 / 同一天的 bundle。`aggregate` 按 personKey 合并去重，规则分两类字段：

- **天级累加字段**（token、`userMessageCount`、`apiRequestCount`、`sampleCount`、`uniqueSessions`、`uniqueWorkspaces`）：去重以**天**为粒度。对每个 `(personKey, date)` 取 `generatedAt` 最新的那份导出 bundle（`selectDailyWinners`），winner 选择优先取该天有数据的 bundle，再比 `generatedAt`，最后用文件路径做稳定 tie-break。同一台机器重复导出 / 周重叠在天级被去重，**不会翻倍**。
- **周级汇总**：weekly **不取整周单份 bundle**，而是把已按天去重的 daily winner 按 `(personKey, 周)` **上卷累加**（`buildAggregatedWeeklyRows`）。因为同一周里多台电脑通常在不同天有数据（同一天一般不会两台都有），按天 winner 各取有数据的那台、再求和，正好把多机数据拼齐；同机/周重叠的翻倍仍由天级去重挡住。
- **usage 字段**（5h / 7d 的 peak/latest）：是百分比快照、不是累加量，不存在翻倍问题。daily 从该天 winner bundle 的 `rawEvents` 重算，weekly 从该周所有 winner 天的事件汇总后重算（peak 取 max、latest 取时间戳最新）；某指标在 `rawEvents` 里缺失时回退到 daySummary 自带值。
- **7d 累计字段**（`sevenDayCumulativeUsagePct`，daily/weekly 各一列）：是把 7d 锯齿波还原成累计真实使用量的派生指标。计算分两层，**两层都不要改回朴素的 `Σ max(0, uᵢ − uᵢ₋₁)`**（真实 7d 信号会 ±1 抖动 + 偶发 stale 尖峰，朴素累加会严重高估，实测 gaoshang 102 / lijian 164 vs 真实 ~50 / ~93）：
  - **① 读数去毛刺**（`deburrSevenDayEvents`，挂在 `buildPersonSevenDayCurve` 合并去重之后）：真实档位被高频采样连续覆盖多个样本、持续几十分钟，stale 缓存读数只持续秒级。把**中间**持续短于 2 分钟（`SEVEN_DAY_MIN_HOLD_MS`）的读数段替换为前值，首尾段无条件保留。持续时长默认按「下一段起始 − 本段起始」度量；但当**多样本**段后面紧跟一段比阈值还大的**采集间隙**时（该度量会把间隙也算进去、把只持续几十秒的短尖峰"撑"过阈值而漏抹），改用**段内真实跨度（最后样本 − 第一样本）**判定；单样本段无段内跨度、仍走原度量以保护稀疏单样本。只对密集真实曲线生效，稀疏数据/单样本段不受影响。（这条 gap 感知正是修掉了「低位短 stale 尖峰后跟采集间隙→漏抹→触发假 reset→累计虚高」的实测 bug。）
  - **② 分段峰谷和**（`computeCumulativeSevenDay`）：把去毛刺后曲线按 reset（样本跌破当前段峰值一半，`SEVEN_DAY_RESET_RATIO=0.5`）切成上升段，每段贡献「段内峰值 − 段内谷值」，累计 = 各段之和。
  - 它把百分比快照变成了**累加量**，所以**不能走 winner 路**——winner 按天只取一台机器会漏样、分机各自累计再相加会翻倍（同账号 7d 额度共享，多机只是同一条曲线的密集采样）。它走一条**独立于 winner 的全样本 merge 路**：对每个 personKey 收集**所有 bundle**（非仅 winner）的 `rawEvents` → 取非 null `sevenDayUsagePct` → 按 timestamp 升序合并、对完全相同 timestamp 去重 → 去毛刺成一条账号级曲线，再按区间切片做分段峰谷和。daily 在当天子曲线上算、weekly 在整周子曲线上一次性算；因「段在区间内重新起算、跨天边界的上升段在 weekly 连续计入而在 daily 被切断」，故 `weekly ≥ Σ daily`，daily 逐行相加只是近似。已知遗留：同 personKey 长期混入交错多源（多账号/多机各自 7d 额度不同）时，去毛刺只压短尖峰、压不掉长期并行的双水平曲线，属数据源粒度问题、不在本算法范围。
- `detail.csv` 同步只展开 winner bundle 的事件，避免同机重复导出把明细也翻倍；`detail.csv` **不**含 `sevenDayCumulativeUsagePct`（单事件行不承载区间累计语义）。

这套合并只改变行的去重 / 取值逻辑，CSV 列集合与 `schemaVersion` 都不变（`sevenDayCumulativeUsagePct` 纯在 aggregate 层从 `rawEvents` 重算，与 `recomputeUsage` 同理，**不 bump export `schemaVersion`**）。winner 判定依赖 bundle 顶层已有的 `generatedAt`，不需要给导出加机器标识字段。实现见 `selectDailyWinners` / `buildAggregatedWeeklyRows` / `recomputeUsage` / `buildPersonSevenDayCurve` / `computeCumulativeSevenDay`。

- `detail.csv` 列：`personKey, timestamp, week, date, sessionId, workspaceName, modelName, source, fiveHourUsagePct, contextWindowPct, contextUsedM, contextMaxM, inputTokensM, outputTokensM, cacheReadInputTokensM`
  - `source` 标记事件来源（`claude` / `codex`）；codex 行的 `*TokensM` 留 0（codex 无单事件 token 语义，token 在 daySummary.codex 按天聚合）
  - 历史上有的 `sourceFile`、`workspaceDir`、`statusLine`、`gitUserName`、`gitUserEmail` 已移除，不要再加回来
  - `inputTokensM` / `outputTokensM` / `cacheReadInputTokensM` 是**该事件所在自然日**的 token 总量（从同一 bundle 的 `dailySummaries` 按 `date` join 而来），不是单条事件的 token。同一天的多条 detail 行会重复同一组日总量，所以这三列不能直接按行求和
  - `contextUsedM` / `contextMaxM` 是单条事件的 context window token（来自 `rawPayload`），同样换算成 M；`contextWindowPct` 仍是百分比，不换算
- `daily.csv` / `weekly.csv` 都包含 `fiveHourPeakUsagePct` / `fiveHourLatestUsagePct` / `sevenDayPeakUsagePct` / `sevenDayLatestUsagePct` 四个 usage 列、`sevenDayCumulativeUsagePct` 累计列（紧跟在 `sevenDayLatestUsagePct` 之后），以及 `inputTokensM` / `outputTokensM` / `cacheReadInputTokensM` 三个 token 列。这些主字段都是 **Claude+Codex 合计**：token/消息/请求数直接相加，额度 peak 取两源 max、latest 两源相加，7d 累计曲线含 Claude 与 Codex 两源读数（codex 事件不再按 source 过滤）。不再单列 `codex*` 列（codex 明细只在 `aggregate serve` 看板表格里保留）
- 所有以 token 计的列（detail 的 `contextUsedM` / `contextMaxM` / `*TokensM`，daily/weekly 的 `*TokensM`）都以**百万（M）为单位**：原始整数除以 1_000_000 后写出（`export.ts` 的 `toMillions`，保留 6 位小数，null 仍写空）。bundle JSON 里仍是原始整数，M 换算只发生在 CSV 展示层，所以本次改动不动 `schemaVersion`。`*M` 后缀就是单位标记，不要去掉

`ccus aggregate serve` 与 `ccus aggregate` 共用同一个 bundle 输入目录，但不写文件，只在内存里渲染多人 dashboard HTML 并通过本地 HTTP 端口提供页面。新增字段时，serve 路径的 HTML 也要同步更新，避免对外契约和页面展示脱节。

## 3. 仓库结构

### 3.1 CLI 入口

- `src/cli.ts`

负责命令分发与主要编排：

- `ccus install`
- `ccus statusline emit`
- `ccus dashboard build`
- `ccus dashboard open`
- `ccus dashboard serve`
- `ccus export`
- `ccus aggregate`
- `ccus aggregate serve`
- `ccus sessions [RANGE] [--out FILE]`（把 `~/.claude/projects` 中在指定时间窗口内有活动的 session 文件打包成 zip，内部保持 `<projectDir>/<sessionId>.jsonl` 结构；文件名格式 `projects_<start>_<end>_<gitUserName>.zip`；默认 `this-week`，输出到 `<data-dir>/sessions/`）
- `ccus open`（用系统文件管理器打开本地存储目录，`--print` 只输出路径不打开）
- `ccus update`（主动检查更新，仅提示不自动安装）
- `ccus sync`（立即执行一次同步：导出当前周 bundle 并复制到目标目录的按周子目录，周一额外归档上一周）
- `ccus sync config`（只读写同步配置 `--target` / `--interval` / `--range` / `--suffix`，不触发同步；不带参数打印当前配置）
- `ccus sync install`（注册系统调度器：每周五 18:00 跑一次 `ccus sync`；Windows 用 schtasks 真正创建，macOS/Linux 打印 cron 命令引导手动安装；`--print` 只打印不安装）
- `ccus sync uninstall`（卸载系统调度器；Windows 用 schtasks 删除任务，macOS/Linux 打印 crontab 提示；`--print` 只打印不执行）
- `ccus sync status`（查看同步配置与上次同步时间）
- `ccus api config`（读写第三方额度 API 模式配置 `--enable`/`--disable`/`--provider zhipu|custom`/`--token-env`/`--token`/`--url`/`--project`/`--organization`/`--header "K: V; K2: V2"`/`--ttl` 等，不触发拉取；不带参数打印当前配置）
- `ccus api test`（立即拉取一次第三方额度并打印 5h/7d/level，验证配置是否生效；绕过缓存，失败把原因打到 stderr）
- `ccus api status`（查看 API 模式配置与额度缓存新鲜度）
- `ccus --version`
- `ccus __check-update`（隐藏命令，statusline 路径 spawn 的 detached 后台进程，只刷新更新缓存，不输出 stdout）
- `ccus __sync`（隐藏命令，statusline 路径 spawn 的 detached 后台进程，静默执行一次同步，不输出 stdout、失败静默）
- `ccus __codex-notify`（隐藏命令，Codex `notify`（config.toml）每 turn 结束 spawn 的回调程序；从末尾 argv 读 notify JSON 的 `cwd`/`thread-id` → `recordCodexEvent`（拉额度 + 构造 `source="codex"` 事件落盘 + 心跳 + 兜底 sync）；不写 stdout、失败 debugLog 到 stderr 后静默退出 0。**orca 等会覆盖 config.toml 的环境 notify 不持久，改用 `__codex-hook`**）
- `ccus __codex-hook`（隐藏命令，Codex hooks.json 的 `Stop` 事件回调程序，orca 等 hook-only 环境的触发入口；从 stdin 读 hook payload 的 `cwd`/`session_id` → `recordCodexEvent`（与 notify 共享同一采集/落盘/sync 逻辑）；不写 stdout（Stop 要求 stdout 空或 JSON，ccus 选空 + exit 0 = success 不干预 Codex）、失败静默；stdin 非法 JSON（Windows Stop 偶发 #23784）容错；`finally` 调 `maybeSpawnBackgroundSync` 兜底触发 3h 定时同步，与 Claude statusline 路径对称）
- `ccus install --codex`（一键把 `ccus __codex-hook`（Windows 用 `ccus.cmd`）挂进 `~/.codex/hooks.json` 的 `Stop` 事件，与现有 Stop hook 并列并发；`--data-dir` 追加、`--codex --uninstall` 移除、`--config PATH` 覆盖 hooks.json 路径；首次需在 Codex `/hooks` 信任该 hook；不带 `--codex` 时仍装 Claude statusLine）

### 3.2 核心库

- `src/lib/payload.ts`
  - 解析 statusline payload
  - 读出 `usagePct` / `sevenDayUsagePct` / context 指标
  - 生成 `StatuslineEvent`

- `src/lib/storage.ts`
  - 本地日志读写
  - 按天/分片存储

- `src/lib/dashboard.ts`
  - dashboard 摘要计算
  - 折线图数据桶
  - HTML 生成

- `src/lib/aggregate-dashboard.ts`
  - 多人 aggregate dashboard 摘要计算
  - 多人 HTML 生成
  - 仅 `ccus aggregate serve` 使用，运行时实时渲染，不落地

- `src/lib/export.ts`
  - 周导出 JSON 生成
  - summary rows
  - 聚合 CSV 输出

- `src/lib/sync.ts`
  - 定时同步：读写 `sync-config.json`（目标目录/周期/范围）与 `sync-state.json`（上次同步时间/结果）
  - `performSync`：注入 `runExport`（避免与 cli.ts 循环依赖）→ 导出当前周 bundle → 在目标目录的按周子目录（`formatWeekDirName`，形如 `2026_06_01_2026_06_07`）下**复制**一份；本地 exports 仍保留
  - `--suffix` 机器后缀：`sanitizeSuffix` 清洗、`applyFileSuffix` 在 `.json.gz` / `.json` 扩展名前插入 `-<suffix>`，只作用于目标目录副本（本地原文件名不变），供多机同步到同一目录时区分不覆盖
  - 周一（`now.getDay() === 1`）额外导出 `last-week` 并归档到对应上一周子目录；用 `sync-state.lastArchivedWeek` 去重，避免周一当天每次同步重复归档
  - `isSyncDue`：默认周期 `3h`（滚动 TTL）；`daily` 按自然日判断，`<N>h` / `<N>m` 按滚动 TTL

- `src/lib/scheduler.ts`
  - 仅 `ccus sync install` 使用：构造「每周五 18:00 跑 `ccus sync`」的系统调度器安装计划
  - `buildSchedulerPlan` 纯函数（按平台生成 schtasks 参数 / cron 命令，便于单测）；Windows `autoInstallable`，macOS/Linux 只打印 cron 命令交用户手动
  - `uninstallScheduler`：Windows `schtasks /delete`（任务不存在视为未卸载、不抛错），macOS/Linux 打印 crontab 提示
  - 任务调用串用绝对 node + cli.js 路径并带显式 `--data-dir`，保证调度环境也能跑
  - `maybeSpawnBackgroundSync`：statusline 路径调用，到周期才 spawn detached `__sync` 后台进程，对单行 stdout 契约零侵入（照搬 update-check 的范式）
  - 本功能是新增编排层，**不改动任何导出/聚合字段，不 bump `schemaVersion`**，导出产物与 `ccus export` 完全一致

- `src/lib/api-mode.ts`
  - 第三方额度 API 模式：读写 `api-config.json`（provider / token 来源 / 缓存 TTL 等）与 `api-quota-cache.json`（上次额度与抓取时间）
  - `resolveApiQuota`：statusline 路径调用，缓存优先（默认 5 分钟 TTL），过期同步拉一次（带超时），失败回退旧缓存，全程不抛错、不写 stdout
  - zhipu 是 custom 的一组内置预设（`ZHIPU_EXTRACTOR` 脚本：`data.limits` 筛 `TOKENS_LIMIT` 用 `number` 字段识别桶位（5h 桶 `number===5`、周桶 `number===1`），5h=number 5 的那条、周桶=余下第一条；不能用 `nextResetTime` 大小排序区分（5h 与周窗口重置时刻互不相关，实测周桶 nextResetTime 可早于 5h，升序会把周桶当 5h 致 5h/7d 互换），仅 `number` 缺失的老接口才退回 `nextResetTime` 稳定排序（有值优先、缺值按原序）），zhipu / custom 走同一条 `runExtractor`（`new Function` 求值）路径；custom 另可用 `extractCustomQuota`（点分字段路径）或 `custom.extractor` 自定义 JS 函数（返回值兼容 `{fiveHour,sevenDay}` / cc-switch 风格数组 / 数字数组，优先于点分路径）
  - token 默认从环境变量 `ANTHROPIC_AUTH_TOKEN` 读（`--token-env` 可改），`--token` 兜底（注意会明文落盘）；header 值支持 `{{token}}` / `{{apikey}}` 占位
  - 手动命令（`api test` 拉取、`api status` / `api config` 显示）在环境变量与 `--token` 都没有时，经 `resolveApiTokenWithSettings` → `readClaudeSettingsEnvTokenSync` 回退读 `~/.claude/settings.json` 的 `env[tokenEnv]`；statusline 高频路径仍走纯 `resolveApiToken`（不读文件），行为不变
  - `cli.ts` `handleStatuslineEmit` 在落盘前调 `applyQuotaToPayload` 把额度填进 `rawPayload.rate_limits`，复用现有展示/落盘/导出/聚合管线，**不 bump export `schemaVersion`**（纯读时填充，与 `recomputeUsage` 同理）

- `src/lib/codex-fetcher.ts`
  - Codex CLI 额度采集：`fetchCodexQuota` spawn `codex -s read-only -a untrusted app-server`，JSON-RPC 握手（`initialize` → 收响应 → 发 `initialized` 通知 → `account/rateLimits/read`，**不发 initialized 会被拒为 Not initialized**），解析 `result.rateLimits.primary`→5h / `secondary`→weekly
  - 字段名实测是**驼峰** `usedPercent` / `resetsAt`（Unix 秒），**不是** design 文档写的 `used_percent` / `reset_at`（后者是 backend wham/usage 直连路径的字段，本路径不走）；解析时驼峰优先、`used_percentage`/`usedPercentage` fallback，clamp 0–100；ENOENT→`unavailable`、超时/RPC error/进程提前退出→`error`，全程不抛错
  - `resolveCodexQuota`：TTL 缓存（默认 5min，`codex-quota-cache.json`），命中秒回、过期才 spawn（带 ~10s 超时）、失败回退旧缓存、全失败或无有效数据返回 null；`options.fetcher` 供测试注入
  - spawn 用 `env: { ...process.env, CODEX_HOME }` 继承（`CODEX_HOME` 默认 `~/.codex`）；Windows 上 codex 多为 codex.cmd，`shell:true` 兜底
  - 由 `cli.ts` 的 `recordCodexEvent` 调用（`__codex-notify` argv 回调与 `__codex-hook` stdin 回调共享同一采集逻辑），拉到额度后经 `applyQuotaToPayload` 填 `rawPayload.rate_limits`（`primary`→`five_hour`、`secondary`→`seven_day`）+ `appendEvent` 落盘，打 `rawPayload.source="codex"` 标记；v8 起按 source 分流进 export/aggregate——Claude usage 只算 claude 事件、Codex 额度单列到 `weeklySummary.codex` / `dailySummaries[].codex` 的 5h/7d peak/latest（从 source=codex 事件重算），detail.csv 加 `source` 列、aggregate daily/weekly CSV 加 codex 额度列
  - 依赖 Codex 内部 app-server 协议，**易碎**：协议字段随版本变，解析层宽松、字段缺失返回 null、失败静默；Codex 桌面版 app 不在本期范围（无 notify 触发点）

- `src/lib/codex-install.ts`
  - `ccus install --codex` 的实现：`installCodexHook` / `uninstallCodexHook` 读写 `~/.codex/hooks.json`，把 ccus 的 command hook 追加进 `hooks.Stop` 第一个分组的 `hooks` 数组（与 orca 等现有 Stop hook 并列、由 Codex 并发执行，互不阻塞），保留其它事件 / 其它 hook / description / 格式；Stop 已有相同 command 则不动文件（幂等），Stop 不存在则新建一个分组；卸载只移除 command 含 `__codex-hook` 的条目、保留其它 hook；非法 hooks.json 抛错不覆盖（避免破坏 orca 写入的文件）
  - hook command 默认 `ccus __codex-hook`（Windows 用 `ccus.cmd __codex-hook`），`--data-dir` 追加 `--data-dir <path>`（cli 层构造）；timeout 60s（缓存命中秒回、过期拉额度 ~10s）
  - 选 hooks.json 而非 config.toml notify 的原因：orca 等外部工具会重写 config.toml（实测把 ccus 的 notify 顶成自己的弹窗 notify），hooks.json 不被频繁重写、是 hook-only 环境的持久触发入口；首次装完需在 Codex `/hooks` 信任该 hook
  - `installCodexNotify` / `uninstallCodexNotify`（文本操作 config.toml 顶层 notify，找第一个 table 头之前的 notify 赋值行，保留其它 key/table/注释/格式；跨行数组拒绝改写）仍作为库函数保留供非 orca 环境或手配 notify 使用，但 `install --codex` 不再走它
  - 纯写 hooks.json / config.toml，不碰 export/aggregate 契约，不 bump `schemaVersion`

- `src/lib/codex-sessions.ts`
  - 扫 `<CODEX_HOME>/sessions` 下递归的 rollout jsonl（仿 `claude.ts`），统计 Codex 的 userMessageCount / apiRequestCount / inputTokens / outputTokens / cacheReadInputTokens
  - 口径：`payload.type=="user_message"` 计消息；`payload.type=="token_count"` 取 `info.last_token_usage`（本次增量，**不**用 `total_token_usage` 累计，否则重复计）累加 token、+1 请求；timestamp 在 top-level
  - `summarizeCodexSessionUsage` / `summarizeCodexSessionUsageByDay` 由 `cli.ts` 的 `runExport` 与 `loadDashboardData` 调用，填进 `weeklySummary.codex` / `dailySummaries[].codex`（export）和每日消息柱图（dashboard）
  - rollout 协议随 Codex 版本变，**易碎**：解析宽松、缺字段按 0

- `src/lib/aggregate.ts`
  - 读取 bundle JSON
  - 从 bundle 展开 detail/daily/weekly 行
  - 当前校验 `schemaVersion` 为 6/7/8（v8 含 codex 额度；v7/v6 容错：codex 额度字段缺失按 null/零值）
  - 同一个人多台电脑导出多个 bundle 时按 personKey 合并去重（见 2.6）

- `src/lib/claude.ts`
  - 从 `~/.claude/projects/**/*.jsonl` 统计：
    - `userMessageCount`
    - `apiRequestCount`
    - `inputTokens`
    - `outputTokens`
    - `cacheReadInputTokens`

- `src/lib/git.ts`
  - 读取 git 用户名/邮箱（只读全局 git config）
  - `readGitBranch(cwd)`：在 workspace 目录实时读取当前分支名，仅供 statusline 展示，不落盘、不进导出契约；detached HEAD / 非 git 仓库返回 null

- `src/lib/install.ts`
  - 把 statusLine 命令写进 Claude Code 的 `settings.json`
  - 只覆盖 `statusLine` 字段，保留其它顶层设置
  - 无法解析的配置文件直接报错，不覆盖

- `src/lib/version.ts`
  - 读取 ccus 自身版本号（运行时读 `package.json`，dist 与源码都用 `../../package.json` 定位）
  - `isNewerVersion(latest, current)`：只比较 `major.minor.patch`，忽略预发布后缀

- `src/lib/update-check.ts`
  - npm 更新检查：查 registry（`ccus-cli/latest`，可用 `CCUS_REGISTRY` 覆盖）、本地缓存 `update-check.json`、24h 节流
  - statusline 路径只做两件无侵入的事：`maybeSpawnBackgroundCheck`（缓存过期则 spawn detached 后台进程刷新，不等待）+ `computeUpdateNotice`（同步读缓存，决定行尾是否追加 `⬆ vX.Y.Z`）
  - `performUpdateCheck` 供 `ccus update` 和隐藏命令 `__check-update` 复用；**绝不写 stdout**，失败一律静默
  - 当前更新行为：只提示、不自动执行 `npm i -g`

- `src/lib/debug.ts`
  - 调试日志开关与统一出口（`--verbose` / `--debug` / `-v` 或 `CCUS_DEBUG=1` 打开）
  - `debugLog` 一律写 **stderr**，绝不写 stdout，避免污染 statusline 的单行 stdout 契约
  - `handleStatuslineEmit` 的兜底 catch 平时会吞掉真实错误，开启调试后会把完整 stack 打到 stderr，这是排查 statusline 不出数据的主要手段

### 3.3 类型源头

- `src/types.ts`

任何导出字段、聚合字段、dashboard 摘要字段变动，都先看这里。

### 3.4 测试

- `src/test/payload.test.ts`
- `src/test/dashboard.test.ts`
- `src/test/export.test.ts`
- `src/test/storage.test.ts`
- `src/test/claude.test.ts`
- `src/test/aggregate.test.ts`
- `src/test/aggregate-dashboard.test.ts`
- `src/test/install.test.ts`
- `src/test/api-mode.test.ts`
- `src/test/codex-fetcher.test.ts`
- `src/test/codex-sessions.test.ts`
- `src/test/codex-install.test.ts`
- `src/test/cli-codex-notify.test.ts`
- `src/test/cli-codex-hook.test.ts`
- `src/test/cli-install-codex.test.ts`
- `src/test/debug.test.ts`

## 4. 常用开发命令

安装与构建：

```bash
npm install
npm run build
```

源码测试：

```bash
npm run test:src
```

编译后测试：

```bash
npm test
```

真实导出 smoke：

```bash
node dist/cli.js export --data-dir "$env:LOCALAPPDATA\ccus"
```

真实聚合 smoke：

```bash
node dist/cli.js aggregate --input-dir "$env:LOCALAPPDATA\ccus\exports" --out-dir "$env:LOCALAPPDATA\ccus\aggregated"
```

## 5. 修改时的硬规则

### 5.1 不要破坏 raw-first 设计

日志中应尽量保留原始数据：

- 不要把大量分析字段重新写回日志
- 新分析字段优先在读取时计算

### 5.2 不要混淆 3 类 usage

这里至少有三层概念：

1. `usagePct`
   - Claude 的 5 小时额度使用率
2. `sevenDayUsagePct`
   - Claude 的 7 天额度使用率
3. `contextWindowPct`
   - context window 占用率

用户历史上多次强调过：

- 5h usage 不是“过去 5 小时范围”，而是 Claude 自己给出的 5 小时额度百分比
- context 不是 usage

### 5.3 改导出字段 = 改外部契约

只要改到以下任一层：

- `weeklySummary`
- `dailySummaries`
- aggregate 输出 CSV 列

就视为外部契约变更。必须同时做：

1. 更新 `src/types.ts`
2. 更新 `src/cli.ts`
3. 更新 `src/lib/export.ts`
4. 更新 `src/lib/aggregate.ts`
5. 更新测试
6. 更新 `README.md`
7. 视情况 bump `schemaVersion`

### 5.4 aggregate 向后兼容

当前接受 `schemaVersion: 6/7/8`，对旧版本做显式容错映射（不默默放宽）：

- v8：完整（codex 含额度字段）
- v7：codex 有 token/消息、无额度字段 → 额度按 null
- v6：无 codex 子结构 → codex 回退零值
- 6/7/8 以外：拒绝，让用户重新导出

codex 额度在 aggregate 层从 `rawEvents` 的 `source="codex"` 事件重算，所以 v6/v7 时期混进 rawEvents 的 codex 事件也能被正确分流（Claude usage 变干净、codex 额度算出）。

## 6. 当前已知产品语义

### 6.1 export

- 默认 `this-week`
- 默认输出一个 bundle `.json`
- 文件名前缀使用 git email 本地部分
- 文件名含开始与结束日期

### 6.2 bundle 内容

- `rawEvents`：原始持久化事件
- `weeklySummary`：整周汇总
- `dailySummaries`：按整周日期枚举，每天一条

即使某天没有 statusline 样本，该天也应该出现在 `dailySummaries` 中。

### 6.3 Claude 本地 transcript 统计来源

来源目录：

- `~/.claude/projects/**/*.jsonl`

统计口径：

- `userMessageCount`：用户请求数。`type:"user"` 但满足以下任一条件的事件都不计入：
  - `isMeta === true`
  - `toolUseResult` 字段存在（工具结果回填的伪 user 事件）
  - `message.content` 是数组且全部条目都是 `tool_result`
- sidechain（子 agent）会话里的 user 提示会被保留计入，因为它们仍代表团队让 Claude 做事，不是工具机械回填
- `apiRequestCount`：带 `message.usage` 的 `type:assistant`
- token 统计来自 assistant usage 事件

历史上 `userMessageCount` 曾经把所有 `type:"user"` 事件都算进去，导致 tool_result 被严重高估（实测过 10× 量级）。如果再调整这套过滤，请同步 `isHumanUserMessage` 和这里的描述。

## 7. 改动后最低验证要求

如果改了实现代码，至少跑：

```bash
npm run test:src
npm run build
```

如果改了导出/聚合契约，再额外做：

```bash
node dist/cli.js export --data-dir "$env:LOCALAPPDATA\ccus"
```

必要时再做：

```bash
node dist/cli.js aggregate --input-dir "$env:LOCALAPPDATA\ccus\exports" --out-dir "$env:LOCALAPPDATA\ccus\aggregated"
```

## 7.1 CHANGELOG 规范

写 `CHANGELOG.md` 时务必**简明扼要**：

- 每条一句话，只说“做了什么 / 改了什么”，不展开实现细节、字段口径、动机推导
- 按 `新增` / `变更` / `修复` 分组，能合并的要点就合并成一条
- 粒度对齐已有的 `[0.1.x]` 段，不要写成提交说明或设计文档

## 8. 给后续 Claude 的建议

- 先读 `src/types.ts`，再读 `src/cli.ts`
- 任何“字段名看起来差不多”的地方都不要凭感觉改
- 先分清事件级字段、导出字段、aggregate CSV 字段是不是同一层
- 如果用户再次要求改导出字段名，默认要考虑 `schemaVersion`
- 如果你看到 `averageUsagePct`，当前应把它视为旧字段，不应重新加回导出契约，除非用户明确要求
