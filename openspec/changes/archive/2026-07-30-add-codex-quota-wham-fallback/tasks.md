## 1. httpRequest 统一加 env 代理支持

- [x] 1.1 `npm i https-proxy-agent http-proxy-agent`（ccus 首个运行时依赖），确认 `package.json` 的 `dependencies` 字段写入（完成判据：`npm ci` 能装、`npm run build` 通过）
- [x] 1.2 在 `src/lib/api-mode.ts` 新增 env 代理解析：https 目标读 `https_proxy`→`HTTPS_PROXY`→`all_proxy`→`ALL_PROXY`，http 目标读 `http_proxy`→`HTTP_PROXY`→`all_proxy`→`ALL_PROXY`，小写优先；`NO_PROXY`/`no_proxy` 匹配的主机直连；无代理变量返回 null（完成判据：纯函数，可单测）
- [x] 1.3 `httpRequest` 接入代理：有代理则给 `http.request`/`https.request` 挂对应 agent（`HttpsProxyAgent`/`HttpProxyAgent`），无则维持默认 globalAgent；行为对无代理环境零变化
- [x] 1.4 把 `httpRequest` 提为 export，供 codex-fetcher 复用
- [x] 1.5 单测：有 `https_proxy` 走代理（断言请求经代理）；`NO_PROXY` 命中直连；无代理维持现状；小写优先于大写；智谱与 custom 请求也走代理
- [x] 1.6 `CCUS_PROXY` 专属变量：单一值优先于 `https_proxy`/`http_proxy`/`all_proxy`，同时管 https / http 目标，仍受 `NO_PROXY` 约束（完成判据：`resolveProxyUrl` 纯函数分支 + 单测覆盖「优先于标准变量」「`NO_PROXY` 命中时绕过」）

## 2. auth.json 读取

- [x] 2.1 在 `src/lib/codex-fetcher.ts` 新增 auth.json 读取：`$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`，复用 `getCodexHome`），解析 `{ auth_mode, tokens: { access_token, account_id }, last_refresh }`，仅 `auth_mode === "chatgpt"` 返回 `{ accessToken, accountId } | null`（完成判据：缺文件 / API key 模式 / 结构异常均返回 null，不抛错）
- [x] 2.2 单测：chatgpt 模式取到 token、API key 模式返回 null、文件缺失返回 null、`tokens` 字段缺失返回 null

## 3. wham/usage 回退拉取

- [x] 3.1 新增 `fetchCodexQuotaViaWham(options)`：读 auth.json → 无 token 直接返回 `error` 占位（不阻塞编排）→ 否则 `GET wham/usage`（headers `Authorization: Bearer {token}` / `User-Agent: codex-cli` / `Accept: application/json`、可选 `ChatGPT-Account-Id`，超时 15s）经 `httpRequest`（自带代理）→ 专用 `parseWhamUsage` 认桶（完成判据：返回 `CodexFetchOutcome`，与 `fetchCodexQuota` 同构）
- [x] 3.2 `parseWhamUsage`：解析 `rate_limit.{primary,secondary}_window`，按 `limit_window_seconds` 认桶（18000→5h、604800→7d），某窗缺 `used_percent` 跳过，`reset_at` Unix 秒转毫秒；两窗都缺返回全 null
- [x] 3.3 全程不抛错：HTTP 失败 / 非 2xx / JSON 异常 / 解析空 → 返回 `{ status: "error", fiveHour: null, sevenDay: null, resetsAt: null }`，`debugLog` 到 stderr
- [x] 3.4 单测：wham 成功解析双窗、按 `limit_window_seconds` 认桶（primary/secondary 互换）、某窗缺字段、HTTP 401、超时、auth.json 无 token

## 4. resolveCodexQuota 编排回退

- [x] 4.1 在 `resolveCodexQuota` 主 fetcher 返回 `status === "unavailable"` 且无新鲜缓存时调 `fetchCodexQuotaViaWham`；其结果 `ok` 且有数据则写缓存返回，否则继续走原「旧缓存 → null」路（完成判据：`error` 不触发回退、仅 `unavailable` 触发）
- [x] 4.2 `fetchCodexQuotaViaWham` 支持测试注入（`options.whamFetcher` 或复用 `options.fetcher` 之外的新注入点），与现有 `options.fetcher` 对称
- [x] 4.3 单测：`unavailable` + wham ok → 返回 wham 额度并写缓存；`unavailable` + wham 失败 → 回退旧缓存 / null；`error` → 不调 wham；缓存新鲜 → 既不调 wham 也不调 app-server

## 5. 文档与验证

- [x] 5.1 `CLAUDE.md`：`codex-fetcher.ts` 小节补 wham 回退（触发条件仅 `unavailable`、auth.json 读取、按 `limit_window_seconds` 认桶、auth.json 结构易碎）；`api-mode.ts` 小节补统一 env 代理支持（读取规则、`https-proxy-agent`/`http-proxy-agent`、破零依赖标注）
- [x] 5.2 `README.md`：Codex 采集章节补 wham 回退说明；额度 / Codex 相关处补「统一走 env 代理」一句话（简述，不展开实现）
- [x] 5.3 跑 `npm run test:src` 与 `npm run build`；手动 smoke（有条件时）：临时让 spawn codex ENOENT + 放一份 chatgpt 模式 auth.json，确认回退采到额度；带 `HTTPS_PROXY` 跑一次确认 wham / 智谱经代理
