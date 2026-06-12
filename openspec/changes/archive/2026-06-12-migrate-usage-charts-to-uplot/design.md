## Context

看板图表现为服务端字符串拼接的自绘 SVG，共 5 张：单人 5h/7d 折线、单人每日消息数纵向 bar、多人 5h/7d 详细曲线、多人每日请求对比折线、多人周累计横向 bar。其中折线只有 hover 到圆点（或整条线一个 `<title>`）才有读数，SVG `<title>` 一元素一文本，做不到「同一条线不同位置显示不同读数」，所以「任意一点看百分比」必须换渲染器。

uPlot 是为时序设计的轻量库，cursor 原生给「十字线 + 数据点高亮 + legend 跟随读数」，~40KB（gzip ~10KB）可整包内联，离线友好。项目现状 `dependencies: {}`、构建链只有 `tsc`、HTML 服务端拼接、产物可 `file://` 打开、并发布到 npm —— 这些约束排除了 CDN（离线失效）与 ECharts（~1MB 内联或被迫引打包器），uPlot 是唯一同时满足「小到可内联 + 离线 + 交互够用」的选项。

本次按图表性质收敛渲染：**折线与纵向柱状 → uPlot**（uPlot 擅长且 hover 读数有意义），**横向排行榜 → 保持自绘 SVG**（uPlot 无原生横向 bar，是反模式）。渲染模型从「服务端画好 SVG」转为「服务端输出容器 + 内联数据 + 内联 uPlot 库 + 初始化脚本，浏览器端 `new uPlot` 绘制」，不触及任何数据计算路、导出/聚合契约或 `schemaVersion`。

## Goals / Non-Goals

**Goals:**

- 三张折线（单人 5h/7d、多人 5h/7d 详细、多人每日请求对比）与单人每日消息数纵向 bar 用 uPlot 渲染，悬停绘图区任意 x 显示各 series 当前读数。
- uPlot 内联进 HTML，`dashboard build` 产物 `file://` 离线打开可完整渲染。
- 多人折线 tooltip 顺 uPlot 原生 legend 全显示；图例点击高亮改用 uPlot 原生 legend toggle。
- 导出/聚合字段、CSV 列集合、`schemaVersion`、数据计算路全部保持不变。

**Non-Goals:**

- 不迁多人周累计**横向排行榜** bar：保持自绘 SVG（它更适合 HTML/CSS，但本次也不转，留作后续可选清理）。
- 不引入前端框架或打包器；不走 CDN。
- 不改 recompute / aggregate / export 计算逻辑，不改任何对外契约。
- 不改数据源：单人仍读本地日志(storage)，多人仍读 bundle JSON。
- 不在本次引入框选缩放等 uPlot 附加能力（先只做悬停读数所需配置）。

## Decisions

**决策 1：内联 uPlot，不用 CDN。**
本地优先 + `file://` 打开，CDN 在离线/内网会失效导致图表空白，违背产品定位。uPlot 整包 ~40KB / gzip ~10KB，内联进每个 HTML 体积可忽略（远小于 ECharts ~1MB）。

**决策 2：uPlot 字节如何进 dist 与发布。**
把 uPlot 的 `uPlot.iife.min.js` 与 `uPlot.min.css` vendored 到仓库（如 `src/vendor/`），运行时用 `fs.readFileSync` + `import.meta.url` 定位读取后内联（照搬 `src/lib/version.ts` 读 `package.json` 的 `../../` 定位套路，dist 与源码路径都要可用）。需调整 build：把 vendored 资源拷进 `dist`（`tsc` 不搬非 ts 文件），并把该路径加入 `package.json` 的 `files`，否则 npm 发布包不含资源、安装后渲染会缺库。uPlot 为 MIT 许可，可放心 vendored；固定一个版本（如 1.6.x）。

**决策 3：渲染模型转为「容器 + 内联数据 + 客户端初始化」。**
每张图输出：一个 `<div class="uplot-host" id="...">` 容器 + 一个 `<script type="application/json" id="...">` 内联该图数据 + 页面级一次性内联 uPlot 库与 CSS + 一段初始化脚本读取数据 `new uPlot`。数据内联须转义/规避 `</script>` 注入。`file://` 下纯前端、无 fetch，离线可跑。禁用 JS 时这些图不显示（横向排行榜仍是 SVG，可见）——看板本是本地交互页，可接受。

**决策 4：多人 5h/7d 时间戳对齐。**
uPlot 要求所有 series 共用一个 x 数组。多人 5h/7d 详细曲线各人按不规则真实时间戳采样、彼此不对齐：取所有人时间戳**并集**升序作为统一 x 轴，每条 series 在缺失时间点填 `null`（uPlot 默认以 gap 呈现，必要时按 `spanGaps` 连接）。这是本次最实的一块新逻辑。多人「每日请求对比折线」x 已是共享 `dateAxis`、天然对齐，无需此步。

**决策 5：读数走跟随 tooltip + 静态 legend toggle + nearest-non-null 吸附。**
读数集中显示在**跟随鼠标的 tooltip**（`setCursor` 钩子自绘浮层）上，而不是底部原生 legend：多人时底部 legend 会铺一长串、大半是 `--`，又长又散，tooltip 更紧凑直观。**关闭 uPlot 原生 legend（`legend.show=false`），改用自绘图例**（`legendGroups` + `buildLegend`）：多人图里一个人只显示一个名字（按原样小写、不强制大写——避开全局 `th{text-transform:uppercase}` 命中 uPlot 原生 legend 的 `<th>` 把人名变大写的问题），点击一个名字用 `setSeries` 同时切换该人 5h + 7d 两条 series 显隐（移除旧手写 `is-dimmed`/`legend-toggle` 脚本）。各人时间戳不对齐、并集对齐后含 null 的曲线，用 `cursor.dataIdx` 让每条 series 的圆点高亮与 tooltip 读数都吸附到该人离光标最近的真实采样点，解决「峰值圆点不亮、读不到值」。`dataIdx` 分两层：横向极窄的尖峰里多个点 x 几乎重合、只按 x 最近会永远吸到靠下的点，故在很窄的 x 像素窗口内改取离鼠标「2D（x+y）最近」的真实点（鼠标移到竖线顶端即命中峰顶）；窗口外稀疏区只剩一个候选、行为与默认一致，窗口内无点 / 无鼠标像素时退回 nearest-non-null。tooltip 跳过被 toggle 隐藏或该处无值的 series。该交互对所有 uPlot 图（单人/多人、折线/柱状）统一。

**决策 6：按图表性质分工——折线/纵向柱 → uPlot，横向排行榜 → 自绘 SVG。**
纵向柱状（每日消息数）uPlot 用 `uPlot.paths.bars()` 原生支持，迁后获得 hover 读数且与折线统一栈。横向「周累计排行榜」每行是「人名 label + 水平进度条 + 数值」，uPlot 无原生横向 bar，强迁要 hack 轴对调、产出更差，且十字线/缩放/读数它一个用不上——故保留自绘 SVG。两类并存是按性质分工，不是临时凑合。

**决策 7：单人 5h/7d 空桶处理沿用现状语义。**
现状「只连有数据的桶、跨空桶相连」避免空桶把线拉回 0。迁 uPlot 时不向 data 注入空桶值（或填 `null` 并连接），保持相邻有效点直连的视觉，与现状一致。

**决策 8：纵向 bar 的 uPlot 落地细节。**
用 `uPlot.paths.bars({ size, align })` 画单系列柱；x 轴为离散「天」，配 bars 宽度与居中对齐，使观感与现状一致。柱顶数值标签 uPlot 不原生，用 `hooks.draw` 在每根柱顶绘制文字（读 series 值 + 坐标换算）。cursor 开启后悬停某天即在 legend 显示该天计数。

## Risks / Trade-offs

- [渲染模型由 SSR-SVG 变客户端 JS] → 禁用 JS 时 uPlot 图不显示。看板为本地交互页，且横向排行榜仍是 SVG，可接受。
- [内联 uPlot 使每个 HTML +~40KB] → 相对「离线 + 任意点读数」的收益可接受，且远小于 ECharts ~1MB。
- [多人时间戳并集对齐增加预处理与矩阵体积] → 点规模上千仍轻松，无性能顾虑。
- [纵向 bar 柱顶数值标签需自写 draw-hook 插件] → 中等增量；是迁纵向 bar 相对折线的额外成本。
- [测试需大改] → 断言从 `<path>`/`<rect>` 字符串改为「含 uPlot 容器 / 内联数据数组 / series 配置」存在性，是本次明确的工作量。
- [两套渲染并存（uPlot + 横向 bar 自绘）增加样式协调] → uPlot 主题色与轴/网格需与现有面板、横向 bar CSS 对齐，避免观感割裂。
- [vendored 资源未进 dist/files 会导致发布后缺库] → 在 tasks 中显式验证 dist 含资源、`npm pack` 清单含资源。
