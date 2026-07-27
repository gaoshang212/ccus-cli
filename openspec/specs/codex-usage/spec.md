# codex-usage Specification

## Purpose

定义 ccus 对 Codex CLI 使用数据的采集与下游接入：以 Codex turn 结束的回调（`notify` / hooks.json `Stop`）为触发点，spawn `codex app-server` 经 JSON-RPC 拉 5h / weekly 额度并落盘为 `source="codex"` 事件；扫描 `~/.codex/sessions` rollout 统计消息数 / 请求数 / token。采集复用现有 statusline 落盘管线，下游按 `source` 分流——Claude usage 只算 Claude 事件、Codex 额度与用量单列到 export（`schemaVersion` v8 的 `weeklySummary.codex` / `dailySummaries[].codex`）与 aggregate（detail.csv `source` 列、daily/weekly CSV Claude+Codex 合计）。仅支持 Codex CLI（`notify` / `Stop` 与可 spawn 的 `codex` 二进制）。

## Requirements

### Requirement: Codex turn 结束的双触发入口

系统 SHALL 提供两个隐藏命令作为 Codex turn 结束的回调，二者共享同一采集 / 落盘 / 兜底同步逻辑（`recordCodexEvent`）：
- `ccus __codex-notify`：作为 Codex `~/.codex/config.toml` 的 `notify` 回调程序，从末尾 argv 读 notify JSON 的 `cwd` 与 `thread-id`；
- `ccus __codex-hook`：作为 `~/.codex/hooks.json` 的 `Stop` 事件回调，从 stdin 读 hook payload 的 `cwd` 与 `session_id`；是 orca 等 hook-only 环境（config.toml notify 被外部工具覆盖、不持久）的触发入口。

两个命令 MUST NOT 向 stdout 写内容（`notify` 不读 stdout、`Stop` 要求 stdout 空或 JSON，ccus 选空 + exit 0 表示 success、不干预 Codex）。命令 `finally` MUST 调 `maybeSpawnBackgroundSync` 兜底触发 3h 定时同步，与 Claude statusline 路径对称。任何失败（拉取 / 落盘 / 载荷解析失败，含 Windows Stop 偶发的 stdin 非法 JSON）MUST 经 `debugLog` 写到 stderr 后静默退出 0，绝不抛未捕获错误影响 Codex 主流程。

#### Scenario: notify 调起落盘 Codex 事件

- **WHEN** Codex 在 turn 结束 spawn `ccus __codex-notify` 并传含 `cwd` / `thread-id` 的 JSON
- **THEN** ccus 落盘一条事件，`rawPayload.workspace.current_dir` = 载荷 `cwd`、`rawPayload.session_id` = 载荷 `thread-id`、`rawPayload.source` = `"codex"`，`rate_limits` 已填本次 5h/7d

#### Scenario: Stop hook 调起落盘 Codex 事件

- **WHEN** Codex `Stop` 事件 spawn `ccus __codex-hook`，stdin 传含 `cwd` / `session_id` 的 hook payload
- **THEN** ccus 落盘同结构的 `source="codex"` 事件，stdout 留空、exit 0

#### Scenario: 不写 stdout

- **WHEN** 任一命令执行完毕
- **THEN** 进程 stdout 为空，诊断信息只在 stderr

#### Scenario: 失败不阻断 Codex

- **WHEN** 拉取 / 落盘 / stdin 非法 JSON 任一失败
- **THEN** 命令仍以 exit 0 静默返回，不向 Codex 抛错

### Requirement: 经 Codex app-server RPC 拉取额度

系统 SHALL 通过 spawn `codex -s read-only -a untrusted app-server` 并发送 JSON-RPC `account/rateLimits/read` 获取额度。MUST 完成握手：发 `initialize` → 收响应 → 发 `initialized` 通知（不发会被拒为 Not initialized）→ 再发 `account/rateLimits/read`。MUST 把返回的 `primary` 窗口映射为 5 小时额度、`secondary` 窗口映射为 7 天额度，取各自的 `usedPercent`（驼峰，clamp 0–100）与 `resetsAt`（Unix 秒）。系统 MUST NOT 改用 ccus 自身 Node `fetch` 直连 `chatgpt.com` 拉额度——Node 裸 fetch 不读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，只有让 codex 子进程（Rust/reqwest）发请求才能正确走代理。

#### Scenario: RPC 成功解析双窗口

- **WHEN** app-server 对 `account/rateLimits/read` 返回 `primary.usedPercent=42`、`secondary.usedPercent=18`
- **THEN** ccus 得到 5h=42、7d=18，落进 `rate_limits.five_hour` / `rate_limits.seven_day`

#### Scenario: Codex 未安装

- **WHEN** spawn `codex` 返回 ENOENT
- **THEN** 拉取返回 `unavailable`，不落空事件，静默退出

#### Scenario: 字段缺失

- **WHEN** `primary` 或 `secondary` 缺 `usedPercent`
- **THEN** 对应窗口计为 null，不阻断另一窗口

### Requirement: 额度缓存节流

系统 SHALL 对 Codex 额度拉取做 TTL 缓存（默认 5 分钟，落盘 `codex-quota-cache.json`）。Codex 的 `notify` / `Stop` 是同步调用、会等待回调返回，缓存 MUST 保证绝大多数 turn 命中缓存秒回、不 spawn app-server。缓存过期才触发一次 spawn 并带超时（~10s）；拉取失败 MUST 回退上一次缓存的额度；全失败或无有效数据返回 null。

#### Scenario: TTL 内不重复 spawn

- **WHEN** 缓存 TTL 内被多次调起
- **THEN** 只首次 spawn，后续命中缓存直接返回

#### Scenario: 拉取失败回退旧缓存

- **WHEN** 缓存过期后拉取失败
- **THEN** 用上一次成功缓存额度落盘，不写空值

### Requirement: 子进程继承宿主环境

系统 spawn `codex app-server` 时 MUST 以 `env: { ...process.env, CODEX_HOME }` 继承 ccus 完整环境，保证代理（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`）、`CODEX_HOME`、系统路由与用户交互的 Codex 一致。`CODEX_HOME` 未显式指定时 SHALL 回退 `~/.codex`。Windows 上 codex 多为 codex.cmd，MUST 以 `shell:true` 兜底。

#### Scenario: 代理变量透传

- **WHEN** ccus `process.env` 含 `HTTPS_PROXY=http://127.0.0.1:7890`
- **THEN** codex 子进程 env 同样含该变量，请求经代理发出

#### Scenario: CODEX_HOME 回退

- **WHEN** 未显式传入 codex home
- **THEN** 用 `~/.codex`，与用户交互 Codex 共享 `auth.json` / `config.toml`

### Requirement: Codex 事件落盘与来源标记

系统 MUST 把 Codex 额度事件落进现有 storage，`rawPayload.rate_limits` 经 `applyQuotaToPayload` 填充（`primary`→`five_hour`、`secondary`→`seven_day`），并在 `rawPayload.source` 打 `"codex"` 标记以区别 Claude 事件（Claude 无该字段、读时视为 `"claude"`）。落盘后 `computeStatuslineEvent` MUST 能在读时从 `rate_limits` 自动算出 `usagePct` / `sevenDayUsagePct`，无需持久化分析字段。

#### Scenario: Codex 事件可被读时计算

- **WHEN** 一条 `source="codex"` 事件落盘，`rate_limits.five_hour.used_percentage=55`
- **THEN** `computeStatuslineEvent` 对该事件算出 `usagePct=55`

#### Scenario: 来源可区分

- **WHEN** 同一 storage 并存 Claude 与 Codex 事件
- **THEN** 读时能据 `rawPayload.source` 区分（缺失视为 Claude）

### Requirement: Codex sessions 统计

系统 SHALL 扫描 `<CODEX_HOME>/sessions` 下递归的 rollout jsonl 统计 Codex 用量：`payload.type=="user_message"` 计 `userMessageCount`；`payload.type=="token_count"` 取 `info.last_token_usage`（本次增量，MUST NOT 用 `total_token_usage`，否则重复计）累加 token、+1 `apiRequestCount`；timestamp 取 top-level。统计结果由 `runExport` 与 `loadDashboardData` 调用，填进 `weeklySummary.codex` / `dailySummaries[].codex`（export）与每日消息柱图（dashboard）。

#### Scenario: 消息与 token 统计

- **WHEN** 一个 rollout 含 3 条 `user_message`、2 条 `token_count`（`last_token_usage` 各 1000 / 2000）
- **THEN** 该 session 统计 `userMessageCount=3`、`apiRequestCount=2`、token 累加 3000

#### Scenario: token 不重复计

- **WHEN** `token_count` 事件含 `total_token_usage=10000` 但 `last_token_usage=500`
- **THEN** token 按 500 计本次增量，不按 10000 累计

### Requirement: Codex hook 一键安装

`ccus install --codex` SHALL 把 ccus hook command（默认 `ccus __codex-hook`，Windows 用 `ccus.cmd __codex-hook`）追加进 `~/.codex/hooks.json` 的 `hooks.Stop` 第一个分组的 `hooks` 数组，与 orca 等现有 Stop hook 并列、由 Codex 并发执行互不阻塞。MUST 保留其它事件 / 其它 hook / description / 格式；`Stop` 已有相同 command 则不动文件（幂等），`Stop` 不存在则新建分组。`--uninstall` 只移除 command 含 `__codex-hook` 的条目、保留其它。非法 hooks.json MUST 抛错不覆盖（避免破坏 orca 写入的文件）。`--data-dir` 追加、`--config PATH` 覆盖 hooks.json 路径。选 hooks.json 而非 config.toml notify：orca 等会重写 config.toml 顶掉 ccus notify，hooks.json 不被频繁重写。

#### Scenario: 首次安装追加 Stop hook

- **WHEN** `~/.codex/hooks.json` 的 `Stop` 已有 orca hook，执行 `ccus install --codex`
- **THEN** ccus hook 追加进同一分组 hooks 数组，orca hook 与其它配置保留

#### Scenario: 幂等

- **WHEN** `Stop` 已有 command 含 `__codex-hook`
- **THEN** 文件不变

#### Scenario: 非法 hooks.json 不覆盖

- **WHEN** hooks.json 无法解析
- **THEN** 抛错退出，不写文件

### Requirement: Codex 接入 export（schemaVersion v8）

`ccus export` SHALL 按 `source` 分流事件：Claude usage 字段（5h/7d peak/latest）只算 `source != "codex"` 的事件；Codex 额度单列到 `weeklySummary.codex` / `dailySummaries[].codex`。Codex 子结构含 `{ userMessageCount, apiRequestCount, inputTokens, outputTokens, cacheReadInputTokens, fiveHourPeakUsagePct, fiveHourLatestUsagePct, sevenDayPeakUsagePct, sevenDayLatestUsagePct }`：token / 消息来自 Codex sessions rollout 累加；额度（5h/7d peak/latest）从 `source="codex"` 事件重算（快照）。bundle `schemaVersion` MUST 为 8。

#### Scenario: Claude usage 不含 Codex

- **WHEN** 同一周 storage 含 Claude 与 Codex 事件，执行 `ccus export`
- **THEN** `weeklySummary.statusline.*` 只统计 Claude 事件，Codex 额度在 `weeklySummary.codex.*`

#### Scenario: schemaVersion 升 v8

- **WHEN** 执行 `ccus export`
- **THEN** bundle 顶层 `schemaVersion` = 8，含 `weeklySummary.codex` / `dailySummaries[].codex`

### Requirement: Codex 接入 aggregate

`ccus aggregate` SHALL 接受 `schemaVersion` 6/7/8 的 bundle 并做显式容错：v8 完整；v7 codex 有 token / 消息、无额度字段按 null；v6 无 codex 子结构回退零值。Codex 额度在 aggregate 层从 `rawEvents` 的 `source="codex"` 事件重算，故 v6/v7 时期混进 rawEvents 的 codex 事件也能被正确分流（Claude usage 变干净、codex 额度算出）。`detail.csv` SHALL 加 `source` 列（`claude` / `codex`），codex 行的 `*TokensM` 留 0（codex 无单事件 token 语义）。daily/weekly CSV 的 token / 消息 / 请求列与额度列均为 Claude + Codex 合计：累加类直接相加、额度 peak 取两源 max、latest 两源相加。schemaVersion 6/7/8 以外的 bundle MUST 被拒绝。

#### Scenario: 旧版 bundle 容错

- **WHEN** 输入 v7 bundle（codex 无额度字段）
- **THEN** codex token 正常统计、额度按 null，不报错

#### Scenario: detail 区分来源

- **WHEN** 展开 detail.csv
- **THEN** 每行带 `source` 列，codex 行 token 列为 0

#### Scenario: 拒绝未知版本

- **WHEN** 输入 schemaVersion 5 的 bundle
- **THEN** 明确拒绝、不静默读取

### Requirement: 范围限定 Codex CLI

Codex 额度采集 SHALL 仅支持 Codex CLI：触发依赖 CLI 的 `notify`（config.toml）或 `Stop` hook（hooks.json），额度拉取依赖可被外部 spawn 的 `codex` CLI 二进制。Codex 桌面版 app（已并入 ChatGPT 桌面 app）不在支持范围——其 GUI 不必然触发 CLI 的 `notify` / `Stop`，且可能不随附独立 `codex` 二进制或不共享 `~/.codex/auth.json`。

#### Scenario: CLI 正常触发

- **WHEN** 用户经 Codex CLI 完成一个 turn 且 hook / notify 已装
- **THEN** ccus 被调起、采集发生

#### Scenario: 桌面 app 不在范围

- **WHEN** 用户仅在 Codex 桌面版 app 活动
- **THEN** ccus 不被调起、不采集，本期不视为缺陷
