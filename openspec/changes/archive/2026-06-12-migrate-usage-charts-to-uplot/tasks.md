## 1. uPlot 资源接入与内联

- [x] 1.1 vendored uPlot 资源到仓库（如 `src/vendor/uplot.iife.min.js` + `src/vendor/uplot.min.css`），固定版本，保留 MIT 许可声明
- [x] 1.2 新增内联读取工具：用 `fs.readFileSync` + `import.meta.url` 定位资源，dist 与源码路径都可用（参考 `src/lib/version.ts` 的 `../../` 定位）
- [x] 1.3 调整 build，使 vendored 资源被拷进 `dist`（`tsc` 不搬非 ts 文件，需补拷贝步骤）
- [x] 1.4 把 vendored 资源路径加入 `package.json` 的 `files`，保证 npm 发布带上
- [x] 1.5 抽出公共「uPlot 容器 + 内联数据 + 初始化脚本」渲染辅助，供单人/多人、折线/柱状复用（数据用 `<script type="application/json">` 内联并规避 `</script>` 注入）

## 2. 单人图迁移（dashboard.ts）

- [x] 2.1 `renderChart`（5h/7d 使用率趋势）改用 uPlot：x=桶时间戳，series=[5h(maxUsagePct), 7d(avgSevenDayUsagePct)]
- [x] 2.2 沿用现状空桶语义：不注入空桶（或填 null 并连接），保持相邻有效点直连
- [x] 2.3 配置 cursor 悬停读数（十字线 + legend 跟随显示两条线当前值）、0–100% 固定 Y 轴、自然日/时刻 x 轴、area 填充与配色对齐现有主题
- [x] 2.4 `renderDailyMessages`（每日消息数纵向 bar）改用 uPlot：`uPlot.paths.bars()` 画柱 + `hooks.draw` 补柱顶数值标签 + cursor 悬停读数；x 离散天配 bars 宽度/居中

## 3. 多人图迁移（aggregate-dashboard.ts）

- [x] 3.1 5h/7d 使用率详细曲线改用 uPlot：实现各人不规则时间戳**并集对齐**为统一 x 轴、缺失填 null
- [x] 3.2 每日用户请求数对比折线改用 uPlot：x 复用共享 `dateAxis`（已对齐，无需并集）
- [x] 3.3 两张折线 tooltip 顺 uPlot 原生 legend 全显示（当前 x 各人值）
- [x] 3.4 图例点击高亮改用 uPlot 原生 legend toggle；移除手写 `is-dimmed`/`legend-toggle` 脚本中针对折线的部分
- [x] 3.5 周使用量累计**横向排行榜** bar（`renderSevenDayCumulativeChart`）保持自绘 SVG，不改
- [x] 3.6 uPlot series 配色复用 `CHART_PALETTE` / `SEVEN_DAY_PALETTE`，5h 实线 / 7d 对比色虚线观感与现状一致

## 4. 测试

- [x] 4.1 重写 `src/test/dashboard.test.ts`：5h/7d 折线与每日消息 bar 断言从 `<path>`/`<rect>` 改为「含 uPlot 容器 / 内联数据 / series 配置」
- [x] 4.2 重写 `src/test/aggregate-dashboard.test.ts`：两张折线同上；**保留**周累计横向 bar 自绘断言
- [x] 4.3 补多人时间戳并集对齐的单测（不同人不同时间戳 → 统一 x 轴 + 缺失填 null）
- [x] 4.4 补「生成 HTML 内联了 uPlot 库与 CSS」的断言（离线自包含）
- [x] 4.5 补纵向 bar 柱顶数值标签插件相关断言（数据/配置存在性）

## 5. 文档与验证

- [x] 5.1 更新 `README.md`：折线与纵向柱改用 uPlot、支持悬停任意点读数、库内联离线可用；说明横向排行榜仍自绘
- [x] 5.2 `npm run test:src` 与 `npm run build` 通过
- [x] 5.3 验证 `dist` 含 vendored 资源；`npm pack --dry-run` 清单含资源
- [x] 5.4 真实 smoke：`dashboard build` 产物用 `file://` 离线打开，确认折线与纵向柱悬停任意点出读数、横向排行榜正常
- [x] 5.5 `openspec validate migrate-usage-charts-to-uplot` 通过
