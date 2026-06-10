## Why

`ccus` 现在对外只暴露 7 天额度的**百分比快照**（`sevenDayPeakUsagePct` / `sevenDayLatestUsagePct`），它们回答"此刻窗口里占了多少"，但回答不了"这一周/这一天到底累计消耗了多少 7d 额度"。7d usage 随时间是一条锯齿波：涨到峰值、窗口重置归零、再从头涨。一个只看峰值的人，会把多次涨—归零—再涨的真实消耗严重低估。我们需要一个能把锯齿波还原成累计真实使用量的对外指标。

## What Changes

- 新增一个**读时计算**的派生指标：7 天额度的**累计真实使用量**，用**分段峰谷和**计算 —— 把曲线按 reset（跌破段峰值一半）切成上升段，每段贡献「段内峰值 − 段内谷值」，累计 = 各段之和。等价于"正增量累加但忽略未跌破段峰一半的小回落"，对真实 7d 信号的 ±1 采样抖动鲁棒（朴素正增量累加会把抖动计成真实增长而严重高估）。
- `aggregate` 输出的 `daily.csv` / `weekly.csv` 各新增一列 `sevenDayCumulativeUsagePct`，语义为**该区间内**（当天 / 当周）的累计真实使用量。
- `aggregate serve` 多人看板同步展示该指标。
- 计算走 bundle 的 **rawEvents 原始样本**（不走分桶），且对同一 personKey 的**多台机器、多周 bundle 先按时间 merge 成一条账号级曲线再算**，绕开现有 `selectDailyWinners`，避免漏样（少算）或分机相加（翻倍）。
- `detail.csv` **不**新增该列（单事件行不承载区间累计语义）。
- 该指标纯在 aggregate 层从 rawEvents 重算，**不改动 `ccus export` 的 bundle 字段集合，不 bump export `schemaVersion`**（与现有 `recomputeUsage` 的处理方式一致）。

## Capabilities

### New Capabilities
- `seven-day-cumulative-usage`: 定义 7 天额度累计真实使用量的计算口径（正增量累加）、多机同账号曲线合并规则、daily/weekly 区间语义，以及它在 aggregate CSV 与 serve 看板上的对外暴露。

### Modified Capabilities
<!-- 无既有 spec 文件，aggregate 行为此前未以 spec 形式固化，本次以新 capability 引入。 -->

## Impact

- 代码：`src/lib/aggregate.ts`（新增 merge + 累计计算路）、`src/lib/export.ts`（daily/weekly CSV 列）、`src/lib/aggregate-dashboard.ts`（serve 看板展示）、`src/types.ts`（聚合行/看板摘要字段）、`src/cli.ts`（如涉及列编排）。
- 测试：`src/test/aggregate.test.ts`、`src/test/aggregate-dashboard.test.ts`、`src/test/export.test.ts`。
- 文档：`README.md`、`CLAUDE.md` 2.6 节（aggregate 输出契约 + 多机合并语义需补充"累计指标走全样本 merge，不走 winner"的说明）。
- 契约：仅 aggregate 输出 CSV 列集合与 serve 看板变更；**不**触及 export bundle 契约，**不** bump export `schemaVersion`；aggregate 输入仍要求 `schemaVersion: 6`。
