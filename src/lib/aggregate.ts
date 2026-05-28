import fs from "node:fs/promises";
import path from "node:path";
import { AggregatedDailyRow, AggregatedEventRow, AggregatedWeeklyRow, PersistedStatuslineEvent, WeeklyExportBundle } from "../types";
import { computeStatuslineEvent } from "./payload";
import { extractGitEmailAccount } from "./time";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedStatuslineEvent(value: unknown): value is PersistedStatuslineEvent {
  return isRecord(value) && typeof value.timestamp === "string" && isRecord(value.rawPayload);
}

function hasWeeklyStatuslineShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.sampleCount === "number" &&
    typeof value.uniqueSessions === "number" &&
    typeof value.uniqueWorkspaces === "number" &&
    (typeof value.fiveHourLatestUsagePct === "number" || value.fiveHourLatestUsagePct === null) &&
    (typeof value.fiveHourPeakUsagePct === "number" || value.fiveHourPeakUsagePct === null) &&
    (typeof value.sevenDayLatestUsagePct === "number" || value.sevenDayLatestUsagePct === null) &&
    (typeof value.sevenDayPeakUsagePct === "number" || value.sevenDayPeakUsagePct === null)
  );
}

function isWeeklyExportBundle(value: unknown): value is WeeklyExportBundle {
  if (!isRecord(value)) {
    return false;
  }

  if (value.schemaVersion !== 6) {
    return false;
  }

  if (!Array.isArray(value.rawEvents) || !Array.isArray(value.dailySummaries) || !isRecord(value.weeklySummary) || !isRecord(value.identity) || !isRecord(value.range)) {
    return false;
  }

  return hasWeeklyStatuslineShape(value.weeklySummary.statusline);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalWeek(date: Date): Date {
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(date);
  start.setDate(date.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function weekKey(date: Date): string {
  return localDateKey(startOfLocalWeek(date));
}

function toPersonKey(gitUserEmail: string | null, gitUserName: string | null): string {
  return extractGitEmailAccount(gitUserEmail) ?? gitUserName ?? "unknown";
}

async function collectBundleJsonFiles(directoryPath: string): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        return collectBundleJsonFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

/** 读取目录里的 export bundle json 文件。 */
export async function loadWeeklyExportBundles(inputDir: string): Promise<Array<{ filePath: string; bundle: WeeklyExportBundle }>> {
  const files = await collectBundleJsonFiles(inputDir);
  const bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }> = [];
  const invalidFiles: string[] = [];

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (isWeeklyExportBundle(parsed)) {
        bundles.push({ filePath, bundle: parsed });
        continue;
      }
      invalidFiles.push(filePath);
    } catch {
      continue;
    }
  }

  if (invalidFiles.length > 0) {
    throw new Error(
      `Unsupported export bundle schema in files: ${invalidFiles.join(", ")}. Re-export with current ccus so aggregate receives schemaVersion 6 bundles.`,
    );
  }

  return bundles;
}

/** 从 bundle.rawEvents 展开 detail.csv 明细。 */
export function buildAggregatedDetailRows(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): AggregatedEventRow[] {
  const rows: AggregatedEventRow[] = [];

  for (const { bundle } of bundles) {
    const personKey = toPersonKey(bundle.identity.gitUserEmail, bundle.identity.gitUserName);
    const tokensByDate = new Map(bundle.dailySummaries.map((day) => [day.date, day]));
    for (const record of bundle.rawEvents.filter(isPersistedStatuslineEvent)) {
      const event = computeStatuslineEvent(record);
      const ts = new Date(event.timestamp);
      const dateKey = localDateKey(ts);
      const dayTokens = tokensByDate.get(dateKey);
      rows.push({
        ...event,
        personKey,
        weekKey: weekKey(ts),
        dateKey,
        inputTokens: dayTokens?.inputTokens ?? 0,
        outputTokens: dayTokens?.outputTokens ?? 0,
        cacheReadInputTokens: dayTokens?.cacheReadInputTokens ?? 0,
      });
    }
  }

  return rows.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

/** 直接从 bundle.dailySummaries 展开 daily.csv。 */
export function buildAggregatedDailyRows(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): AggregatedDailyRow[] {
  const rows: AggregatedDailyRow[] = [];

  for (const { bundle } of bundles) {
    const personKey = toPersonKey(bundle.identity.gitUserEmail, bundle.identity.gitUserName);
    for (const item of bundle.dailySummaries) {
      rows.push({
        personKey,
        date: item.date,
        userMessageCount: item.userMessageCount,
        apiRequestCount: item.apiRequestCount,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cacheReadInputTokens: item.cacheReadInputTokens,
        sampleCount: item.sampleCount,
        fiveHourPeakUsagePct: item.fiveHourPeakUsagePct,
        fiveHourLatestUsagePct: item.fiveHourLatestUsagePct,
        sevenDayPeakUsagePct: item.sevenDayPeakUsagePct,
        sevenDayLatestUsagePct: item.sevenDayLatestUsagePct,
        uniqueSessions: item.uniqueSessions,
        uniqueWorkspaces: item.uniqueWorkspaces,
      });
    }
  }

  return rows.sort((left, right) => `${left.personKey}|${left.date}`.localeCompare(`${right.personKey}|${right.date}`));
}

/** 直接从 bundle.weeklySummary 展开 weekly.csv。 */
export function buildAggregatedWeeklyRows(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): AggregatedWeeklyRow[] {
  return bundles
    .map(({ bundle }) => ({
      personKey: toPersonKey(bundle.identity.gitUserEmail, bundle.identity.gitUserName),
      week: weekKey(new Date(bundle.range.start)),
      userMessageCount: bundle.weeklySummary.counts.userMessageCount,
      apiRequestCount: bundle.weeklySummary.counts.apiRequestCount,
      inputTokens: bundle.weeklySummary.tokens.inputTokens,
      outputTokens: bundle.weeklySummary.tokens.outputTokens,
      cacheReadInputTokens: bundle.weeklySummary.tokens.cacheReadInputTokens,
      sampleCount: bundle.weeklySummary.statusline.sampleCount,
      fiveHourPeakUsagePct: bundle.weeklySummary.statusline.fiveHourPeakUsagePct,
      fiveHourLatestUsagePct: bundle.weeklySummary.statusline.fiveHourLatestUsagePct,
      sevenDayPeakUsagePct: bundle.weeklySummary.statusline.sevenDayPeakUsagePct,
      sevenDayLatestUsagePct: bundle.weeklySummary.statusline.sevenDayLatestUsagePct,
      uniqueSessions: bundle.weeklySummary.statusline.uniqueSessions,
      uniqueWorkspaces: bundle.weeklySummary.statusline.uniqueWorkspaces,
    }))
    .sort((left, right) => `${left.personKey}|${left.week}`.localeCompare(`${right.personKey}|${right.week}`));
}
