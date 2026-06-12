# ccus

一个本地优先的 Claude Code statusline 使用率采集 CLI：

- `ccus install`：自动把 statusLine 命令写进 Claude Code 的 `settings.json`，省去手动改配置。
- `ccus statusline emit`：读取 Claude Code statusline 通过 `stdin` 传入的 JSON，输出 statusline 文本，并写入本地日志（加 `--no-store` / `--no-log` 则只输出、不落盘）。
- `ccus dashboard serve`：直接启动本地 Web 页面，不用先手动生成 HTML 文件。
- `ccus export`：默认导出当前周数据包（gzip 压缩的 `.json.gz`），里面同时包含原始事件和按天维度的周汇总。
- `ccus aggregate`：读取一个目录里的多人 export bundle（`.json.gz` 或 `.json`），输出明细、按天、按周三个 CSV。
- `ccus aggregate serve`：同样以 bundle 目录为输入，启动本地多人 dashboard 页面，不落地任何文件。
- `ccus sync`：定时把当前周数据包导出并复制到一个目标目录（如团队共享盘），目标目录下按周自动建子目录；日常由 statusline 兜底触发，也可挂系统计划任务做到严格每天定时。
- `ccus open`：用系统文件管理器打开 ccus 本地存储目录（事件日志、exports、dashboard 都在里面）；加 `--print` 只输出目录路径、不打开。
- `ccus update`：主动检查 npm 上是否有新版本，有则提示手动升级命令；`ccus --version` 查看当前版本。

> **支持范围**：`ccus statusline emit` 依赖 Claude Code 的 statusLine 机制（从 `stdin` 读 JSON、向 `stdout` 回一行文本），**只在命令行版 Claude Code（CLI / 终端）里生效**。
>
> Claude **桌面版** 和 **VS Code 插件** 都不支持 statusLine，因此不会调用 `ccus statusline emit`，也就采集不到使用率数据。

## 安装

全局安装（statusline 每次渲染都会调用，推荐全局装好，避免 `npx` 的启动开销）：

```bash
npm install -g ccus-cli
```

要求 Node.js >= 20。

## 更新检查

ccus 通过 npm 全局安装，自带一个轻量的更新检查：

- statusline 渲染时会**异步、节流（每天最多一次）**地向 npm registry 查询最新版本，结果缓存到数据目录下的 `update-check.json`。检查在 detached 后台进程里完成，**不阻塞 statusline、不污染单行输出**。
- 一旦发现有更新，statusline 行尾会追加一个小标记，例如 `… | ⏱ 11:44 | ⬆ v0.1.5`。
- 看到标记后手动升级即可：

```bash
npm i -g ccus-cli@latest
```

也可以随时主动检查：

```bash
ccus update        # 立即查 registry，有新版本则打印升级命令
ccus --version     # 查看当前安装的版本
```

> 出于稳妥考虑，ccus **只提示、不自动替你执行全局安装**。如需走私服或镜像（如 npmmirror），设置环境变量 `CCUS_REGISTRY` 指向对应 registry 即可。

## 快速开始

全局安装后，一条命令把 statusline 接进 Claude Code：

```bash
ccus install
```

然后照常使用 Claude Code，statusline 会显示 5 小时额度使用率（`5h`）、7 天额度使用率（`7d`）、context window 占用百分比（`ctx`）、模型名、工作区名，以及当前 git 分支（`⎇ <branch>`，实时读取，非 git 仓库或处于 detached HEAD 时省略该段）；原始 payload 也会落到本地日志，供后续 dashboard / export 使用。

> **ctx 高占用标红（按窗口大小分档）**：当 context 占用偏高时，`ctx` 段会整段标红提醒。触发条件为「百分比超阈值」或「已用 token 超阈值」任一满足。
>
> ccus 会根据 `contextMax` 自动判断当前是哪种上下文窗口，并套用各自独立的挡位（`contextMax > 400K` 视为 1M 档，否则按 200K 档）：
>
> | 档位 | 默认百分比阈值 | 默认 token 阈值 | 百分比环境变量 | token 环境变量 |
> | --- | --- | --- | --- | --- |
> | 200K 窗口 | `80`（约 160K 标红） | 不启用 | `CCUS_CTX_RED_PCT_200K` | `CCUS_CTX_RED_TOKENS_200K` |
> | 1M 窗口 | `50`（约 500K 标红） | 不启用 | `CCUS_CTX_RED_PCT_1M` | `CCUS_CTX_RED_TOKENS_1M` |
>
> 阈值优先级：**档位专属环境变量 > 通用环境变量（`CCUS_CTX_RED_PCT` / `CCUS_CTX_RED_TOKENS`）> 档位内置默认**。token 阈值支持 `120000` / `120k` / `0.5m` 写法。例如：
>
> - 只想让 200K 窗口在 70% 标红：设 `CCUS_CTX_RED_PCT_200K=70`。
> - 让 1M 窗口已用 token 超过 600K 就标红：设 `CCUS_CTX_RED_TOKENS_1M=600k`。
> - 两档统一用同一个百分比阈值：设通用 `CCUS_CTX_RED_PCT`（不设专属变量时生效）。
>
> 标红只是 statusline 的颜色展示，不改变 stdin/stdout 文本契约，也不落盘、不进任何导出/聚合契约。

攒了一段时间数据后，最常用的几条命令：

```bash
ccus export                     # 导出当前周数据包（this-week）
ccus export lw                  # 导出上一整周（last-week，周一到周日）
ccus export tw                  # 导出本周（等价于默认 ccus export）

ccus dashboard serve            # 启动本地页面，默认看本周（this-week）的 5 小时使用率曲线与每日用户消息数

ccus aggregate --input-dir ./team-exports   # 多人的数据汇总，可以导出 detail.csv、daily.csv、weekly.csv 三个维度的文件
ccus aggregate serve --input-dir ./team-exports #直接打开一个看板

ccus sync config --target ./team-exports    # 配置同步目标目录（之后 statusline 会兜底定时同步）
ccus sync                                   # 立即同步一次
ccus sync status                            # 查看同步配置与上次同步时间
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
ccus export --out ./alice_export_2026-05-26_to_2026-06-01.json   # --out 指定非 .gz 路径时写明文 JSON
ccus aggregate --input-dir ./team-exports --out-dir ./team-report
ccus aggregate serve --input-dir ./team-exports
```

`serve` 会启动一个本地 HTTP 服务，默认监听 `127.0.0.1` 上的随机端口，并在每次请求时实时读取最新日志生成页面。`serve` 默认查看 `this-week`（整周）使用量曲线（`build` / `open` 仍默认 `today`），可用 `--range` 覆盖。

其中：

- `5 小时使用量百分比` 是 **展示指标**，来自 Claude 自身字段 `rate_limits.five_hour.used_percentage`
- 使用率趋势图会在同一张图上叠加两条线：实线为 5 小时使用率（`rate_limits.five_hour`），虚线为 7 天使用率（`rate_limits.seven_day`），两者各自独立按时间桶聚合
- **折线与纵向柱状图均由 [uPlot](https://github.com/leeoniya/uPlot) 渲染**：鼠标在绘图区**任意位置**悬停即可通过十字线 + **跟随鼠标的 tooltip** 看到该处各条线的当前读数（不必精确落在采样点上；遇到几乎垂直的窄尖峰，把鼠标移到竖线顶端即可读到峰值）；纵向柱还会在每根柱顶标注数值。底部为**自绘图例**（实时读数集中在 tooltip 里）。uPlot 库与样式已**内联进生成的 HTML**，`dashboard build` 产物用 `file://` 离线打开也能完整渲染与交互，不依赖任何 CDN
- 页面新增 **每日用户消息数** 纵向柱状图：按自然日统计的真实用户请求数，口径与导出契约的 `userMessageCount` 一致（来自 `~/.claude/projects/**/*.jsonl`），不是 statusline 采样数，也仅用于页面展示、不进任何导出/聚合契约
- 跨多天的窗口（如 `this-week` / `last-week`）使用率曲线会自动改用小时桶聚合，避免一周生成上千个点；x 轴刻度由 uPlot 按时间跨度自适应（短窗口显示 `HH:mm` **24 小时制**、跨天的刻度再补一行日期），不用 am/pm
- 顶部统计卡展示 `Latest 5h usage`、`Peak 5h usage`、`Latest 7d usage`（含峰值）、`用户消息数`（窗口内每日真实用户请求数合计）
- `--range today / this-week / last-week / 24h` 是 **你要查看的采样历史时间窗口**（`last-week` 指上一个完整周一到周日）
- statusline 日志本身主要保存 `rawPayload` 与外部补充字段；默认导出时会同时保留原始事件，并额外汇总 `~/.claude/projects/**/*.jsonl` 中的会话 usage

## 导出

- 默认导出 `this-week`；如需导出上一个完整周（周一到周日），用 `--range last-week`，或位置参数简写 `ccus export lw`（`tw` = 本周）
- 周度导出固定覆盖**完整一周（周一到周日）**：`this-week` 即使本周还没过完、后面几天还没有任何数据，文件名的起止日期也会补齐到本周日，`dailySummaries` 同样按整周 7 天逐日输出
- 默认输出一个 `json` 数据包，里面同时包含 `rawEvents`、`weeklySummary`、`dailySummaries`
- 导出文件内容为**紧凑 JSON**（无缩进），并默认 **gzip 压缩**后写成 `.json.gz`；gzip 与紧凑化都只是存储/展示层变化，解压后的字段集合与 `schemaVersion` 不变
- 默认写 `.json.gz`；若用 `--out` 指定一个非 `.gz` 结尾的路径，则按明文 JSON 写出（不压缩）
- 当前导出 bundle / weeklySummary 的 `schemaVersion` 为 `6`，用于标识已使用 `fiveHourLatestUsagePct`、`fiveHourPeakUsagePct`、`sevenDayLatestUsagePct`、`sevenDayPeakUsagePct` 字段的新导出契约
- 默认文件名会带 git email 的帐号名前缀和起止日期，例如：`alice_export_2026-05-26_to_2026-06-01.json.gz`
- `userMessageCount` 来自 `~/.claude/projects/**/*.jsonl` 的非 meta `type:user` 事件
- `apiRequestCount` 与 token 指标来自 `~/.claude/projects/**/*.jsonl` 中带 `message.usage` 的 `type:assistant` 事件
- `dailySummaries` 会按每天输出消息数、请求数、token 和当天 statusline usage 摘要
- 不再支持其它导出格式

## 多人汇总

- 输入目录放很多通过 `ccus export` 导出的 bundle 文件，`.json.gz`（gzip 压缩）与明文 `.json` 都能识别，gzip 文件读取时自动解压
- `aggregate` 目前只接受 `schemaVersion: 6` 的 bundle；旧导出请先用当前版本重新 `ccus export`
- 同一个人在多台电脑上各自导出 bundle 时会自动合并去重：去重以**天**为粒度，对每个「同人同天」取 `generatedAt` 最新的那份导出，避免同一台机器重复导出或周与周重叠造成翻倍；**周汇总不取整周单份，而是把按天去重后的各天数据上卷累加**，所以多台电脑在不同天产生的用量会正确合进同一周。usage（5h / 7d）从选中事件按真实时间戳重算（peak 取 max、latest 取最新）
- `ccus aggregate --input-dir DIR --out-dir DIR`
- 输出三个文件：
  - `detail.csv`：来自 winner bundle 的 `rawEvents`（同人同天只展开最新那份的事件），`contextUsedM` / `contextMaxM` 为单条事件的 context window token；另附带 `inputTokensM` / `outputTokensM` / `cacheReadInputTokensM`（按 `date` 取自当天 `dailySummaries` 的日总量，同一天多行会重复，不能按行求和）
  - `daily.csv`：同人同天取最新导出 bundle 的 `dailySummaries`，usage 从该 bundle 当天事件重算
  - `weekly.csv`：把同人同周的各天 winner（已按天去重）上卷累加得到，usage 从该周全部 winner 天的事件重算
- `daily.csv` / `weekly.csv` 还各带一列 `sevenDayCumulativeUsagePct`：7 天额度的**累计真实使用量**，把锯齿波（涨到峰值→窗口重置归零→再涨）还原成实际消耗。计算分两层：先**去毛刺**（把持续短于 2 分钟的 stale 瞬时读数尖峰抹平，只保留真实持续的水平），再做**分段峰谷和**（按 reset 跌破段峰值一半切成上升段，每段累加「段内峰值−谷值」）。以百分比累加表达、可大于 100（用掉多于一个 7d 额度）。对 ±1 采样抖动和 stale 读数尖峰都鲁棒，不会被噪声虚增
  - 该列**绕开按天 winner**，对同一个人**所有机器、所有周**的 bundle `rawEvents` 先按时间合并去重成一条账号级曲线再算，绝不分机相加（同账号 7d 额度共享）
  - 区间内第一个有效样本无前值、不贡献增量，所以 **`daily.csv` 逐行相加只是对全局总量的近似**（跨天边界增量不计入单天）；`weekly.csv` 在整周连续算、把跨天增量也计入，更连续，恒有 `weekly ≥ Σ 同周 daily`，想要更准的总量请看 weekly 这列
  - 无有效样本写空（`null`），有样本但无净增长写 `0`；`detail.csv` 不含此列（单事件行不承载区间累计语义）
- CSV 里所有以 token 计的列（context 与 in/out/cache）都以百万（M）为单位（原始值除以 1,000,000），列名统一带 `M` 后缀；`contextWindowPct` 仍是百分比
- 想直接查看团队多人 dashboard，可以用 `ccus aggregate serve --input-dir DIR [--port 0] [--host 127.0.0.1]`：默认监听 `127.0.0.1` 上的随机端口，启动后会自动用系统默认浏览器打开，每次请求实时读取目录里的 bundle，不写入任何文件
  - 多人「5h/7d 使用率详细曲线」与「每日用户请求数对比」两张折线同样由 uPlot 渲染，悬停任意位置即可在**跟随 tooltip** 里看到当前位置**各人**的读数。底部图例**一个人只显示一个名字**（小写），点击该名字会同时切换该人 5h + 7d 两条线的显隐。各人按真实时间戳采样、彼此不对齐的曲线会先做**时间戳并集对齐**（缺失点留空而非补 0）再绘制；悬停时每条线的读数与高亮点会**吸附到该人离光标最近的真实采样点**，横向重合的尖峰按鼠标高度做 2D 命中，所以任意位置都能读到每个人的值、峰值圆点也会亮
  - 「周使用量累计对比」是**横向排行榜**，仍保持自绘 SVG（它是带标签的水平进度条排行，uPlot 无原生横向 bar，不纳入迁移）
  - uPlot 库同样内联，离线可用

## 定时同步

把每个人的 `ccus export` 攒到一个共享目录（团队网盘 / 共享盘）通常是手动的，容易漏。`ccus sync` 用来自动化这一步：周期到了就 `export` 一次，并把导出文件**复制**到目标目录下**按周命名的子目录**里。

```bash
ccus sync config --target ./team-exports         # 配置同步目标目录（默认周期 3h）
ccus sync config --interval daily                # 改周期，可写 3h（默认）/ daily / 6h / 30m
ccus sync config --suffix laptop                 # 给目标文件名加机器后缀，区分多台电脑
ccus sync config --no-suffix                     # 移除已配置的机器后缀
ccus sync config                                 # 不带参数：打印当前配置
ccus sync                                        # 用已存配置立即同步一次
ccus sync install                                # 注册系统调度器：每周五 18:00 自动同步（Windows 直接创建计划任务）
ccus sync uninstall                              # 卸载系统调度器
ccus sync status                                 # 查看目标目录、周期、上次同步时间、是否到期
```

行为：

- **目标目录按周建子目录**：子目录名形如 `2026_06_01_2026_06_07`（该周周一~周日，全下划线），不存在时自动创建。
- **周一归档上一周**：周一同步时会额外把刚结束的上一整周（`last-week`）导出并归档到对应的上一周子目录（周一是第一个能拿到完整上一周数据的日子）；同一天内多次同步用 `sync-state.lastArchivedWeek` 去重，不重复归档。
- **复制语义**：本地 `data-dir/exports` 仍保留一份，目标目录再放一份，本地照旧可 `aggregate` / `dashboard`。导出产物与 `ccus export` 完全一致，目标目录可直接喂给 `ccus aggregate`。
- **机器后缀**：`ccus sync config --suffix laptop` 会在**目标目录副本**的文件名扩展名前加 `-laptop`（如 `…_to_2026-06-07-laptop.json.gz`），本地原文件名不变。同一个人多台电脑同步到同一目标目录时，靠后缀让各机器的文件互不覆盖、都保留下来，正好供 `ccus aggregate` 按 personKey 合并去重。用 `ccus sync config --no-suffix` 移除后缀。
- **配置与同步分离**：`ccus sync config` 只读写配置（`--target` / `--interval` / `--range` 写进数据目录下的 `sync-config.json`，可手编；不带参数则打印当前配置）；`ccus sync` 只用已存配置执行一次同步。上次同步时间记录在 `sync-state.json`。
- **周期**：默认 `3h`（每 3 小时最多同步一次的滚动周期）；也支持 `daily`（按**自然日**判断——同一天内不重复同步，跨到下一天才再同步）与 `<N>h` / `<N>m` 的滚动周期。

### 两种触发方式

1. **statusline 兜底（零配置）**：配置过目标目录后，每次 statusline 渲染都会检查是否到周期，到了就 spawn 一个 detached 后台进程静默执行同步，**不阻塞 statusline、不污染单行输出**（与更新检查同款机制）。
   - 局限：statusline 只在你**使用 Claude Code** 时触发。某天完全不开 Claude Code，则当天不会自动同步——但那天也没有新数据，下次任意一次交互都会把整周最新 bundle 重新覆盖同步，不丢数据。
2. **系统调度器（不依赖是否开 Claude Code）**：如果要做到「哪怕一整天不碰 Claude Code，也在固定时间准时跑一次」，用 `ccus sync install` 一键注册一个**每周五 18:00** 跑 `ccus sync` 的系统调度器：

   ```bash
   ccus sync install          # Windows 用 schtasks 创建计划任务（任务名 ccus-sync）
   ccus sync install --print  # 只打印将执行的命令、不实际安装
   ccus sync uninstall        # 卸载该调度器（--print 只打印不执行）
   ```

   - **Windows** 会真正创建/删除计划任务；也可手动 `schtasks /delete /tn ccus-sync /f`。
   - **macOS / Linux** 不自动改系统，`ccus sync install` 会打印一条 cron 命令（`0 18 * * 5 …`）让你手动 `crontab` 安装，避免误改已有 crontab。

   > 记得先 `ccus sync config --target DIR` 配好目标目录，调度任务才有地方可同步。

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
