## Context

`aggregate.ts` 现有的对外 usage 列（5h/7d 的 peak/latest）都是**百分比快照**，由 `recomputeUsage` 从 winner bundle 的 `rawEvents` 重算。整条聚合管线建立在 `selectDailyWinners` 之上：对每个 `(personKey, date)` 只保留一份"最新且尽量有数据"的 bundle，以此对 token 等**累加量**做天级去重防翻倍（见 `CLAUDE.md` 2.6）。

本次要新增的"7 天额度累计真实使用量"打破了一个隐含前提——它把百分比快照**变成了累加量**。这带来两个与现有管线直接冲突的点：(1) winner 按天只取一台机器，会漏掉非 winner 机器的样本；(2) 同 personKey 多机若分别累计再相加会翻倍（同账号 7d 额度共享，是同一条曲线的密集采样）。因此累计指标需要一条**独立于 winner 的计算路**。

## Goals / Non-Goals

**Goals:**
- 用正增量累加 `Σ max(0, uᵢ − uᵢ₋₁)` 从 `rawEvents` 还原 7d 累计真实使用量。
- daily/weekly CSV 与 serve 看板暴露 `sevenDayCumulativeUsagePct`，区间内语义。
- 同 personKey 多机/多周样本合并成一条账号级曲线再算，绝不分机相加。
- 不动 export bundle 字段集合与 `schemaVersion`。

**Non-Goals:**
- 不把累计值持久化进 bundle，也不进 `detail.csv`。
- 不改 5h/7d peak/latest 既有列与既有 winner 去重逻辑。
- 不解决多机时钟不同步的根因（只在算法上做容错，不做对齐）。
- 不把累计换算回 token 绝对量（本期就用百分比累加单位）。

## Decisions

### 决策 1：分段峰谷和（修订）

**初版选了正增量累加 `Σ max(0, uᵢ − uᵢ₋₁)`，已在真实数据上被推翻。** 实测 7d 信号在同一档位反复 ±1 抖动（采样毛刺，如 `14↔15` 一分钟往复 6 次），朴素累加把每次上抖都计成真实增长，导致严重高估（实测 gaoshang 102 vs 合理 ~50、lijian naive 303）。design 初版 Risks 里其实已预警"对时钟漂移 / 近似重复敏感"，真实数据证实抖动才是主因。

**改用分段峰谷和**：把曲线按 reset 切成若干上升段，每段贡献「段内峰值 − 段内谷值」，累计 = 各段贡献之和。reset 判定 = 某样本跌破「当前段峰值 × 0.5」（`SEVEN_DAY_RESET_RATIO`，对 0.4/0.5/0.6 实测不敏感）。等价于"正增量累加，但忽略未跌破段峰一半的小回落"。它对 ±1 抖动与滚动窗口 aging 回落鲁棒（只取整段峰谷差），又能正确累计"涨到峰 → 归零 → 再涨"的多段真实使用。

这套口径**完全兼容 spec 既有的全部示例数值**（`[30,60,0,25,50]`=80、`[10,35,5,20]`=40、单样本=0、无样本=null），只是把真实抖动数据从高估拉回合理量级。代价是引入了一个 reset 比例阈值（正是初版想避免的），但实测证明不设阈值无法成立。

### 决策 1b：分段前先做读数去毛刺

仅有分段峰谷和还不够：真实数据里 baseline 很低时会偶发 stale 缓存读数尖峰（如 `2` 基线里跳出 `30`/`15` 又落回），每个尖峰都被分段当成一次「涨到峰 → reset → 再涨」，把 lijian 撑到 164（真实约 93，见使用率详细曲线图上 lijian 7d 干净两段 ~33% + ~60%）。

**在分段前对账号级曲线做去毛刺**：真实 7d 信号变化慢、每档被高频采样连续覆盖多个样本（baseline 常持续几十分钟），stale 尖峰只持续秒级。把**中间**持续时长（下一段起始 − 本段起始）短于 2 分钟的读数段替换为最近保留前值，首尾段无条件保留。等价于人眼在曲线图上忽略短毛刺。实测把 lijian 精确拉回 93、其余人小幅修正，且对 2/5/10 分钟阈值不敏感（stale 尖峰都远短于 2 分钟）。

该去毛刺**只对密集采样的真实曲线生效**：稀疏数据（每值一两个样本、间隔远大于阈值）中间段持续超阈值不被误删，所以 spec 纯分段示例（80/40/...）和集成测试稀疏数据不受影响。实现 `deburrSevenDayEvents`，挂在 `buildPersonSevenDayCurve` 合并去重之后。

**已知遗留**：若同 personKey 真的混入交错多源（多账号/多机长期并行、各自 7d 额度不同），去毛刺只能压掉短尖峰、压不掉长期并行的双水平曲线。这属于数据源在 personKey 粒度混账号的问题，不在本算法范围，后续单独处理。

### 决策 2：累计走独立的全样本 merge 路，绕开 winner
新增一条计算路（建议 `buildPersonSevenDayCurve` / `computeCumulativeSevenDay`）：对每个 `personKey`，收集**所有 bundle**（非仅 winner）的 `rawEvents` → `computeStatuslineEvent` → 取非 null `sevenDayUsagePct` → 按 `timestamp` 升序合并 → 对完全相同 timestamp 去重 → 按自然日 / 周切区间 → 区间内求正增量。**替代方案**复用 winner 路被否：winner 按天只留一台机器，若某天两台机器各覆盖半天曲线，只取 winner 会丢半天样本、漏增量。同账号曲线本就该一致，多机只是把曲线采得更密，merge 不会翻倍——所以这条路安全。

### 决策 3：weekly 不等于各天 daily 相加
weekly 行对 `(personKey, 周)` 的整周合并曲线**一次性**求正增量；daily 行对当天曲线求。由于"区间第一个样本不贡献增量"，跨天边界那一步增量在 daily 里被吃掉、在 weekly 整周连续算时被计入，故 `weekly ≥ Σ daily`。这是区间内语义在不同粒度下的正常结果，不是 bug。文档须写明 daily 逐行相加只是对全局总量的**近似**。

### 决策 4：字段命名与单位
列名 `sevenDayCumulativeUsagePct`，与 `sevenDayPeakUsagePct` / `sevenDayLatestUsagePct` 同家族。单位是**百分比累加**，允许 >100（= 用掉多于一个 7d 额度），写出格式（小数位、null 写空）与现有 usage 列一致。

### 决策 5：不 bump schemaVersion
纯 aggregate 层从 rawEvents 重算，不新增任何 export bundle 字段，与 `recomputeUsage` 同理。aggregate 输入仍校验 `schemaVersion: 6`。仅 aggregate 输出 CSV 列集合 + serve 看板属于对外契约变更，需同步 types/export/aggregate/测试/README/`CLAUDE.md` 2.6。

## Risks / Trade-offs

- **多机时钟不同步** → 合并后曲线可能出现非真实的跳变；`max(0, …)` 会把负向漂移吃成 0，正向漂移可能虚增一点增量。Mitigation：本期接受，仅按 timestamp 排序+同戳去重；在 `CLAUDE.md` 注明该口径对时钟漂移敏感，后续可加去抖。
- **近似时间戳的多机重复** → 只去"完全相同 timestamp"挡不住相差 1ms 的重复采样，可能制造微小虚假增量。Mitigation：同账号同时刻值应几乎相等，正增量近 0，影响可忽略；不引入时间窗口聚合以免改变锯齿形状。
- **daily 逐行不可精确求和** → 用户可能误以为 daily 列可直接 sum 成全局总量。Mitigation：在 README/看板措辞明示"近似"，并提供 weekly 作为更连续的口径。
- **计算开销** → 全样本（非 winner）合并会处理更多 rawEvents。Mitigation：仅对 `sevenDayUsagePct` 这一标量序列做合并，按 personKey 缓存曲线，复用 `bundleEventsByDate` 的缓存模式。

## Open Questions

- serve 看板是否需要在 personKey 维度之外再给一个"团队总计累计使用量"卡片？（跨不同 personKey 即跨不同账号额度，相加语义成立，但需确认是否在本期范围内。）
- `null`（无样本）与 `0`（有样本无净增长）在 CSV 中是否都按"空 vs 0"严格区分写出，与现有 usage 列 null 处理保持一致即可，待实现时对齐。
