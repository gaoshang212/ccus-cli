## 1. 渲染层改造

- [x] 1.1 将 `renderSevenDayPeakChart` 重命名为 `renderSevenDayCumulativeChart`，并更新调用处
- [x] 1.2 过滤与排序改用 `sevenDayCumulativeUsagePct`（过滤非 null、按累计值降序）
- [x] 1.3 条长归一改为按在场人群最大累计值动态归一，加除零下限兜底（全 0 时条归零）
- [x] 1.4 条长与右侧标注取 `sevenDayCumulativeUsagePct`，标注保留绝对百分比
- [x] 1.5 更新文案：eyebrow（`Weekly Cumulative Usage`）、标题（「周使用量累计对比」）、说明文字、ARIA 标签、空态文案

## 2. 测试

- [x] 2.1 更新 `src/test/aggregate-dashboard.test.ts`：对比图断言改为校验累计值口径与动态归一
- [x] 2.2 补充空态（全 null）与累计值 > 100% 动态归一的断言

## 3. 文档与验证

- [x] 3.1 更新 `README.md` 中 `aggregate serve` 看板对比图口径说明（如有提及）
- [x] 3.2 运行 `npm run test:src` 与 `npm run build` 验证通过
- [x] 3.3 跑 `openspec validate seven-day-cumulative-chart` 确认 change 合规
