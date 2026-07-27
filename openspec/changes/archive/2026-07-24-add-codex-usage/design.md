## Context

Codex CLI 没有 Claude Code 那样的 statusline hook（自定义 statusline 命令仍是 feature request openai/codex#17827），但有三条可用通道：

- `notify`：每个 turn 结束 spawn 一个外部程序，argv 传 JSON（含 `thread-id`/`turn-id`/`cwd`，**不含 usage**）。是 Codex 唯一「主动 spawn 外部程序」的入口。
- app-server RPC：`codex -s read-only -a untrusted app-server` 暴露 JSON-RPC，`account/rateLimits/read` 返回 `{ primary, secondary }` 窗口的百分比与重置时间，是 Codex 自身用的官方协议。
- session jsonl：`~/.codex/sessions/*.jsonl` 的 `turn.completed.usage` 带 token 计数（本期不用）。

Orca（stablyai/orca）的 `src/main/rate-limits/codex-fetcher.ts` 已验证 app-server RPC 是拿 Codex 额度的可行主路（它另有 `chatgpt.com/backend-api/wham/usage` 直连与 `/status` PTY 两条 fallback）。本期 ccus 只做额度，token 统计留后续。

## Goals / Non-Goals

**Goals:**
- 以 notify 为触发点采集 Codex 5h / weekly 额度并落盘。
- 复用 api-mode 的额度填充与 storage 落盘，不改契约、不 bump `schemaVersion`。
- spawn codex 时继承 `process.env`，保证代理 / `CODEX_HOME` / config 与用户交互的 Codex 同环境。

**Non-Goals:**
- 不采 Codex 的 token / message / apiRequest 统计（session jsonl，后续 change）。
- 不把 Codex 事件接入 `ccus export` / `ccus aggregate`（后续 change）。
- 不做 `~/.codex/config.toml` notify 行的自动安装（后续，先手动配）。
- 不补 notify 缺失的 `model` 字段（留空，后续从 session 补）。
- 不走 `chatgpt.com/backend-api/wham/usage` 直连（非官方、易碎、Node fetch 不读代理）。
- 不支持 Codex 桌面版 app（已并入 ChatGPT 桌面 app）：`notify` 是 CLI 的 config 特性，桌面 app 不必然触发；桌面 app 也可能不随附独立 `codex` 二进制（spawn 会 ENOENT）、或不共享 `~/.codex/auth.json`。额度本身账号级共享，但触发点断，故留后续 change（候选方案：脱离 notify 的定时轮询 app-server）。

## Decisions

### 决策 1：触发点选 notify

Codex 没有自定义 statusline，可选触发点只有 notify（turn 级 spawn）、hooks.json（工具级，噪声大）、系统调度器（丢 env）。notify 是唯一「由 Codex 主动 spawn、且天然继承 Codex 环境」的入口，频率（每 turn）配 TTL 节流后对额度采样足够，且与 ccus 现有「被宿主 spawn → 落盘」模型对称。

### 决策 2：拉取走 app-server RPC，不走 wham 直连

app-server RPC 是 Codex 自己的协议（`account/rateLimits/read`），比 `chatgpt.com/backend-api/wham/usage` 稳：不碰非官方 backend-api、token 由 codex 进程自己用 `auth.json` 登录、ccus 无需管 OAuth。关键还在于代理——Node 裸 fetch 不读 `HTTP_PROXY`（Orca `claude-fetcher.ts:55` 注释实锤），而 codex（Rust/reqwest）读 env 代理，故只有 spawn codex 这条路在代理环境下能通。

### 决策 3：子进程继承 `process.env`

notify 调起的 ccus 是 Codex 的直接子进程，已继承 Codex 的代理 / `CODEX_HOME` / config。ccus 再 spawn codex app-server 时 `env: { ...process.env }` 再传一层，整条链同环境，代理与虚拟网卡（系统路由）天然生效。

### 决策 4：TTL 缓存节流，不阻塞 Codex

notify 是同步的，Codex 会等 notify 程序返回。额度拉取带 5 分钟 TTL 缓存：命中秒回、不 spawn；过期才 spawn app-server（带 ~10s 超时），失败静默回退旧缓存。模式照搬现有 api-mode 的 `resolveApiQuota`。

### 决策 5：落盘复用管线 + source 标记

额度经 `applyQuotaToPayload` 填进 `rawPayload.rate_limits`（`primary`→`five_hour`、`secondary`→`seven_day`），`appendEvent` 落盘；额外打 `rawPayload.source = "codex"` 供下游区分 Claude / Codex 事件。`computeStatuslineEvent` 读时自动算出 usage，与 api-mode 同理，不 bump `schemaVersion`。

### 决策 6：scope 限定 Codex CLI

`notify`（`~/.codex/config.toml`）与 `codex app-server` 都是 Codex CLI 的能力。Codex 桌面版 app 是 GUI、不必然触发 CLI 的 `notify`（config parity 问题，openai/codex#29156），也不一定随附可被外部 spawn 的 `codex` 二进制。额度虽账号级跨 CLI / 桌面共享，但桌面 app 缺触发点。本期据此把范围限定 CLI；桌面 app 的额度采集留后续，候选方案为脱离 notify 的定时轮询 app-server。

## Risks / Trade-offs

- **app-server 协议随版本变** → `account/rateLimits/read` 的返回结构可能变。Mitigation：解析层宽松、字段缺失返回 null、失败静默；在 `CLAUDE.md` 标注依赖 Codex 内部协议。
- **notify 阻塞 Codex** → 拉取慢会拖累交互。Mitigation：TTL 命中秒回 + spawn 超时 + 失败回退缓存，绝不抛错。
- **Windows argv 大 payload**（Codex #18309）→ `input-messages` 很大时 notify 失败。Mitigation：ccus 仅取 `cwd` / `thread-id`，不依赖大字段；记录该 Codex 侧 bug。
- **Codex 未安装 / 未登录** → spawn 失败。Mitigation：探测失败返回 `unavailable` 状态，静默不落空事件。

## Open Questions

- 额度缓存 TTL 是否复用 api-mode 的 `cacheTtlMs`（默认 5min）还是单独配置？倾向复用，待实现时定。
- 是否在本期顺手做 `ccus install --codex`（写 `~/.codex/config.toml` 的 notify 行）？倾向不做，留后续，先文档说明手动配。
