# ccus

一个本地优先的 Claude Code statusline 使用率采集 CLI：

- `ccus statusline emit`：读取 Claude Code statusline 通过 `stdin` 传入的 JSON，输出 statusline 文本，并写入本地日志。
- `ccus dashboard build`：生成 Claude **5 小时使用量百分比**趋势的静态 HTML dashboard。
- `ccus dashboard open`：生成并打开 dashboard。
- `ccus dashboard serve`：直接启动本地 Web 页面，不用先手动生成 HTML 文件。
- `ccus export`：默认导出当前周的原始日志为 jsonl 文件。

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
ccus export --out ./week_2026-05-26_to_2026-06-01.jsonl
```

`serve` 会启动一个本地 HTTP 服务，默认监听 `127.0.0.1` 上的随机端口，并在每次请求时实时读取最新日志生成页面。

其中：

- `5 小时使用量百分比` 是 **展示指标**，来自 Claude 自身字段 `rate_limits.five_hour.used_percentage`
- `--range today / this-week / 24h` 是 **你要查看的采样历史时间窗口**
- 日志本身主要保存 `rawPayload` 与外部补充字段；分析列在导出和 dashboard 时实时从原始数据计算

导出规则：

- 默认导出 `this-week`
- 默认输出 `jsonl`
- 默认文件名带起止日期，例如：`export_2026-05-26_to_2026-06-01.jsonl`
- 不再支持其它导出格式

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
