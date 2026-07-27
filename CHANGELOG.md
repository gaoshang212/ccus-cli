# Changelog

## [0.2.3] - 2026-07-27

### 修复
- Codex 额度解析改按各窗口 `windowDurationMins` 认桶（300→5h、10080→7d），不再硬映射 primary→5h / secondary→7d：实测 app-server 可能把周额度放在 primary，旧逻辑导致 7d 恒为 null、5h 误填周值；`windowDurationMins` 缺失时退回原映射。

## [0.2.2] - 2026-07-27

### 变更
- README 的 Codex 安装说明订正 hook 信任流程：装完重启 Codex 后按 `hook need review` 提示信任（`Trust all and continue`，或 `1 Review hooks` 里找到 ccus 的 Stop hook 按 `t` 允许），不再需要手动 `/hooks`。

## [0.2.1] - 2026-07-27

### 变更
- 移除 aggregate 看板与聚合行结构中已无消费方的 Codex 额度明细列（看板排行榜 / 周表的 Codex 5h/7d 列、`AggregatedDailyRow.codex` / `AggregatedWeeklyRow.codex`）；Codex 额度仍叠加在 daily/weekly 主 usage 字段，bundle 导出的 `weeklySummary.codex` / `dailySummaries[].codex` 不变。

## [0.2.0] - 2026-07-27

### 新增
- 新增 Codex 额度采集：Codex `notify` / hooks.json `Stop` 回调调起隐藏命令 `__codex-hook` / `__codex-notify`，spawn `codex app-server` 经 JSON-RPC `account/rateLimits/read` 拉 5h / weekly 额度并落盘 `source="codex"` 事件，带 5 分钟 TTL 缓存、失败静默、Stop 路径兜底后台同步。
- 新增 `ccus install --codex`：一键把 ccus hook 挂进 `~/.codex/hooks.json` 的 `Stop` 事件（与 orca 等现有 hook 并列并发执行），支持 `--uninstall` / `--data-dir` / `--config`。
- 新增 Codex sessions 统计：扫描 `~/.codex/sessions` rollout，统计消息数 / 请求数 / token，接入导出与看板每日消息柱图。
- export / aggregate 接入 Codex：bundle 按 `source` 分流，Codex 额度单列到 `weeklySummary.codex` / `dailySummaries[].codex` 的 5h/7d peak/latest；`detail.csv` 加 `source` 列，daily/weekly CSV 额度列改为 Claude+Codex 合计。

### 变更
- export `schemaVersion` 升至 8；`aggregate` 兼容 v6/7/8，v6/v7 缺失的 codex 额度字段按 null/零值容错并从 `rawEvents` 重算。

## [0.1.26] - 2026-07-07

### 修复
- 智谱额度 extractor 改用 `number===5` 字段识别 5h 桶：5h 与周窗口重置时刻互不相关，此前按 `nextResetTime` 升序排序，当周桶重置早于 5h 时会把周桶当成 5h、5h 当成周桶，导致 5h/7d 互换（0.1.24 仅修了缺字段一种方向，本次为更根本的字段级识别）。

## [0.1.25] - 2026-07-01

### 新增
- `ccus api test` / `api status` / `api config` 在环境变量无 token 时，自动回退从 `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN` 读取，免去手动 export。

## [0.1.24] - 2026-07-01

### 修复
- 智谱额度 extractor 修复 5h/7d 槽位互换：5h 桶=0% 时智谱会省略该条的 `nextResetTime`，此前缺字段的那条被当成 weekly，导致 statusline 出现 `5h <weekly值> | 7d 0.0%` 的错位（对照 cc-switch v3.16.0 同类修复）。

## [0.1.23] - 2026-06-30

### 新增
- `ccus api`：第三方 API 模式，走智谱 GLM 等非官方订阅时主动拉取 5h/7d 额度填进 statusline 与导出；内置智谱 provider，支持自定义 provider；token 默认从环境变量读，带缓存、失败静默。
- `ccus api config --extractor-file`：custom provider 支持自定义 JS extractor 脚本，处理点分路径表达不了的响应结构（数组筛选/排序），返回值兼容 cc-switch 风格。

## [0.1.22] - 2026-06-18

### 新增
- 个人看板使用率趋势图新增「7d 分区叠加累计」曲线（走右侧自适应 Y 轴），顶部 7d 卡片主数值改为分区叠加累计值、小字显示峰值与最新值。

### 修复
- 7d 累计去毛刺增加采集间隙感知：短 stale 尖峰后紧跟采样间隙时也能正确抹平，避免误判额度 reset 导致累计虚高。

## [0.1.21] - 2026-06-12

### 变更
- `aggregate serve` 非根路径请求（如 `favicon.ico`）直接返回 404，不再触发完整计算。
- `loadWeeklyExportBundles` 改为并发读取文件（`Promise.all`），多文件读盘与解压同时进行。

### 修复
- 修复 uPlot category 轴刻度在插值点上显示多余标签的问题。

## [0.1.20] - 2026-06-12

### 新增
- dashboard 与 `aggregate serve` 的使用率折线图、每日消息数/请求数柱状图迁移至 uPlot：悬停任意位置显示十字线与跟随 tooltip 读数，多人图支持点击人名切换显隐，uPlot 资源内联进 HTML 离线可用。

### 变更
- `aggregate` 同一人同一天多台电脑的数据改为叠加合并：通过 `rawEvents` 中的 `session_id` 集合判断是否同台机器，不同机器的 userMessageCount / apiRequestCount / token 等累加字段直接相加，同台机器重复导出仍走去重（取最佳代表），daily × 人矩阵不再丢失多机数据。

## [0.1.19] - 2026-06-10

### 变更
- 发布 workflow 升级 `actions/checkout` / `actions/setup-node` 到 v5、构建 Node 升到 22，消除 Node 20 弃用告警。
- 重新发布以修正 npm `latest` 标签（此前 0.1.16 晚于 0.1.18 完成发布，把 `latest` 顶回了 0.1.16）。

## [0.1.18] - 2026-06-10

### 变更
- `aggregate serve` 看板顶部对比图从「周使用量峰值」改为 `sevenDayCumulativeUsagePct` 累计，默认 100% 满刻度、仅当有人超 100% 时放大刻度。

## [0.1.17] - 2026-06-10

### 新增
- `aggregate serve` 折线图：点击图例人名只高亮该人曲线，其余淡化，再次点击取消。
- `aggregate` 的 daily.csv / weekly.csv 及 serve 看板新增 `sevenDayCumulativeUsagePct`：7 天额度累计真实使用量（先去毛刺再分段峰谷和），detail.csv 不含此列。

## [0.1.16] - 2026-06-10

### 修复
- dashboard 趋势曲线改用桶内最大值（max）代替平均值（avg），峰值样本（如 57%）现在会正确显示在图上。

## [0.1.14] - 2026-06-06

### 修复
- `aggregate` 按天 winner 选取：有 transcript 数据（userMessageCount / apiRequestCount > 0）的 bundle 现在优先于仅有 sampleCount 的 bundle，避免新机器采样覆盖掉有真实消息的旧机器数据导致矩阵出现空格。

## [0.1.13] - 2026-06-05

### 修复
- `aggregate` 周聚合：同一个人在多台电脑、同一周不同天产生的用量现在会正确合进同一周（按天去重后上卷累加），不再只取单份导出导致漏算。

## [0.1.12] - 2026-06-05

### 新增
- `ccus sync config --suffix NAME` 给同步到目标目录的文件名加固定后缀，方便多台电脑同步到同一目录时互不覆盖；`--no-suffix` 移除后缀。

## [0.1.11] - 2026-06-05

### 新增
- 新增 `ccus sync` 定时同步：周期到了就导出当前周数据包并复制到目标目录的按周子目录，默认每 3 小时一次，周一额外归档上一整周；statusline 兜底后台触发（不阻塞）。`ccus sync config` 配置目标目录/周期、`ccus sync status` 查看状态、`ccus sync install` / `ccus sync uninstall` 注册或卸载每周五 18:00 的系统调度器（Windows schtasks，macOS/Linux 打印 cron 命令）。

## [0.1.10] - 2026-06-05

### 新增
- 新增 `ccus open` 命令，用系统文件管理器打开本地存储目录，`--print` 只输出路径不打开。

### 变更
- `aggregate` 支持同一个人多台电脑导出的 bundle 合并去重：累加类指标取最新导出那份、不相加，usage 从原始事件重算。

## [0.1.9] - 2026-06-04

### 变更
- `ccus update` 改为交互式升级：发现新版本时询问用户是否立即安装，确认后自动执行 `npm i -g ccus-cli@latest`。

## [0.1.8] - 2026-06-04

### 新增
- 新增 GitHub Actions 发布流程,推送 `v*` tag 时经 OIDC Trusted Publishing 自动构建并发布到 npm。

## [0.1.7] - 2026-06-04

### 新增
- statusline 的 `ctx` 段在 context 高占用时标红,按窗口大小分档(200K 默认 80%、1M 默认 50%),百分比与 token 阈值均可用 `CCUS_CTX_RED_*` 环境变量按档或通用配置。

## [0.1.6] - 2026-06-03

### 变更
- `export` bundle 改为紧凑 JSON,体积约降三分之一。
- `export` 默认输出 gzip 压缩的 `.json.gz`,`aggregate` 读取时兼容 `.json.gz` 与明文 `.json`。

## [0.1.5] - 2026-06-02

### 新增
- 新增更新检查:statusline 后台节流查询 npm 最新版本,有更新时行尾追加 `⬆ vX.Y.Z` 标记。
- 新增 `ccus update`(主动检查并提示升级命令)与 `ccus --version`。

## [0.1.4] - 2026-06-01

### 新增
- dashboard 使用率趋势图叠加 7d 曲线(实线 5h、虚线 7d)。
- 新增每日用户消息数柱状图,以及 `Latest 7d usage`、`用户消息数` 统计卡。

### 变更
- `dashboard serve` 默认改为 `this-week` 并补齐整周,x 轴按天展示 7 天。
- 跨多天窗口曲线改用小时桶、按自然日刻度;统计卡移除 Sessions/Workspaces。

## [0.1.3] - 2026-06-01

### 新增
- statusline 末尾显示当前 git 分支 `⎇ <branch>`,纯展示、不落盘、不进导出契约。
- 多人 dashboard 5h 曲线叠加 7d 周使用量,实线 5h、对比色虚线 7d,共用 Y 轴。

### 变更
- `export` 周度导出固定覆盖周一到周日,本周未结束也补齐整周。
