import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { AggregatedDailyRow, AggregatedEventRow, AggregatedWeeklyRow, PersistedStatuslineEvent, StatuslineEvent, WeeklyExportBundle, WeeklyExportDaySummary } from "../types";
import { computeStatuslineEvent } from "./payload";
import { extractGitEmailAccount, roundNumber } from "./time";

const gunzipAsync = promisify(gunzip);

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

/** bundle 文件可以是明文 `.json`，也可以是 `ccus export` 默认输出的 gzip 压缩 `.json.gz`。 */
function isBundleFileName(name: string): boolean {
  return name.endsWith(".json") || name.endsWith(".json.gz");
}

async function collectBundleJsonFiles(directoryPath: string): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        return collectBundleJsonFiles(fullPath);
      }
      return entry.isFile() && isBundleFileName(entry.name) ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

/** 读取 bundle 文件内容：`.gz` 结尾的先 gunzip 再按 UTF-8 解码，其它按明文读取。 */
async function readBundleFileContent(filePath: string): Promise<string> {
  if (filePath.endsWith(".gz")) {
    const compressed = await fs.readFile(filePath);
    const decompressed = await gunzipAsync(compressed);
    return decompressed.toString("utf8");
  }
  return fs.readFile(filePath, "utf8");
}

/** 读取目录里的 export bundle json 文件。 */
export async function loadWeeklyExportBundles(inputDir: string): Promise<Array<{ filePath: string; bundle: WeeklyExportBundle }>> {
  const files = await collectBundleJsonFiles(inputDir);
  const bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }> = [];
  const invalidFiles: string[] = [];

  for (const filePath of files) {
    try {
      const content = await readBundleFileContent(filePath);
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

/**
 * 同一个人在多台电脑导出多个 bundle 时的合并策略。
 *
 * 累加类字段（token / 消息数 / 采样数等）怕重复计数（同一台机器重复导出、周与周重叠），
 * 所以按「同人同天 / 同人同周取 generatedAt 最新的那份导出 bundle」去重，不相加。
 * usage 是百分比快照、不是累加量，从选中那份 winner bundle 的 rawEvents 按真实时间戳重算
 * （peak 取 max，latest 取时间戳最新），某指标在 rawEvents 里缺失时回退到 daySummary/weeklySummary 自带值。
 */

/** bundle 的 personKey 解析结果做一次缓存，避免反复计算。 */
function bundlePersonKey(bundle: WeeklyExportBundle): string {
  return toPersonKey(bundle.identity.gitUserEmail, bundle.identity.gitUserName);
}

/** 某天 daySummary 是否承载真实数据（用于优先选中有数据的那份 bundle，而非占位空天）。 */
function dayHasData(day: WeeklyExportDaySummary): boolean {
  return day.sampleCount > 0 || day.userMessageCount > 0 || day.apiRequestCount > 0;
}

/** winner 比较：有数据优先，其次 generatedAt 较新，最后用 filePath 做稳定 tie-break。 */
function isBetterCandidate(nextHasData: boolean, nextGeneratedAt: string, nextFilePath: string, currentHasData: boolean, currentGeneratedAt: string, currentFilePath: string): boolean {
  if (nextHasData !== currentHasData) {
    return nextHasData;
  }
  if (nextGeneratedAt !== currentGeneratedAt) {
    return nextGeneratedAt > currentGeneratedAt;
  }
  return nextFilePath > currentFilePath;
}

interface DailyWinner {
  personKey: string;
  date: string;
  day: WeeklyExportDaySummary;
  bundle: WeeklyExportBundle;
}

/** 对每个 (personKey, date) 选出 generatedAt 最新、且尽量有数据的那份 bundle 当天数据。 */
function selectDailyWinners(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): Map<string, DailyWinner> {
  const winners = new Map<string, DailyWinner & { generatedAt: string; filePath: string }>();
  for (const { filePath, bundle } of bundles) {
    const personKey = bundlePersonKey(bundle);
    const generatedAt = bundle.generatedAt ?? "";
    for (const day of bundle.dailySummaries) {
      const key = `${personKey}|${day.date}`;
      const current = winners.get(key);
      if (!current || isBetterCandidate(dayHasData(day), generatedAt, filePath, dayHasData(current.day), current.generatedAt, current.filePath)) {
        winners.set(key, { personKey, date: day.date, day, bundle, generatedAt, filePath });
      }
    }
  }
  return winners;
}

/** 把 bundle 的 rawEvents 计算成 StatuslineEvent 并按本地自然日分组，结果做缓存复用。 */
const bundleEventsCache = new WeakMap<WeeklyExportBundle, Map<string, StatuslineEvent[]>>();
function bundleEventsByDate(bundle: WeeklyExportBundle): Map<string, StatuslineEvent[]> {
  const cached = bundleEventsCache.get(bundle);
  if (cached) {
    return cached;
  }
  const byDate = new Map<string, StatuslineEvent[]>();
  for (const record of bundle.rawEvents.filter(isPersistedStatuslineEvent)) {
    const event = computeStatuslineEvent(record);
    const dateKey = localDateKey(new Date(event.timestamp));
    const list = byDate.get(dateKey);
    if (list) {
      list.push(event);
    } else {
      byDate.set(dateKey, [event]);
    }
  }
  bundleEventsCache.set(bundle, byDate);
  return byDate;
}

interface RecomputedUsage {
  fiveHourPeakUsagePct: number | null;
  fiveHourLatestUsagePct: number | null;
  sevenDayPeakUsagePct: number | null;
  sevenDayLatestUsagePct: number | null;
}

/** 从一组事件按真实时间戳重算 5h / 7d 的 peak（max）与 latest（时间戳最新非空）。 */
function recomputeUsage(events: StatuslineEvent[]): RecomputedUsage {
  const newestFirst = [...events].sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
  const fiveValues = events.map((event) => event.usagePct).filter((value): value is number => value !== null);
  const sevenValues = events.map((event) => event.sevenDayUsagePct).filter((value): value is number => value !== null);
  return {
    fiveHourPeakUsagePct: fiveValues.length > 0 ? roundNumber(Math.max(...fiveValues), 1) : null,
    fiveHourLatestUsagePct: newestFirst.find((event) => event.usagePct !== null)?.usagePct ?? null,
    sevenDayPeakUsagePct: sevenValues.length > 0 ? roundNumber(Math.max(...sevenValues), 1) : null,
    sevenDayLatestUsagePct: newestFirst.find((event) => event.sevenDayUsagePct !== null)?.sevenDayUsagePct ?? null,
  };
}

/** 从 winner bundle 的事件展开 detail.csv，同人同天只保留 winner，那份的当天 token 总量随行附带。 */
export function buildAggregatedDetailRows(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): AggregatedEventRow[] {
  const winners = selectDailyWinners(bundles);
  const rows: AggregatedEventRow[] = [];

  for (const winner of winners.values()) {
    const events = bundleEventsByDate(winner.bundle).get(winner.date) ?? [];
    for (const event of events) {
      rows.push({
        ...event,
        personKey: winner.personKey,
        weekKey: weekKey(new Date(event.timestamp)),
        dateKey: winner.date,
        inputTokens: winner.day.inputTokens,
        outputTokens: winner.day.outputTokens,
        cacheReadInputTokens: winner.day.cacheReadInputTokens,
      });
    }
  }

  return rows.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

/** 展开 daily.csv：同人同天取 winner bundle 的累加值，usage 从该 bundle 当天事件重算。 */
export function buildAggregatedDailyRows(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): AggregatedDailyRow[] {
  const winners = selectDailyWinners(bundles);
  const rows: AggregatedDailyRow[] = [];

  for (const winner of winners.values()) {
    const day = winner.day;
    const usage = recomputeUsage(bundleEventsByDate(winner.bundle).get(winner.date) ?? []);
    rows.push({
      personKey: winner.personKey,
      date: day.date,
      userMessageCount: day.userMessageCount,
      apiRequestCount: day.apiRequestCount,
      inputTokens: day.inputTokens,
      outputTokens: day.outputTokens,
      cacheReadInputTokens: day.cacheReadInputTokens,
      sampleCount: day.sampleCount,
      fiveHourPeakUsagePct: usage.fiveHourPeakUsagePct ?? day.fiveHourPeakUsagePct,
      fiveHourLatestUsagePct: usage.fiveHourLatestUsagePct ?? day.fiveHourLatestUsagePct,
      sevenDayPeakUsagePct: usage.sevenDayPeakUsagePct ?? day.sevenDayPeakUsagePct,
      sevenDayLatestUsagePct: usage.sevenDayLatestUsagePct ?? day.sevenDayLatestUsagePct,
      uniqueSessions: day.uniqueSessions,
      uniqueWorkspaces: day.uniqueWorkspaces,
    });
  }

  return rows.sort((left, right) => `${left.personKey}|${left.date}`.localeCompare(`${right.personKey}|${right.date}`));
}

/** 周级 usage 回退：rawEvents 缺失时从各天 daySummary 自带值取 peak（max）/ latest（date 最新非空）。 */
function fallbackWeeklyUsage(days: WeeklyExportDaySummary[]): RecomputedUsage {
  const byDateDesc = [...days].sort((left, right) => right.date.localeCompare(left.date));
  const fivePeaks = days.map((day) => day.fiveHourPeakUsagePct).filter((value): value is number => value !== null);
  const sevenPeaks = days.map((day) => day.sevenDayPeakUsagePct).filter((value): value is number => value !== null);
  return {
    fiveHourPeakUsagePct: fivePeaks.length > 0 ? roundNumber(Math.max(...fivePeaks), 1) : null,
    fiveHourLatestUsagePct: byDateDesc.find((day) => day.fiveHourLatestUsagePct !== null)?.fiveHourLatestUsagePct ?? null,
    sevenDayPeakUsagePct: sevenPeaks.length > 0 ? roundNumber(Math.max(...sevenPeaks), 1) : null,
    sevenDayLatestUsagePct: byDateDesc.find((day) => day.sevenDayLatestUsagePct !== null)?.sevenDayLatestUsagePct ?? null,
  };
}

interface WeeklyAccumulator {
  personKey: string;
  week: string;
  userMessageCount: number;
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  sampleCount: number;
  uniqueSessions: number;
  uniqueWorkspaces: number;
  days: WeeklyExportDaySummary[];
  events: StatuslineEvent[];
}

/**
 * 展开 weekly.csv：一个人同一周有多份 bundle（多台电脑各导出）时，不取单独一份的整周汇总，
 * 而是复用按天去重后的 daily winner（每天选有数据的那份），按 (person, 周) 把每天的 token / 计数累加上卷，
 * usage 从该周所有 winner 天的事件重算（peak 取 max、latest 取时间戳最新），缺失时回退到 daySummary 自带值。
 */
export function buildAggregatedWeeklyRows(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): AggregatedWeeklyRow[] {
  const dailyWinners = selectDailyWinners(bundles);
  const groups = new Map<string, WeeklyAccumulator>();

  for (const winner of dailyWinners.values()) {
    const week = weekKey(new Date(winner.bundle.range.start));
    const key = `${winner.personKey}|${week}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        personKey: winner.personKey,
        week,
        userMessageCount: 0,
        apiRequestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        sampleCount: 0,
        uniqueSessions: 0,
        uniqueWorkspaces: 0,
        days: [],
        events: [],
      };
      groups.set(key, acc);
    }
    const day = winner.day;
    acc.userMessageCount += day.userMessageCount;
    acc.apiRequestCount += day.apiRequestCount;
    acc.inputTokens += day.inputTokens;
    acc.outputTokens += day.outputTokens;
    acc.cacheReadInputTokens += day.cacheReadInputTokens;
    acc.sampleCount += day.sampleCount;
    acc.uniqueSessions += day.uniqueSessions;
    acc.uniqueWorkspaces += day.uniqueWorkspaces;
    acc.days.push(day);
    acc.events.push(...(bundleEventsByDate(winner.bundle).get(winner.date) ?? []));
  }

  const rows: AggregatedWeeklyRow[] = [];
  for (const acc of groups.values()) {
    const usage = recomputeUsage(acc.events);
    const fallback = fallbackWeeklyUsage(acc.days);
    rows.push({
      personKey: acc.personKey,
      week: acc.week,
      userMessageCount: acc.userMessageCount,
      apiRequestCount: acc.apiRequestCount,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens,
      sampleCount: acc.sampleCount,
      fiveHourPeakUsagePct: usage.fiveHourPeakUsagePct ?? fallback.fiveHourPeakUsagePct,
      fiveHourLatestUsagePct: usage.fiveHourLatestUsagePct ?? fallback.fiveHourLatestUsagePct,
      sevenDayPeakUsagePct: usage.sevenDayPeakUsagePct ?? fallback.sevenDayPeakUsagePct,
      sevenDayLatestUsagePct: usage.sevenDayLatestUsagePct ?? fallback.sevenDayLatestUsagePct,
      uniqueSessions: acc.uniqueSessions,
      uniqueWorkspaces: acc.uniqueWorkspaces,
    });
  }

  return rows.sort((left, right) => `${left.personKey}|${left.week}`.localeCompare(`${right.personKey}|${right.week}`));
}
