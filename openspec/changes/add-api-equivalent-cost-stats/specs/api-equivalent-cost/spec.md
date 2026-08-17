## Purpose

为 Claude 与 Codex 本地用量提供可审计、可聚合的标准 API 等效成本估算，并明确价格时点、未知模型和对外导出语义。

## ADDED Requirements

### Requirement: 按请求计算等效 API 成本
系统 SHALL 按单次模型请求的来源、模型、发生时间和计费 token 分类计算美元成本，不得先把多次请求汇总后再应用请求级价格规则。

Claude 请求 SHALL 分别计算输入、输出、缓存读取和缓存写入 token；缓存写入 SHALL 按 5 分钟与 1 小时 TTL 拆成两个计价桶。Codex 请求 SHALL 分别计算净输入、缓存输入和输出 token，不得再次从净输入扣除缓存输入。推理 token 已包含在输出 token 时不得重复计费。

#### Scenario: Claude 已知模型请求
- **WHEN** Claude 请求包含可识别模型及输入、输出、缓存读取、缓存写入 token
- **THEN** 系统按该请求发生时间匹配输入、输出、缓存读取及两种 TTL 缓存写入单价计算成本

#### Scenario: Codex 已知模型请求
- **WHEN** Codex 请求包含可识别模型、净输入、缓存输入和输出 token
- **THEN** 系统分别应用输入、缓存输入和输出单价且不重复扣减缓存输入

#### Scenario: Claude 缓存写入缺少 TTL 明细
- **WHEN** Claude 请求只提供缓存写入总量而没有 5 分钟与 1 小时 TTL 明细
- **THEN** 系统按 Claude 默认 5 分钟缓存写入价格计算该总量

#### Scenario: 请求触发长上下文价格
- **WHEN** 单次请求满足价格目录定义的长上下文条件
- **THEN** 系统只对该请求应用对应价格规则，不因同日累计 token 超过阈值而改变其它请求价格

### Requirement: 使用本地版本化价格目录
系统 SHALL 使用随 ccus 发布的本地价格目录。全部模型价格 SHALL 集中存储在单个 JSON 文件中。价格项 SHALL 标识来源、规范模型、生效区间和各 token 分类单价；同一来源与规范模型的生效区间不得重叠。导出 SHALL 记录价格目录版本和 `event-time-standard-api` 计价基准。

#### Scenario: 更新模型价格
- **WHEN** 维护者新增模型或调整价格生效区间
- **THEN** 只需更新价格目录 JSON，不需要修改计价代码

#### Scenario: 历史请求选择价格
- **WHEN** 同一模型在不同时间存在多份价格项
- **THEN** 系统按请求发生时间选择生效区间匹配的价格

#### Scenario: 离线统计
- **WHEN** 设备无法访问网络
- **THEN** 系统仍使用内置价格目录完成统计且不发起价格查询请求

#### Scenario: 无生效价格
- **WHEN** 模型已归一化但请求时间没有匹配的价格项
- **THEN** 系统把该请求标记为未定价且不套用其它模型价格

#### Scenario: 价格生效区间重叠
- **WHEN** 价格目录中同一来源与规范模型存在重叠生效区间
- **THEN** 价格目录校验失败且不得用于成本统计

### Requirement: 显式报告定价覆盖度
每个来源及合计结果 SHALL 包含 `estimatedUsd`、`pricedApiRequestCount` 和 `unpricedApiRequestCount`。每个来源的两类请求数之和 SHALL 等于该来源 `apiRequestCount`；`total` 的请求数和金额 SHALL 由 Claude 与 Codex 来源结果相加。未知模型请求不得从覆盖度分母中删除。存在已定价请求时，`estimatedUsd` SHALL 为已知成本小计；全部请求均未定价时 SHALL 为 null；没有请求时 SHALL 为 0。

#### Scenario: 部分请求模型未知
- **WHEN** 统计范围同时包含已定价请求和未定价请求
- **THEN** 系统返回已知成本小计及两类请求数，展示层以不低于该金额的语义提示结果不完整

#### Scenario: 全部请求无法定价
- **WHEN** 范围内有请求但没有任何请求可匹配价格
- **THEN** `estimatedUsd` 为 null 且 `unpricedApiRequestCount` 大于 0

#### Scenario: 空白日期
- **WHEN** 某个枚举日期没有模型请求
- **THEN** `estimatedUsd` 为 0 且两个请求数均为 0

#### Scenario: 来源结果合并
- **WHEN** Claude 与 Codex 均有请求
- **THEN** total 的两类请求数分别等于两个来源对应请求数之和，金额为可定价来源的已知成本小计

### Requirement: bundle v10 导出成本
`ccus export` SHALL 以 `schemaVersion: 10` 导出。bundle 顶层 SHALL 包含价格目录版本、币种和计价基准；`weeklySummary` 与每个 `dailySummaries` 条目 SHALL 包含 `apiEquivalentCost`，并分别提供 Claude、Codex 和两者合计结果。

#### Scenario: 导出包含完整成本元数据
- **WHEN** 用户执行 `ccus export`
- **THEN** 周汇总与每日汇总包含来源级及合计成本和覆盖度，顶层包含价格目录元数据

#### Scenario: 周汇总与每日汇总一致
- **WHEN** 导出范围覆盖完整一周
- **THEN** 周级成本和覆盖度等于该周每日结果之和

### Requirement: aggregate 向后兼容并按 token 去重路径聚合成本
`ccus aggregate` SHALL 接受 schemaVersion 6、7、8、9、10。v10 成本 SHALL 沿用 token 的日级代表选择与周级上卷路径；v6 至 v9 存在请求时成本 SHALL 视为不可用，不得回退为零，没有请求时成本 SHALL 为 0。

#### Scenario: 聚合 v10 bundle
- **WHEN** 输入包含同人多机或重复导出的 v10 bundle
- **THEN** daily 与 weekly 成本沿用对应 token 行的去重和叠加结果，不从 detail 行求和

#### Scenario: 聚合旧版 bundle
- **WHEN** 输入只包含 schemaVersion 6 至 9 的 bundle
- **THEN** token 与 usage 继续正常聚合，旧版 `apiRequestCount` 全部计入未定价请求；存在请求时成本为不可用，没有请求时成本为 0，价格目录版本均为不可用

#### Scenario: 旧版与 v10 混合聚合
- **WHEN** 同一聚合行同时使用 schemaVersion 6 至 9 与 v10 bundle
- **THEN** 系统保留 v10 已知成本小计，把旧版请求计入未定价请求；旧版存在请求时将 `pricingCatalogVersion` 标记为 `mixed` 并把结果显示为不完整，旧版没有请求时不影响 v10 价格目录版本与完整性

#### Scenario: 混合价格目录版本
- **WHEN** 同一聚合行使用的 v10 bundle 具有不同价格目录版本
- **THEN** 输出把 `pricingCatalogVersion` 标记为 `mixed`

### Requirement: daily 与 weekly CSV 暴露合计成本
`daily.csv` 与 `weekly.csv` SHALL 在列尾增加 `estimatedApiEquivalentCostUsd` 和 `pricingCatalogVersion` 列，金额单位为美元。定价覆盖度请求数 SHALL 保留在 bundle 与 dashboard，不得写入 CSV。

#### Scenario: 生成聚合 CSV
- **WHEN** 用户执行 `ccus aggregate`
- **THEN** daily 与 weekly 行末包含合计成本和价格目录版本，不包含 `pricedApiRequestCount` 或 `unpricedApiRequestCount`；金额最多保留 6 位小数且 null 写空，只有旧版输入时价格目录版本写空

### Requirement: detail CSV 保持事件明细契约
`detail.csv` SHALL 保持原有事件与日级 token 列集合，不得增加合计成本、定价覆盖度或价格目录版本列。

#### Scenario: 生成 detail CSV
- **WHEN** 用户聚合包含成本的 v10 bundle
- **THEN** detail 行只包含事件指标和所属自然日的 token，不包含 `estimatedApiEquivalentCostUsd`、`pricedApiRequestCount`、`unpricedApiRequestCount` 或 `pricingCatalogVersion`

### Requirement: dashboard 展示等效成本及覆盖度
个人 dashboard 与 aggregate dashboard SHALL 使用与导出相同的价格目录和成本语义。存在未定价请求时 SHALL 显示结果不完整；全部无法定价时 SHALL 显示不可用。

#### Scenario: 个人 dashboard 显示成本
- **WHEN** 当前范围包含至少一个已定价请求
- **THEN** dashboard 在顶部统计区将合计成本作为第 5 张卡片展示，同时显示合计未定价请求数，不显示 Claude、Codex 来源分项

#### Scenario: 多人 dashboard 显示成本
- **WHEN** aggregate serve 加载 v10 bundle
- **THEN** 总览、人员汇总和周表展示按对应聚合行计算的成本，顶部总览保持单行且不显示 Total API requests 独立卡片，合计成本卡排在 Peak 7d usage 后；“多人对比”表不显示 API 请求列，请求数仍保留在周表、每日矩阵、成本覆盖度和导出契约中

#### Scenario: dashboard 链接独立当前价格页
- **WHEN** 生成个人或多人 dashboard
- **THEN** 看板正文不内联价目表，合计等效 API 成本卡下通过新页面链接 `pricing.html`，独立页面只显示一套标题，按生成时间展示价格目录有效区间内的普通与长上下文价格，标明 USD / 百万 token、目录版本和生效时间，并把 Codex 排在 Claude 前且按模型版本从新到旧排列

#### Scenario: 静态与服务模式访问价格页
- **WHEN** 用户通过 dashboard build/open、dashboard serve 或 aggregate serve 查看看板
- **THEN** `pricing.html` 链接均可打开；静态模式在看板同目录写文件，服务模式响应 `/pricing.html`
