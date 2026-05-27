# CLAUDE.md

本文件给进入 `ccus` 仓库工作的 Claude / Claude Code 使用，目标是让新会话能快速理解项目边界、数据契约和修改注意事项。

## 1. 项目是什么

`ccus` 是一个本地优先的 Claude Code statusline 使用率采集 CLI，主要能力有：

- 读取 Claude Code statusline 传入的 JSON payload
- 输出一行 statusline 文本，并把原始 payload 以本地日志形式落盘
- 基于本地日志生成 dashboard（build / open / serve）
- 导出当前周 bundle JSON（原始事件 + 周汇总 + 按天汇总）
- 聚合同一目录下多人导出的 bundle，生成 `detail.csv` / `daily.csv` / `weekly.csv`

## 2. 当前最重要的契约

### 2.1 statusline 官方契约

- `stdin`：Claude Code 传入 JSON
- `stdout`：返回 statusline 文本

不要把这个命令改成读取参数或输出多行日志到 stdout。

### 2.2 原始日志契约

持久化事件模型是 raw-first：

- `schemaVersion`（当前 statusline 事件写入版本为 `3`）
- `timestamp`
- `gitUserName`
- `gitUserEmail`
- `gitUserAccount`（email `@` 前的规范化用户名，仅在 statusline 落盘时写入；读旧日志时若缺失会从 email 派生）
- `rawPayload`

分析字段不直接持久化，而是在读时从 `rawPayload` 重新计算。

### 2.3 事件级语义

`StatuslineEvent` 是读时计算视图，不是最终导出契约。

- `usagePct`：Claude 的 **5 小时额度使用率**，来源 `rate_limits.five_hour.used_percentage`
- `sevenDayUsagePct`：Claude 的 **7 天额度使用率**，来源 `rate_limits.seven_day.used_percentage`
- `contextWindowPct` / `contextUsed` / `contextMax`：上下文窗口相关指标，不等于 5h usage

注意：

- 事件级仍使用 `usagePct` / `sevenDayUsagePct`
- 不要把对外导出字段名和事件级字段名混为一谈

### 2.4 当前导出契约（非常重要）

`ccus export` 当前默认导出 **bundle JSON**，不是 jsonl。

顶层结构：

- `schemaVersion`
- `generatedAt`
- `range`
- `identity`
- `rawEvents`
- `weeklySummary`
- `dailySummaries`

当前导出契约版本：

- `schemaVersion: 5`

当前对外 usage 字段：

- `weeklySummary.statusline.fiveHourLatestUsagePct`
- `weeklySummary.statusline.fiveHourPeakUsagePct`
- `weeklySummary.statusline.sevenDayUsagePct`
- `dailySummaries[].fiveHourLatestUsagePct`
- `dailySummaries[].fiveHourPeakUsagePct`
- `dailySummaries[].sevenDayUsagePct`

`averageUsagePct` 已从对外汇总/导出契约中移除。

如果再改这些字段名或字段集合，必须把导出 `schemaVersion` 再往上 bump，并同步测试和 README。

### 2.5 aggregate 输入契约

`ccus aggregate` 当前只接受：

- `schemaVersion: 5` 的 bundle JSON
- 通过 `ccus export` 导出的 `.json` 文件

旧 schema bundle 现在会被明确拒绝，不再静默读取。
不支持把 raw-event jsonl 直接作为 `aggregate` 输入。

### 2.6 aggregate 输出契约

三个 CSV 共用一个 `personKey` —— 来源于 `gitUserEmail` 在 `@` 前的规范化用户名（小写、清洗特殊字符），落到不出现真实 email 的导出列里。

- `detail.csv` 列：`personKey, timestamp, week, date, sessionId, workspaceName, modelName, fiveHourUsagePct, contextWindowPct, contextUsed, contextMax`
  - 历史上有的 `sourceFile`、`workspaceDir`、`statusLine`、`gitUserName`、`gitUserEmail` 已移除，不要再加回来
- `daily.csv` / `weekly.csv` 都包含 `fiveHourPeakUsagePct` / `fiveHourLatestUsagePct` / `sevenDayUsagePct` 三个 usage 列

## 3. 仓库结构

### 3.1 CLI 入口

- `src/cli.ts`

负责命令分发与主要编排：

- `ccus statusline emit`
- `ccus dashboard build`
- `ccus dashboard open`
- `ccus dashboard serve`
- `ccus export`
- `ccus aggregate`

### 3.2 核心库

- `src/lib/payload.ts`
  - 解析 statusline payload
  - 读出 `usagePct` / `sevenDayUsagePct` / context 指标
  - 生成 `StatuslineEvent`

- `src/lib/storage.ts`
  - 本地日志读写
  - 按天/分片存储

- `src/lib/dashboard.ts`
  - dashboard 摘要计算
  - 折线图数据桶
  - HTML 生成

- `src/lib/export.ts`
  - 周导出 JSON 生成
  - summary rows
  - 聚合 CSV 输出

- `src/lib/aggregate.ts`
  - 读取 bundle JSON
  - 从 bundle 展开 detail/daily/weekly 行
  - 当前会校验 `schemaVersion: 5`

- `src/lib/claude.ts`
  - 从 `~/.claude/projects/**/*.jsonl` 统计：
    - `userMessageCount`
    - `apiRequestCount`
    - `inputTokens`
    - `outputTokens`
    - `cacheReadInputTokens`

- `src/lib/git.ts`
  - 读取 git 用户名/邮箱
  - local 优先，必要时回退 global

### 3.3 类型源头

- `src/types.ts`

任何导出字段、聚合字段、dashboard 摘要字段变动，都先看这里。

### 3.4 测试

- `src/test/payload.test.ts`
- `src/test/dashboard.test.ts`
- `src/test/export.test.ts`
- `src/test/storage.test.ts`
- `src/test/claude.test.ts`
- `src/test/aggregate.test.ts`

## 4. 常用开发命令

安装与构建：

```bash
npm install
npm run build
```

源码测试：

```bash
npm run test:src
```

编译后测试：

```bash
npm test
```

真实导出 smoke：

```bash
node dist/cli.js export --data-dir "$env:LOCALAPPDATA\ccus"
```

真实聚合 smoke：

```bash
node dist/cli.js aggregate --input-dir "$env:LOCALAPPDATA\ccus\exports" --out-dir "$env:LOCALAPPDATA\ccus\aggregated"
```

## 5. 修改时的硬规则

### 5.1 不要破坏 raw-first 设计

日志中应尽量保留原始数据：

- 不要把大量分析字段重新写回日志
- 新分析字段优先在读取时计算

### 5.2 不要混淆 3 类 usage

这里至少有三层概念：

1. `usagePct`
   - Claude 的 5 小时额度使用率
2. `sevenDayUsagePct`
   - Claude 的 7 天额度使用率
3. `contextWindowPct`
   - context window 占用率

用户历史上多次强调过：

- 5h usage 不是“过去 5 小时范围”，而是 Claude 自己给出的 5 小时额度百分比
- context 不是 usage

### 5.3 改导出字段 = 改外部契约

只要改到以下任一层：

- `weeklySummary`
- `dailySummaries`
- aggregate 输出 CSV 列

就视为外部契约变更。必须同时做：

1. 更新 `src/types.ts`
2. 更新 `src/cli.ts`
3. 更新 `src/lib/export.ts`
4. 更新 `src/lib/aggregate.ts`
5. 更新测试
6. 更新 `README.md`
7. 视情况 bump `schemaVersion`

### 5.4 aggregate 不做宽松兼容

当前策略是 fail-fast：

- 只接受 `schemaVersion: 5`
- 旧 bundle 直接报错，让用户重新导出

如果你要改成向后兼容，请显式实现映射，不要默默放宽校验。

## 6. 当前已知产品语义

### 6.1 export

- 默认 `this-week`
- 默认输出一个 bundle `.json`
- 文件名前缀使用 git email 本地部分
- 文件名含开始与结束日期

### 6.2 bundle 内容

- `rawEvents`：原始持久化事件
- `weeklySummary`：整周汇总
- `dailySummaries`：按整周日期枚举，每天一条

即使某天没有 statusline 样本，该天也应该出现在 `dailySummaries` 中。

### 6.3 Claude 本地 transcript 统计来源

来源目录：

- `~/.claude/projects/**/*.jsonl`

统计口径：

- `userMessageCount`：非 meta 的 `type:user`
- `apiRequestCount`：带 `message.usage` 的 `type:assistant`
- token 统计来自 assistant usage 事件

## 7. 改动后最低验证要求

如果改了实现代码，至少跑：

```bash
npm run test:src
npm run build
```

如果改了导出/聚合契约，再额外做：

```bash
node dist/cli.js export --data-dir "$env:LOCALAPPDATA\ccus"
```

必要时再做：

```bash
node dist/cli.js aggregate --input-dir "$env:LOCALAPPDATA\ccus\exports" --out-dir "$env:LOCALAPPDATA\ccus\aggregated"
```

## 8. 给后续 Claude 的建议

- 先读 `src/types.ts`，再读 `src/cli.ts`
- 任何“字段名看起来差不多”的地方都不要凭感觉改
- 先分清事件级字段、导出字段、aggregate CSV 字段是不是同一层
- 如果用户再次要求改导出字段名，默认要考虑 `schemaVersion`
- 如果你看到 `averageUsagePct`，当前应把它视为旧字段，不应重新加回导出契约，除非用户明确要求
