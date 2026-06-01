#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { buildDashboardHtml } from "./lib/dashboard";
import { summarizeEvents } from "./lib/dashboard";
import { buildAggregateDashboardHtml } from "./lib/aggregate-dashboard";
import { summarizeClaudeProjectUsage, summarizeClaudeProjectUsageByDay } from "./lib/claude";
import { buildAggregatedDailyCsv, buildAggregatedDetailCsv, buildAggregatedWeeklyCsv, buildSummaryRows, buildWeeklyExportBundleJson, writeTextFile } from "./lib/export";
import { buildAggregatedDailyRows, buildAggregatedDetailRows, buildAggregatedWeeklyRows, loadWeeklyExportBundles } from "./lib/aggregate";
import { debugLog, resolveDebugEnabled, setDebugEnabled } from "./lib/debug";
import { readGitBranch, readGitIdentity } from "./lib/git";
import { installStatusline } from "./lib/install";
import { readStdin } from "./lib/io";
import { openInBrowser } from "./lib/open";
import { computeStatuslineEvent, createPersistedStatuslineEvent, extractWorkspaceDir, parseStatuslinePayload } from "./lib/payload";
import { getClaudeSettingsPath, getDashboardDir, getDefaultDataDir } from "./lib/paths";
import { appendEvent, readEventsForRange } from "./lib/storage";
import { enumerateDateKeys, extractGitEmailAccount, formatGitEmailFilePrefix, formatRangeFileLabel, resolveRange } from "./lib/time";

export interface CliOptions {
  [key: string]: string | boolean | undefined;
}

/** CLI 帮助信息保持简洁，方便直接挂到 README 或终端里查看。 */
function printHelp(): void {
  process.stdout.write(`ccus\n\nCommands:\n  ccus install [--settings PATH] [--command CMD] [--data-dir PATH]\n  ccus statusline emit [--data-dir PATH] [--input FILE] [--no-store]\n  ccus dashboard build [--range today|this-week|last-week|5h] [--out FILE] [--data-dir PATH]\n  ccus dashboard open [--range today|this-week|last-week|5h] [--out FILE] [--data-dir PATH]\n  ccus dashboard serve [--range today|this-week|last-week|5h] [--port 0] [--host 127.0.0.1] [--open] [--data-dir PATH]\n  ccus export [RANGE] [--out FILE] [--data-dir PATH]   (RANGE: this-week|tw, last-week|lw, today, 5h; e.g. ccus export lw)\n  ccus aggregate --input-dir DIR [--out-dir DIR]\n  ccus aggregate serve --input-dir DIR [--port 0] [--host 127.0.0.1]\n\nGlobal flags:\n  --verbose | --debug | -v   输出详细调试日志到 stderr（等价于设置 CCUS_DEBUG=1），方便排查问题\n`);
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
    process.stdout.write(`${event.statusLine}\n`);
  } catch (error) {
    // 正常路径不能因为采样失败把 statusline 弄挂，所以这里仍然降级输出兜底文本；
    // 但默认会吞掉真实错误，排查极其困难。开启调试时把完整错误打到 stderr。
    debugLog("statusline", "failed, emitting fallback", error instanceof Error ? (error.stack ?? error.message) : String(error));
    const fallback = computeStatuslineEvent(createPersistedStatuslineEvent({}));
    process.stdout.write(`${fallback.statusLine}\n`);
  }
}

/** 构建 dashboard 的公共逻辑，build/open 复用同一套生成流程。 */
async function buildDashboard(options: CliOptions): Promise<string> {
  const dataDir = getDataDir(options);
  const range = getStringOption(options, "range") ?? "today";
  const now = new Date();
  const window = resolveRange(range, now);
  const events = (await readEventsForRange(dataDir, range, now)).map((record) => computeStatuslineEvent(record));
  debugLog("dashboard", "events loaded", { range, label: window.label, sampleCount: events.length });
  const html = buildDashboardHtml(events, window.label, window.start, window.end);
  const outputPath = path.resolve(
    getStringOption(options, "out") ?? path.join(getDashboardDir(dataDir), `${window.label}.html`),
  );
  await writeTextFile(outputPath, html);
  debugLog("dashboard", "html written", { outputPath, bytes: html.length });
  return outputPath;
}

/** 直接返回 dashboard HTML 字符串，供本地 HTTP 服务复用。 */
async function renderDashboardHtml(options: CliOptions): Promise<string> {
  const dataDir = getDataDir(options);
  const range = getStringOption(options, "range") ?? "today";
  const now = new Date();
  const window = resolveRange(range, now);
  const events = (await readEventsForRange(dataDir, range, now)).map((record) => computeStatuslineEvent(record));
  return buildDashboardHtml(events, window.label, window.start, window.end);
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
 * 导出原始事件。
 *
 * 当前默认导出一个 JSON 包，同时包含原始事件和按天周汇总。
 */
async function handleExport(options: CliOptions): Promise<void> {
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
  const window = resolveRange(range, now);
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
  const defaultFileName = gitEmailPrefix ? `${gitEmailPrefix}_export_${fileLabel}.json` : `export_${fileLabel}.json`;
  const outputPath = path.resolve(output ?? path.join(dataDir, "exports", defaultFileName));
  await writeTextFile(outputPath, content);
  debugLog("export", "bundle written", { outputPath, bytes: content.length });
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

  const server = http.createServer(async (_request, response) => {
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
