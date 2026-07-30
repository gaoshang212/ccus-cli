## Context

`resolveCodexQuota`（`codex-fetcher.ts`）当前只走 spawn `codex app-server`。`fetchCodexQuota` 把 ENOENT 归为 `unavailable`、其它失败归为 `error`；`resolveCodexQuota` 末尾统一回退旧缓存、全失败返回 null。本机无 codex CLI 时额度彻底空。

`docs/research/cc-switch-codex-quota.md` 调研了 cc-switch 的另一条路径：HTTP 直连 `https://chatgpt.com/backend-api/wham/usage`，用 Codex OAuth `access_token` 鉴权、`User-Agent: codex-cli` 让后端认 Codex 客户端，返回下划线风格 `rate_limit` 结构、按 `limit_window_seconds`（18000 / 604800）自描述认桶。其第 8 节给出了把它作为 ccus「无 codex 命令」回退的设计，本 change 据此落地。

Node 原生 `http`/`https` 模块不读 `HTTP_PROXY` / `HTTPS_PROXY` 等环境变量——这是现有 `codex-usage` spec「主路径 MUST NOT Node 直连」的根因，也是 wham 回退与 api-mode 在代理环境失效的原因。本 change 同时解决这层：给 `httpRequest` 统一加 env 代理支持。

## Goals / Non-Goals

**Goals:**

- 本机无 codex CLI（`unavailable`）且无新鲜缓存时，改走 wham/usage 拿到同账号的 Codex 额度。
- 复用现有缓存 / 落盘 / source 分流管线，零契约改动、不 bump `schemaVersion`。
- 解析按 `limit_window_seconds`（秒）认桶，与主路径 `windowDurationMins`（分钟）认桶同构、互相印证。
- 统一给 ccus 出站额度 HTTP 请求（wham 回退 + 智谱 / custom）加 env 代理支持，代理用户的 wham 保底与 api-mode 真正可用。

**Non-Goals:**

- 不实现 OAuth refresh（要 Keychain + refresh_token，成本高于收益；token 过期即降级）。
- 不碰 macOS Keychain（文件源 `auth.json` 已够）。
- 不替代主路径——codex CLI 可用时仍走 app-server（更快、不碰 OAuth）。
- 不支持 SOCKS 代理（`https-proxy-agent` / `http-proxy-agent` 只覆盖 http/https 代理；SOCKS 留后续）。
- `error`（超时 / RPC 错）不触发回退。

## Decisions

### 决策 1：触发条件仅限 unavailable

只在 `fetchCodexQuota` 返回 `status === "unavailable"` 且无新鲜缓存时进入 wham 回退。`error`（超时 / RPC 错 / 进程崩）不触发——瞬时故障不该再扛一次 15s HTTP，且 `error` 多半意味着 codex 装着但有问题，wham 未必更好。回退失败仍走原有「旧缓存 → null」路。

### 决策 2：token 只读 auth.json，不刷新不碰 Keychain

读 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`），结构 `{ auth_mode, tokens: { access_token, account_id }, last_refresh }`（对齐 cc-switch 文件源，跨平台）。仅 `auth_mode === "chatgpt"` 取 `tokens.access_token`；API key 模式 / 文件缺失 / 结构异常 → 放弃回退。距 `last_refresh` > 8 天仍试（token 多半仍有效）、失败静默。不实现 refresh、不读 Keychain——refresh 要 Keychain + refresh_token，收益不抵成本与跨平台风险。

### 决策 3：按 limit_window_seconds 认桶，专用 parser

wham 响应 `rate_limit.{primary_window, secondary_window}`，每窗 `{ used_percent, limit_window_seconds, reset_at }`。**不假设哪个 window 是 5h / 7d**，按 `limit_window_seconds` 自描述认桶（18000→5h、604800→7d），绕开「某窗 used_percent 缺失或 reset 顺序异常致 5h/7d 互换」——主路径 0.2.3（commit 07eb6f7）已因同样问题改成按 `windowDurationMins` 认桶，wham 按 `limit_window_seconds` 认桶是同一思想的回退侧（一个分钟、一个秒，等价）。写专用 `parseWhamUsage`（仿现有 `parseRateLimitsResult`），不走 extractor 脚本：响应结构固定、不需用户可配，专用 parser 类型安全、好测、无 `new Function` 开销。

### 决策 4：统一走 env 代理（加 npm 依赖）

wham 走 ccus 自身 Node `http`/`https`。Node 原生模块**不读代理 env**——这是现有 spec「主路径 MUST NOT Node 直连」的根因，也是 wham / api-mode 在代理环境失效的原因。本期**不给 wham 单独加代理，而是给 `httpRequest`（api-mode.ts）统一加 env 代理支持**，一处生效、三个调用方（wham + 智谱 + custom）统一受益。

- env 读取规则（对齐 curl / `proxy-from-env`）：https 目标读 `https_proxy` → `HTTPS_PROXY` → `all_proxy` → `ALL_PROXY`；http 目标读 `http_proxy` → `HTTP_PROXY` → `all_proxy` → `ALL_PROXY`。**小写优先**。`NO_PROXY` / `no_proxy` 匹配的主机直连。无代理变量维持现状直连。
- `CCUS_PROXY`：ccus 专属扩展（curl / `proxy-from-env` 均无），单一值同时管 https / http 目标、优先于上述标准变量，仍受 `NO_PROXY` 约束。动机：团队常有「只想让 ccus 走某代理、不污染系统其它工具 env」的需求，放一个 ccus 独有变量比覆盖标准变量更可控。
- agent 选型：装 `https-proxy-agent`（https 目标）+ `http-proxy-agent`（http 目标），成熟、覆盖代理鉴权 / 超时 / TLS / 错误全套。有代理则给 `http.request` / `https.request` 挂对应 agent，否则用默认 globalAgent。
- 这**引入 ccus 首个运行时依赖**——ccus 至今 `dependencies` 为空是刻意保持的卖点，本次破例。权衡：代理用户（团队主要场景）的 wham 保底与 api-mode 才真正可用，收益大于「零依赖」的形式纯洁。
- 否决的替代：① 手写 `net`+`tls` CONNECT 隧道（零依赖）——约 150 行、要覆盖代理鉴权 / 错误 / 超时 / NO_PROXY，正确性风险高；② esbuild bundle 后 vendor——要给纯 tsc 构建链加 bundler，性价比最低。

### 决策 5：代码组织——回退放 codex-fetcher.ts，复用加了代理的 httpRequest

新增 `fetchCodexQuotaViaWham` 放 `codex-fetcher.ts`（与 `fetchCodexQuota` 内聚，auth.json 是 codex 专属职责），由 `resolveCodexQuota` 编排。HTTP 请求复用 api-mode 的 `httpRequest`（提为 export，且已带决策 4 的代理支持）；wham 用专用 parser 不走 extractor 脚本。回退拉到的额度进同一份 `codex-quota-cache.json`，下游 `recordCodexEvent` / `applyQuotaToPayload` 零改动。

### 决策 6：缓存与下游零侵入

wham 回退拿到的也是 `{ fiveHour, sevenDay, resetsAt }`，照常进 `codex-quota-cache.json`（5min TTL，下次命中秒回），照常经 `applyQuotaToPayload` 填 `rate_limits`、`source="codex"` 落盘。`cli.ts` 的 `recordCodexEvent` 完全不动。

## Risks / Trade-offs

- **wham 是 ChatGPT 后端内部端点，比 app-server 更易碎** → URL / 字段 / 反爬随版本变。Mitigation：解析极度宽松、字段缺失返回 null、失败静默回退缓存；CLAUDE.md 标注。
- **auth.json 结构随 Codex 升级变** → 假设对齐 cc-switch 当前版本。Mitigation：多结构兜底解析、缺字段放弃回退、不抛错。
- **破「零运行时依赖」现状** → `dependencies` 首次非空。Mitigation：选成熟、轻量、单一职责的 `https-proxy-agent` / `http-proxy-agent`，依赖链浅；不接受手写隧道带来的正确性风险。
- **代理 env 规则与 curl/系统工具有细微差异** → 大小写优先级、NO_PROXY 匹配口径若不一致可能该走代理时直连（或反之）。Mitigation：严格对齐 curl / `proxy-from-env` 的既有规则，单测覆盖。
- **触发 / 范围张力** → 现有 spec「范围限定 Codex CLI」「Codex 未安装→静默」均因回退调整。Mitigation：spec delta 明确「触发仍依赖 CLI notify/Stop，仅额度拉取多一条 HTTP 回退」。

## Open Questions

- wham 请求超时 15s（cc-switch 口径）是否合适？notify/Stop 是同步等待，15s 可能拖累交互。倾向：缓存命中秒回是常态，过期才触发且仅 unavailable 时，15s 可接受；实现时验证。
- auth.json 的 `tokens` 字段是否需多结构兜底（如 `access_token` 在顶层）？倾向：先按 cc-switch 结构 `{ tokens: { access_token } }`，实现时遇真实样本再补 fallback。
