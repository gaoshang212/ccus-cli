## ADDED Requirements

### Requirement: 7 天额度累计真实使用量的计算口径

系统 SHALL 提供一个名为 `sevenDayCumulativeUsagePct` 的派生指标，对一组按时间升序排列的原始样本的 `sevenDayUsagePct`，用**分段峰谷和**计算：把曲线按 reset 切成若干上升段，每段贡献「段内峰值 − 段内谷值」，累计 = 各段贡献之和。当某样本跌到「当前段峰值 × reset 比例」（默认 `0.5`）及以下时，MUST 判定为一次额度重置（reset），锁定上一段的峰谷差并从该样本开启新段。该指标 MUST 在读时从 `rawEvents` 计算，不持久化，也不进入 `ccus export` 的 bundle 字段集合。

之所以不用朴素的正增量累加 `Σ max(0, uᵢ − uᵢ₋₁)`：真实 7d 信号在同一档位会反复 ±1 抖动（采样毛刺），朴素累加会把每次上抖都计成真实增长而严重高估。分段峰谷和对抖动与滚动窗口的小幅回落（aging，未跌破段峰一半）鲁棒 —— 只取整段峰谷差、不重复计数；同时仍能正确累计「涨到峰 → 归零 → 再涨」的多段真实使用。

`null` 的 `sevenDayUsagePct` 样本 MUST 在排序前剔除，不参与计算。区间内的第一个有效样本作为首段谷值起点，无前值时 MUST 不贡献增量（由此天然减掉区间起点的初始存量）。

#### Scenario: 单调上升后归零再上升

- **WHEN** 某区间内 `sevenDayUsagePct` 样本按时间为 `[30, 60, 0, 25, 50]`
- **THEN** `0` 跌破段峰 `60` 的一半判定 reset：段1 `[30,60]` 贡献 `60−30=30`，段2 `[0,25,50]` 贡献 `50−0=50`，累计 `30 + 50 = 80`

#### Scenario: 同档位反复抖动不重复计数

- **WHEN** 某区间内样本为 `[14, 15, 14, 15, 14, 15]`（同一档位 ±1 采样毛刺）
- **THEN** 视为单段，累计值为段峰谷差 `15 − 14 = 1`（而非朴素正增量累加的 `3`）

#### Scenario: 含 null 样本

- **WHEN** 某区间内样本为 `[20, null, 45, null, 70]`
- **THEN** 剔除 null 后按 `[20, 45, 70]` 单段计算，累计值为 `70 − 20 = 50`

#### Scenario: 区间内只有一个有效样本

- **WHEN** 某区间内仅有一个非 null 样本 `[42]`
- **THEN** 累计值为 `0`（无前值可比，不贡献增量）

#### Scenario: 无有效样本

- **WHEN** 某区间内 `sevenDayUsagePct` 全部为 null 或无样本
- **THEN** 累计值为 `null`（区别于 `0`：`0` 表示有样本但无净增长）

### Requirement: 7d 读数去毛刺

在分段峰谷和之前，系统 MUST 对合并后的账号级曲线做读数去毛刺：真实 7d 信号变化慢、每个档位会被高频采样连续覆盖多个样本，而 stale 缓存读数 / 瞬时异常只会短暂出现。系统 SHALL 把**中间**持续时长（下一段起始时间戳 − 本段起始时间戳）短于阈值（默认 2 分钟）的读数段替换为最近的已保留前值；曲线的**首段与末段无条件保留**（端点缺上下文判断持续性）。

该去毛刺 MUST 只对密集采样的真实曲线生效：稀疏数据（每个值仅一两个样本、间隔远大于阈值）的中间段持续时长超过阈值，不被误删，因此不影响纯分段口径的示例数值。

#### Scenario: 中间短毛刺被抹平

- **WHEN** 某账号曲线为「`2` 持续 30 分钟 → `30` 仅持续 30 秒 → `2` 持续 30 分钟」
- **THEN** 中间的 `30` 段持续短于 2 分钟被替换为前值 `2`，去毛刺后曲线无 `30`，该区间累计为 `0`（baseline 无净增长）

#### Scenario: 稀疏代表点不被误删

- **WHEN** 某区间样本为 `[30, 60, 0, 25, 50]`，相邻样本间隔均远大于 2 分钟
- **THEN** 所有中间段持续时长都超过阈值、全部保留，去毛刺不改变曲线，累计仍为 `80`

### Requirement: 多机同账号曲线合并

对同一 `personKey`，系统 MUST 把该人**所有机器、所有周** bundle 的 `rawEvents` 先按 `timestamp` 升序合并去重成一条账号级曲线，再在该曲线上计算累计指标。系统 MUST NOT 对各机器分别计算累计值后相加（同账号 7d 额度共享，分机相加会翻倍）。该合并路 MUST 独立于现有 `selectDailyWinners` 的按天 winner 去重（只取 winner 会漏掉非 winner 机器的样本，导致曲线稀疏、累计偏小）。

合并去重时，对**完全相同 timestamp** 的重复条目 SHALL 仅保留一条，避免重复采样污染相邻增量。

#### Scenario: 两台机器交错采样同一账号

- **WHEN** 同一 personKey 机器 A 采到 `[t1:30, t3:60]`、机器 B 采到 `[t2:45, t4:0, t5:40]`，t1<t2<t3<t4<t5
- **THEN** 先合并为一条曲线 `[30, 45, 60, 0, 40]`，再算累计 `15+15+0+40 = 70`，而非 A、B 各自累计相加

#### Scenario: 相同时间戳重复条目

- **WHEN** 两台机器在完全相同的 timestamp 各写入一条样本
- **THEN** 合并后该时间点只保留一条，不产生 0 距离的重复增量

### Requirement: daily / weekly 区间累计语义

`aggregate` 输出的 `daily.csv` 与 `weekly.csv` 各 SHALL 包含一列 `sevenDayCumulativeUsagePct`，其值为该行所属 `(personKey, 自然日)` 或 `(personKey, 周)` **区间内**合并曲线的累计真实使用量。该值以**百分比累加**表达，允许大于 100（表示用掉了多于一个 7d 额度的量），写出格式与现有 usage 百分比列一致。

`daily.csv` 的多行相加 MUST 仅被视为对全局总量的**近似**（区间边界的跨界增量按区间内语义不计入），文档 SHALL 明示该近似性，不得宣称逐行可精确求和。

#### Scenario: daily 行的区间内累计

- **WHEN** 某 personKey 在某自然日的合并曲线为 `[10, 35, 5, 20]`
- **THEN** 该天 `daily.csv` 行的 `sevenDayCumulativeUsagePct` 为 `5` 跌破 `35` 一半 reset 后两段峰谷差之和：段1 `35−10=25`、段2 `20−5=15`，合计 `40`

#### Scenario: weekly 行覆盖整周曲线

- **WHEN** 某 personKey 某周的合并曲线跨多天
- **THEN** `weekly.csv` 行的 `sevenDayCumulativeUsagePct` 为整周合并曲线一次性求得的正增量和，而非各天 daily 值的简单相加

### Requirement: detail.csv 不暴露累计列

`detail.csv` MUST NOT 新增 `sevenDayCumulativeUsagePct` 列。detail 行是单条事件视图，承载的是该事件的瞬时快照，区间累计语义与之不匹配。

#### Scenario: detail 列集合不变

- **WHEN** 生成 `detail.csv`
- **THEN** 列集合与本次变更前一致，不含任何累计列

### Requirement: serve 看板展示累计指标

`ccus aggregate serve` 多人看板 SHALL 展示 `sevenDayCumulativeUsagePct`，与现有 7d peak/latest 指标并列，保证对外契约（CSV）与页面展示不脱节。

#### Scenario: 看板与 CSV 同源

- **WHEN** 渲染 serve 看板
- **THEN** 看板上某 personKey 的累计 7d 使用量与该人 weekly.csv 行的 `sevenDayCumulativeUsagePct` 取自同一计算路、数值一致
