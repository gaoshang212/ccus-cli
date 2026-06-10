## 1. 类型与计算口径

- [x] 1.1 在 `src/types.ts` 给 `AggregatedDailyRow` / `AggregatedWeeklyRow` 增加 `sevenDayCumulativeUsagePct: number | null`，并按需扩展 serve 看板摘要类型
- [x] 1.2 在 `src/lib/aggregate.ts` 新增纯函数 `computeCumulativeSevenDay(events)`：取非 null `sevenDayUsagePct`、按 timestamp 升序、求 `Σ max(0, uᵢ−uᵢ₋₁)`；无有效样本返回 `null`，单样本返回 `0`
- [x] 1.3 为 `computeCumulativeSevenDay` 写单测：单调上升后归零再上升、含 null、单样本、无样本四个场景（对齐 spec 的示例数值）

## 2. 多机同账号曲线合并

- [x] 2.1 在 `src/lib/aggregate.ts` 新增 `buildPersonSevenDayCurve(bundles)`：按 personKey 收集**所有 bundle**（非 winner）的 rawEvents → `computeStatuslineEvent` → 合并去重（完全相同 timestamp 只留一条）→ 按 personKey 缓存
- [x] 2.2 提供按区间切分的取数：`(personKey, date)` 与 `(personKey, week)` 各自的合并曲线子序列
- [x] 2.3 写单测：两台机器交错采样同账号合并成一条曲线（验证不分机相加、不翻倍）；相同时间戳去重

## 3. 接入 daily / weekly 行

- [x] 3.1 在 `buildAggregatedDailyRows` 写入 `sevenDayCumulativeUsagePct` = 当天合并曲线的区间内累计（走第 2 步的曲线，**不**走 winner 的 `recomputeUsage`）
- [x] 3.2 在 `buildAggregatedWeeklyRows` 写入 `sevenDayCumulativeUsagePct` = 整周合并曲线一次性求得的正增量和（验证 `weekly ≥ Σ daily`）
- [x] 3.3 确认 `buildAggregatedDetailRows` 与 detail 列集合**不**变（不新增累计列）

## 4. CSV 输出层

- [x] 4.1 在 `src/lib/export.ts` 的 daily.csv / weekly.csv 列定义里加入 `sevenDayCumulativeUsagePct`，写出格式（小数位、null 写空）对齐现有 usage 列
- [x] 4.2 更新/新增 `src/test/export.test.ts` 与 `src/test/aggregate.test.ts` 断言新列存在且数值正确，detail.csv 列集合不变

## 5. serve 看板

- [x] 5.1 在 `src/lib/aggregate-dashboard.ts` 的摘要计算里接入累计指标（与 weekly.csv 同源、数值一致）
- [x] 5.2 在多人看板 HTML 里展示 `sevenDayCumulativeUsagePct`，与现有 7d peak/latest 并列
- [x] 5.3 更新 `src/test/aggregate-dashboard.test.ts` 覆盖新指标渲染

## 6. 文档与验证

- [x] 6.1 更新 `README.md`：新增列说明，明示 daily 逐行相加只是全局总量的**近似**、weekly 更连续
- [x] 6.2 更新 `CLAUDE.md` 2.6 节：补充"累计指标走全样本 merge、绕开 winner、不分机相加"的合并语义，标注 `sevenDayCumulativeUsagePct` 不 bump `schemaVersion`
- [x] 6.3 跑 `npm run test:src` 与 `npm run build`；再跑一次真实 `aggregate` smoke 验证新列与看板
