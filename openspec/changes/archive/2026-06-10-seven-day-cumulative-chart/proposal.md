## Why

`ccus aggregate serve` 多人看板顶部的横向条形对比图当前展示每个人的 `sevenDayPeakUsagePct`（7 天额度使用率峰值）。峰值只反映「最接近用满周额度的瞬时高点」，无法体现一段时间里实际累计消耗了多少额度——一个全程贴着 90% 的人和一个反复涨到 90% 又归零多轮的人峰值相同，但后者真实用量是前者的数倍。看板已经在统计表里提供了更能反映真实用量的 `sevenDayCumulativeUsagePct`，但最显眼的对比图仍用峰值，主指标与对比图口径不一致，容易误导团队解读。

## What Changes

- 把 `aggregate serve` 看板里「周使用量峰值对比」横向条形图的数据源从 `sevenDayPeakUsagePct` 改为 `sevenDayCumulativeUsagePct`（区间内累计真实使用量）。
- 排序、归一与文案同步改为累计口径：标题/eyebrow/说明文字与 ARIA 标签从「峰值」改为「累计」，空态文案相应调整。
- 条长归一默认保留 100% 满刻度（条长直接反映绝对使用率），仅当有人累计超过 100% 时才把刻度放大到在场最大累计值，避免超长条溢出；右侧仍标注绝对百分比。
- 不改动任何导出/聚合 CSV 字段、列集合或 `schemaVersion`：该图所用 `sevenDayCumulativeUsagePct` 已存在于 `AggregatePersonSummary`，本次仅切换渲染所引用的字段。

## Capabilities

### New Capabilities

（无新增能力。）

### Modified Capabilities

- `seven-day-cumulative-usage`: 「serve 看板展示累计指标」需求细化——看板顶部的人均对比条形图 MUST 以 `sevenDayCumulativeUsagePct`（而非峰值）为口径，使最显眼的对比图与统计表主指标一致。

## Impact

- 代码：`src/lib/aggregate-dashboard.ts`（`renderSevenDayPeakChart` 函数体与文案、归一逻辑、调用处命名）。
- 测试：`src/test/aggregate-dashboard.test.ts`（对比图断言改为校验累计值与动态归一）。
- 文档：`README.md` 中 `aggregate serve` 看板说明（如提到该对比图口径）。
- 不影响：`export` bundle、`daily.csv` / `weekly.csv` / `detail.csv` 列集合、`schemaVersion`、事件级与导出契约。
