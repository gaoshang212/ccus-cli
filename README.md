# ccus

一个本地优先的 Claude Code statusline 使用率采集 CLI：

- `ccus install`：自动把 statusLine 命令写进 Claude Code 的 `settings.json`，省去手动改配置。
- `ccus statusline emit`：读取 Claude Code statusline 通过 `stdin` 传入的 JSON，输出 statusline 文本，并写入本地日志（加 `--no-store` / `--no-log` 则只输出、不落盘）。
- `ccus dashboard serve`：直接启动本地 Web 页面，不用先手动生成 HTML 文件。
- `ccus export`：默认导出当前周数据包，里面同时包含原始事件和按天维度的周汇总。
- `ccus aggregate`：读取一个目录里的多人 export bundle json，输出明细、按天、按周三个 CSV。
- `ccus aggregate serve`：同样以 bundle 目录为输入，启动本地多人 dashboard 页面，不落地任何文件。

> **支持范围**：`ccus statusline emit` 依赖 Claude Code 的 statusLine 机制（从 `stdin` 读 JSON、向 `stdout` 回一行文本），**只在命令行版 Claude Code（CLI / 终端）里生效**。
>
> Claude **桌面版** 和 **VS Code 插件** 都不支持 statusLine，因此不会调用 `ccus statusline emit`，也就采集不到使用率数据。

## 安装

全局安装（statusline 每次渲染都会调用，推荐全局装好，避免 `npx` 的启动开销）：

```bash
npm install -g ccus-cli
```

要求 Node.js >= 20。

## 快速开始

全局安装后，一条命令把 statusline 接进 Claude Code：

```bash
ccus install
```

然后照常使用 Claude Code，statusline 会显示 5 小时额度使用率（`5h`）、7 天额度使用率（`7d`）、context window 占用百分比（`ctx`）、模型名、工作区名，以及当前 git 分支（`⎇ <branch>`，实时读取，非 git 仓库或处于 detached HEAD 时省略该段）；原始 payload 也会落到本地日志，供后续 dashboard / export 使用。

攒了一段时间数据后，最常用的几条命令：

```bash
ccus export                     # 导出当前周数据包（this-week）
ccus export lw                  # 导出上一整周（last-week，周一到周日）
ccus export tw                  # 导出本周（等价于默认 ccus export）

ccus dashboard serve            # 启动本地页面，默认看本周（this-week）的 5 小时使用率曲线与每日用户消息数

ccus aggregate --input-dir ./team-exports   # 多人的数据汇总，可以导出 detail.csv、daily.csv、weekly.csv 三个维度的文件
ccus aggregate serve --input-dir ./team-exports #直接打开一个看板
```

### 一键安装（推荐）

不想手动改配置时，直接运行：

```bash
ccus install
```

行为：

- 默认写入 `~/.claude/settings.json`（可用 `--settings PATH` 覆盖；遵循 `CCUS_CLAUDE_DATA_DIR`）
- 默认写入的命令是 `ccus statusline emit`（需要先全局安装，让 PATH 上能找到 `ccus`）
- 只覆盖 `statusLine` 字段（保留其下已有的 `padding` 等键），其它顶层设置原样保留
- 已存在且命令一致时显示 `already configured`，被替换时会回显旧命令
- `settings.json` 无法解析为 JSON 时直接报错，不会覆盖文件
- `--command CMD` 可完全自定义命令；`--data-dir PATH` 会在默认命令后追加 `--data-dir`，让采样落到指定目录

### 手动配置

也可以手动在 `settings.json` 里写：

```json
{
  "statusLine": {
    "type": "command",
    "command": "ccus statusline emit"
  }
}
```

## 常用命令

```bash
ccus install
ccus install --settings ~/.claude/settings.json
ccus statusline emit
ccus statusline emit --no-store   # 只渲染并输出状态行，不写本地日志（别名 --no-log）
ccus dashboard build --range today --out ./ccus-dashboard.html
ccus dashboard open --range today
ccus dashboard serve --range today --open
ccus export
ccus export --range today
ccus export --range last-week
ccus export lw                 # 位置参数简写，等价于 --range last-week
ccus export tw                 # 等价于 --range this-week
ccus export --out ./alice_export_2026-05-26_to_2026-06-01.json
ccus aggregate --input-dir ./team-exports --out-dir ./team-report
ccus aggregate serve --input-dir ./team-exports
```

`serve` 会启动一个本地 HTTP 服务，默认监听 `127.0.0.1` 上的随机端口，并在每次请求时实时读取最新日志生成页面。`serve` 默认查看 `this-week`（整周）使用量曲线（`build` / `open` 仍默认 `today`），可用 `--range` 覆盖。

其中：

- `5 小时使用量百分比` 是 **展示指标**，来自 Claude 自身字段 `rate_limits.five_hour.used_percentage`
- 使用率趋势图会在同一张图上叠加两条线：实线为 5 小时使用率（`rate_limits.five_hour`），虚线为 7 天使用率（`rate_limits.seven_day`），两者各自独立按时间桶聚合
- 页面新增 **每日用户消息数** 柱状图：按自然日统计的真实用户请求数，口径与导出契约的 `userMessageCount` 一致（来自 `~/.claude/projects/**/*.jsonl`），不是 statusline 采样数，也仅用于页面展示、不进任何导出/聚合契约
- 跨多天的窗口（如 `this-week` / `last-week`）使用率曲线会自动改用小时桶聚合，避免一周生成上千个点，且 x 轴改为按自然日（月-日）打刻度
- 顶部统计卡展示 `Latest 5h usage`、`Peak 5h usage`、`Latest 7d usage`（含峰值）、`用户消息数`（窗口内每日真实用户请求数合计）
- `--range today / this-week / last-week / 24h` 是 **你要查看的采样历史时间窗口**（`last-week` 指上一个完整周一到周日）
- statusline 日志本身主要保存 `rawPayload` 与外部补充字段；默认导出时会同时保留原始事件，并额外汇总 `~/.claude/projects/**/*.jsonl` 中的会话 usage

## 导出

- 默认导出 `this-week`；如需导出上一个完整周（周一到周日），用 `--range last-week`，或位置参数简写 `ccus export lw`（`tw` = 本周）
- 周度导出固定覆盖**完整一周（周一到周日）**：`this-week` 即使本周还没过完、后面几天还没有任何数据，文件名的起止日期也会补齐到本周日，`dailySummaries` 同样按整周 7 天逐日输出
- 默认输出一个 `json` 数据包，里面同时包含 `rawEvents`、`weeklySummary`、`dailySummaries`
- 当前导出 bundle / weeklySummary 的 `schemaVersion` 为 `6`，用于标识已使用 `fiveHourLatestUsagePct`、`fiveHourPeakUsagePct`、`sevenDayLatestUsagePct`、`sevenDayPeakUsagePct` 字段的新导出契约
- 默认文件名会带 git email 的帐号名前缀和起止日期，例如：`alice_export_2026-05-26_to_2026-06-01.json`
- `userMessageCount` 来自 `~/.claude/projects/**/*.jsonl` 的非 meta `type:user` 事件
- `apiRequestCount` 与 token 指标来自 `~/.claude/projects/**/*.jsonl` 中带 `message.usage` 的 `type:assistant` 事件
- `dailySummaries` 会按每天输出消息数、请求数、token 和当天 statusline usage 摘要
- 不再支持其它导出格式

## 多人汇总

- 输入目录放很多通过 `ccus export` 导出的 bundle `.json` 文件
- `aggregate` 目前只接受 `schemaVersion: 6` 的 bundle；旧导出请先用当前版本重新 `ccus export`
- `ccus aggregate --input-dir DIR --out-dir DIR`
- 输出三个文件：
  - `detail.csv`：来自每个 bundle 的 `rawEvents`，`contextUsedM` / `contextMaxM` 为单条事件的 context window token；另附带 `inputTokensM` / `outputTokensM` / `cacheReadInputTokensM`（按 `date` 取自当天 `dailySummaries` 的日总量，同一天多行会重复，不能按行求和）
  - `daily.csv`：直接来自每个 bundle 的 `dailySummaries`
  - `weekly.csv`：直接来自每个 bundle 的 `weeklySummary`
- CSV 里所有以 token 计的列（context 与 in/out/cache）都以百万（M）为单位（原始值除以 1,000,000），列名统一带 `M` 后缀；`contextWindowPct` 仍是百分比
- 想直接查看团队多人 dashboard，可以用 `ccus aggregate serve --input-dir DIR [--port 0] [--host 127.0.0.1]`：默认监听 `127.0.0.1` 上的随机端口，启动后会自动用系统默认浏览器打开，每次请求实时读取目录里的 bundle，不写入任何文件

## 调试

出问题时（比如 statusline 不出数据、导出/聚合结果不对），可以打开详细日志：

- 给任意命令加 `--verbose`（或 `--debug` / `-v`），例如 `ccus export --verbose`、`ccus aggregate --input-dir DIR --verbose`
- 或设置环境变量 `CCUS_DEBUG=1`，对 Claude Code 自动调用的 `ccus statusline emit` 尤其方便（无法临时加参数时）

注意：

- 调试日志一律输出到 **stderr**，stdout 仍然只输出正常结果（statusline 单行文本 / 文件路径），所以加上 `--verbose` 不会破坏 statusline 渲染
- 平时 `ccus statusline emit` 即使内部出错也会静默降级输出兜底文本；开启调试后会把真正的错误堆栈打到 stderr，便于定位

## 默认数据目录

- Windows: `%LOCALAPPDATA%\\ccus`
- macOS: `~/Library/Application Support/ccus`
- Linux: `$XDG_DATA_HOME/ccus` 或 `~/.local/share/ccus`

## 当前日志记录字段

- `timestamp`
- `gitUserName`
- `gitUserEmail`
- `schemaVersion`
- `rawPayload`

## 开发

从源码构建：

```bash
npm install
npm run build
```

测试：

```bash
npm run test:src    # 直接跑 TypeScript 源码测试（tsx）
npm run build       # 编译到 dist
npm test            # 跑编译后的测试
```

发布到 npm 时只包含运行时产物（`dist` 下的 `cli.js`、`lib/**/*.js`、`types.js`）与 `README.md`、`package.json`；源码、测试、sourcemap、内部文档不会被打包。
