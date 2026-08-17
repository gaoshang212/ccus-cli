## Why

ccus 已能汇总 Claude 与 Codex 的 token，但无法回答这些用量按标准 API 计费时价值多少。现有汇总缺少模型和 Claude 缓存写入维度，直接用总 token 乘单价会产生明显偏差。

## What Changes

- 从 Claude transcript 和 Codex rollout 按请求提取模型与计费 token，计算美元计价的等效 API 成本。
- 使用带版本和生效区间的本地价格目录；按请求发生时间选择标准同步 API 价格。
- 把全部模型价格集中到单个 JSON 文件，降低价格更新成本。
- 对未知模型保留已知成本小计，并暴露已定价与未定价请求数。
- 在个人 dashboard、bundle 周/日汇总、aggregate daily/weekly CSV 和多人 dashboard 展示成本。
- 为个人与多人 dashboard 提供独立当前价格页，并在合计成本卡下用新页面链接该页面；页面只保留一套标题，Codex 模型按版本从新到旧排列。
- aggregate 的 daily/weekly CSV 仅在末尾输出合计金额和价格目录版本；定价覆盖度保留在 bundle 与 dashboard，`detail.csv` 不增加成本字段。
- **BREAKING**：bundle `schemaVersion` 从 9 升至 10；aggregate 继续兼容 6/7/8/9，旧版本成本按不可用处理。

## Capabilities

### New Capabilities

- `api-equivalent-cost`: 定义请求级成本计算、价格目录、覆盖度、导出、聚合和 dashboard 展示契约。

### Modified Capabilities

- `codex-usage`: Codex sessions 统计新增模型归属和等效 API 成本，并接入 v10 导出与向后兼容聚合。

## Impact

- 影响 `src/lib/claude.ts`、`src/lib/codex-sessions.ts`、新增价格计算模块及对应测试。
- 影响 `src/types.ts`、`src/cli.ts`、`src/lib/export.ts`、`src/lib/aggregate.ts` 和 bundle/CSV 外部契约。
- 影响个人与多人 dashboard，以及 README、AGENTS.md、CHANGELOG.md。
- 不增加运行时网络请求；价格目录随 ccus 版本发布。
