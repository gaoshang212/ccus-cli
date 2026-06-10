## Context

`src/lib/aggregate-dashboard.ts` 的 `renderSevenDayPeakChart` 渲染看板顶部的横向条形对比图，当前读取 `AggregatePersonSummary.sevenDayPeakUsagePct`，按固定 100% 满刻度归一。`AggregatePersonSummary` 已包含 `sevenDayCumulativeUsagePct`（由 weekly 行累加而来，见现有 spec `seven-day-cumulative-usage`），且已在统计表中展示。本次改动只在渲染层把对比图引用的字段从峰值切换为累计，不触及任何数据计算路、导出/聚合 CSV 或 `schemaVersion`。

## Goals / Non-Goals

**Goals:**

- 对比图数据源、排序、文案、ARIA 标签全部切到 `sevenDayCumulativeUsagePct` 累计口径。
- 条长归一改为按在场人群最大累计值动态归一，兼容累计值 > 100% 的情形。
- 统计表、CSV 导出、`schemaVersion` 保持不变。

**Non-Goals:**

- 不改 `sevenDayCumulativeUsagePct` 的计算逻辑（`computeCumulativeSevenDay` 等保持原样）。
- 不动单机 dashboard（`src/lib/dashboard.ts`），本次仅 aggregate serve 看板。
- 不在对比图里同时保留峰值条（峰值仍可在统计表中查看）。

## Decisions

**决策 1：默认 100% 满刻度，仅超限时放大。**
峰值天然落在 0–100，固定满刻度合理；累计值可超过 100（用掉多于一个 7d 额度）。若一律按在场最大值动态归一，会让「都不超过 100%」的常见情形也失去与绝对刻度的对应（条长不再直接读出绝对使用率，且跨截图刻度漂移）。取折中：`maxValue = Math.max(100, ...各人 sevenDayCumulativeUsagePct)`——默认 100% 满刻度，条长直接反映绝对使用率；仅当确有人突破 100% 时刻度才放大到该最大值，避免超长条溢出轨道。下限 100 同时兜底全 0（有样本无净增长）时的除零，使条长归零而非 NaN。

**决策 2：函数命名。**
`renderSevenDayPeakChart` 名称含 "Peak"，口径变更后语义不符。重命名为 `renderSevenDayCumulativeChart`（连同调用处），保持代码可读性；这是纯内部重构，不影响外部契约。

**决策 3：文案与排序。**
eyebrow 从 `Weekly Peak Usage` 改为 `Weekly Cumulative Usage`，标题从「周使用量峰值对比」改为「周使用量累计对比」，说明文字与 ARIA 标签、空态文案同步。排序从按峰值降序改为按累计降序。过滤条件从 `sevenDayPeakUsagePct !== null` 改为 `sevenDayCumulativeUsagePct !== null`。

## Risks / Trade-offs

- [累计值含义比峰值更难直觉理解] → 说明文字明确「区间内累计真实使用量，可超过 100%」，与统计表口径一致，降低误读。
- [动态归一使不同时间段截图的满条绝对值不同] → 右侧始终标注绝对百分比，满条只表达相对排名，绝对值以标注为准。
- [全员累计为 0 的除零风险] → 用 `maxValue` 下限兜底，全 0 时条归零并正常渲染。
