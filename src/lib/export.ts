import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { AggregatedDailyRow, AggregatedEventRow, AggregatedWeeklyRow, ExportSummaryRow, PersistedStatuslineEvent, StatuslineEvent, WeeklyExportBundle, WeeklyExportSummary } from "../types";
import { roundNumber } from "./time";

const gzipAsync = promisify(gzip);

/** CSV 字符串字段统一做转义，避免逗号和引号破坏列结构。 */
function quoteCsv(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

/** token / context 计数统一换算成百万（M）单位，避免 CSV 里出现长串数字。 */
function toMillions(value: number | null): number | null {
  return value === null ? null : roundNumber(value / 1_000_000, 6);
}

/**
 * 清理控制字符，并防止 Excel/Sheets 把值解释成公式。
 *
 * 只对字符串字段生效，数字字段保持原样。
 */
function sanitizeCsvValue(value: string): string {
  const cleaned = value.replaceAll(/[\r\n\0]+/g, " ").trim();
  if (/^[=+\-@]/.test(cleaned)) {
    return `'${cleaned}`;
  }
  return cleaned;
}

/** 把一组值序列化成一行 CSV。 */
function toCsvLine(values: Array<string | number | null | undefined>): string {
  return values
    .map((value) => {
      if (value === null || value === undefined) {
        return "";
      }
      if (typeof value === "number") {
        return String(value);
      }
      return quoteCsv(sanitizeCsvValue(value));
    })
    .join(",");
}

/**
 * 导出原始事件明细，便于后续在 Excel、BI 或脚本里二次分析。
 */
export function buildRawCsv(events: StatuslineEvent[]): string {
  const header = [
    "timestamp",
    "sessionId",
    "workspaceDir",
    "workspaceName",
    "modelName",
    "gitUserName",
    "gitUserEmail",
    "fiveHourUsagePct",
    "contextWindowPct",
    "contextUsed",
    "contextMax",
    "statusLine",
  ];

  const rows = events.map((event) =>
    toCsvLine([
      event.timestamp,
      event.sessionId,
      event.workspaceDir,
      event.workspaceName,
      event.modelName,
      event.gitUserName,
      event.gitUserEmail,
      event.usagePct,
      event.contextWindowPct,
      event.contextUsed,
      event.contextMax,
      event.statusLine,
    ]),
  );

  return [header.join(","), ...rows].join("\n");
}

/** 多人汇总的 detail.csv。 */
export function buildAggregatedDetailCsv(events: AggregatedEventRow[]): string {
  const header = [
    "personKey",
    "timestamp",
    "week",
    "date",
    "sessionId",
    "workspaceName",
    "modelName",
    "source",
    "fiveHourUsagePct",
    "contextWindowPct",
    "contextUsedM",
    "contextMaxM",
    "inputTokensM",
    "outputTokensM",
    "cacheReadInputTokensM",
  ];

  const rows = events.map((event) =>
    toCsvLine([
      event.personKey,
      event.timestamp,
      event.weekKey,
      event.dateKey,
      event.sessionId,
      event.workspaceName,
      event.modelName,
      event.source,
      event.usagePct,
      event.contextWindowPct,
      toMillions(event.contextUsed),
      toMillions(event.contextMax),
      toMillions(event.inputTokens),
      toMillions(event.outputTokens),
      toMillions(event.cacheReadInputTokens),
    ]),
  );

  return [header.join(","), ...rows].join("\n");
}

/** 原始 JSONL 导出适合程序继续消费。 */
export function buildRawJsonl(events: PersistedStatuslineEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

/** 默认导出把本周汇总序列化成可读 JSON。 */
export function buildWeeklySummaryJson(summary: WeeklyExportSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

/** 默认导出把原始事件与周汇总一起打包成一个 JSON 文件，用紧凑序列化避免缩进空白撑大体积。 */
export function buildWeeklyExportBundleJson(bundle: WeeklyExportBundle): string {
  return `${JSON.stringify(bundle)}\n`;
}

/** 按天汇总 usage 数据，生成 summary 模式的中间结果。 */
export function buildSummaryRows(events: StatuslineEvent[]): ExportSummaryRow[] {
  const grouped = new Map<string, StatuslineEvent[]>();
  for (const event of events) {
    const key = event.timestamp.slice(0, 10);
    const items = grouped.get(key);
    if (items) {
      items.push(event);
    } else {
      grouped.set(key, [event]);
    }
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, items]) => {
      const usages = items.map((item) => item.usagePct).filter((value): value is number => value !== null);
      const sevenDayUsages = items.map((item) => item.sevenDayUsagePct).filter((value): value is number => value !== null);
      const latestUsage = [...items]
        .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
        .find((item) => item.usagePct !== null)?.usagePct ?? null;
      const latestSevenDayUsage = [...items]
        .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
        .find((item) => item.sevenDayUsagePct !== null)?.sevenDayUsagePct ?? null;

      return {
        date,
        sampleCount: items.length,
        fiveHourPeakUsagePct: usages.length > 0 ? roundNumber(Math.max(...usages), 1) : null,
        minimumUsagePct: usages.length > 0 ? roundNumber(Math.min(...usages), 1) : null,
        fiveHourLatestUsagePct: latestUsage,
        sevenDayLatestUsagePct: latestSevenDayUsage,
        sevenDayPeakUsagePct: sevenDayUsages.length > 0 ? roundNumber(Math.max(...sevenDayUsages), 1) : null,
        uniqueSessions: new Set(items.map((item) => item.sessionId).filter(Boolean)).size,
        uniqueWorkspaces: new Set(items.map((item) => item.workspaceDir).filter(Boolean)).size,
      };
    });
}

/** 把 summary 结果导出为 CSV。 */
export function buildSummaryCsv(rows: ExportSummaryRow[]): string {
  const header = [
    "date",
    "sampleCount",
    "fiveHourPeakUsagePct",
    "minimumUsagePct",
    "fiveHourLatestUsagePct",
    "sevenDayPeakUsagePct",
    "sevenDayLatestUsagePct",
    "uniqueSessions",
    "uniqueWorkspaces",
  ];
  const lines = rows.map((row) =>
    toCsvLine([
      row.date,
      row.sampleCount,
      row.fiveHourPeakUsagePct,
      row.minimumUsagePct,
      row.fiveHourLatestUsagePct,
      row.sevenDayPeakUsagePct,
      row.sevenDayLatestUsagePct,
      row.uniqueSessions,
      row.uniqueWorkspaces,
    ]),
  );
  return [header.join(","), ...lines].join("\n");
}

/** 多人汇总的 daily.csv。 */
export function buildAggregatedDailyCsv(rows: AggregatedDailyRow[]): string {
  const header = [
    "personKey",
    "date",
    "userMessageCount",
    "apiRequestCount",
    "inputTokensM",
    "outputTokensM",
    "cacheReadInputTokensM",
    "sampleCount",
    "fiveHourPeakUsagePct",
    "fiveHourLatestUsagePct",
    "sevenDayPeakUsagePct",
    "sevenDayLatestUsagePct",
    "sevenDayCumulativeUsagePct",
    "uniqueSessions",
    "uniqueWorkspaces",
  ];
  const lines = rows.map((row) =>
    toCsvLine([
      row.personKey,
      row.date,
      row.userMessageCount,
      row.apiRequestCount,
      toMillions(row.inputTokens),
      toMillions(row.outputTokens),
      toMillions(row.cacheReadInputTokens),
      row.sampleCount,
      row.fiveHourPeakUsagePct,
      row.fiveHourLatestUsagePct,
      row.sevenDayPeakUsagePct,
      row.sevenDayLatestUsagePct,
      row.sevenDayCumulativeUsagePct,
      row.uniqueSessions,
      row.uniqueWorkspaces,
    ]),
  );
  return [header.join(","), ...lines].join("\n");
}

/** 多人汇总的 weekly.csv。 */
export function buildAggregatedWeeklyCsv(rows: AggregatedWeeklyRow[]): string {
  const header = [
    "personKey",
    "week",
    "userMessageCount",
    "apiRequestCount",
    "inputTokensM",
    "outputTokensM",
    "cacheReadInputTokensM",
    "sampleCount",
    "fiveHourPeakUsagePct",
    "fiveHourLatestUsagePct",
    "sevenDayPeakUsagePct",
    "sevenDayLatestUsagePct",
    "sevenDayCumulativeUsagePct",
    "uniqueSessions",
    "uniqueWorkspaces",
  ];
  const lines = rows.map((row) =>
    toCsvLine([
      row.personKey,
      row.week,
      row.userMessageCount,
      row.apiRequestCount,
      toMillions(row.inputTokens),
      toMillions(row.outputTokens),
      toMillions(row.cacheReadInputTokens),
      row.sampleCount,
      row.fiveHourPeakUsagePct,
      row.fiveHourLatestUsagePct,
      row.sevenDayPeakUsagePct,
      row.sevenDayLatestUsagePct,
      row.sevenDayCumulativeUsagePct,
      row.uniqueSessions,
      row.uniqueWorkspaces,
    ]),
  );
  return [header.join(","), ...lines].join("\n");
}

/** 统一负责写文本文件，顺带确保父目录存在。 */
export async function writeTextFile(outputPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, "utf8");
}

/**
 * 把内容 gzip 压缩后写文件，父目录不存在时自动创建。
 *
 * 仅压缩存储/传输层，写入的字节解压后与 `writeTextFile` 完全一致，
 * 不改变 bundle 字段集合，也不影响 schemaVersion。
 */
export async function writeGzipFile(outputPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const compressed = await gzipAsync(content);
  await fs.writeFile(outputPath, compressed);
}
