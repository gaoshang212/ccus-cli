# ccus

一个本地优先的 Claude Code statusline 使用率采集 CLI：

- `ccus statusline emit`：读取 Claude Code statusline 通过 `stdin` 传入的 JSON，输出 statusline 文本，并写入本地日志。
- `ccus dashboard build`：生成 Claude **5 小时使用量百分比**趋势的静态 HTML dashboard。
- `ccus dashboard open`：生成并打开 dashboard。
- `ccus dashboard serve`：直接启动本地 Web 页面，不用先手动生成 HTML 文件。
- `ccus export`：默认导出当前周数据包，里面同时包含原始事件和按天维度的周汇总。
- `ccus aggregate`：读取一个目录里的多人 raw-event jsonl，输出明细、按天、按周三个 CSV。
- `ccus aggregate`：读取一个目录里的多人 export bundle json，输出明细、按天、按周三个 CSV。

## 安装

```bash
npm install
npm run build
```

## Claude Code statusline 配置

官方 statusline 命令契约是：`stdin` 传入 JSON，`stdout` 输出状态栏文本。

这里的核心指标不是 context window 百分比，而是 Claude payload 里的：

```json
{
  "rate_limits": {
    "five_hour": {
      "used_percentage": 23.5
    }
  }
}
```

也就是 `rate_limits.five_hour.used_percentage`。

示例配置：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node D:/workspace/nodejs/ccus/dist/cli.js statusline emit"
  }
}
```

如果已经全局安装或做了 `npm link`，也可以直接使用：

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
ccus statusline emit
ccus dashboard build --range today --out ./ccus-dashboard.html
ccus dashboard open --range today
ccus dashboard serve --range today --open
ccus export
ccus export --range today
ccus export --out ./alice_export_2026-05-26_to_2026-06-01.json
ccus aggregate --input-dir ./team-exports --out-dir ./team-report
```

`serve` 会启动一个本地 HTTP 服务，默认监听 `127.0.0.1` 上的随机端口，并在每次请求时实时读取最新日志生成页面。

其中：

- `5 小时使用量百分比` 是 **展示指标**，来自 Claude 自身字段 `rate_limits.five_hour.used_percentage`
- `--range today / this-week / 24h` 是 **你要查看的采样历史时间窗口**
- statusline 日志本身主要保存 `rawPayload` 与外部补充字段；默认导出时会同时保留原始事件，并额外汇总 `~/.claude/projects/**/*.jsonl` 中的会话 usage

导出规则：

- 默认导出 `this-week`
- 默认输出一个 `json` 数据包，里面同时包含 `rawEvents`、`weeklySummary`、`dailySummaries`
- 当前导出 bundle / weeklySummary 的 `schemaVersion` 为 `4`，用于标识已使用 `fiveHourLatestUsagePct`、`fiveHourPeakUsagePct`、`weeklyUsagePct` 字段的新导出契约
- 默认文件名会带 git email 的帐号名前缀和起止日期，例如：`alice_export_2026-05-26_to_2026-06-01.json`
- `userMessageCount` 来自 `~/.claude/projects/**/*.jsonl` 的非 meta `type:user` 事件
- `apiRequestCount` 与 token 指标来自 `~/.claude/projects/**/*.jsonl` 中带 `message.usage` 的 `type:assistant` 事件
- `dailySummaries` 会按每天输出消息数、请求数、token 和当天 statusline usage 摘要
- 不再支持其它导出格式

多人汇总：

- 输入目录放很多通过 `ccus export` 导出的 bundle `.json` 文件
- `aggregate` 目前只接受 `schemaVersion: 4` 的 bundle；旧导出请先用当前版本重新 `ccus export`
- `ccus aggregate --input-dir DIR --out-dir DIR`
- 输出三个文件：
  - `detail.csv`：来自每个 bundle 的 `rawEvents`
  - `daily.csv`：直接来自每个 bundle 的 `dailySummaries`
  - `weekly.csv`：直接来自每个 bundle 的 `weeklySummary`

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

## 测试

```bash
npm run test:src
npm run build
npm test
```
