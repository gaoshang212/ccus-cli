## Why

`ccus` 现在只采集 Claude Code 的使用率。团队同时用 Codex，Codex 同样有「5 小时窗口 + 周窗口」两层额度（`primary` / `secondary`），语义与 Claude 的 `five_hour` / `seven_day` 对称，却没有等价的本地采集手段。需要让 ccus 也能采 Codex 的额度并落盘，复用现有展示 / 导出 / 聚合管线的下游能力。

## What Changes

- 新增 Codex 额度采集：以 Codex 的 `notify`（`agent-turn-complete`）为触发入口，每个 turn 调起 ccus 的隐藏命令；ccus 再 spawn `codex app-server` 经 JSON-RPC `account/rateLimits/read` 拉取 `primary`（5h）/ `secondary`（weekly）窗口的百分比与重置时间，落盘成一条 Codex 事件。
- 额度拉取带 TTL 缓存（默认 5 分钟），命中即返回不重复 spawn，避免阻塞 Codex 主流程。
- Codex 事件落进现有 storage，`rawPayload.rate_limits` 复用 `applyQuotaToPayload` 填充，并打 `rawPayload.source = "codex"` 来源标记；`computeStatuslineEvent` 自动算出 `usagePct` / `sevenDayUsagePct`。
- spawn codex 时 `env` 继承 `process.env`，保证代理、`CODEX_HOME`、config 与用户交互的 Codex 同环境。
- 纯读时填充 + 复用现有管线，**不 bump export `schemaVersion`**。
- 本期面向 **Codex CLI**：`notify` 与 `codex app-server` 都是 CLI 的能力。Codex 桌面版 app（已并入 ChatGPT 桌面 app）是 GUI、不必然触发 CLI 的 `notify`，也不一定随附可被外部 spawn 的 `codex` 二进制 / 共享 `~/.codex/auth.json`，留待后续 change。

## Capabilities

### New Capabilities
- `codex-usage`: 定义 Codex 额度的 notify 触发入口、app-server RPC 拉取口径、缓存节流、子进程环境继承、落盘与来源标记，以及本期「不进 export/aggregate」的边界。

### Modified Capabilities
<!-- 本期为全新采集路径，不改既有 spec；export / aggregate 的 Codex 支持留待后续 change。 -->

## Impact

- 代码：`src/cli.ts`（新增 `__codex-notify` 隐藏命令）、新增 `src/lib/codex-fetcher.ts`（spawn app-server + JSON-RPC + 解析 + TTL 缓存）、`src/lib/storage.ts`（复用 `appendEvent`）、`src/lib/api-mode.ts`（复用 `applyQuotaToPayload`）、`src/types.ts`（`source` 标记注释）。
- 测试：新增 `src/test/codex-fetcher.test.ts`、`src/test/cli-codex-notify.test.ts`。
- 文档：`README.md`、`CLAUDE.md`（新增 Codex 采集章节、notify 手动配置、source 标记、不 bump schemaVersion、依赖 Codex 内部协议的易碎标注）。
- 契约：**不**触及 export bundle 字段集合与 `schemaVersion`；本期 Codex 事件不进 `ccus export` / `ccus aggregate`。
