# Changelog

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
