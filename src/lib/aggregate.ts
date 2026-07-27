import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { AggregatedDailyRow, AggregatedEventRow, AggregatedWeeklyRow, PersistedStatuslineEvent, StatuslineEvent, WeeklyExportBundle, WeeklyExportDaySummary, CodexUsageSnapshot } from "../types";
import { computeStatuslineEvent, isCodexSourceEvent } from "./payload";
import { extractGitEmailAccount, roundNumber } from "./time";

const gunzipAsync = promisify(gunzip);

function maxOrNull(values: Array<number | null>): number | null {
  const numbers = values.filter((v): v is number => v !== null);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

/** 两个可空数值相加：null 视为 0；两者皆 null 返回 null（表示两源都无该指标）。用于 codex+claude latest 叠加。 */
export function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

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

  if (typeof value.schemaVersion !== "number" || ![6, 7, 8].includes(value.schemaVersion)) {
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
  const invalidFiles: string[] = [];

  const results = await Promise.all(
    files.map(async (filePath) => {
      try {
        const content = await readBundleFileContent(filePath);
        const parsed = JSON.parse(content) as unknown;
        if (isWeeklyExportBundle(parsed)) {
          return { filePath, bundle: parsed as WeeklyExportBundle };
        }
        return { filePath, bundle: null };
      } catch {
        return null;
      }
    }),
  );

  const bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }> = [];
  for (const result of results) {
    if (result === null) continue;
    if (result.bundle === null) {
      invalidFiles.push(result.filePath);
    } else {
      bundles.push({ filePath: result.filePath, bundle: result.bundle });
    }
  }

  if (invalidFiles.length > 0) {
    throw new Error(
      `Unsupported export bundle schema in files: ${invalidFiles.join(", ")}. Re-export with current ccus so aggregate receives schemaVersion 6/7/8 bundles.`,
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

/**
 * winner 比较：数据质量等级高优先；同 tier=2 時消息数多优先（避免"仅 generatedAt 更新"的低活跃机器
 * 覆盖同一天高活跃机器的数据）；同 count 内 generatedAt 较新优先；最后用 filePath 做稳定 tie-break。
 */
function isBetterCandidate(
  nextTier: number, nextMsgCount: number, nextApiCount: number, nextGeneratedAt: string, nextFilePath: string,
  currentTier: number, currentMsgCount: number, currentApiCount: number, currentGeneratedAt: string, currentFilePath: string,
): boolean {
  if (nextTier !== currentTier) {
    return nextTier > currentTier;
  }
  if (nextTier === 2) {
    if (nextMsgCount !== currentMsgCount) {
      return nextMsgCount > currentMsgCount;
    }
    if (nextApiCount !== currentApiCount) {
      return nextApiCount > currentApiCount;
    }
  }
  if (nextGeneratedAt !== currentGeneratedAt) {
    return nextGeneratedAt > currentGeneratedAt;
  }
  return nextFilePath > currentFilePath;
}

interface DailyRepresentative {
  personKey: string;
  date: string;
  day: WeeklyExportDaySummary;
  bundle: WeeklyExportBundle;
}

/**
 * 同一 (personKey, date) 的所有 bundle，按 rawEvents sessionId 集合的交集分组：
 * - 有交集的视为同机器重复导出（同一账号同一天的会话在两份 bundle 里均存在），只取最优 winner
 * - 无交集的视为不同机器的独立数据，分别保留，后续叠加
 *
 * sessionId 集合为空的候选（该天没有 statusline 事件）不参与交集判断，单独成组。
 */
function selectDailyRepresentatives(
  bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>,
): Map<string, DailyRepresentative[]> {
  // 收集每个 (personKey, date) 的所有候选
  const candidatesByKey = new Map<
    string,
    Array<{ day: WeeklyExportDaySummary; bundle: WeeklyExportBundle; generatedAt: string; filePath: string; sessionIds: Set<string> }>
  >();

  for (const { filePath, bundle } of bundles) {
    const personKey = bundlePersonKey(bundle);
    const generatedAt = bundle.generatedAt ?? "";
    const eventsByDate = bundleEventsByDate(bundle);
    for (const day of bundle.dailySummaries) {
      const key = `${personKey}|${day.date}`;
      const events = eventsByDate.get(day.date) ?? [];
      const sessionIds = new Set(events.map((e) => e.sessionId).filter((s): s is string => s !== null));
      const list = candidatesByKey.get(key) ?? [];
      list.push({ day, bundle, generatedAt, filePath, sessionIds });
      candidatesByKey.set(key, list);
    }
  }

  const result = new Map<string, DailyRepresentative[]>();
  for (const [key, candidates] of candidatesByKey.entries()) {
    const barIdx = key.indexOf("|");
    const personKey = key.slice(0, barIdx);
    const date = key.slice(barIdx + 1);

    // 贪心分组：候选有 sessionId 且与某组内任意候选的 sessionId 有交集，则并入该组；否则新建组
    const groups: typeof candidates[] = [];
    for (const candidate of candidates) {
      let added = false;
      if (candidate.sessionIds.size > 0) {
        for (const group of groups) {
          const hasOverlap = group.some((c) => c.sessionIds.size > 0 && [...candidate.sessionIds].some((s) => c.sessionIds.has(s)));
          if (hasOverlap) {
            group.push(candidate);
            added = true;
            break;
          }
        }
      }
      if (!added) {
        groups.push([candidate]);
      }
    }

    // 每组取最优代表（同机器多次导出只保留一份）
    const reps: DailyRepresentative[] = groups.map((group) => {
      let best = group[0];
      for (let i = 1; i < group.length; i++) {
        const c = group[i];
        if (
          isBetterCandidate(
            dayDataTier(c.day), c.day.userMessageCount, c.day.apiRequestCount, c.generatedAt, c.filePath,
            dayDataTier(best.day), best.day.userMessageCount, best.day.apiRequestCount, best.generatedAt, best.filePath,
          )
        ) {
          best = c;
        }
      }
      return { personKey, date, day: best.day, bundle: best.bundle };
    });

    result.set(key, reps);
  }

  return result;
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

/** 7d 累计曲线上的一个点：某采样时刻 + 截至该时刻的分段峰谷累计值（单调非递减）。 */
export interface CumulativeSevenDayPoint {
  timestamp: string;
  cumulative: number;
}

/**
 * 7 天额度累计真实使用量的**逐点曲线**：对一组事件取非 null `sevenDayUsagePct`、按时间升序，用**分段峰谷和**
 * 还原，并在每个样本处输出「截至此刻的累计值」，得到一条单调非递减曲线。
 *
 * 把曲线按 reset（样本跌破当前段峰值的 {@link SEVEN_DAY_RESET_RATIO}）切成若干上升段，
 * 每段贡献「段内峰值 − 段内谷值」，累计 = 各段贡献之和。等价于「正增量累加，但忽略未跌破段峰一半的小回落」。
 *
 * 之所以不用朴素的 `Σ max(0, uᵢ − uᵢ₋₁)`：实测 7d 信号在同一档位反复 ±1 抖动（采样毛刺），
 * 朴素累加会把每次上抖都计成真实增长，导致严重高估（实测 gaoshang 102 vs 分段 50）。
 * 分段峰谷和对抖动 / aging 回落鲁棒，又能正确累计「涨到峰 → 归零 → 再涨」的多段真实使用。
 *
 * 每个点的累计 = 已锁定的各完整段贡献 + 当前段 (segMax − segMin)；段内更新 / reset 都不会让它回落，
 * 所以曲线单调非递减、终点恒等于 {@link computeCumulativeSevenDay} 的标量返回值。输入建议先经 deburr 去毛刺。
 * 无有效样本返回空数组；单样本返回单点 0。
 */
export function computeCumulativeSevenDayCurve(events: StatuslineEvent[]): CumulativeSevenDayPoint[] {
  const sorted = [...events]
    .filter((event): event is StatuslineEvent & { sevenDayUsagePct: number } => event.sevenDayUsagePct !== null)
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
  if (sorted.length === 0) {
    return [];
  }
  const points: CumulativeSevenDayPoint[] = [{ timestamp: sorted[0].timestamp, cumulative: 0 }];
  let cumulative = 0;
  let segMin = sorted[0].sevenDayUsagePct;
  let segMax = sorted[0].sevenDayUsagePct;
  for (let index = 1; index < sorted.length; index += 1) {
    const value = sorted[index].sevenDayUsagePct;
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
    points.push({ timestamp: sorted[index].timestamp, cumulative: roundNumber(cumulative + (segMax - segMin), 1) ?? 0 });
  }
  return points;
}

/**
 * 7 天额度累计真实使用量（标量）：取 {@link computeCumulativeSevenDayCurve} 曲线终点。
 *
 * 无有效样本返回 null（区别于 0：0 表示有样本但无净增长）；单样本返回 0。
 */
export function computeCumulativeSevenDay(events: StatuslineEvent[]): number | null {
  const curve = computeCumulativeSevenDayCurve(events);
  return curve.length === 0 ? null : curve[curve.length - 1].cumulative;
}

/** 7d 曲线读数去毛刺的最小持续时长：短于此的中间读数段视为 stale / 瞬时异常。 */
const SEVEN_DAY_MIN_HOLD_MS = 2 * 60 * 1000;

/**
 * 7d 曲线读数去毛刺：真实 7d 信号变化慢、每个档位会被高频采样连续覆盖几十上百个样本，
 * 而 stale 缓存读数 / 瞬时异常只会短暂出现（秒级，如 baseline 很低时偶发跳到 30 又落回）。
 *
 * 把**中间**持续短于 {@link SEVEN_DAY_MIN_HOLD_MS} 的读数段替换为最近的已保留前值，抹掉这些尖峰；
 * 首尾段无条件保留（端点缺上下文判断持续性）。这等价于人眼在曲线图上自动忽略短毛刺。
 *
 * 持续时长默认按「下一段起始 − 本段起始」度量（密集采样下约等于本段实际持续）；但当**多样本**段后面紧跟一段
 * 比阈值还大的**采集间隙**时，该度量会把间隙也算进去、把只持续几十秒的短尖峰“撑”过阈值而漏抹，
 * 此时改用**段内真实跨度（最后样本 − 第一样本）**判定。单样本段无段内跨度、无法据此判断，仍走原度量。
 *
 * 仅对密集采样的真实曲线生效：稀疏数据（每个值只有一两个样本、间隔很大）的单样本中间段仍按原度量保留，
 * 不会被误删，所以 spec 的稀疏示例与单样本段不受影响。输入须按 timestamp 升序。
 */
export function deburrSevenDayEvents(events: StatuslineEvent[], minHoldMs: number = SEVEN_DAY_MIN_HOLD_MS): StatuslineEvent[] {
  if (events.length <= 2) {
    return events;
  }
  const runs: Array<{ value: number | null; startIdx: number; endIdx: number; startTime: number; endTime: number }> = [];
  let index = 0;
  while (index < events.length) {
    let end = index;
    while (end + 1 < events.length && events[end + 1].sevenDayUsagePct === events[index].sevenDayUsagePct) {
      end += 1;
    }
    runs.push({
      value: events[index].sevenDayUsagePct,
      startIdx: index,
      endIdx: end,
      startTime: new Date(events[index].timestamp).getTime(),
      endTime: new Date(events[end].timestamp).getTime(),
    });
    index = end + 1;
  }

  const result = [...events];
  let lastKept = runs[0].value;
  for (let k = 0; k < runs.length; k += 1) {
    const isEdge = k === 0 || k === runs.length - 1;
    // 默认持续时长 = 下一段起始 − 本段起始（密集采样下约等于本段实际持续）。
    const toNext = k + 1 < runs.length ? runs[k + 1].startTime - runs[k].startTime : Number.POSITIVE_INFINITY;
    // 本段最后样本到下一段起始的采集间隙：密集采样下很小，遇到数据采集中断时会变大。
    const gapAfter = k + 1 < runs.length ? runs[k + 1].startTime - runs[k].endTime : Number.POSITIVE_INFINITY;
    // 多样本段（段内本身有跨度）后面若紧跟一段比阈值还大的采集间隙，说明 toNext 把间隙也算进了持续时长，
    // 会把本只持续几十秒的短尖峰“撑”过阈值而漏抹；此时改用段内真实跨度判定，正确识别这类 stale 尖峰。
    // 单样本段（无段内跨度）无法据此判断真实持续，仍走 toNext，避免误伤稀疏单样本数据。
    const multiSample = runs[k].endIdx > runs[k].startIdx;
    const holdMs = multiSample && gapAfter > minHoldMs ? runs[k].endTime - runs[k].startTime : toNext;
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
 * 把一组事件整理成一条可用于累计计算的 7d 曲线：取非 null `sevenDayUsagePct`、按时间升序、
 * 对完全相同 timestamp 去重，再做读数去毛刺。
 *
 * 单台机器的本地日志（dashboard 个人看板）与多机合并（aggregate）都走这同一套整理逻辑，
 * 保证两边的累计口径不会漂移。
 */
export function buildSevenDayCurveFromEvents(events: StatuslineEvent[]): StatuslineEvent[] {
  const sorted = [...events]
    .filter((event) => event.sevenDayUsagePct !== null)
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
  const seen = new Set<string>();
  const deduped: StatuslineEvent[] = [];
  for (const event of sorted) {
    if (seen.has(event.timestamp)) {
      continue;
    }
    seen.add(event.timestamp);
    deduped.push(event);
  }
  return deburrSevenDayEvents(deduped);
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
    // 含 Claude + Codex 两源读数：codex 7d 读数不再过滤，并入同一条曲线算累计
    for (const record of bundle.rawEvents.filter((r) => isPersistedStatuslineEvent(r))) {
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
    curves.set(personKey, buildSevenDayCurveFromEvents(events));
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

/** 展开 detail.csv：同人同天各机器的代表 bundle 事件都列出来，token 总量随本机器当天的 daySummary 附带。 */
export function buildAggregatedDetailRows(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): AggregatedEventRow[] {
  const repsMap = selectDailyRepresentatives(bundles);
  const rows: AggregatedEventRow[] = [];

  for (const reps of repsMap.values()) {
    for (const rep of reps) {
      const events = bundleEventsByDate(rep.bundle).get(rep.date) ?? [];
      for (const event of events) {
        const isCodex = isCodexSourceEvent(event);
        rows.push({
          ...event,
          personKey: rep.personKey,
          weekKey: weekKey(new Date(event.timestamp)),
          dateKey: rep.date,
          source: isCodex ? "codex" : "claude",
          // codex 事件无单事件 token 语义（token 在 daySummary.codex 按天聚合），不附 claude 的日总量。
          inputTokens: isCodex ? 0 : rep.day.inputTokens,
          outputTokens: isCodex ? 0 : rep.day.outputTokens,
          cacheReadInputTokens: isCodex ? 0 : rep.day.cacheReadInputTokens,
        });
      }
    }
  }

  return rows.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

const ZERO_CODEX: CodexUsageSnapshot = { userMessageCount: 0, apiRequestCount: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, fiveHourPeakUsagePct: null, fiveHourLatestUsagePct: null, sevenDayPeakUsagePct: null, sevenDayLatestUsagePct: null };

/** 取 daySummary 的 codex 快照；缺字段（手编 bundle）回退零值，避免 reduce 抛错或 NaN。 */
function codexOf(day: WeeklyExportDaySummary): CodexUsageSnapshot {
  return day.codex ?? ZERO_CODEX;
}

/**
 * 展开 daily.csv：同人同天的不同机器数据直接叠加（计数字段相加），usage 从所有机器该天事件合并后重算。
 * 同机器重复导出由 selectDailyRepresentatives 在分组阶段去重，不会翻倍。
 */
export function buildAggregatedDailyRows(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): AggregatedDailyRow[] {
  const repsMap = selectDailyRepresentatives(bundles);
  const curves = buildPersonSevenDayCurve(bundles);
  const rows: AggregatedDailyRow[] = [];

  for (const reps of repsMap.values()) {
    const { personKey, date } = reps[0];

    // 不同机器的独立数据直接叠加
    // 累加量含 Codex：Claude + Codex 同字段相加
    const userMessageCount = reps.reduce((sum, r) => sum + r.day.userMessageCount + codexOf(r.day).userMessageCount, 0);
    const apiRequestCount = reps.reduce((sum, r) => sum + r.day.apiRequestCount + codexOf(r.day).apiRequestCount, 0);
    const inputTokens = reps.reduce((sum, r) => sum + r.day.inputTokens + codexOf(r.day).inputTokens, 0);
    const outputTokens = reps.reduce((sum, r) => sum + r.day.outputTokens + codexOf(r.day).outputTokens, 0);
    const cacheReadInputTokens = reps.reduce((sum, r) => sum + r.day.cacheReadInputTokens + codexOf(r.day).cacheReadInputTokens, 0);
    const sampleCount = reps.reduce((sum, r) => sum + r.day.sampleCount, 0);
    const uniqueSessions = reps.reduce((sum, r) => sum + r.day.uniqueSessions, 0);
    const uniqueWorkspaces = reps.reduce((sum, r) => sum + r.day.uniqueWorkspaces, 0);

    // 按 source 分流：Claude usage 只算 claude 事件，Codex usage 单列重算（避免 codex 额度污染 claude usage）。
    const allEvents = reps.flatMap((r) => bundleEventsByDate(r.bundle).get(date) ?? []);
    const claudeEvents = allEvents.filter((event) => !isCodexSourceEvent(event));
    const codexEvents = allEvents.filter(isCodexSourceEvent);
    const usage = recomputeUsage(claudeEvents);
    const codexUsage = recomputeUsage(codexEvents);
    // 额度回退：rawEvents 缺时从 daySummary 取（Claude+Codex 合并，见 fallbackWeeklyUsage）
    const fallback = fallbackWeeklyUsage(reps.map((r) => r.day));

    // 累计指标走全样本合并曲线，不走单机的 recomputeUsage，避免漏掉另一台机器的样本。
    const sevenDayCumulativeUsagePct = computeCumulativeSevenDay(sliceCurveByDate(curves.get(personKey) ?? [], date));
    rows.push({
      personKey,
      date,
      userMessageCount,
      apiRequestCount,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      sampleCount,
      fiveHourPeakUsagePct: maxOrNull([usage.fiveHourPeakUsagePct, codexUsage.fiveHourPeakUsagePct]) ?? fallback.fiveHourPeakUsagePct,
      fiveHourLatestUsagePct: addNullable(usage.fiveHourLatestUsagePct, codexUsage.fiveHourLatestUsagePct) ?? fallback.fiveHourLatestUsagePct,
      sevenDayPeakUsagePct: maxOrNull([usage.sevenDayPeakUsagePct, codexUsage.sevenDayPeakUsagePct]) ?? fallback.sevenDayPeakUsagePct,
      sevenDayLatestUsagePct: addNullable(usage.sevenDayLatestUsagePct, codexUsage.sevenDayLatestUsagePct) ?? fallback.sevenDayLatestUsagePct,
      sevenDayCumulativeUsagePct,
      uniqueSessions,
      uniqueWorkspaces,
    });
  }

  return rows.sort((left, right) => `${left.personKey}|${left.date}`.localeCompare(`${right.personKey}|${right.date}`));
}

/** 周级 usage 回退：rawEvents 缺失时从各天 daySummary 自带值取 peak（max）/ latest（date 最新非空）。 */
/**
 * rawEvents 缺失时的额度回退：从各天 daySummary 取。
 * Claude 与 Codex 合并：peak 取两源 max、latest 两源相加（与主字段叠加口径一致）。daily/weekly 共用。
 */
function fallbackWeeklyUsage(days: WeeklyExportDaySummary[]): RecomputedUsage {
  const byDateDesc = [...days].sort((left, right) => right.date.localeCompare(left.date));
  const fivePeaks = days.flatMap((day) => [day.fiveHourPeakUsagePct, codexOf(day).fiveHourPeakUsagePct]);
  const sevenPeaks = days.flatMap((day) => [day.sevenDayPeakUsagePct, codexOf(day).sevenDayPeakUsagePct]);
  const claudeFiveLatest = byDateDesc.find((day) => day.fiveHourLatestUsagePct !== null)?.fiveHourLatestUsagePct ?? null;
  const codexFiveDay = byDateDesc.find((day) => codexOf(day).fiveHourLatestUsagePct !== null);
  const claudeSevenLatest = byDateDesc.find((day) => day.sevenDayLatestUsagePct !== null)?.sevenDayLatestUsagePct ?? null;
  const codexSevenDay = byDateDesc.find((day) => codexOf(day).sevenDayLatestUsagePct !== null);
  return {
    fiveHourPeakUsagePct: roundNumber(maxOrNull(fivePeaks), 1),
    fiveHourLatestUsagePct: addNullable(claudeFiveLatest, codexFiveDay ? codexOf(codexFiveDay).fiveHourLatestUsagePct : null),
    sevenDayPeakUsagePct: roundNumber(maxOrNull(sevenPeaks), 1),
    sevenDayLatestUsagePct: addNullable(claudeSevenLatest, codexSevenDay ? codexOf(codexSevenDay).sevenDayLatestUsagePct : null),
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
 * 展开 weekly.csv：不同机器的同人同天数据已在 selectDailyRepresentatives 层按 sessionId 去重分组，
 * 这里直接按 (person, 周) 把所有代表的 token / 计数累加上卷，usage 从该周所有代表事件重算。
 */
export function buildAggregatedWeeklyRows(bundles: Array<{ filePath: string; bundle: WeeklyExportBundle }>): AggregatedWeeklyRow[] {
  const repsMap = selectDailyRepresentatives(bundles);
  const curves = buildPersonSevenDayCurve(bundles);
  const groups = new Map<string, WeeklyAccumulator>();

  for (const reps of repsMap.values()) {
    for (const rep of reps) {
      const week = weekKey(new Date(rep.bundle.range.start));
      const key = `${rep.personKey}|${week}`;
      let acc = groups.get(key);
      if (!acc) {
        acc = {
          personKey: rep.personKey,
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
      const day = rep.day;
      const codexDay = codexOf(day);
      // 累加量含 Codex：Claude + Codex 同字段相加
      acc.userMessageCount += day.userMessageCount + codexDay.userMessageCount;
      acc.apiRequestCount += day.apiRequestCount + codexDay.apiRequestCount;
      acc.inputTokens += day.inputTokens + codexDay.inputTokens;
      acc.outputTokens += day.outputTokens + codexDay.outputTokens;
      acc.cacheReadInputTokens += day.cacheReadInputTokens + codexDay.cacheReadInputTokens;
      acc.sampleCount += day.sampleCount;
      acc.uniqueSessions += day.uniqueSessions;
      acc.uniqueWorkspaces += day.uniqueWorkspaces;
      acc.days.push(day);
      acc.events.push(...(bundleEventsByDate(rep.bundle).get(rep.date) ?? []));
    }
  }

  const rows: AggregatedWeeklyRow[] = [];
  for (const acc of groups.values()) {
    // 按 source 分流：Claude usage 只算 claude 事件，Codex usage 单列重算。
    const claudeEvents = acc.events.filter((event) => !isCodexSourceEvent(event));
    const codexEvents = acc.events.filter(isCodexSourceEvent);
    const usage = recomputeUsage(claudeEvents);
    const codexUsage = recomputeUsage(codexEvents);
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
      fiveHourPeakUsagePct: maxOrNull([usage.fiveHourPeakUsagePct, codexUsage.fiveHourPeakUsagePct]) ?? fallback.fiveHourPeakUsagePct,
      fiveHourLatestUsagePct: addNullable(usage.fiveHourLatestUsagePct, codexUsage.fiveHourLatestUsagePct) ?? fallback.fiveHourLatestUsagePct,
      sevenDayPeakUsagePct: maxOrNull([usage.sevenDayPeakUsagePct, codexUsage.sevenDayPeakUsagePct]) ?? fallback.sevenDayPeakUsagePct,
      sevenDayLatestUsagePct: addNullable(usage.sevenDayLatestUsagePct, codexUsage.sevenDayLatestUsagePct) ?? fallback.sevenDayLatestUsagePct,
      sevenDayCumulativeUsagePct,
      uniqueSessions: acc.uniqueSessions,
      uniqueWorkspaces: acc.uniqueWorkspaces,
    });
  }

  return rows.sort((left, right) => `${left.personKey}|${left.week}`.localeCompare(`${right.personKey}|${right.week}`));
}
