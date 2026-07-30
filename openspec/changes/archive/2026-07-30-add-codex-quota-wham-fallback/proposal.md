## Why

`ccus` 采 Codex 额度依赖 spawn `codex app-server`。本机没装 codex CLI、或 codex 不在 ccus 的 PATH 时，`fetchCodexQuota` 返回 `unavailable`、额度直接为空。但这类用户往往已在 Codex 登录、本地留有 `~/.codex/auth.json` 的 OAuth token——额度数据账号级存在，只是 ccus 取不到。需要一个保底通道：app-server 不可用时改走 ChatGPT 后端 `wham/usage` HTTP 直连，让「装过 codex 留下 hook+auth.json / codex 未入 PATH」的用户也能采到额度。

口径与采集路径参考 `docs/research/cc-switch-codex-quota.md` 第 8 节。

## What Changes

- 在 `resolveCodexQuota`（`codex-fetcher.ts`）里，主 fetcher 返回 `unavailable`（ENOENT，本机无 codex）后、回退旧缓存前，插入 wham/usage HTTP 直连回退；`error`（超时 / RPC 错）不触发，避免瞬时故障多扛一次 15s HTTP。
- wham 回退读 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`），仅 `auth_mode === "chatgpt"` 取 `tokens.access_token`；API key 模式、文件缺失、结构异常直接放弃回退。不实现 refresh、不碰 Keychain。
- `GET https://chatgpt.com/backend-api/wham/usage`，headers `Authorization: Bearer {access_token}`、`User-Agent: codex-cli`、`Accept: application/json`，`account_id` 存在时追加 `ChatGPT-Account-Id`；超时 15s。
- 解析下划线风格响应 `rate_limit.{primary_window,secondary_window}.{used_percent, limit_window_seconds, reset_at}`，**按 `limit_window_seconds` 认桶**（18000→5h、604800→7d），不假设 primary/secondary 顺序。
- 回退拉到的额度进同一份 `codex-quota-cache.json` + 5min TTL，下游 `applyQuotaToPayload` + `source="codex"` 落盘分流不变。
- **统一加 env 代理支持**：把 `httpRequest`（`api-mode.ts`）改为读环境变量代理（`https_proxy`/`HTTPS_PROXY`/`http_proxy`/`HTTP_PROXY`/`all_proxy`/`ALL_PROXY`，小写优先、`ALL_PROXY` 兜底、`NO_PROXY` 排除），有代理则给请求挂 `https-proxy-agent` / `http-proxy-agent`，无则维持直连。另设 ccus 专属变量 `CCUS_PROXY`：单一值同时管 https / http 目标、优先于上述标准变量（仍受 `NO_PROXY` 约束），供「只想给 ccus 指定代理、不动系统其它工具 env」的场景。wham 回退与既有智谱 / custom 第三方额度请求**统一**受益——代理用户（chatgpt.com 须经代理才达）也能用上 wham 保底与 api-mode。引入 ccus 首个运行时依赖（`https-proxy-agent` + `http-proxy-agent`）。
- **顺手同步主路径认桶口径**：主路径（app-server RPC）实现 0.2.3（commit 07eb6f7）已改成按 `windowDurationMins` 认桶，但主 spec 仍是旧 `primary`→5h / `secondary`→7d 硬映射描述（commit 漏改 spec）；本 change 的 MODIFIED delta 覆盖该段，apply 后主 spec 与实现对齐。

## Capabilities

### Modified Capabilities

- `codex-usage`: 在「经 Codex app-server RPC 拉取额度」Requirement 里给 `unavailable` 加 wham 回退分支，wham 请求经统一代理通道；主路径「MUST NOT Node 直连」约束的理由调整为「用 codex 官方协议、不碰 OAuth、更稳」，Node 直连 wham 仅作回退。在「范围限定 Codex CLI」放宽「额度拉取仅靠 spawn codex」——触发仍依赖 CLI notify/Stop，额度拉取多一条 HTTP 回退通道。

## Impact

- 代码：`src/lib/api-mode.ts`（`httpRequest` 加 env 代理解析 + agent 选择，提为 export）；`src/lib/codex-fetcher.ts`（新增 `fetchCodexQuotaViaWham` + auth.json 读取 + `parseWhamUsage`，`resolveCodexQuota` 编排回退）。
- 依赖：`dependencies` 新增 `https-proxy-agent` + `http-proxy-agent`（ccus 首个运行时依赖，破「零依赖」现状）。
- 测试：新增 wham 回退、auth.json 解析、`resolveCodexQuota` unavailable→wham 编排、`httpRequest` 代理（走代理 / `NO_PROXY` 直连 / 无代理维持现状 / 智谱与 custom 也走代理）的单测。
- 文档：`README.md`、`CLAUDE.md` 标注 wham 回退触发条件、统一代理支持、auth.json 结构假设的易碎性。
- 契约：**不**触及 export bundle 字段集合与 `schemaVersion`；回退额度走既有 `source="codex"` 分流；代理仅改传输层、不改请求/响应字段语义。
