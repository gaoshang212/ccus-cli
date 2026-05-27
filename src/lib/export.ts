import fs from "node:fs/promises";
import path from "node:path";
import { ExportSummaryRow, PersistedStatuslineEvent, StatuslineEvent } from "../types";
import { roundNumber } from "./time";

/** CSV 字符串字段统一做转义，避免逗号和引号破坏列结构。 */
function quoteCsv(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
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

/** 原始 JSONL 导出适合程序继续消费。 */
export function buildRawJsonl(events: PersistedStatuslineEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
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
      const latestUsage = [...items]
        .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
        .find((item) => item.usagePct !== null)?.usagePct ?? null;

      return {
        date,
        sampleCount: items.length,
        averageUsagePct:
          usages.length > 0 ? roundNumber(usages.reduce((sum, value) => sum + value, 0) / usages.length, 1) : null,
        peakUsagePct: usages.length > 0 ? roundNumber(Math.max(...usages), 1) : null,
        minimumUsagePct: usages.length > 0 ? roundNumber(Math.min(...usages), 1) : null,
        latestUsagePct: latestUsage,
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
    "averageUsagePct",
    "peakUsagePct",
    "minimumUsagePct",
    "latestUsagePct",
    "uniqueSessions",
    "uniqueWorkspaces",
  ];
  const lines = rows.map((row) =>
    toCsvLine([
      row.date,
      row.sampleCount,
      row.averageUsagePct,
      row.peakUsagePct,
      row.minimumUsagePct,
      row.latestUsagePct,
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
