## MODIFIED Requirements

### Requirement: 经 Codex app-server RPC 拉取额度

系统 SHALL 通过 spawn `codex -s read-only -a untrusted app-server` 并发送 JSON-RPC `account/rateLimits/read` 获取额度（主路径）。MUST 完成握手：发 `initialize` → 收响应 → 发 `initialized` 通知（不发会被拒为 Not initialized）→ 再发 `account/rateLimits/read`。MUST 按各窗口自带的 `windowDurationMins` 认桶（300→5h、10080→7d，±1 分钟容差，不依赖 primary/secondary 顺序——实测 app-server 可能把周额度放在 primary）；取各自的 `usedPercent`（驼峰，clamp 0–100）与 `resetsAt`（Unix 秒）。`windowDurationMins` 缺失或无法归类时退回 legacy `primary`→5h、`secondary`→7d。

**主路径 MUST NOT** 改用 ccus 自身 Node HTTP 直连 `chatgpt.com` 作为主路——主路应用 codex 官方协议（app-server RPC）：由 codex 进程自带 `auth.json` 登录、ccus 不碰 OAuth，且官方协议比 wham 内部端点稳。Node 直连 wham 仅作下方 `unavailable` 时的回退通道。

**wham/usage 回退（仅 `unavailable` 时）**：主路径 spawn 返回 ENOENT（`unavailable`）且无新鲜缓存时，系统 SHALL 改走 ChatGPT 后端 `GET https://chatgpt.com/backend-api/wham/usage` HTTP 直连作为保底：

- 鉴权：读 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`），仅 `auth_mode === "chatgpt"` 取 `tokens.access_token` 作 `Authorization: Bearer {token}`；API key 模式 / 文件缺失 / 结构异常 MUST 放弃回退。不实现 refresh、不读 Keychain。
- headers：`User-Agent: codex-cli`（写死，后端据此认 Codex 客户端）、`Accept: application/json`；`tokens.account_id` 存在时追加 `ChatGPT-Account-Id`。
- 解析：响应下划线风格 `rate_limit.{primary_window, secondary_window}.{used_percent, limit_window_seconds, reset_at}`，MUST 按 `limit_window_seconds` 认桶（18000→5h、604800→7d），不假设 primary/secondary 顺序；某窗缺 `used_percent` 跳过、不阻断另一窗。`reset_at` 为 Unix 秒。
- 超时 15s。
- **代理**：wham 请求 SHALL 经 ccus 统一的 env 代理通道——读 `https_proxy` / `HTTPS_PROXY`（https 目标）、`http_proxy` / `HTTP_PROXY`（http 目标）、`all_proxy` / `ALL_PROXY`（兜底，**小写优先**）；有代理则给请求挂对应 agent（`https-proxy-agent` / `http-proxy-agent`）。`NO_PROXY` / `no_proxy` 匹配的主机、或无任何代理变量时 MUST 直连。另设 ccus 专属变量 `CCUS_PROXY`：单一值同时管 https / http 目标、SHALL 优先于上述标准变量，但仍受 `NO_PROXY` 约束。该代理通道 SHALL 复用于 ccus 所有出站额度 HTTP 请求（含 api-mode 智谱 / custom 拉取），非 codex 专属。
- `error`（超时 / RPC 错 / 进程崩）MUST NOT 触发 wham 回退，避免瞬时故障多扛一次 HTTP。

回退成功拿到的额度照常进 `codex-quota-cache.json` 与下游 `source="codex"` 分流。

#### Scenario: RPC 成功解析双窗口

- **WHEN** app-server 对 `account/rateLimits/read` 返回 `primary.usedPercent=42`、`secondary.usedPercent=18`
- **THEN** ccus 得到 5h=42、7d=18，落进 `rate_limits.five_hour` / `rate_limits.seven_day`

#### Scenario: RPC 按 windowDurationMins 认桶（顺序无关）

- **WHEN** app-server 把周额度放在 `primary`（`windowDurationMins=10080, usedPercent=18`）、5h 放在 `secondary`（`windowDurationMins=300, usedPercent=42`）
- **THEN** ccus 按 `windowDurationMins` 认桶得到 5h=42、7d=18，不因 primary/secondary 顺序互换而错位

#### Scenario: Codex 未安装且 wham 回退成功

- **WHEN** spawn `codex` 返回 ENOENT（`unavailable`），`~/.codex/auth.json` 为 `auth_mode="chatgpt"` 且 token 有效，wham/usage 返回 `primary_window.limit_window_seconds=18000, used_percent=30`、`secondary_window.limit_window_seconds=604800, used_percent=12`
- **THEN** ccus 经 wham 回退得到 5h=30、7d=12，照常落盘 `source="codex"` 事件

#### Scenario: wham 按 limit_window_seconds 认桶（顺序无关）

- **WHEN** wham 返回的 `secondary_window` 是 5h 桶（`limit_window_seconds=18000`）、`primary_window` 是 7d 桶（`limit_window_seconds=604800`）
- **THEN** ccus 仍正确认出 5h / 7d，不因 primary/secondary 顺序互换而错位

#### Scenario: 无 OAuth token 不回退

- **WHEN** spawn 返回 `unavailable`，但 `auth.json` 缺失 / `auth_mode != "chatgpt"` / 结构异常
- **THEN** 不走 wham 回退，回退旧缓存 / null，静默不落空事件

#### Scenario: 代理环境经代理通道回退

- **WHEN** spawn 返回 `unavailable`，ccus `process.env` 含 `HTTPS_PROXY=http://127.0.0.1:7890`，`~/.codex/auth.json` 有 chatgpt token
- **THEN** wham 请求经代理通道发往 chatgpt.com 并回退采到额度，不走直连

#### Scenario: NO_PROXY 命中则直连

- **WHEN** env 含 `HTTPS_PROXY` 但 `NO_PROXY=chatgpt.com`
- **THEN** wham 请求绕过代理直连 chatgpt.com

#### Scenario: CCUS_PROXY 优先于标准代理变量

- **WHEN** env 同时含 `CCUS_PROXY=http://10.0.0.1:8080` 与 `https_proxy=http://127.0.0.1:7890`
- **THEN** wham 请求经 `CCUS_PROXY` 指定的代理（`10.0.0.1:8080`）发出，不用标准 `https_proxy`

#### Scenario: CCUS_PROXY 受 NO_PROXY 约束

- **WHEN** env 含 `CCUS_PROXY` 且 `NO_PROXY=chatgpt.com`
- **THEN** wham 请求绕过 `CCUS_PROXY` 直连 chatgpt.com

#### Scenario: error 不触发 wham 回退

- **WHEN** spawn `codex` 成功但 app-server 超时 / RPC 错（`error`）
- **THEN** 不走 wham 回退，直接回退旧缓存 / null

#### Scenario: 字段缺失

- **WHEN** app-server 返回的 `primary` 或 `secondary` 缺 `usedPercent`
- **THEN** 对应窗口计为 null，不阻断另一窗口

### Requirement: 范围限定 Codex CLI

Codex 额度采集的**触发点** SHALL 仅依赖 Codex CLI：`notify`（config.toml）或 `Stop` hook（hooks.json）——二者都是 CLI 能力，Codex 桌面版 app（已并入 ChatGPT 桌面 app）的 GUI 不必然触发。**额度拉取通道**有两条：主路径 spawn `codex` CLI 二进制走 app-server RPC；当本机无 `codex` 二进制（spawn ENOENT）时，走 wham/usage HTTP 回退（读 `~/.codex/auth.json` OAuth token，经统一 env 代理通道）。即：额度账号级存在、ccus 可借 auth.json 直连后端取，但「何时采」仍由 CLI 的 notify/Stop 决定——桌面 app 缺触发点，故不在范围。

#### Scenario: CLI 正常触发

- **WHEN** 用户经 Codex CLI 完成一个 turn 且 hook / notify 已装
- **THEN** ccus 被调起、采集发生

#### Scenario: 无 codex 二进制但装了 hook

- **WHEN** 用户装了 ccus codex hook（`notify` / `Stop`）但本机 spawn `codex` 返回 ENOENT（如 codex 未入 PATH / 已卸载留 hook+auth.json），`~/.codex/auth.json` 有 `auth_mode="chatgpt"` token
- **THEN** ccus 被 CLI 触发点调起，主路径 `unavailable` 后走 wham 回退采到额度

#### Scenario: 桌面 app 不在范围

- **WHEN** 用户仅在 Codex 桌面版 app 活动（未装 CLI、未装 hook）
- **THEN** ccus 不被调起、不采集，本期不视为缺陷
