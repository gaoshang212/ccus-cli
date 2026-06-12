# Spec: interactive-usage-charts

## Purpose

定义 ccus 看板（单人 dashboard 与多人 aggregate dashboard）中使用率图表的交互渲染规范，包括：基于 uPlot 的折线图与纵向柱状图渲染、鼠标悬停十字线与跟随 tooltip、自绘图例的显隐切换、离线内联可用性，以及渲染改造对外部契约的零影响约束。

## Requirements

### Requirement: 图表悬停读数

看板的使用率折线图与纵向柱状图 SHALL 由 uPlot 渲染，并在鼠标悬停于绘图区任意 x 位置时，通过十字线与**跟随鼠标的 tooltip** 显示该位置上各 series 的当前数值读数。读数 SHALL 不依赖鼠标精确落在某个采样点或某根柱上。

读数集中显示在跟随 tooltip 上；底部图例改为自绘图例（关闭 uPlot 原生 legend），多人图里**一个人只显示一个名字**（按原样小写、不强制大写），点击该名字 SHALL 同时切换该人所有 series（5h + 7d）的显隐。对各人时间戳不对齐、并集对齐后含缺失（null）的曲线，每条 series 的读数与高亮点 SHALL 吸附到该 series 离光标最近的真实采样点；横向极窄的尖峰里多点 x 几乎重合时，SHALL 在很窄的 x 像素窗口内按鼠标高度取 2D 最近的真实点（移到竖线顶端即命中峰值），而非呈现空缺或错误数值。

适用图表：单人看板 5h/7d 使用率趋势（折线）、单人看板每日消息数（纵向柱状）、多人看板 5h/7d 使用率详细曲线（折线）、多人看板每日用户请求数对比（折线）。

#### Scenario: 单人 5h/7d 折线悬停任意位置

- **WHEN** 用户在单人看板的 5h/7d 使用率趋势图绘图区内任意 x 位置悬停
- **THEN** 图表 SHALL 显示十字线定位该 x
- **AND** 跟随 tooltip SHALL 同时显示该位置上 5h 与 7d 两条线的当前百分比值

#### Scenario: 单人每日消息数纵向柱状悬停

- **WHEN** 用户在单人看板每日消息数柱状图绘图区内任意 x 位置悬停
- **THEN** 跟随 tooltip SHALL 显示该日期对应的用户消息数读数
- **AND** 每根柱顶 SHALL 标注其数值

#### Scenario: 多人 5h/7d 详细曲线悬停全显示

- **WHEN** 用户在多人看板 5h/7d 详细曲线绘图区内任意 x 位置悬停
- **THEN** 跟随 tooltip SHALL 列出当前位置上各人 5h 与 7d series 的值
- **AND** 某人在该 x 无精确采样点时，其读数与高亮点 SHALL 吸附到该人离光标最近的真实采样点（nearest-non-null），而非呈现空缺或错误数值

#### Scenario: 多人每日请求对比折线悬停

- **WHEN** 用户在多人看板每日用户请求数对比折线绘图区内任意 x 位置悬停
- **THEN** 跟随 tooltip SHALL 列出当前日期上各人的用户请求数读数

#### Scenario: 图例点击切换某人显隐

- **WHEN** 用户点击多人折线图自绘图例中的某个**人名**（一个人一项）
- **THEN** 该人的所有 series（5h 实线 + 7d 虚线）SHALL 在图中同时切换显隐
- **AND** 被隐藏的 series SHALL 不出现在跟随 tooltip 的读数里
- **AND** 图例中的人名 SHALL 按原样显示（小写），不强制大写

### Requirement: 横向排行榜保持自绘

多人看板「周使用量累计对比」横向排行榜 SHALL 继续以自绘 SVG 渲染，不纳入 uPlot（uPlot 无原生横向 bar，且该图为带标签的水平进度条排行榜，非坐标图）。

#### Scenario: 横向排行榜渲染不变

- **WHEN** `ccus aggregate serve` 渲染多人看板顶部的周使用量累计对比横向排行榜
- **THEN** 该图 SHALL 仍由自绘 SVG 渲染，行布局、排序与百分比标注保持原有行为

### Requirement: 图表离线内联可用

uPlot 渲染的图表所依赖的 uPlot 库与样式 SHALL 内联进生成的看板 HTML，使看板在无网络环境（含以 `file://` 打开 `dashboard build` 产物）时仍能完整渲染图表与悬停读数，不得依赖任何 CDN 或运行时网络请求。

#### Scenario: file:// 离线打开 build 产物

- **WHEN** 在无网络环境下用浏览器以 `file://` 打开 `dashboard build` 生成的 HTML
- **THEN** 折线与纵向柱状图 SHALL 正常渲染
- **AND** 悬停读数 SHALL 正常工作

#### Scenario: 发布包包含 uPlot 资源

- **WHEN** 通过 npm 安装 `ccus-cli` 后运行看板命令
- **THEN** 生成的 HTML SHALL 含内联的 uPlot 库与 CSS（vendored 资源随发布包分发）

### Requirement: 渲染改造不改对外契约

图表渲染改造 SHALL NOT 改变任何导出/聚合字段、CSV 列集合或 `schemaVersion`，亦 SHALL NOT 改变数据计算路（recompute / aggregate / export 逻辑）与数据源。

#### Scenario: 契约保持不变

- **WHEN** 完成图表迁移到 uPlot
- **THEN** `export` bundle 的字段集合与 `schemaVersion` SHALL 保持不变
- **AND** `daily.csv` / `weekly.csv` / `detail.csv` 的列集合 SHALL 保持不变
- **AND** 单人(storage) 与多人(bundle JSON) 的数据源 SHALL 保持不变
