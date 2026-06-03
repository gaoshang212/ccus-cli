# Changelog

## [0.1.6] - 2026-06-03

### 变更
- `export` bundle 改为紧凑 JSON,体积约降三分之一。

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
