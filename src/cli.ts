#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { buildDashboardHtml } from "./lib/dashboard";
import { summarizeEvents } from "./lib/dashboard";
import { buildAggregateDashboardHtml } from "./lib/aggregate-dashboard";
import { findActiveSessionFiles, summarizeClaudeProjectUsage, summarizeClaudeProjectUsageByDay } from "./lib/claude";
import { buildAggregatedDailyCsv, buildAggregatedDetailCsv, buildAggregatedWeeklyCsv, buildSummaryRows, buildWeeklyExportBundleJson, writeGzipFile, writeTextFile } from "./lib/export";
import { buildAggregatedDailyRows, buildAggregatedDetailRows, buildAggregatedWeeklyRows, loadWeeklyExportBundles } from "./lib/aggregate";
import { debugLog, resolveDebugEnabled, setDebugEnabled } from "./lib/debug";
import { readGitBranch, readGitIdentity } from "./lib/git";
import { installStatusline } from "./lib/install";
import { readStdin } from "./lib/io";
import { openInBrowser, openPath } from "./lib/open";
import { computeStatuslineEvent, createPersistedStatuslineEvent, extractWorkspaceDir, parseStatuslinePayload } from "./lib/payload";
import { getClaudeSettingsPath, getDashboardDir, getDefaultDataDir } from "./lib/paths";
import { installScheduler, uninstallScheduler } from "./lib/scheduler";
import { applyQuotaToPayload, fetchQuota, readApiConfig, readApiQuotaCacheSync, readClaudeSettingsEnvTokenSync, resolveApiQuota, resolveApiToken, resolveApiTokenWithSettings, writeApiConfig } from "./lib/api-mode";
import { isSyncDue, maybeSpawnBackgroundSync, performSync, readSyncConfig, readSyncStateSync, sanitizeSuffix, writeSyncConfig } from "./lib/sync";
import type { ApiModeConfig } from "./types";
import { appendEvent, readEventsForRange } from "./lib/storage";
import { enumerateDateKeys, expandToFullWeekWindow, extractGitEmailAccount, formatGitEmailFilePrefix, formatRangeFileLabel, resolveRange } from "./lib/time";
import { computeUpdateNotice, fetchLatestVersion, maybeSpawnBackgroundCheck, performUpdateCheck } from "./lib/update-check";
import { getCurrentVersion, isNewerVersion } from "./lib/version";

export interface CliOptions {
  [key: string]: string | boolean | undefined;
}

/** CLI 帮助信息保持简洁，方便直接挂到 README 或终端里查看。 */
function printHelp(): void {
  process.stdout.write(`ccus\n\nCommands:\n  ccus install [--settings PATH] [--command CMD] [--data-dir PATH]\n  ccus statusline emit [--data-dir PATH] [--input FILE] [--no-store]\n  ccus dashboard build [--range today|this-week|last-week|5h] [--out FILE] [--data-dir PATH]\n  ccus dashboard open [--range today|this-week|last-week|5h] [--out FILE] [--data-dir PATH]\n  ccus dashboard serve [--range today|this-week|last-week|5h] [--port 0] [--host 127.0.0.1] [--open] [--data-dir PATH]\n  ccus export [RANGE] [--out FILE] [--data-dir PATH]   (RANGE: this-week|tw, last-week|lw, today, 5h; e.g. ccus export lw)\n  ccus sessions [RANGE] [--out FILE] [--data-dir PATH]   (把 ~/.claude/projects 本周活跃 session 打包成 zip，名如 projects_<dates>_<user>.zip)\n  ccus aggregate --input-dir DIR [--out-dir DIR]\n  ccus aggregate serve --input-dir DIR [--port 0] [--host 127.0.0.1]\n  ccus sync [--data-dir PATH]\n  ccus sync config [--target DIR] [--interval 3h|daily|<N>h|<N>m] [--range this-week] [--suffix NAME | --no-suffix] [--data-dir PATH]\n  ccus sync install [--print] [--data-dir PATH]   (注册每周五 18:00 的系统调度器)\n  ccus sync uninstall [--print]   (卸载系统调度器)\n  ccus sync status [--data-dir PATH]\n  ccus api config [--enable|--disable] [--provider zhipu|custom] [--token-env NAME] [--token VAL] [--url URL] [--project P] [--organization O] [--ttl 5m] [--extractor-file FILE] [--data-dir PATH]\n  ccus api test [--data-dir PATH]   (立即拉取第三方额度并打印，验证配置是否生效)\n  ccus api status [--data-dir PATH]\n  ccus open [--data-dir PATH] [--print]\n  ccus update [--data-dir PATH]\n  ccus --version\n\nGlobal flags:\n  --verbose | --debug | -v   输出详细调试日志到 stderr（等价于设置 CCUS_DEBUG=1），方便排查问题\n`);
}

/** 一个轻量的参数解析器，当前命令面不复杂，没必要引入额外依赖。 */
function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }
  return options;
}

/** 读取某个字符串选项，不存在时返回 undefined。 */
function getStringOption(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

/** 读取布尔选项；当前 CLI 中存在即视为 true。 */
function getBooleanOption(options: CliOptions, key: string): boolean {
  return options[key] === true;
}

/** 所有命令都共享一套数据目录解析逻辑。 */
function getDataDir(options: CliOptions): string {
  return path.resolve(getStringOption(options, "data-dir") ?? getDefaultDataDir());
}

/**
 * statusline 可以从 stdin 输入，也支持测试时通过 `--input` 指向 fixture 文件。
 */
async function readInputPayload(options: CliOptions): Promise<string> {
  const inputFile = getStringOption(options, "input");
  if (!inputFile) {
    return readStdin();
  }

  const fs = await import("node:fs/promises");
  return fs.readFile(path.resolve(inputFile), "utf8");
}

/**
 * 拼出默认的 statusLine 命令。
 *
 * 直接用全局安装的 `ccus` 命令；如果传了 data-dir 就追加，路径统一用正斜杠避免在 JSON / shell 里反复转义。
 */
function buildDefaultStatuslineCommand(dataDir: string | undefined): string {
  let command = "ccus statusline emit";
  if (dataDir) {
    command += ` --data-dir "${dataDir.replaceAll("\\", "/")}"`;
  }
  return command;
}

/**
 * 把 ccus 的 statusLine 命令写进 Claude Code 的 settings.json。
 *
 * 默认写 `~/.claude/settings.json`，只覆盖 statusLine 字段，其它设置原样保留。
 */
async function handleInstall(options: CliOptions): Promise<void> {
  const settingsPath = path.resolve(getStringOption(options, "settings") ?? getClaudeSettingsPath());
  const explicitCommand = getStringOption(options, "command");
  const dataDirOption = getStringOption(options, "data-dir");
  const command =
    explicitCommand ?? buildDefaultStatuslineCommand(dataDirOption ? path.resolve(dataDirOption) : undefined);

  const result = await installStatusline(settingsPath, command);

  const header = result.created
    ? `Created Claude settings and configured statusLine: ${result.settingsPath}`
    : result.unchanged
      ? `Claude statusLine already configured: ${result.settingsPath}`
      : `Updated Claude statusLine: ${result.settingsPath}`;
  process.stdout.write(`${header}\n  command: ${result.command}\n`);
  if (result.previousCommand && !result.unchanged) {
    process.stdout.write(`  replaced: ${result.previousCommand}\n`);
  }
}

/**
 * statusline 主路径：读 payload、归一化、落盘、输出单行状态文本。
 *
 * 这里即使异常也要优雅降级，不能因为采样失败把 statusline 弄挂。
 *
 * `--no-store`（别名 `--no-log`）只渲染并输出状态行，不把事件落盘，
 * 适合预览 statusline 输出或临时禁用采集，stdout 单行契约保持不变。
 */
async function handleStatuslineEmit(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const noStore = getBooleanOption(options, "no-store") || getBooleanOption(options, "no-log");
  debugLog("statusline", "start", { dataDir, noStore });

  try {
    const raw = await readInputPayload(options);
    debugLog("statusline", "payload received", { length: raw.length });
    const payload = parseStatuslinePayload(raw);
    const record = createPersistedStatuslineEvent(payload);
    const workspaceDir = extractWorkspaceDir(payload);
    const [gitIdentity, gitBranch] = await Promise.all([readGitIdentity(), readGitBranch(workspaceDir)]);
    record.gitUserName = gitIdentity.userName;
    record.gitUserEmail = gitIdentity.userEmail;
    record.gitUserAccount = extractGitEmailAccount(gitIdentity.userEmail);
    // API 模式：若启用，主动拉取第三方额度（智谱等），填进 rawPayload.rate_limits，
    // 让落盘与 computeStatuslineEvent 都能算出 usage；失败静默回退缓存，绝不污染单行 statusline 契约。
    const apiConfig = readApiConfig(dataDir);
    if (apiConfig.enabled) {
      const quota = await resolveApiQuota(dataDir, apiConfig, process.env);
      if (quota) {
        applyQuotaToPayload(record.rawPayload, quota);
      }
    }
    if (noStore) {
      debugLog("statusline", "no-store enabled, skipping appendEvent");
    } else {
      await appendEvent(dataDir, record);
    }
    const event = computeStatuslineEvent(record, { gitBranch });
    debugLog("statusline", "event computed", {
      sessionId: event.sessionId,
      usagePct: event.usagePct,
      sevenDayUsagePct: event.sevenDayUsagePct,
      contextWindowPct: event.contextWindowPct,
      modelName: event.modelName,
      workspaceName: event.workspaceName,
      gitUserAccount: event.gitUserAccount,
      gitBranch,
    });
    // 更新检查必须对 statusline 完全无侵入：同步读旧缓存决定是否在行尾追加小标记，
    // 把网络请求甩给 detached 后台进程，主进程不等待、失败静默。
    maybeSpawnBackgroundCheck(dataDir);
    // 定时同步同样对 statusline 无侵入：到周期才 spawn detached 后台进程执行 export+复制，主进程不等待。
    maybeSpawnBackgroundSync(dataDir);
    const notice = computeUpdateNotice(dataDir);
    const statusLine = notice ? `${event.statusLine} | ${notice}` : event.statusLine;
    process.stdout.write(`${statusLine}\n`);
  } catch (error) {
    // 正常路径不能因为采样失败把 statusline 弄挂，所以这里仍然降级输出兜底文本；
    // 但默认会吞掉真实错误，排查极其困难。开启调试时把完整错误打到 stderr。
    debugLog("statusline", "failed, emitting fallback", error instanceof Error ? (error.stack ?? error.message) : String(error));
    const fallback = computeStatuslineEvent(createPersistedStatuslineEvent({}));
    process.stdout.write(`${fallback.statusLine}\n`);
  }
}

/**
 * 加载某个时间窗口内的 dashboard 渲染数据：statusline 事件 + 每日用户消息数。
 *
 * 每日用户消息数与导出契约同源（Claude 本地 transcript 的真实用户请求数），仅供 dashboard 展示，
 * 不落盘、不进任何导出/聚合契约。`defaultRange` 让 build/open 与 serve 各自决定缺省窗口。
 */
async function loadDashboardData(
  options: CliOptions,
  defaultRange: string,
): Promise<{ html: string; window: ReturnType<typeof resolveRange> }> {
  const dataDir = getDataDir(options);
  const range = getStringOption(options, "range") ?? defaultRange;
  const now = new Date();
  // this-week 固定补齐到完整一周（周一到周日），即使本周还没过完，曲线 x 轴也按 7 天逐日展示；
  // 其它范围（today / last-week / 5h）不受影响。
  const window = expandToFullWeekWindow(resolveRange(range, now));
  const events = (await readEventsForRange(dataDir, range, now)).map((record) => computeStatuslineEvent(record));
  const claudeDailyUsage = await summarizeClaudeProjectUsageByDay(window.start, window.end);
  const dailyUserMessages = enumerateDateKeys(window.start, window.end).map((date) => ({
    date,
    userMessageCount: claudeDailyUsage.get(date)?.userMessageCount ?? 0,
  }));
  debugLog("dashboard", "events loaded", { range, label: window.label, sampleCount: events.length, days: dailyUserMessages.length });
  const html = buildDashboardHtml(events, window.label, window.start, window.end, dailyUserMessages);
  return { html, window };
}

/** 构建 dashboard 的公共逻辑，build/open 复用同一套生成流程。 */
async function buildDashboard(options: CliOptions): Promise<string> {
  const dataDir = getDataDir(options);
  const { html, window } = await loadDashboardData(options, "today");
  const outputPath = path.resolve(
    getStringOption(options, "out") ?? path.join(getDashboardDir(dataDir), `${window.label}.html`),
  );
  await writeTextFile(outputPath, html);
  debugLog("dashboard", "html written", { outputPath, bytes: html.length });
  return outputPath;
}

/** 直接返回 dashboard HTML 字符串，供本地 HTTP 服务复用。serve 默认看整周使用量曲线。 */
async function renderDashboardHtml(options: CliOptions): Promise<string> {
  const { html } = await loadDashboardData(options, "this-week");
  return html;
}

/** 只生成 dashboard 文件，不主动打开浏览器。 */
async function handleDashboardBuild(options: CliOptions): Promise<void> {
  const outputPath = await buildDashboard(options);
  process.stdout.write(`${outputPath}\n`);
}

/** 生成并打开 dashboard，适合本地快速查看。 */
async function handleDashboardOpen(options: CliOptions): Promise<void> {
  const outputPath = await buildDashboard(options);
  await openInBrowser(outputPath);
  process.stdout.write(`${outputPath}\n`);
}

/**
 * 启动一个本地 HTTP 页面，直接渲染最新 dashboard。
 *
 * 与 `build/open` 不同，这里不依赖预先生成 HTML 文件，而是每次请求时实时读取日志。
 */
async function handleDashboardServe(options: CliOptions): Promise<void> {
  const host = getStringOption(options, "host") ?? "127.0.0.1";
  const portOption = getStringOption(options, "port");
  const port = portOption ? Number.parseInt(portOption, 10) : 0;

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portOption ?? ""}`);
  }

  const server = http.createServer(async (_request, response) => {
    try {
      const html = await renderDashboardHtml(options);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine dashboard server address");
  }

  const url = `http://${host}:${address.port}`;
  if (getBooleanOption(options, "open")) {
    await openInBrowser(url);
  }

  process.stdout.write(`${url}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/**
 * 导出原始事件：生成 bundle 并写入本地 exports，返回输出路径与时间窗口。
 *
 * 当前默认导出一个 JSON 包，同时包含原始事件和按天周汇总。
 * 抽成独立函数供 `ccus export` 与 `ccus sync` 复用，行为完全一致。
 */
async function runExport(options: CliOptions): Promise<{ outputPath: string; window: ReturnType<typeof resolveRange> }> {
  const dataDir = getDataDir(options);
  const range = getStringOption(options, "range") ?? "this-week";
  const output = getStringOption(options, "out");

  if (options.mode !== undefined) {
    throw new Error("--mode has been removed.");
  }

  if (options.format !== undefined) {
    throw new Error("--format has been removed. Export now always writes a weekly bundle json.");
  }

  const now = new Date();
  // 周度导出固定覆盖完整一周：this-week 即使本周还没过完，文件名与 dailySummaries 也补齐到周日。
  const window = expandToFullWeekWindow(resolveRange(range, now));
  debugLog("export", "range resolved", { range, label: window.label, start: window.start.toISOString(), end: window.end.toISOString() });
  const records = await readEventsForRange(dataDir, range, now);
  const events = records.map((record) => computeStatuslineEvent(record));
  const statuslineSummary = summarizeEvents(events);
  const statuslineDailyRows = buildSummaryRows(events);
  const claudeUsage = await summarizeClaudeProjectUsage(window.start, window.end);
  const claudeDailyUsage = await summarizeClaudeProjectUsageByDay(window.start, window.end);
  debugLog("export", "data collected", {
    statuslineSamples: records.length,
    claudeProjectFiles: claudeUsage.matchedFileCount,
    userMessageCount: claudeUsage.userMessageCount,
    apiRequestCount: claudeUsage.apiRequestCount,
  });
  const reversedRecords = [...records].reverse();
  let exportUserEmail = reversedRecords.map((record) => record.gitUserEmail).find((email): email is string => Boolean(email)) ?? null;
  let exportUserName = reversedRecords.map((record) => record.gitUserName).find((name): name is string => Boolean(name)) ?? null;
  // 窗口内没有带身份的采样（例如导出上一周但当时没运行 ccus）时，回退到当前 git 身份，
  // 保证文件名前缀和 bundle identity 仍能标识导出人。
  if (exportUserEmail === null && exportUserName === null) {
    const gitIdentity = await readGitIdentity();
    exportUserEmail = gitIdentity.userEmail;
    exportUserName = gitIdentity.userName;
  }
  const weeklySummary = {
    schemaVersion: 6,
    generatedAt: new Date().toISOString(),
    range: {
      label: window.label,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    identity: {
      gitUserName: exportUserName,
      gitUserEmail: exportUserEmail,
    },
    counts: {
      userMessageCount: claudeUsage.userMessageCount,
      apiRequestCount: claudeUsage.apiRequestCount,
    },
    tokens: {
      inputTokens: claudeUsage.inputTokens,
      outputTokens: claudeUsage.outputTokens,
      cacheReadInputTokens: claudeUsage.cacheReadInputTokens,
    },
    statusline: {
      sampleCount: statuslineSummary.sampleCount,
      uniqueSessions: statuslineSummary.uniqueSessions,
      uniqueWorkspaces: statuslineSummary.uniqueWorkspaces,
      fiveHourLatestUsagePct: statuslineSummary.fiveHourLatestUsagePct,
      fiveHourPeakUsagePct: statuslineSummary.fiveHourPeakUsagePct,
      sevenDayLatestUsagePct: statuslineSummary.sevenDayLatestUsagePct,
      sevenDayPeakUsagePct: statuslineSummary.sevenDayPeakUsagePct,
    },
    sources: {
      ccusDataDir: dataDir,
      claudeDataDir: claudeUsage.claudeDataDir,
      projectFilesMatched: claudeUsage.matchedFileCount,
      messageCountSource: "claude-projects:user-events",
      apiRequestCountSource: "claude-projects:assistant-usage-events",
      tokenSource: "claude-projects:assistant-usage-events",
    },
  };
  const statuslineDailyMap = new Map(statuslineDailyRows.map((row) => [row.date, row]));
  const dailySummaries = enumerateDateKeys(window.start, window.end).map((date) => {
    const row = statuslineDailyMap.get(date);
    const claudeDay = claudeDailyUsage.get(date);
    return {
      date,
      userMessageCount: claudeDay?.userMessageCount ?? 0,
      apiRequestCount: claudeDay?.apiRequestCount ?? 0,
      inputTokens: claudeDay?.inputTokens ?? 0,
      outputTokens: claudeDay?.outputTokens ?? 0,
      cacheReadInputTokens: claudeDay?.cacheReadInputTokens ?? 0,
      sampleCount: row?.sampleCount ?? 0,
      fiveHourLatestUsagePct: row?.fiveHourLatestUsagePct ?? null,
      fiveHourPeakUsagePct: row?.fiveHourPeakUsagePct ?? null,
      sevenDayLatestUsagePct: row?.sevenDayLatestUsagePct ?? null,
      sevenDayPeakUsagePct: row?.sevenDayPeakUsagePct ?? null,
      uniqueSessions: row?.uniqueSessions ?? 0,
      uniqueWorkspaces: row?.uniqueWorkspaces ?? 0,
    };
  });
  const bundle = {
    schemaVersion: 6,
    generatedAt: new Date().toISOString(),
    range: {
      label: window.label,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    identity: {
      gitUserName: exportUserName,
      gitUserEmail: exportUserEmail,
    },
    rawEvents: records,
    weeklySummary,
    dailySummaries,
  };
  const content = buildWeeklyExportBundleJson(bundle);
  const fileLabel = formatRangeFileLabel(window.start, window.end);
  const gitEmailPrefix = formatGitEmailFilePrefix(exportUserEmail);
  // 默认导出 gzip 压缩的 bundle（.json.gz）以缩减体积；用户用 --out 指定非 .gz 路径时仍写明文 JSON。
  const defaultFileName = gitEmailPrefix ? `${gitEmailPrefix}_export_${fileLabel}.json.gz` : `export_${fileLabel}.json.gz`;
  const outputPath = path.resolve(output ?? path.join(dataDir, "exports", defaultFileName));
  const compressed = outputPath.endsWith(".gz");
  if (compressed) {
    await writeGzipFile(outputPath, content);
  } else {
    await writeTextFile(outputPath, content);
  }
  debugLog("export", "bundle written", { outputPath, rawBytes: content.length, compressed });
  return { outputPath, window };
}

/**
 * `ccus export` 入口：执行 runExport 并把输出路径打到 stdout。
 */
async function handleExport(options: CliOptions): Promise<void> {
  const { outputPath } = await runExport(options);
  process.stdout.write(`${outputPath}\n`);
}

/**
 * 聚合一个目录里的多人 export bundle json，输出 detail/daily/weekly 三个 CSV。
 */
async function handleAggregate(options: CliOptions): Promise<void> {
  const inputDir = getStringOption(options, "input-dir");
  if (!inputDir) {
    throw new Error("--input-dir is required.");
  }

  const resolvedInputDir = path.resolve(inputDir);
  const outputDir = path.resolve(getStringOption(options, "out-dir") ?? path.join(resolvedInputDir, "aggregated"));
  debugLog("aggregate", "loading bundles", { inputDir: resolvedInputDir, outputDir });
  const bundles = await loadWeeklyExportBundles(resolvedInputDir);
  const detailRows = buildAggregatedDetailRows(bundles);
  const dailyRows = buildAggregatedDailyRows(bundles);
  const weeklyRows = buildAggregatedWeeklyRows(bundles);
  debugLog("aggregate", "bundles loaded", { bundleCount: bundles.length, detailRows: detailRows.length, dailyRows: dailyRows.length, weeklyRows: weeklyRows.length });
  const detailCsv = buildAggregatedDetailCsv(detailRows);
  const dailyCsv = buildAggregatedDailyCsv(dailyRows);
  const weeklyCsv = buildAggregatedWeeklyCsv(weeklyRows);

  const detailPath = path.join(outputDir, "detail.csv");
  const dailyPath = path.join(outputDir, "daily.csv");
  const weeklyPath = path.join(outputDir, "weekly.csv");
  await Promise.all([
    writeTextFile(detailPath, detailCsv),
    writeTextFile(dailyPath, dailyCsv),
    writeTextFile(weeklyPath, weeklyCsv),
  ]);
  debugLog("aggregate", "csv written", { detailPath, dailyPath, weeklyPath });
  process.stdout.write(`${detailPath}\n${dailyPath}\n${weeklyPath}\n`);
}

/** 实时把 input-dir 里的 bundle 渲染成多人 dashboard HTML，供 serve 路径复用。 */
async function renderAggregateDashboardHtml(inputDir: string): Promise<string> {
  const bundles = await loadWeeklyExportBundles(inputDir);
  const detailRows = buildAggregatedDetailRows(bundles);
  const dailyRows = buildAggregatedDailyRows(bundles);
  const weeklyRows = buildAggregatedWeeklyRows(bundles);
  return buildAggregateDashboardHtml(detailRows, dailyRows, weeklyRows);
}

/**
 * 启动一个本地 HTTP 页面，直接渲染多人 aggregate dashboard。
 *
 * 与 `aggregate` 写 CSV 不同，这里不落地任何文件，每次请求时实时读 bundle 目录。
 */
async function handleAggregateServe(options: CliOptions): Promise<void> {
  const inputDir = getStringOption(options, "input-dir");
  if (!inputDir) {
    throw new Error("--input-dir is required.");
  }

  const resolvedInputDir = path.resolve(inputDir);
  const host = getStringOption(options, "host") ?? "127.0.0.1";
  const portOption = getStringOption(options, "port");
  const port = portOption ? Number.parseInt(portOption, 10) : 0;

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portOption ?? ""}`);
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const html = await renderAggregateDashboardHtml(resolvedInputDir);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine aggregate dashboard server address");
  }

  const url = `http://${host}:${address.port}`;
  await openInBrowser(url);

  process.stdout.write(`${url}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/**
 * `ccus open`：用系统文件管理器打开 ccus 本地存储目录（事件日志、exports、dashboard 都在里面）。
 *
 * 默认目录由 `getDefaultDataDir` 推导，可用 `--data-dir` 覆盖。
 * 加 `--print` 只把目录路径打到 stdout、不真正打开，方便在脚本里取路径。
 */
async function handleOpenDataDir(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  debugLog("open", "resolved data dir", { dataDir, print: getBooleanOption(options, "print") });

  if (getBooleanOption(options, "print")) {
    process.stdout.write(`${dataDir}\n`);
    return;
  }

  // 目录可能还没被 statusline 创建过，先确保存在，否则系统打开会失败。
  const fs = await import("node:fs/promises");
  await fs.mkdir(dataDir, { recursive: true });
  await openPath(dataDir);
  process.stdout.write(`${dataDir}\n`);
}

/** 历史上被移除的导出格式 token，作为位置参数出现时要明确报错而不是当成 range。 */
const REMOVED_EXPORT_FORMAT_TOKENS = new Set(["csv", "jsonl", "raw"]);

/**
 * 解析 export 命令的参数。
 *
 * 位置参数被当作 range 简写，例如 `ccus export lw` 等价于 `ccus export --range last-week`。
 * 已移除的旧子命令 / 格式 token 仍然明确报错，避免旧脚本误判。
 */
export function resolveExportOptions(action: string | undefined, args: string[], rest: string[]): CliOptions {
  if (!action || action.startsWith("--")) {
    return parseOptions(args.slice(1));
  }

  if (action === "summary") {
    throw new Error("`ccus export summary` has been removed. Use `ccus export` to export raw jsonl data.");
  }

  if (REMOVED_EXPORT_FORMAT_TOKENS.has(action)) {
    throw new Error(
      `Unsupported export argument: ${action}. Use \`ccus export [RANGE] [--out FILE]\`; legacy export formats have been removed.`,
    );
  }

  const options = parseOptions(rest);
  if (typeof options.range !== "string") {
    options.range = action;
  }
  return options;
}

/**
 * `ccus sessions`：把 ~/.claude/projects 中在指定时间范围内有活动的 session 文件打包成 zip。
 *
 * zip 内部结构保持 <projectDir>/<sessionId>.jsonl 层级（路径分隔符统一用 /）。
 * 文件名格式：projects_<start>_<end>_<gitUserName>.zip。
 * 默认输出到 <data-dir>/sessions/，加 --out 可指定完整路径。
 * 位置参数作为 range 简写，例如 `ccus sessions lw` 等价于 `--range last-week`。
 */
async function handleSessions(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const range = getStringOption(options, "range") ?? "this-week";
  const out = getStringOption(options, "out");
  const now = new Date();
  const window = expandToFullWeekWindow(resolveRange(range, now));
  debugLog("sessions", "range resolved", { range, label: window.label, start: window.start.toISOString(), end: window.end.toISOString() });

  const sessions = await findActiveSessionFiles(window.start, window.end);
  debugLog("sessions", "active sessions found", { count: sessions.length });

  const fsRead = (await import("node:fs/promises")).readFile;
  const { buildZipBuffer } = await import("./lib/zip");

  const entries = await Promise.all(
    sessions.map(async (session) => ({
      name: `${session.projectDir.replaceAll("\\", "/")}/${session.sessionId}.jsonl`,
      data: await fsRead(session.filePath),
    })),
  );

  const zipBuffer = await buildZipBuffer(entries);

  const gitIdentity = await readGitIdentity();
  const userName = formatGitEmailFilePrefix(gitIdentity.userEmail) ?? "unknown";
  const fileLabel = formatRangeFileLabel(window.start, window.end);
  const defaultFileName = `projects_${fileLabel}_${userName}.zip`;
  const outputPath = path.resolve(out ?? path.join(dataDir, "sessions", defaultFileName));
  const fsNode = await import("node:fs/promises");
  await fsNode.mkdir(path.dirname(outputPath), { recursive: true });
  await fsNode.writeFile(outputPath, zipBuffer);
  process.stdout.write(`${outputPath}\n`);
}

/**
 * 解析 sessions 命令的参数，支持 RANGE 作为位置参数简写。
 */
function resolveSessionsOptions(action: string | undefined, args: string[], rest: string[]): CliOptions {
  if (!action || action.startsWith("--")) {
    return parseOptions(args.slice(1));
  }
  const options = parseOptions(rest);
  if (typeof options.range !== "string") {
    options.range = action;
  }
  return options;
}

/** 用 readline 向用户提问，返回用户输入的一行文本。 */
async function prompt(question: string): Promise<string> {
  const rl = (await import("node:readline")).createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * `ccus update`：用户主动检查更新（绕过 24h 节流）。
 *
 * 发现新版本时交互式询问用户是否立即安装；输入 y/Y 则执行 `npm i -g ccus-cli@latest`。
 */
async function handleUpdate(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const current = getCurrentVersion();

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`无法检查更新：${message}\n当前版本 v${current}\n`);
    return;
  }

  // 顺手刷新缓存，让 statusline 标记和这次检查结果保持一致。
  await performUpdateCheck(dataDir);

  if (!isNewerVersion(latest, current)) {
    process.stdout.write(`已是最新版本 v${current}\n`);
    return;
  }

  process.stdout.write(`发现新版本：v${current} -> v${latest}\n`);

  let answer: string;
  try {
    answer = await prompt("立即升级？[y/N] ");
  } catch {
    // stdin 不可交互（如管道），退回纯提示。
    process.stdout.write(`运行以下命令升级：\n  npm i -g ccus-cli@latest\n`);
    return;
  }

  if (answer.toLowerCase() !== "y") {
    process.stdout.write(`已取消。如需手动升级：\n  npm i -g ccus-cli@latest\n`);
    return;
  }

  process.stdout.write("正在升级…\n");
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("npm", ["i", "-g", "ccus-cli@latest"], { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.stdout.write("升级失败，请手动运行：\n  npm i -g ccus-cli@latest\n");
    process.exitCode = 1;
  }
}

/**
 * 隐藏命令 `__check-update`：由 statusline 路径以 detached 后台进程触发。
 *
 * 只做一件事：查 registry 并写缓存。不输出任何东西到 stdout（它不是被人看的），
 * 失败也静默，绝不影响触发它的 statusline 主进程。
 */
async function handleBackgroundCheckUpdate(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  await performUpdateCheck(dataDir);
}

/**
 * `ccus sync`：执行一次定时同步（导出当前周 bundle 并复制到目标目录的按周子目录）。
 *
 * 带 `--target` / `--interval` / `--range` 时先合并并持久化配置，再立即同步一次；
 * 不带参数则用已存配置同步。最终仍无目标目录则报错引导用户先配置。
 */
async function handleSync(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const target = getStringOption(options, "target");
  const interval = getStringOption(options, "interval");
  const range = getStringOption(options, "range");

  const suffix = getStringOption(options, "suffix");
  if (target !== undefined || interval !== undefined || range !== undefined || suffix !== undefined) {
    const current = readSyncConfig(dataDir);
    const next = {
      targetDir: target !== undefined ? path.resolve(target) : current.targetDir,
      intervalLabel: interval ?? current.intervalLabel,
      range: range ?? current.range,
      suffix: suffix !== undefined ? sanitizeSuffix(suffix) : current.suffix,
    };
    await writeSyncConfig(dataDir, next);
    debugLog("sync", "config updated", next);
  }

  const config = readSyncConfig(dataDir);
  if (!config.targetDir) {
    throw new Error("未配置同步目标目录。请先运行 `ccus sync config --target DIR`。");
  }

  const result = await performSync(dataDir, runExport);
  process.stdout.write(`已同步到 ${result.destPath}\n`);
  if (result.archivedLastWeekDest) {
    process.stdout.write(`已归档上一周到 ${result.archivedLastWeekDest}\n`);
  }
}

/**
 * `ccus sync status`：打印当前同步配置、上次同步时间与是否到期。
 */
async function handleSyncStatus(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const config = readSyncConfig(dataDir);
  const state = readSyncStateSync(dataDir);
  const due = isSyncDue(config, state);

  const lines = [
    `目标目录: ${config.targetDir ?? "(未配置)"}`,
    `同步周期: ${config.intervalLabel}`,
    `导出范围: ${config.range}`,
    `文件后缀: ${config.suffix ?? "(无)"}`,
    `上次同步: ${state?.lastSyncedAt ?? "(从未)"}${state?.lastResult ? ` [${state.lastResult}]` : ""}`,
    state?.lastArchivedWeek ? `已归档上一周: ${state.lastArchivedWeek}` : null,
    state?.lastError ? `上次错误: ${state.lastError}` : null,
    `现在是否到期: ${config.targetDir ? (due ? "是" : "否") : "(未配置目标目录)"}`,
  ].filter((line): line is string => line !== null);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * `ccus sync config`：只读写同步配置，不触发同步。
 *
 * 带 `--target` / `--interval` / `--range` 时合并并持久化到 `sync-config.json`；
 * 不带任何参数时仅打印当前配置，方便确认。
 */
async function handleSyncConfig(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const target = getStringOption(options, "target");
  const interval = getStringOption(options, "interval");
  const range = getStringOption(options, "range");
  const suffix = getStringOption(options, "suffix");
  const clearSuffix = getBooleanOption(options, "no-suffix");
  const current = readSyncConfig(dataDir);

  const changed = target !== undefined || interval !== undefined || range !== undefined || suffix !== undefined || clearSuffix;
  const next = {
    targetDir: target !== undefined ? path.resolve(target) : current.targetDir,
    intervalLabel: interval ?? current.intervalLabel,
    range: range ?? current.range,
    // --no-suffix 优先清除；否则有 --suffix 就更新，没有就保持原值。
    suffix: clearSuffix ? null : suffix !== undefined ? sanitizeSuffix(suffix) : current.suffix,
  };

  if (changed) {
    await writeSyncConfig(dataDir, next);
    debugLog("sync", "config updated", next);
  }

  const header = changed ? "同步配置已更新：" : "当前同步配置：";
  process.stdout.write(
    `${header}\n  目标目录: ${next.targetDir ?? "(未配置)"}\n  同步周期: ${next.intervalLabel}\n  导出范围: ${next.range}\n  文件后缀: ${next.suffix ?? "(无)"}\n`,
  );
}

/**
 * `ccus sync install`：安装一个系统调度器，每周五 18:00 跑一次 `ccus sync`。
 *
 * Windows 用 schtasks 真正创建计划任务；macOS / Linux 打印 cron 命令交由用户手动安装。
 * 加 `--print` 只打印将执行的调度器命令、不真正安装。
 */
async function handleSyncInstall(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const print = getBooleanOption(options, "print");
  const scriptPath = process.argv[1];
  const result = installScheduler(process.execPath, scriptPath, dataDir, { print });
  const { plan } = result;

  if (print) {
    process.stdout.write(`将安装的调度器命令（每周五 18:00 同步）：\n  ${plan.displayCommand}\n`);
    return;
  }

  if (result.installed) {
    process.stdout.write(`已安装系统调度器「ccus-sync」：每周五 18:00 运行一次 ccus sync。\n卸载：\n  ${plan.uninstallHint}\n`);
    return;
  }

  // 非 Windows：不自动改系统，打印命令引导用户手动安装。
  process.stdout.write(
    `当前平台（${plan.platform}）不自动安装，请手动运行以下命令注册每周五 18:00 的 cron 任务：\n  ${plan.displayCommand}\n卸载：\n  ${plan.uninstallHint}\n`,
  );
}

/**
 * `ccus sync uninstall`：卸载每周五同步的系统调度器。
 *
 * Windows 用 schtasks 删除计划任务；macOS / Linux 打印 crontab 提示。加 `--print` 只打印命令、不执行。
 */
async function handleSyncUninstall(options: CliOptions): Promise<void> {
  const print = getBooleanOption(options, "print");
  const result = uninstallScheduler({ print });

  if (print) {
    process.stdout.write(`将执行的卸载命令：\n  ${result.displayCommand}\n`);
    return;
  }

  if (result.autoUninstallable) {
    if (result.uninstalled) {
      process.stdout.write(`已卸载系统调度器「ccus-sync」。\n`);
    } else {
      process.stdout.write(`未能删除调度任务（可能本就未安装）。如需手动卸载：\n  ${result.displayCommand}\n`);
    }
    return;
  }

  process.stdout.write(`当前平台（${result.platform}）请手动卸载：\n  ${result.displayCommand}\n`);
}

/**
 * 隐藏命令 `__sync`：由 statusline 路径以 detached 后台进程触发。
 *
 * 静默执行一次同步：不写 stdout，失败一律吞掉，绝不影响触发它的 statusline 主进程。
 */
async function handleBackgroundSync(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  try {
    await performSync(dataDir, runExport);
  } catch (error) {
    debugLog("sync", "background sync failed", error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

/** 解析时长字面量为毫秒：纯数字按 ms，支持 ms/s/m/h 后缀。非法返回 null。 */
function parseDurationMs(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const text = raw.trim().toLowerCase();
  if (text === "") {
    return null;
  }
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  const unit = match[2] ?? "ms";
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * mult);
}

/** 把毫秒时长格式化成人类可读（整分钟显示成 m，否则 ms）。 */
function formatDurationMs(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  return `${ms}ms`;
}

/** 解析 --header "K1: V1; K2: V2" 为 header map；按首个冒号拆 K/V，非法条目跳过。 */
function parseHeaderFlag(raw: string | undefined): Record<string, string> | null {
  if (raw === undefined) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const segment of raw.split(";")) {
    const idx = segment.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = segment.slice(0, idx).trim();
    const value = segment.slice(idx + 1).trim();
    if (key !== "") {
      out[key] = value;
    }
  }
  return out;
}

/** 脱敏展示 token：只露首尾各 3 位。 */
function maskSecret(value: string | null | undefined): string {
  if (!value) {
    return "(未配置)";
  }
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

/**
 * `ccus api config`：只读写 API 模式配置，不触发拉取。
 *
 * 带任意参数时合并并持久化到 api-config.json；不带参数仅打印当前配置。
 * `--url` 按 `--provider` 落到 zhipu 或 custom 段；`--header "K: V; K2: V2"` 仅作用于 custom。
 */
async function handleApiConfig(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const current = readApiConfig(dataDir);

  const enable = getBooleanOption(options, "enable");
  const disable = getBooleanOption(options, "disable");
  const provider = getStringOption(options, "provider");
  const tokenEnv = getStringOption(options, "token-env");
  const token = getStringOption(options, "token");
  const clearToken = getBooleanOption(options, "no-token");
  const ttlMs = parseDurationMs(getStringOption(options, "ttl"));
  const timeoutMs = parseDurationMs(getStringOption(options, "timeout"));
  const userAgent = getStringOption(options, "user-agent");
  const url = getStringOption(options, "url");
  const project = getStringOption(options, "project");
  const organization = getStringOption(options, "organization");
  const method = getStringOption(options, "method");
  const headers = parseHeaderFlag(getStringOption(options, "header"));
  const clearHeaders = getBooleanOption(options, "no-header");
  const fiveHourPath = getStringOption(options, "five-hour-path");
  const sevenDayPath = getStringOption(options, "seven-day-path");
  const extractorInline = getStringOption(options, "extractor");
  const extractorFile = getStringOption(options, "extractor-file");
  const clearExtractor = getBooleanOption(options, "no-extractor");

  let extractorValue: string | undefined;
  if (clearExtractor) {
    extractorValue = "";
  } else if (extractorInline !== undefined) {
    extractorValue = extractorInline;
  } else if (extractorFile !== undefined) {
    const fsp = await import("node:fs/promises");
    extractorValue = await fsp.readFile(path.resolve(extractorFile), "utf8");
  }

  const targetProvider = provider === "custom" || provider === "zhipu" ? provider : current.provider;
  const next: ApiModeConfig = {
    ...current,
    enabled: enable ? true : disable ? false : current.enabled,
    provider: targetProvider,
    tokenEnv: tokenEnv ?? current.tokenEnv,
    token: clearToken ? null : token !== undefined ? token : current.token,
    cacheTtlMs: ttlMs ?? current.cacheTtlMs,
    timeoutMs: timeoutMs ?? current.timeoutMs,
    userAgent: userAgent ?? current.userAgent,
    zhipu: {
      url: targetProvider === "zhipu" && url !== undefined ? url : current.zhipu.url,
      project: project ?? current.zhipu.project,
      organization: organization ?? current.zhipu.organization,
    },
    custom: {
      url: targetProvider === "custom" && url !== undefined ? url : current.custom.url,
      method: method ?? current.custom.method,
      headers: clearHeaders ? {} : headers ?? current.custom.headers,
      fiveHourPath: fiveHourPath ?? current.custom.fiveHourPath,
      sevenDayPath: sevenDayPath ?? current.custom.sevenDayPath,
      extractor: extractorValue !== undefined ? extractorValue : current.custom.extractor,
    },
  };

  const changed =
    enable ||
    disable ||
    clearToken ||
    clearHeaders ||
    provider !== undefined ||
    tokenEnv !== undefined ||
    token !== undefined ||
    ttlMs !== null ||
    timeoutMs !== null ||
    userAgent !== undefined ||
    url !== undefined ||
    project !== undefined ||
    organization !== undefined ||
    method !== undefined ||
    headers !== null ||
    fiveHourPath !== undefined ||
    sevenDayPath !== undefined ||
    extractorValue !== undefined;

  if (changed) {
    await writeApiConfig(dataDir, next);
    debugLog("api-mode", "config updated", next);
  }

  const header = changed ? "API 模式配置已更新：" : "当前 API 模式配置：";
  const lines = [
    `  启用: ${next.enabled ? "是" : "否"}`,
    `  provider: ${next.provider}`,
    `  token 环境变量: ${next.tokenEnv}`,
    `  token 兜底: ${maskSecret(next.token)}`,
    `  当前生效 token: ${maskSecret(resolveApiTokenWithSettings(next))}`,
    `  缓存 TTL: ${formatDurationMs(next.cacheTtlMs)}`,
    `  请求超时: ${formatDurationMs(next.timeoutMs)}`,
    `  User-Agent: ${next.userAgent}`,
    `  [zhipu] url: ${next.zhipu.url}`,
    `  [zhipu] project: ${next.zhipu.project || "(无)"}`,
    `  [zhipu] organization: ${next.zhipu.organization || "(无)"}`,
    `  [custom] url: ${next.custom.url || "(未配置)"}`,
    `  [custom] method: ${next.custom.method}`,
    `  [custom] headers: ${Object.keys(next.custom.headers).length > 0 ? JSON.stringify(next.custom.headers) : "(无)"}`,
    `  [custom] fiveHourPath: ${next.custom.fiveHourPath}`,
    `  [custom] sevenDayPath: ${next.custom.sevenDayPath}`,
    `  [custom] extractor: ${next.custom.extractor.trim() !== "" ? `(已配置，${next.custom.extractor.length} 字符；优先于点分路径)` : "(无，用点分路径)"}`,
  ];
  process.stdout.write(`${header}\n${lines.join("\n")}\n`);
}

/**
 * `ccus api test`：立即拉取一次第三方额度并打印，验证配置是否生效。
 *
 * 直接打真实接口（绕过缓存），成功打印 5h/7d/level，失败把原因打到 stderr 并返回非 0 退出码。
 */
async function handleApiTest(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const config = readApiConfig(dataDir);
  if (!config.enabled) {
    process.stdout.write("API 模式未启用，先用 `ccus api config --enable` 开启。\n");
    return;
  }

  process.stdout.write(`正在用 provider=${config.provider} 拉取额度（超时 ${formatDurationMs(config.timeoutMs)}）...\n`);

  // 环境变量和 config.token 都拿不到 token 时，回退到 ~/.claude/settings.json 的 env 字段。
  // 手动跑 api test 时不在 Claude Code 进程树下，环境变量里通常没有 ANTHROPIC_AUTH_TOKEN，
  // 而 settings.json 的 env 是 Claude Code 持久化这些变量的地方，正好作为来源。
  let env: NodeJS.ProcessEnv = process.env;
  if (!resolveApiToken(config, env)) {
    const settingsToken = readClaudeSettingsEnvTokenSync(config.tokenEnv);
    if (settingsToken) {
      env = { ...process.env, [config.tokenEnv]: settingsToken };
      debugLog("api-mode", `token from settings.json env.${config.tokenEnv}`);
    }
  }

  try {
    const quota = await fetchQuota(config, env);
    const fiveHour = quota.fiveHour !== null ? `${quota.fiveHour.toFixed(1)}%` : "--";
    const sevenDay = quota.sevenDay !== null ? `${quota.sevenDay.toFixed(1)}%` : "--";
    process.stdout.write(`✅ 5h ${fiveHour} | 7d ${sevenDay}${quota.level ? ` | level ${quota.level}` : ""}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`❌ 拉取失败：${message}\n`);
    process.exitCode = 1;
  }
}

/** `ccus api status`：打印当前 API 模式配置摘要与额度缓存新鲜度。 */
async function handleApiStatus(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);
  const config = readApiConfig(dataDir);
  const cache = readApiQuotaCacheSync(dataDir);
  const now = Date.now();
  let fresh = false;
  let ageLabel = "(无缓存)";
  if (cache) {
    const fetched = Date.parse(cache.fetchedAt);
    if (Number.isFinite(fetched)) {
      const ageMs = now - fetched;
      fresh = ageMs < config.cacheTtlMs;
      ageLabel = `${formatDurationMs(ageMs)} 前${fresh ? "" : "（已过期）"}`;
    }
  }

  const lines = [
    `  启用: ${config.enabled ? "是" : "否"}`,
    `  provider: ${config.provider}`,
    `  当前生效 token: ${maskSecret(resolveApiTokenWithSettings(config))}`,
    `  缓存 TTL: ${formatDurationMs(config.cacheTtlMs)}`,
    `  缓存状态: ${ageLabel}`,
  ];
  if (cache) {
    const fiveHour = cache.fiveHour !== null ? `${cache.fiveHour.toFixed(1)}%` : "--";
    const sevenDay = cache.sevenDay !== null ? `${cache.sevenDay.toFixed(1)}%` : "--";
    lines.push(`  缓存额度: 5h ${fiveHour} | 7d ${sevenDay}${cache.level ? ` | level ${cache.level}` : ""}`);
  }
  process.stdout.write(`API 模式状态：\n${lines.join("\n")}\n`);
}

/** 顶层命令分发入口。 */
async function main(args = process.argv.slice(2)): Promise<void> {
  setDebugEnabled(resolveDebugEnabled(args));

  const [group, action, ...rest] = args;
  const options = parseOptions(rest);

  debugLog("cli", "invoked", { group, action, dataDir: getDataDir(options) });

  if (!group) {
    printHelp();
    return;
  }

  if (group === "--version" || group === "-V" || group === "version") {
    process.stdout.write(`${getCurrentVersion()}\n`);
    return;
  }

  if (group === "open") {
    await handleOpenDataDir(parseOptions(args.slice(1)));
    return;
  }

  if (group === "update") {
    await handleUpdate(parseOptions(args.slice(1)));
    return;
  }

  if (group === "__check-update") {
    await handleBackgroundCheckUpdate(parseOptions(args.slice(1)));
    return;
  }

  if (group === "sync") {
    if (action === "config") {
      await handleSyncConfig(parseOptions(rest));
      return;
    }

    if (action === "status") {
      await handleSyncStatus(parseOptions(rest));
      return;
    }

    if (action === "install") {
      await handleSyncInstall(parseOptions(rest));
      return;
    }

    if (action === "uninstall") {
      await handleSyncUninstall(parseOptions(rest));
      return;
    }

    if (action && !action.startsWith("--")) {
      throw new Error(
        `Unsupported sync argument: ${action}. Use \`ccus sync\`, \`ccus sync config [--target DIR]\`, \`ccus sync install\`, \`ccus sync uninstall\` or \`ccus sync status\`.`,
      );
    }

    await handleSync(parseOptions(args.slice(1)));
    return;
  }

  if (group === "api") {
    if (action === "config") {
      await handleApiConfig(parseOptions(rest));
      return;
    }
    if (action === "test") {
      await handleApiTest(parseOptions(rest));
      return;
    }
    if (action === "status") {
      await handleApiStatus(parseOptions(rest));
      return;
    }
    if (action && !action.startsWith("--")) {
      throw new Error(
        `Unsupported api argument: ${action}. Use \`ccus api config\`, \`ccus api test\` or \`ccus api status\`.`,
      );
    }
    await handleApiStatus(parseOptions(args.slice(1)));
    return;
  }

  if (group === "__sync") {
    await handleBackgroundSync(parseOptions(args.slice(1)));
    return;
  }

  if (group === "install") {
    await handleInstall(parseOptions(args.slice(1)));
    return;
  }

  if (group === "statusline" && action === "emit") {
    await handleStatuslineEmit(options);
    return;
  }

  if (group === "dashboard" && action === "build") {
    await handleDashboardBuild(options);
    return;
  }

  if (group === "dashboard" && action === "open") {
    await handleDashboardOpen(options);
    return;
  }

  if (group === "dashboard" && action === "serve") {
    await handleDashboardServe(options);
    return;
  }

  if (group === "export") {
    const exportOptions = resolveExportOptions(action, args, rest);
    await handleExport(exportOptions);
    return;
  }

  if (group === "sessions") {
    const sessionsOptions = resolveSessionsOptions(action, args, rest);
    await handleSessions(sessionsOptions);
    return;
  }

  if (group === "aggregate") {
    if (action === "serve") {
      await handleAggregateServe(parseOptions(rest));
      return;
    }

    if (action && !action.startsWith("--")) {
      throw new Error(
        `Unsupported aggregate argument: ${action}. Use \`ccus aggregate --input-dir DIR\` or \`ccus aggregate serve --input-dir DIR\`.`,
      );
    }

    await handleAggregate(parseOptions(args.slice(1)));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

/** 顶层兜底错误处理：给出错误信息并返回非 0 退出码。 */
if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (error instanceof Error && error.stack) {
      debugLog("cli", "uncaught error", error.stack);
    }
    process.exitCode = 1;
  });
}
