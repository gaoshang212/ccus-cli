## 1. Codex 额度拉取器（app-server RPC）

- [x] 1.1 新增 `src/lib/codex-fetcher.ts`：spawn `codex -s read-only -a untrusted app-server`，完成 JSON-RPC 握手（`initialize` → `initialized` → `account/rateLimits/read`），带 ~10s 超时；返回 `{ fiveHour, sevenDay, resetsAt } | null`
- [x] 1.2 解析 `rateLimits.primary`（5h）/ `secondary`（weekly）的 `used_percent` 与 `reset_at`，百分比 clamp 到 0–100
- [x] 1.3 `env: { ...process.env }` 继承，保证代理 / `CODEX_HOME` 透传（完成判据：带 `HTTPS_PROXY` 的测试断言子进程 env 含该变量）
- [x] 1.4 降级：Codex 未安装（ENOENT）→ `unavailable`；超时 / RPC 错误 → `error`；全程不抛错
- [x] 1.5 单测覆盖：RPC 成功解析、未安装、超时、字段缺失返回 null

## 2. notify 触发命令

- [x] 2.1 在 `src/cli.ts` 新增隐藏命令 `__codex-notify`，从入参读取 Codex notify JSON（`thread-id`/`turn-id`/`cwd`）
- [x] 2.2 命令体：读额度（走第 3 步缓存）→ 构造 `rawPayload`（`session_id`=`thread-id`、`workspace.current_dir`=`cwd`、`source`=`"codex"`）→ `applyQuotaToPayload` 填 `rate_limits` → `appendEvent` 落盘
- [x] 2.3 **不写 stdout**（notify 不读 stdout，且会污染 Codex 终端）；失败 `debugLog` 到 stderr 后静默退出
- [x] 2.4 单测：notify 调起后落盘一条 `source="codex"` 事件、`rate_limits` 含 5h/7d、stdout 为空

## 3. 额度缓存节流

- [x] 3.1 参照 `resolveApiQuota` / `api-quota-cache.json` 模式实现 TTL 缓存（默认 5min），命中直接返回不 spawn
- [x] 3.2 缓存落盘 `codex-quota-cache.json`（quota + fetchedAt），拉取失败回退旧缓存
- [x] 3.3 单测：TTL 内不重复 spawn app-server；过期才触发拉取

## 4. 来源标记与读时计算

- [x] 4.1 在 `src/types.ts` 的 `RawStatuslinePayload` 注释补充 `source` 可选字段（Codex 事件打 `"codex"`，Claude 事件无此字段视为 `"claude"`）
- [x] 4.2 确认 `computeStatuslineEvent` 能从填充后的 `rate_limits` 算出 `usagePct` / `sevenDayUsagePct`（复用，不改）

## 5. 文档与验证

- [x] 5.1 `README.md` 新增 Codex 采集章节：手动配置 `~/.codex/config.toml` 的 `notify = ["ccus", "__codex-notify"]`、代理继承说明、本期不进 export/aggregate
- [x] 5.2 `CLAUDE.md` 新增 Codex 采集小节：触发点、app-server RPC、source 标记、不 bump `schemaVersion`、依赖 Codex 内部协议的易碎标注
- [x] 5.3 跑 `npm run test:src` 与 `npm run build`；手动 smoke：配 notify 后跑一次 Codex turn，确认落盘事件含 5h/7d
