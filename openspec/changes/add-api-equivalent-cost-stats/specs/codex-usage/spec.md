## ADDED Requirements

### Requirement: Codex sessions 按请求归属模型
系统 SHALL 从 Codex rollout 的模型上下文中确定每个 token 增量所属模型，并在模型切换后把后续请求归入新模型。系统 SHALL 将 `cached_input_tokens` 视为 `input_tokens` 的子集，按 `max(0, input_tokens - cached_input_tokens)` 派生净输入，并单列缓存输入。无法确定模型时 SHALL 保留 token 并把请求标记为未定价。

#### Scenario: turn context 提供模型
- **WHEN** rollout 在 token_count 前提供模型上下文
- **THEN** 该 token_count 的净输入、缓存输入和输出 token 归入该模型

#### Scenario: token_count 包含缓存输入
- **WHEN** token_count 同时提供 `input_tokens` 和 `cached_input_tokens`
- **THEN** 系统从 `input_tokens` 扣除缓存输入得到非负净输入，并保留完整缓存输入

#### Scenario: 会话中切换模型
- **WHEN** 同一 rollout 的模型上下文从一个模型切换为另一个模型
- **THEN** 切换前后的 token_count 分别归入各自模型

#### Scenario: token_count 没有模型上下文
- **WHEN** token_count 之前没有可识别模型
- **THEN** token 仍计入总量且该请求计入未定价请求数

#### Scenario: Guardian rollout
- **WHEN** rollout 属于 Guardian 安全审查子代理
- **THEN** 其 token 和成本均不计入 Codex 统计

### Requirement: Codex 等效成本接入 v10 导出
Codex 周级和日级统计 SHALL 向 bundle v10 的 `apiEquivalentCost.codex` 提供已知成本小计、已定价请求数和未定价请求数，且原有消息、请求、token 与额度字段语义不变。

#### Scenario: Codex 已知与未知模型混合
- **WHEN** 导出范围包含可定价和不可定价的 Codex 请求
- **THEN** Codex 成本仅累计可定价请求并准确报告两类请求数

#### Scenario: 旧版聚合兼容
- **WHEN** aggregate 读取 schemaVersion 6 至 9 的 bundle
- **THEN** 原 Codex 统计继续可用；存在 Codex API 请求时成本为不可用，没有请求时成本为 0
