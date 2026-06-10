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

/**
 * 某天 daySummary 的数据质量等级（越高越优先）：
 * 2 = 有 transcript 数据（userMessageCount / apiRequestCount > 0）
 * 1 = 仅有 statusline 采样（sampleCount > 0，但 transcript 字段全为 0）
 * 0 = 全空占位天
 *
 * transcript 级别优先于纯 sampleCount 级别，避免只有采样事件但无消息数的 bundle
 * 抢走有真实 transcript 数据的 bundle 的 winner 位置。
 */
function dayDataTier(day: WeeklyExportDaySummary): number {
  if (day.userMessageCount > 0 || day.apiRequestCount > 0) return 2;
  if (day.sampleCount > 0) return 1;
  return 0;
}

/** winner 比较：数据质量等级高优先，同级别内 generatedAt 较新优先，最后用 filePath 做稳定 tie-break。 */
function isBetterCandidate(nextTier: number, nextGeneratedAt: string, nextFilePath: string, currentTier: number, currentGeneratedAt: string, currentFilePath: string): boolean {
  if (nextTier !== currentTier) {
    return nextTier > currentTier;
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
      if (!current || isBetterCandidate(dayDataTier(day), generatedAt, filePath, dayDataTier(current.day), current.generatedAt, current.filePath)) {
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

/**
 * 7d 曲线判定额度重置（reset）的阈值：某样本跌到「当前段峰值 × 此比例」及以下时视为一次归零重置，开启新段。
 *
 * 真实 7d 曲线在每个档位附近会 ±1 抖动、并随滚动窗口小幅回落（aging），这些都不该被当成新使用量。
 * 只有跌破段峰值一半才算真正的额度重置；0.4 / 0.5 / 0.6 对实测数值几乎不敏感，取中间值 0.5。
 */
const SEVEN_DAY_RESET_RATIO = 0.5;

/**
 * 7 天额度累计真实使用量：对一组事件取非 null `sevenDayUsagePct`、按时间升序，用**分段峰谷和**还原。
 *
 * 把曲线按 reset（样本跌破当前段峰值的 {@link SEVEN_DAY_RESET_RATIO}）切成若干上升段，
 * 每段贡献「段内峰值 − 段内谷值」，累计 = 各段贡献之和。等价于「正增量累加，但忽略未跌破段峰一半的小回落」。
 *
 * 之所以不用朴素的 `Σ max(0, uᵢ − uᵢ₋₁)`：实测 7d 信号在同一档位反复 ±1 抖动（采样毛刺），
 * 朴素累加会把每次上抖都计成真实增长，导致严重高估（实测 gaoshang 102 vs 分段 50）。
 * 分段峰谷和对抖动 / aging 回落鲁棒，又能正确累计「涨到峰 → 归零 → 再涨」的多段真实使用。
 *
 * 无有效样本返回 null（区别于 0：0 表示有样本但无净增长）；单样本返回 0。
 */
export function computeCumulativeSevenDay(events: StatuslineEvent[]): number | null {
  const values = [...events]
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
    .map((event) => event.sevenDayUsagePct)
    .filter((value): value is number => value !== null);
  if (values.length === 0) {
    return null;
  }
  let cumulative = 0;
  let segMin = values[0];
  let segMax = values[0];
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value > segMax) {
      segMax = value;
    } else if (segMax > 0 && value <= segMax * SEVEN_DAY_RESET_RATIO) {
      // 跌破段峰一半：判定为额度重置，锁定上一段峰谷差，从该点开启新段。
      cumulative += segMax - segMin;
      segMin = value;
      segMax = value;
    } else if (value < segMin) {
      // 段内小回落（抖动 / aging）：只更新谷值，不分段、不重复计数。
      segMin = value;
    }
  }
  cumulative += segMax - segMin;
  return roundNumber(cumulative, 1);
}

/** 7d 曲线读数去毛刺的最小持续时长：短于此的中间读数段视为 stale / 瞬时异常。 */
const SEVEN_DAY_MIN_HOLD_MS = 2 * 60 * 1000;

/**
 * 7d 曲线读数去毛刺：真实 7d 信号变化慢、每个档位会被高频采样连续覆盖几十上百个样本，
 * 而 stale 缓存读数 / 瞬时异常只会短暂出现（秒级，如 baseline 很低时偶发跳到 30 又落回）。
 *
 * 把**中间**持续短于 {@link SEVEN_DAY_MIN_HOLD_MS} 的读数段（下一段起始 − 本段起始）替换为最近的已保留前值，
 * 抹掉这些尖峰；首尾段无条件保留（端点缺上下文判断持续性）。这等价于人眼在曲线图上自动忽略短毛刺。
 *
 * 仅对密集采样的真实曲线生效：稀疏数据（每个值只有一两个样本、间隔很大）的中间段持续时长通常远超阈值，
 * 不会被误删，所以 spec 的稀疏示例与单样本段不受影响。输入须按 timestamp 升序。
 */
function deburrSevenDayEvents(events: StatuslineEvent[], minHoldMs: number = SEVEN_DAY_MIN_HOLD_MS): StatuslineEvent[] {
  if (events.length <= 2) {
    return events;
  }
  const runs: Array<{ value: number | null; startIdx: number; endIdx: number; startTime: number }> = [];
  let index = 0;
  while (index < events.length) {
    let end = index;
    while (end + 1 < events.length && events[end + 1].sevenDayUsagePct === events[index].sevenDayUsagePct) {
      end += 1;
    }
    runs.push({ value: events[index].sevenDayUsagePct, startIdx: index, endIdx: end, startTime: new Date(events[index].timestamp).getTime() });
    index = end + 1;
  }

  const result = [...events];
  let lastKept = runs[0].value;
  for (let k = 0; k < runs.length; k += 1) {
    const isEdge = k === 0 || k === runs.length - 1;
    const holdMs = k + 1 < runs.length ? runs[k + 1].startTime - runs[k].startTime : Number.POSITIVE_INFINITY;
    if (isEdge || holdMs >= minHoldMs) {
      lastKept = runs[k].value;
      continue;
    }
    for (let idx = runs[k].startIdx; idx <= runs[k].endIdx; idx += 1) {
      result[idx] = { ...result[idx], sevenDayUsagePct: lastKept };
    }
  }
  return result;
}

/**
 * 同一 personKey 的 7d 累计曲线：把该人**所有 bundle**（非仅 winner）的 rawEvents 计算成事件、
 * 取非 null `sevenDayUsagePct`、按 timestamp 升序合并、对完全相同 timestamp 去重，再做读数去毛刺，
 * 得到一条账号级曲线。
 *
 * 走全样本而非 winner，是因为累计指标是同一条共享额度曲线的密集采样：只取 winner 会漏掉非 winner
 * 机器的样本（曲线稀疏、累计偏小），分机各自累计再相加又会翻倍。结果按 bundles 数组缓存复用。
 */
const personSevenDayCurveCache = new WeakMap<object, Map<string, StatuslineEvent[]>>();
export function buildPersonSevenDayCurve(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): Map<string, StatuslineEvent[]> {
  const cached = personSevenDayCurveCache.get(bundles);
  if (cached) {
    return cached;
  }

  const collected = new Map<string, StatuslineEvent[]>();
  for (const { bundle } of bundles) {
    const personKey = bundlePersonKey(bundle);
    for (const record of bundle.rawEvents.filter(isPersistedStatuslineEvent)) {
      const event = computeStatuslineEvent(record);
      if (event.sevenDayUsagePct === null) {
        continue;
      }
      const list = collected.get(personKey);
      if (list) {
        list.push(event);
      } else {
        collected.set(personKey, [event]);
      }
    }
  }

  const curves = new Map<string, StatuslineEvent[]>();
  for (const [personKey, events] of collected.entries()) {
    const sorted = [...events].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
    const seen = new Set<string>();
    const deduped: StatuslineEvent[] = [];
    for (const event of sorted) {
      if (seen.has(event.timestamp)) {
        continue;
      }
      seen.add(event.timestamp);
      deduped.push(event);
    }
    curves.set(personKey, deburrSevenDayEvents(deduped));
  }

  personSevenDayCurveCache.set(bundles, curves);
  return curves;
}

/** 从合并曲线里切出某自然日的子序列。 */
function sliceCurveByDate(curve: StatuslineEvent[], date: string): StatuslineEvent[] {
  return curve.filter((event) => localDateKey(new Date(event.timestamp)) === date);
}

/** 从合并曲线里切出某周（周起始日 key）的子序列。 */
function sliceCurveByWeek(curve: StatuslineEvent[], week: string): StatuslineEvent[] {
  return curve.filter((event) => weekKey(new Date(event.timestamp)) === week);
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
  const curves = buildPersonSevenDayCurve(bundles);
  const rows: AggregatedDailyRow[] = [];

  for (const winner of winners.values()) {
    const day = winner.day;
    const usage = recomputeUsage(bundleEventsByDate(winner.bundle).get(winner.date) ?? []);
    // 累计指标走全样本合并曲线，不走 winner 的 recomputeUsage，避免漏掉非 winner 机器的样本。
    const sevenDayCumulativeUsagePct = computeCumulativeSevenDay(sliceCurveByDate(curves.get(winner.personKey) ?? [], winner.date));
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
      sevenDayCumulativeUsagePct,
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
  const curves = buildPersonSevenDayCurve(bundles);
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
    // 整周累计：在整周合并曲线上一次性求正增量，跨天边界增量被计入，故 weekly ≥ Σ daily。
    const sevenDayCumulativeUsagePct = computeCumulativeSevenDay(sliceCurveByWeek(curves.get(acc.personKey) ?? [], acc.week));
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
      sevenDayCumulativeUsagePct,
      uniqueSessions: acc.uniqueSessions,
      uniqueWorkspaces: acc.uniqueWorkspaces,
    });
  }

  return rows.sort((left, right) => `${left.personKey}|${left.week}`.localeCompare(`${right.personKey}|${right.week}`));
}
