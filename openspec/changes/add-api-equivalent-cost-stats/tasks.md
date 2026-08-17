## 1. 请求级价格核心

- [x] 1.1 在独立模块定义请求计费输入、成本结果和版本化价格目录类型；完成标准是 Claude/Codex 价格项均包含模型、生效区间和 token 分类价格，且重叠区间校验测试通过。
- [x] 1.2 实现两来源的模型归一化和事件时间价格匹配；完成标准是历史别名、推理档位、未知模型和无生效价格均有单测。
- [x] 1.3 实现请求级普通与长上下文计价；完成标准是 Claude 输入、输出、缓存读取、5 分钟缓存写入、1 小时缓存写入五个计价桶，以及 Codex 净输入/缓存输入/输出和阈值边界测试通过。
- [x] 1.4 实现成本结果合并与覆盖度守恒；完成标准是空范围、全部已定价、部分未定价、全部未定价及 Claude/Codex 合并的金额和请求数测试通过。

## 2. 本地会话采集

- [x] 2.1 扩展 Claude transcript 解析，按 assistant 请求提取模型、缓存写入及其它 token 并生成周/日成本；完成标准是原消息/token 口径不变且新增模型切换、TTL 明细、缺少 TTL 时按 5 分钟回退和未知模型测试通过。
- [x] 2.2 扩展 Codex rollout 解析，跟踪模型上下文并把每个有效 token_count 归入模型；完成标准是按 `max(0, input_tokens - cached_input_tokens)` 恢复 v9 净输入口径，且模型切换、缺失模型、Guardian 排除和现有去重测试通过。
- [x] 2.3 为 Claude 与 Codex 汇总返回统一的来源级成本结果；完成标准是 weekly 等于 daily 求和且 API 请求数等于已定价与未定价请求数之和。

## 3. bundle 与聚合契约

- [x] 3.1 更新 `src/types.ts` 的价格元数据、成本结果、周/日汇总和聚合行类型；完成标准是 v10 字段形状与规格一致且 TypeScript 编译通过。
- [x] 3.2 更新 export 编排并将 bundle schemaVersion 升至 10；完成标准是顶层 pricing、周/日 Claude/Codex/total 成本及覆盖度均进入 JSON，并更新导出测试。
- [x] 3.3 更新 aggregate 校验与兼容映射以接受 6 至 10；完成标准是旧版请求计入未定价、旧版零请求成本为 0 且不影响 v10 完整性和目录版本、v10 成本沿用 token 去重路径、混合 schema 或目录版本标记为 `mixed`，并覆盖多机与重复导出测试。
- [x] 3.4 更新 daily/weekly CSV 列和格式化；完成标准是四个新列顺序固定、美元最多 6 位小数、不可用值留空且 `detail.csv` 列集合保持不变。

## 4. Dashboard 展示

- [x] 4.1 扩展个人 dashboard 数据加载与页面，仅展示合计成本及未知请求提示；完成标准是完整、部分和不可用三种状态的 HTML 测试通过，且页面不出现 Claude、Codex 成本分项。
- [x] 4.2 扩展 aggregate dashboard 的总览、人员汇总和周表；完成标准是页面值与聚合行一致，完整、部分未定价、全部未定价状态及混合 schema/价格目录提示的 HTML 测试通过。

## 5. 文档与验证

- [x] 5.1 更新 README、AGENTS.md 和 CHANGELOG，说明等效成本不是账单、计价基准、v10 字段、CSV 列及旧版本兼容；完成标准是文档与实现字段一致。
- [x] 5.2 运行 `npm run test:src` 和 `npm run build`；完成标准是全部通过且无类型错误。
- [x] 5.3 使用真实数据目录执行 export 与 aggregate smoke；完成标准是生成 v10 gzip bundle、daily/weekly 成本列和可打开的两类 dashboard，且 statusline stdout 契约不变。
- [x] 5.4 修正 Codex rollout 的输入拆分与成本计价；完成标准是 v10 保持 v9 净输入口径、缓存输入不重复计价、周/日回归测试及全量构建通过。
- [x] 5.5 精简个人 dashboard 成本卡；完成标准是只保留合计成本和合计覆盖度，来源级数据与多人 dashboard、bundle 契约不变，源码测试和构建通过。
- [x] 5.6 调整个人 dashboard 顶部布局；完成标准是合计成本并入顶部统计区成为第 5 张卡片，不再单独占行，价格说明和覆盖度语义保持不变。
- [x] 5.7 精简 team dashboard 顶部卡片；完成标准是移除 Total API requests 卡，剩余 6 张卡保持单行，请求数数据、表格和导出契约不变。
- [x] 5.8 精简 team dashboard 多人对比表；完成标准是移除“API 请求”列，请求数仍保留在周表、每日矩阵、成本覆盖度和导出契约中。
- [x] 5.9 把全部模型价格迁移到单个 JSON 目录；完成标准是计价模块不再硬编码模型价格，源码、dist 和 npm 发布包都能加载同一文件，现有计价结果不变。
- [x] 5.10 在个人与 team dashboard 最后增加当前价格表；完成标准是两页共享渲染、普通与长上下文价格和单位完整、空数据页面也显示。
- [x] 5.11 更新文档并完成验证；完成标准是源码与编译产物测试、构建、npm 发布清单及 OpenSpec 严格校验通过。
- [x] 5.12 把当前价目表迁移为独立 `pricing.html`；完成标准是 Codex 排在 Claude 前，两个看板正文不再内联表格，合计成本卡下链接该页面。
- [x] 5.13 接通静态与服务访问并完成验证；完成标准是 dashboard build/open 在同目录写价格页，dashboard serve 与 aggregate serve 响应 `/pricing.html`，全量测试、构建和 OpenSpec 严格校验通过。
- [x] 5.14 精简并重排独立价格页；完成标准是页面只保留一套标题，Codex 模型按版本从新到旧排列，并根据 Orca 源码核对 Claude 模型价格目录后完成测试与严格校验。
- [x] 5.15 让价目表链接在新页面打开；完成标准是个人和 Team 看板链接均包含安全的新页面属性，测试、构建和严格校验通过。
- [x] 5.16 修复 aggregate 同人同日代表分组；完成标准是无 sessionId 的重复导出不翻倍、跨组桥接按传递闭包合并，独立机器仍可叠加。
- [x] 5.17 补齐 Orca 实际模型别名；完成标准是 Claude thinking 变体和裸 `gpt-5.6` 均匹配正确价格且未知模型语义不变。
- [x] 5.18 补齐当前模型长上下文目录并验证；完成标准是 Sonnet 4.6 与 GPT-5.4/5.5/5.6 的阈值和高档价格进入 JSON，源码测试、编译测试、构建及 OpenSpec 严格校验通过。
- [x] 5.19 扩展 aggregate detail 导出成本；完成标准是 `detail.csv` 追加日级成本、覆盖度和价格目录四列，v10 与旧版语义正确且文档明确同日重复值不可求和。
- [x] 5.20 调整团队成本卡顺序并验证；完成标准是合计等效 API 成本卡紧跟 `Peak 7d usage`，全量测试、构建和 OpenSpec 严格校验通过。
- [x] 5.21 统一 aggregate 成本列顺序；完成标准是 detail/daily/weekly 的四个成本字段均位于 CSV 末尾，测试、构建和严格校验通过。
- [x] 5.22 精简 aggregate CSV 成本列；完成标准是 `detail.csv` 恢复原列集合，daily/weekly 仅在列尾保留金额和价格目录版本，内部 bundle 与 dashboard 覆盖度语义不变。
