# cc-switch 获取 Codex 额度的方式

> 调研对象：[`farion1231/cc-switch`](https://github.com/farion1231/cc-switch)（Tauri：Rust 后端 + React 前端，Claude Code / Codex 供应商切换器）
> 调研时间：2026-07-27，分支 `main`
> 目的：对比 ccus 自身的 Codex 额度采集路径，评估是否有可借鉴之处

## 结论先行

cc-switch **不走** Codex CLI 的 app-server JSON-RPC，而是 **HTTP 直连 ChatGPT 后端的 `wham/usage` 端点**。这与 ccus 当前的 `codex-fetcher.ts` 路径是同一份 quota 数据的两个不同对外口径。

## 1. 请求协议

核心代码 `src-tauri/src/services/subscription.rs:686-690`：

```rust
let mut req = client
    .get("https://chatgpt.com/backend-api/wham/usage")
    .header("Authorization", format!("Bearer {access_token}"))
    .header("User-Agent", "codex-cli")
    .header("Accept", "application/json");
```

- 方法：`GET`
- URL：`https://chatgpt.com/backend-api/wham/usage`
- 超时：15s
- 多账号场景追加 `ChatGPT-Account-Id: {account_id}` 头
- **`User-Agent: codex-cli` 写死**——后端大概率据此识别为 Codex 客户端、返回 codex 额度结构

## 2. 鉴权（两套 Token 来源）

`Authorization: Bearer {access_token}`，token 来源分两条路径：

### 路径 A：Codex CLI 自带凭据

入口 `get_subscription_quota("codex")`（`src-tauri/src/commands/subscription.rs:18-42`）。取 token 按优先级（`services/subscription.rs:490-543`）：

1. macOS Keychain service `"Codex Auth"`（`security find-generic-password -s "Codex Auth" -w`，仅 macOS）
2. 文件 `~/.codex/auth.json`（路径由 `codex_config::get_codex_auth_path()` 解析）

- 仅 `auth_mode == "chatgpt"`（OAuth）有效，API key 模式直接 `NotFound`（`subscription.rs:560-567`）
- 解析结构：`CodexAuthJson { auth_mode, tokens: { access_token, account_id }, last_refresh }`
- staleness：距 `last_refresh` > 8 天视为可能过期，但仍尝试调用（`subscription.rs:614-625`）

### 路径 B：cc-switch 自管 OAuth

入口 `get_codex_oauth_quota(account_id)`（`src-tauri/src/commands/codex_oauth.rs:24-60`），由 `CodexOAuthManager::get_valid_token_for_account(&id)` 取（必要时自动刷新）token。无账号时返回 `not_found`，前端静默不渲染。

## 3. 返回结构与字段映射（下划线风格）

解析结构 `services/subscription.rs:630-646`：

```rust
struct CodexRateLimitWindow {
    used_percent: Option<f64>,
    limit_window_seconds: Option<i64>,
    reset_at: Option<i64>,              // Unix 秒
}

struct CodexRateLimit {
    primary_window: Option<CodexRateLimitWindow>,
    secondary_window: Option<CodexRateLimitWindow>,
}

struct CodexUsageResponse {
    rate_limit: Option<CodexRateLimit>,
}
```

字段映射到 `QuotaTier`（`subscription.rs:735-755`）：

| wham 字段 | 映射 | 说明 |
|---|---|---|
| `used_percent` | `utilization` | 百分比 0–100 |
| `reset_at` | `resets_at` | Unix 秒 → ISO 8601 字符串 |
| `limit_window_seconds` | `name` | 经 `window_seconds_to_tier_name` 映射成 tier 名 |

## 4. 区分 5h / 7d / 30d 桶：靠 `limit_window_seconds` 自描述

`services/subscription.rs:649-666`：

```rust
fn window_seconds_to_tier_name(secs: i64) -> String {
    match secs {
        18000     => TIER_FIVE_HOUR.to_string(),     // 5 * 3600
        604800    => TIER_SEVEN_DAY.to_string(),     // 7 * 86400
        2_592_000 => TIER_THIRTY_DAY.to_string(),    // 30 天（Codex 免费方案）
        s => {
            let hours = s / 3600;
            if hours >= 24 { format!("{}_day", hours / 24) }
            else { format!("{}_hour", hours) }
        }
    }
}
```

迭代时把 `[primary_window, secondary_window]` flatten 后逐个看 `limit_window_seconds`（`subscription.rs:737-755`），**不假设哪个 window 是 5h、哪个是 7d**。某 window 的 `used_percent` 缺失就跳过、不报错。

## 5. 缓存 / 失败处理 / 容错

**缓存**：

- 前端 react-query `staleTime = 5min`（`src/lib/query/subscription.ts:12`），可被 per-provider `autoQueryIntervalMinutes` 覆盖（最小 1min）
- 后端 `state.usage_cache`：成功时 `put_subscription` 持久化快照 + `emit("usage-cache-updated")` + `schedule_tray_refresh()`

**失败处理**（`services/subscription.rs:696-733`）：

- 瞬时失败（网络 / 超时 / 读体中断）→ `Err(String)`：前端 reject + retry，保留上次成功 data（`useQuotaKeepLastGood`）。`Err` **不写快照、不 emit**，避免覆盖托盘旧值
- 确定性失败 → `Ok({ success: false, ... })`：HTTP 401/403 → `credential_status = Expired`；其它非 2xx → `Valid` + 错误体；JSON 解析失败 → `Valid` + 解析错误

**字段缺失容错**：

- `used_percent` 缺失 → 跳过该 window
- `rate_limit` 整个缺失 → 空 tiers + `success: true`
- `limit_window_seconds` 缺失 → tier 名回退 `"unknown"`
- `reset_at` 缺失 → `resets_at = None`

## 6. 与 ccus 的对比

| 维度 | cc-switch | ccus |
|---|---|---|
| 协议 | HTTP GET 直连 | spawn `codex app-server` JSON-RPC |
| URL / method | `https://chatgpt.com/backend-api/wham/usage` | `account/rateLimits/read`（JSON-RPC over stdio） |
| User-Agent | `codex-cli`（写死） | 不走 HTTP UA |
| 鉴权 | OAuth `access_token`（Bearer）+ `ChatGPT-Account-Id` | 借 `codex` 进程身份，自己不碰 OAuth token |
| 字段风格 | **下划线** `used_percent` / `reset_at` / `limit_window_seconds` | **驼峰** `usedPercent` / `resetsAt` |
| 区分 5h/7d | **`limit_window_seconds` 自描述**（18000 / 604800） | primary→5h / secondary→7d **硬映射** |
| reset 单位 | Unix 秒（自转 ISO） | Unix 秒 |

ccus `CLAUDE.md` 中 `src/lib/codex-fetcher.ts` 一节已标注：驼峰 `usedPercent`/`resetsAt` 是 app-server JSON-RPC 路径的字段，下划线 `used_percent`/`reset_at` 是 backend wham/usage 直连路径的字段——cc-switch 走的正是后者。

## 7. 可借鉴点

**`limit_window_seconds` 认桶比 primary/secondary 硬映射更稳健**。cc-switch 不假设 `primary` 一定是 5h、`secondary` 一定是 7d，而是按窗口时长（18000s / 604800s）自描述认桶，绕开了「5h 用量为 0 被后端省略、或 reset 时间顺序异常导致 5h/7d 互换」这类错位问题——这恰好是 ccus 在 0.1.24 / 0.1.26 修过的坑。

**注意迁移成本**：wham/usage 直连需要 OAuth `access_token`，cc-switch 自己实现了 token 读取（Keychain / `auth.json`）与刷新。ccus 目前借 `codex` 进程身份拿额度、自己不碰 OAuth；若要切到 wham/usage 直连，得自行解决 token 读取与刷新逻辑，且需关注 Keychain / `auth.json` 结构随 Codex 版本变化的风险。

## 8. 回退方案：本机无 codex 命令时改走 wham/usage

ccus 主路径 `resolveCodexQuota` → `fetchCodexQuota` spawn `codex app-server`。本机没装 codex CLI 时返回 `unavailable`、额度为空。此场景回退到本调研的 wham/usage HTTP 直连，让「只装了 Codex 桌面版 / codex 未入 PATH」的用户也能采到额度。

### 8.1 触发

`resolveCodexQuota` 拉取结果 `status === "unavailable"` 且无新鲜缓存时进入回退；`error`（超时 / RPC 错）不触发，避免把瞬时故障误判成「无 codex」。

### 8.2 token 来源（与 api-mode 区分）

wham/usage 要的是 Codex OAuth `access_token`，**不是** ccus `api-mode` 的 `ANTHROPIC_AUTH_TOKEN`。读 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）：

- 结构 `{ auth_mode, tokens: { access_token, account_id }, last_refresh }`（对齐 cc-switch 路径 A 文件源，跨平台）
- 仅 `auth_mode === "chatgpt"` 有 OAuth token；API key 模式直接放弃回退
- 不实现 refresh：距 `last_refresh` > 8 天仍尝试，失败静默回退 null（refresh 要 Keychain + refresh_token，成本高于收益）
- 不碰 macOS Keychain：文件源已够，cc-switch 也以文件为 fallback

### 8.3 请求与解析

- `GET https://chatgpt.com/backend-api/wham/usage`
- headers：`Authorization: Bearer {access_token}`、`User-Agent: codex-cli`（写死，后端据此认 Codex 客户端）、`Accept: application/json`；`account_id` 存在时追加 `ChatGPT-Account-Id`
- 超时 15s（cc-switch 口径，HTTP 直连比 app-server 慢）
- 响应下划线风格：`rate_limit.{primary_window, secondary_window}`，每窗 `{ used_percent, limit_window_seconds, reset_at }`
- **按 `limit_window_seconds` 认桶**（18000→5h、604800→7d），不假设 primary/secondary 顺序——比 ccus 主路径 primary→5h / secondary→7d 硬映射更稳健（见 §7）；某窗缺 `used_percent` 跳过

### 8.4 复用现有设施

- `httpRequest` + `runExtractor`（`api-mode.ts`）天然适配：wham 当 custom provider，extractor 脚本按 `limit_window_seconds` 认桶，headers 用 `{{token}}` 占位填 access_token
- token 解析需新增一条 codex 专属路径（读 `auth.json`），不能复用 `resolveApiToken`
- 缓存复用 `codex-quota-cache.json` + 5min TTL；回退拉到的额度照常进缓存，下次命中秒回
- `applyQuotaToPayload` 不变：回退拿到的也是 `{ fiveHour, sevenDay }`，照常填 `rate_limits`、走 source="codex" 分流

### 8.5 插入点

在 `resolveCodexQuota`（`codex-fetcher.ts`）里，主 fetcher 返回 `unavailable` 后、回退旧缓存前插入 wham 回退。统一在缓存层处理，对 `cli.ts` `recordCodexEvent` 零侵入。

### 8.6 风险 / 不做

- wham/usage 是 ChatGPT 后端内部端点，比 codex app-server **更易碎**，字段随版本变；解析宽松、失败静默
- `auth.json` 结构假设对齐 cc-switch 当前版本，Codex 升级可能破坏；本方案只读不刷新，过期即降级
- 仅作「无 codex 命令」兜底，不替代主路径；codex CLI 可用时仍走 app-server（更快、不碰 OAuth）

## 9. 相关源码文件

后端（`src-tauri/src/`）：

- `services/subscription.rs` — 核心：`query_codex_quota` / `read_codex_credentials` / `get_subscription_quota` 路由
- `commands/subscription.rs` — Tauri 命令入口
- `commands/codex_oauth.rs` — cc-switch 自管 OAuth 入口
- `services/codex_oauth_models.rs` — Codex 模型列表（同域名 `chatgpt.com/backend-api/codex/models`，可佐证 wham 是 ChatGPT 后端）
- `proxy/providers/codex_oauth_auth.rs` — `CodexOAuthManager` 多账号 token 管理
- `usage_script.rs` — API key 模式的 JS 脚本沙箱（rquickjs），与 OAuth 额度无关

前端（`src/`）：

- `lib/api/subscription.ts`
- `lib/query/subscription.ts`
- `types/subscription.ts`
