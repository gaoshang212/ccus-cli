#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { buildDashboardHtml } from "./lib/dashboard";
import { summarizeEvents } from "./lib/dashboard";
import { summarizeClaudeProjectUsage, summarizeClaudeProjectUsageByDay } from "./lib/claude";
import { buildAggregatedDailyCsv, buildAggregatedDetailCsv, buildAggregatedWeeklyCsv, buildSummaryRows, buildWeeklyExportBundleJson, writeTextFile } from "./lib/export";
import { buildAggregatedDailyRows, buildAggregatedDetailRows, buildAggregatedWeeklyRows, loadWeeklyExportBundles } from "./lib/aggregate";
import { readGitIdentity } from "./lib/git";
import { readStdin } from "./lib/io";
import { openInBrowser } from "./lib/open";
import { computeStatuslineEvent, createPersistedStatuslineEvent, extractWorkspaceDir, parseStatuslinePayload } from "./lib/payload";
import { getDashboardDir, getDefaultDataDir } from "./lib/paths";
import { appendEvent, readEventsForRange } from "./lib/storage";
import { enumerateDateKeys, formatGitEmailFilePrefix, formatRangeFileLabel, resolveRange } from "./lib/time";

export interface CliOptions {
  [key: string]: string | boolean | undefined;
}

/** CLI 帮助信息保持简洁，方便直接挂到 README 或终端里查看。 */
function printHelp(): void {
  process.stdout.write(`ccus\n\nCommands:\n  ccus statusline emit [--data-dir PATH] [--input FILE]\n  ccus dashboard build [--range today] [--out FILE] [--data-dir PATH]\n  ccus dashboard open [--range today] [--out FILE] [--data-dir PATH]\n  ccus dashboard serve [--range today] [--port 0] [--host 127.0.0.1] [--open] [--data-dir PATH]\n  ccus export [--range this-week] [--out FILE] [--data-dir PATH]\n  ccus aggregate --input-dir DIR [--out-dir DIR]\n`);
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
 * statusline 主路径：读 payload、归一化、落盘、输出单行状态文本。
 *
 * 这里即使异常也要优雅降级，不能因为采样失败把 statusline 弄挂。
 */
async function handleStatuslineEmit(options: CliOptions): Promise<void> {
  const dataDir = getDataDir(options);

  try {
    const raw = await readInputPayload(options);
    const payload = parseStatuslinePayload(raw);
    const record = createPersistedStatuslineEvent(payload);
    const gitIdentity = await readGitIdentity(extractWorkspaceDir(payload));
    record.gitUserName = gitIdentity.userName;
    record.gitUserEmail = gitIdentity.userEmail;
    await appendEvent(dataDir, record);
    const event = computeStatuslineEvent(record);
    process.stdout.write(`${event.statusLine}\n`);
  } catch {
    const fallback = computeStatuslineEvent(createPersistedStatuslineEvent({}));
    process.stdout.write(`${fallback.statusLine}\n`);
  }
}

/** 构建 dashboard 的公共逻辑，build/open 复用同一套生成流程。 */
async function buildDashboard(options: CliOptions): Promise<string> {
  const dataDir = getDataDir(options);
  const range = getStringOption(options, "range") ?? "today";
  const window = resolveRange(range);
  const events = (await readEventsForRange(dataDir, range, window.end)).map((record) => computeStatuslineEvent(record));
  const html = buildDashboardHtml(events, window.label, window.start, window.end);
  const outputPath = path.resolve(
    getStringOption(options, "out") ?? path.join(getDashboardDir(dataDir), `${window.label}.html`),
  );
  await writeTextFile(outputPath, html);
  return outputPath;
}

/** 直接返回 dashboard HTML 字符串，供本地 HTTP 服务复用。 */
async function renderDashboardHtml(options: CliOptions): Promise<string> {
  const dataDir = getDataDir(options);
  const range = getStringOption(options, "range") ?? "today";
  const window = resolveRange(range);
  const events = (await readEventsForRange(dataDir, range, window.end)).map((record) => computeStatuslineEvent(record));
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

  const window = resolveRange(range);
  const records = await readEventsForRange(dataDir, range, window.end);
  const events = records.map((record) => computeStatuslineEvent(record));
  const statuslineSummary = summarizeEvents(events);
  const statuslineDailyRows = buildSummaryRows(events);
  const claudeUsage = await summarizeClaudeProjectUsage(window.start, window.end);
  const claudeDailyUsage = await summarizeClaudeProjectUsageByDay(window.start, window.end);
  const latestIdentityRecord = [...records].reverse().find((record) => record.gitUserEmail || record.gitUserName);
  const weeklySummary = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    range: {
      label: window.label,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    identity: {
      gitUserName: latestIdentityRecord?.gitUserName ?? null,
      gitUserEmail: latestIdentityRecord?.gitUserEmail ?? null,
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
      weeklyUsagePct: statuslineSummary.weeklyUsagePct,
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
      weeklyUsagePct: row?.weeklyUsagePct ?? null,
      uniqueSessions: row?.uniqueSessions ?? 0,
      uniqueWorkspaces: row?.uniqueWorkspaces ?? 0,
    };
  });
  const bundle = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    range: {
      label: window.label,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    identity: {
      gitUserName: latestIdentityRecord?.gitUserName ?? null,
      gitUserEmail: latestIdentityRecord?.gitUserEmail ?? null,
    },
    rawEvents: records,
    weeklySummary,
    dailySummaries,
  };
  const content = buildWeeklyExportBundleJson(bundle);
  const fileLabel = formatRangeFileLabel(window.start, window.end);
  const gitEmailPrefix = [...records].reverse().reduce<string | null>((prefix, record) => {
    if (prefix !== null) {
      return prefix;
    }

    return formatGitEmailFilePrefix(record.gitUserEmail);
  }, null);
  const defaultFileName = gitEmailPrefix ? `${gitEmailPrefix}_export_${fileLabel}.json` : `export_${fileLabel}.json`;
  const outputPath = path.resolve(output ?? path.join(dataDir, "exports", defaultFileName));
  await writeTextFile(outputPath, content);
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
  const bundles = await loadWeeklyExportBundles(resolvedInputDir);
  const detailCsv = buildAggregatedDetailCsv(buildAggregatedDetailRows(bundles));
  const dailyCsv = buildAggregatedDailyCsv(buildAggregatedDailyRows(bundles));
  const weeklyCsv = buildAggregatedWeeklyCsv(buildAggregatedWeeklyRows(bundles));

  const detailPath = path.join(outputDir, "detail.csv");
  const dailyPath = path.join(outputDir, "daily.csv");
  const weeklyPath = path.join(outputDir, "weekly.csv");
  await Promise.all([
    writeTextFile(detailPath, detailCsv),
    writeTextFile(dailyPath, dailyCsv),
    writeTextFile(weeklyPath, weeklyCsv),
  ]);
  process.stdout.write(`${detailPath}\n${dailyPath}\n${weeklyPath}\n`);
}

/**
 * 解析 export 命令的参数，并拒绝已经移除的旧位置参数/子命令。
 */
export function resolveExportOptions(action: string | undefined, args: string[], rest: string[]): CliOptions {
  if (!action || action.startsWith("--")) {
    return parseOptions(args.slice(1));
  }

  if (action === "summary") {
    throw new Error("`ccus export summary` has been removed. Use `ccus export` to export raw jsonl data.");
  }

  throw new Error(
    `Unsupported export argument: ${action}. Use \`ccus export [--range RANGE] [--out FILE]\`; positional formats and subcommands have been removed.`,
  );
}

/** 顶层命令分发入口。 */
async function main(args = process.argv.slice(2)): Promise<void> {
  const [group, action, ...rest] = args;
  const options = parseOptions(rest);

  if (!group) {
    printHelp();
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
    const aggregateOptions = action && !action.startsWith("--") ? parseOptions(rest) : parseOptions(args.slice(1));
    await handleAggregate(aggregateOptions);
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
    process.exitCode = 1;
  });
}
