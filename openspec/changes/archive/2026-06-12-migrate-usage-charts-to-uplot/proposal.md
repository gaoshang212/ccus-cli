## Why

看板（单人 `dashboard` 与多人 `aggregate serve`）的 5h/7d 使用率折线目前是服务端自绘 SVG：单人只有数据点圆点挂 `<title>` 才能看到百分比，鼠标落在线段中间空白处读不到值；多人 5h/7d 详细曲线整条线只挂一个 `<title>`（人名），完全看不到任何百分比。用户希望「曲线上任意一点都能看到当前百分比」。SVG 原生 `<title>` 一个元素只能挂一个固定文本，无法随鼠标在同一条线上的不同位置显示不同读数，现状机制从根上满足不了该需求。

uPlot 的 cursor 原生提供「十字线 + legend 跟随读数」，正是该需求本身，且体积极小（~40KB min / gzip ~10KB），能内联进 HTML、离线可用，是这个零依赖、本地优先项目里唯一合身的图表库。本次借迁移统一把**折线与纵向柱状**两类图收敛到 uPlot，仅保留「横向排行榜」一张自绘 SVG（它本质是排行 UI，非坐标图，uPlot 反而不合适）。

## What Changes

- 把看板的**折线图**改用 uPlot 渲染，借其原生 cursor（十字线 + legend 跟随）实现「悬停绘图区任意 x 位置看到各 series 当前百分比」：
  - 单人 `src/lib/dashboard.ts` 的 `renderChart`（5h/7d 使用率趋势）
  - 多人 `src/lib/aggregate-dashboard.ts` 的 5h/7d 使用率详细曲线
  - 多人 `src/lib/aggregate-dashboard.ts` 的每日用户请求数对比折线
- 把单人**每日消息数纵向柱状图**（`renderDailyMessages`）也迁到 uPlot：用 `uPlot.paths.bars()` 画柱，配 draw-hook 插件补柱顶数值标签，同样获得悬停读数。
- uPlot 库**内联**进生成的 HTML（vendored 文件读取，不走 CDN），保证 `dashboard build` 产物用 `file://` 离线打开仍能渲染。
- 读数走**跟随鼠标的 tooltip**（`setCursor` 自绘浮层）集中显示当前位置各 series 的值；关闭 uPlot 原生 legend、改用**自绘图例**：多人图里一个人只显示一个名字（小写、不强制大写），点击同时切换该人 5h + 7d 两条线显隐（移除现有手写 `is-dimmed` 脚本）。各人时间戳不对齐、并集含 null 的曲线用 `cursor.dataIdx` 吸附高亮到最近真实点、横向重合尖峰按鼠标高度做 2D 命中，避免「峰值圆点不亮、读不到值」。该交互对所有 uPlot 图统一。
- 渲染模型从「服务端拼好 SVG path」转为「服务端输出容器 `<div>` + 内联数据 + 内联 uPlot + 初始化脚本，浏览器端 `new uPlot` 绘制」。
- **仅** 多人「周使用量累计对比」**横向排行榜 bar** 保持自绘 SVG：uPlot 无原生横向 bar、是反模式，且该图本质是带标签的水平进度条排行榜（更适合 HTML/CSS），本次不动。
- 纯展示层改造：不改任何导出/聚合字段、CSV 列集合或 `schemaVersion`。

## Capabilities

### New Capabilities

- `interactive-usage-charts`: 看板使用率图表（折线 + 纵向柱状）以 uPlot 渲染并支持悬停读数；uPlot 库内联以保证离线（含 `file://`）可用。

### Modified Capabilities

（无既有能力契约变更。）

## Impact

- 代码：`src/lib/dashboard.ts`（`renderChart` 与 `renderDailyMessages` 均改 uPlot）、`src/lib/aggregate-dashboard.ts`（5h/7d 详细曲线 + 每日请求对比折线改 uPlot；周累计**横向** bar 不动；移除旧 `legend-toggle`/`is-dimmed` 脚本中被 uPlot 原生取代的部分）。
- 新增：vendored uPlot 资源（如 `src/vendor/uplot.iife.min.js` + `uplot.min.css`）及其内联读取逻辑；调整 build 使资源进 `dist`，并把该路径加入 `package.json` 的 `files` 以随 npm 发布。
- 测试：`src/test/dashboard.test.ts`、`src/test/aggregate-dashboard.test.ts` 断言从自绘 `<path>`/`<rect>` 改为 uPlot 容器 / 内联数据 / series 配置存在性；保留周累计横向 bar 的自绘断言。
- 文档：`README.md` 看板说明（折线与纵向柱改用 uPlot、支持悬停读数、库内联离线可用；横向排行榜仍自绘）。
- 不影响：`export` bundle、`daily.csv` / `weekly.csv` / `detail.csv` 列集合、`schemaVersion`、事件级与导出契约、周累计横向 bar、单人(storage)/多人(bundle JSON) 数据源。
