## MODIFIED Requirements

### Requirement: serve 看板展示累计指标

`ccus aggregate serve` 多人看板 SHALL 展示 `sevenDayCumulativeUsagePct`，与现有 7d peak/latest 指标并列，保证对外契约（CSV）与页面展示不脱节。

看板顶部用于人均横向对比的条形图 MUST 以 `sevenDayCumulativeUsagePct`（区间内累计真实使用量）为口径，而非 `sevenDayPeakUsagePct`（峰值），使最显眼的对比图与统计表的累计主指标一致。该对比图的人员排序 MUST 按累计值降序。条长归一 SHALL 默认采用 100% 满刻度，使条长直接反映绝对使用率；仅当在场人群中存在累计值超过 100% 的人时，归一刻度 MUST 放大到该最大累计值，以免超长条溢出轨道。即归一刻度 = `max(100, 在场最大累计值)`。条右侧 MUST 仍标注每人的绝对累计百分比。当没有任何人有有效累计值时，看板 MUST 显示空态文案而非空图。

#### Scenario: 看板与 CSV 同源

- **WHEN** 渲染 serve 看板
- **THEN** 看板上某 personKey 的累计 7d 使用量与该人 weekly.csv 行的 `sevenDayCumulativeUsagePct` 取自同一计算路、数值一致

#### Scenario: 对比图以累计为口径并按累计降序

- **WHEN** 看板存在多个人均有有效 `sevenDayCumulativeUsagePct`
- **THEN** 顶部对比图的每根条长与右侧标注取自各人的 `sevenDayCumulativeUsagePct`，条按累计值从大到小排列，最大累计值对应满条

#### Scenario: 全员累计不超过 100% 时按 100% 满刻度

- **WHEN** 在场人群的累计值分别为 70 与 40（都不超过 100）
- **THEN** 归一刻度为 100，两人分别按「自身累计 ÷ 100」缩放（条长直接反映绝对使用率），无人到满条，右侧标注为各自绝对百分比

#### Scenario: 有人累计超过 100% 时放大刻度动态归一

- **WHEN** 在场人群的最大 `sevenDayCumulativeUsagePct` 为 240（超过 100）
- **THEN** 归一刻度放大到 240，该最大值对应满条，其余人按「自身累计 ÷ 240」成比例缩放，右侧标注仍为各自的绝对百分比（如 `240.0%`）

#### Scenario: 无有效累计值时显示空态

- **WHEN** 所有人 `sevenDayCumulativeUsagePct` 均为 null
- **THEN** 对比图区域显示空态文案，不渲染任何条形
