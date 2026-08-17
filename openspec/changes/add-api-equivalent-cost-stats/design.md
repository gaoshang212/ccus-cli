## Context

Claude transcript 已提供每次 assistant 请求的模型与 usage，但 ccus 只累计输入、输出和缓存读取。Codex rollout 已提供 token 增量和可变化的模型上下文，但当前解析器只累计净输入、输出和缓存输入。现有 bundle v9 不包含成本或价格元数据。

价格会随模型和时间变化。部分长上下文规则按单次请求判断，不能在日级或周级 token 汇总后计算。ccus 保持本地优先，statusline 路径不得增加网络访问。

## Goals / Non-Goals

**Goals:**

- 用同一套请求级计价核心处理 Claude 与 Codex。
- 保留现有 token 口径和多机去重语义。
- 让成本结果可解释、可复现，并显式呈现未知模型。

**Non-Goals:**

- 不模拟真实订阅账单、税费、批处理、区域、优先服务或企业折扣。
- 不估算 Web 搜索、代码执行等工具附加费用。
- 不运行时拉取远程价格。

## Decisions

### 1. 建立统一的请求级计价模型

新增独立价格模块，接收规范化的请求：

```text
timestamp + provider + model
+ inputTokens + outputTokens
+ cacheReadInputTokens
+ cacheWrite5mInputTokens + cacheWrite1hInputTokens
```

模块先校验同一来源与规范模型的价格生效区间不重叠，再按来源归一化模型、按事件时间选择价格项，最后对单次请求应用普通或长上下文规则。计算过程保留完整浮点精度；CSV 最多保留 6 位小数，页面金额少于 0.01 美元显示四位，其余显示两位。

Claude usage 的输入与缓存字段彼此独立。若日志只提供总缓存写入而没有 TTL 明细，按 Claude 默认 5 分钟写入计价。Codex rollout 的 `cached_input_tokens` 是 `input_tokens` 的子集；扫描器先按 `max(0, input_tokens - cached_input_tokens)` 派生净输入，再把净输入、缓存输入和输出交给价格模块，价格模块不二次扣减。

备选方案是复用 orca 的日级聚合后计价。该方案会让长上下文结果随聚合边界变化，因此不采用。

### 2. 价格目录静态内置并带生效区间

价格目录由单个 `src/lib/api-pricing-catalog.json` 维护，包含 `catalogVersion`、来源、规范模型、生效起止时间、token 分类价格和请求级长上下文规则。TypeScript 只负责类型、校验、模型归一化和计价。构建产物与 npm 发布包都携带该 JSON；每次更新价格目录同时更新版本和测试。

采用事件时间价格，确保历史周报不会因升级后重新导出而被当前价格追溯改写。备选的“全部历史套当前价”实现简单，但不可复现且无法正确处理限时价格，因此不采用。

### 3. 扩展扫描结果而不持久化分析字段到 statusline 日志

`claude.ts` 在遍历 assistant usage 时同步生成请求级成本结果和按日结果，并统计缓存写入。`codex-sessions.ts` 在解析 rollout 时维护当前模型，把每个有效 `last_token_usage` 关联到模型后计价。

模型归属数据来自 transcript 与 rollout，不写入 `PersistedStatuslineEvent`，保持 raw-first 日志契约。statusline 的 `modelName` 只用于事件展示，不参与 token 计价。

### 4. 用成本结果和覆盖度组成稳定值对象

内部和 bundle 共用：

```text
ApiEquivalentCostResult
  estimatedUsd: number | null
  pricedApiRequestCount: number
  unpricedApiRequestCount: number
```

每个来源的已定价与未定价请求数之和必须等于该来源 API 请求数，`total` 逐项合并两个来源。`weeklySummary.apiEquivalentCost` 与 `dailySummaries[].apiEquivalentCost` 均包含 `claude`、`codex`、`total` 三个结果。bundle 顶层增加：

```text
pricing
  catalogVersion
  currency: "USD"
  basis: "event-time-standard-api"
```

只要存在已定价请求，金额就是已知小计；存在未定价请求时 UI 显示为不低于该金额。这样既不丢失已知成本，也不把部分结果伪装成完整总额。

### 5. bundle 升至 v10，aggregate 对旧版本返回不可用

导出 schemaVersion 升至 10。aggregate 显式接受 6 至 10；6 至 9 缺少成本时使用 null 状态，不合成 0。v10 成本随 token 使用相同的代表选择与周级上卷路径，避免重复导出或 detail 展开造成翻倍。

daily/weekly CSV 仅在列尾写合计金额和价格目录版本，金额最多保留 6 位小数，null 写空；已定价与未定价请求数不写入 CSV，仍保留在 bundle 与 dashboard。detail CSV 保持原有事件与日级 token 列集合，不写成本、覆盖度或目录版本。只有 v6 至 v9 输入时，所有旧版 API 请求计入内部未定价请求：存在请求时金额为空，没有请求时金额为 0，`pricingCatalogVersion` 均为空。旧版与 v10 混合时，只有旧版实际贡献请求才把目录版本写 `mixed` 并标记不完整；多个 v10 目录版本混合时也写 `mixed`。不新增来源级 CSV 列，来源拆分保留在 bundle 和 dashboard。

### 6. 两类 dashboard 共用汇总语义

个人 dashboard 的数据加载保留 Claude/Codex 成本汇总，但页面只展示 `total` 合计，不展示来源分项。合计成本并入顶部统计区作为第 5 张卡片，价格目录说明紧随顶部卡片区。多人 dashboard 从聚合 daily/weekly 行读取成本，顶部总览不展示 Total API requests 独立卡片，使剩余 6 张卡保持单行；合计成本卡排在 `Peak 7d usage` 后。“多人对比”表也不展示独立的 API 请求列，请求数仍保留在周表、每日矩阵、成本覆盖度和导出契约中。两个看板正文不内联价目表，在合计成本卡下统一链接 `pricing.html`，链接使用 `target="_blank"` 和 `rel="noopener noreferrer"` 在新页面安全打开。独立页面只保留一套主标题，按生成时间展示有效价格；Codex 排在 Claude 前并按模型版本从新到旧排列，普通与长上下文价格分别成行，单位统一为 USD / 百万 token。dashboard build/open 在看板同目录写出该文件；dashboard serve 与 aggregate serve 响应 `/pricing.html`。页面金额少于 0.01 美元显示四位小数，其余显示两位；有已知成本和未定价请求时显示不低于已知金额，只有未定价请求时显示不可用。

## Risks / Trade-offs

- [模型命名继续演化] → 未知模型不使用模糊默认价；新增别名和测试后再纳入已定价范围。
- [价格目录过期] → 版本化目录并在发布时更新来源；不以运行时联网换取新鲜度。
- [Claude 缓存写入缺少 TTL 明细] → 优先读取 TTL 明细；仅有总量时明确按默认 5 分钟价格估算。
- [历史 v6 至 v9 无法补算成本] → aggregate 显示不可用，要求重新执行 export 生成 v10。
- [不同 ccus 版本混合聚合] → CSV 标记 `mixed`，dashboard 提示价格目录不一致。

## Migration Plan

1. 发布包含价格目录、请求级扫描和 v10 类型的版本。
2. export 从发布时开始生成 v10；本地 statusline 日志无需迁移。
3. aggregate 同时接受 v6 至 v10，旧 bundle 继续提供原统计但不提供成本。
4. 需要历史成本时，用户用新版本对仍在本机的 transcript 和 rollout 重新导出。
5. 回滚时仍可读取既有 v6 至 v9；旧版 ccus 不保证读取 v10，需重新导出兼容版本或恢复新版本。
