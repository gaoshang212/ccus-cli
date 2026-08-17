import fs from "node:fs/promises";
import path from "node:path";
import {
  type ApiEquivalentCostResult,
  emptyApiEquivalentCost,
  mergeApiEquivalentCosts,
  priceApiRequest,
} from "./api-equivalent-cost";
import { getCodexHome, getCodexSessionHomes } from "./paths";
import { localDateKey } from "./time";

interface CodexSessionUsageSummary {
  userMessageCount: number;
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  apiEquivalentCost: ApiEquivalentCostResult;
}

interface CodexDailyUsageSummary extends CodexSessionUsageSummary {
  date: string;
}

/** 一个 task_started 事件节点（turn_id + 事件 timestamp 毫秒）。 */
interface RolloutTurnNode {
  turnId: string;
  ms: number;
}

/**
 * summarizeRollout 的返回：本文件范围内的 task_started turn 节点 + token_count 用量。
 * userMessageCount 不在此层产出——turn_id 会被 fork/sub-agent/resume 跨文件重放，
 * 必须由上层做全局 distinct（按 turn_id 取最早 timestamp）。
 */
interface RolloutParse {
  turns: RolloutTurnNode[];
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  apiEquivalentCost: ApiEquivalentCostResult;
}

/** 多个 session 根目录中同一相对路径的 rollout 文件组。 */
interface RolloutFileGroup {
  relativePath: string;
  filePaths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function splitInputTokens(usage: Record<string, unknown>): {
  inputTokens: number;
  cacheReadInputTokens: number;
} {
  const cacheReadInputTokens = getNumber(usage.cached_input_tokens);
  return {
    inputTokens: Math.max(0, getNumber(usage.input_tokens) - cacheReadInputTokens),
    cacheReadInputTokens,
  };
}

/** Guardian 是 Codex Desktop 的动作安全审查子代理，不代表用户请求或业务模型调用。 */
function isGuardianRollout(content: string): boolean {
  let offset = 0;
  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const line = content.slice(offset, newline === -1 ? content.length : newline).trim();
    offset = newline === -1 ? content.length : newline + 1;
    try {
      const record = JSON.parse(line) as unknown;
      if (!isRecord(record) || record.type !== "session_meta" || !isRecord(record.payload)) {
        continue;
      }
      const source = record.payload.source;
      return isRecord(source)
        && isRecord(source.subagent)
        && source.subagent.other === "guardian";
    } catch {
      continue;
    }
  }
  return false;
}

async function collectRolloutFiles(directoryPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          return collectRolloutFiles(fullPath);
        }
        return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
      }),
    );
    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function rolloutPathKey(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 收集标准 Codex 与 Orca session，并按 sessions 下的相对路径归并同一 rollout。 */
async function collectRolloutFileGroups(): Promise<RolloutFileGroup[]> {
  const sessionDirs = getCodexSessionHomes().map((home) => path.join(home, "sessions"));
  const filesByDir = await Promise.all(sessionDirs.map((directory) => collectRolloutFiles(directory)));
  const groups = new Map<string, RolloutFileGroup>();

  for (let index = 0; index < sessionDirs.length; index += 1) {
    const sessionsDir = sessionDirs[index];
    for (const filePath of filesByDir[index]) {
      const relativePath = path.relative(sessionsDir, filePath);
      const key = rolloutPathKey(relativePath);
      const group = groups.get(key);
      if (group) {
        group.filePaths.push(filePath);
      } else {
        groups.set(key, { relativePath, filePaths: [filePath] });
      }
    }
  }

  return [...groups.values()];
}

function rolloutLineKey(line: string): string {
  try {
    return JSON.stringify(JSON.parse(line) as unknown);
  } catch {
    return line;
  }
}

/**
 * 合并同一 rollout 在不同根目录下的副本。
 *
 * 对每种 JSONL 行保留各副本中的最大出现次数，既消除完整/部分镜像造成的重复，
 * 又保留任一副本独有的新增事件以及单个源内真实存在的重复行。
 */
function mergeRolloutContents(contents: string[]): string {
  const mergedLines: string[] = [];
  const mergedCounts = new Map<string, number>();

  for (const content of contents) {
    const sourceCounts = new Map<string, number>();
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    for (const line of lines) {
      const key = rolloutLineKey(line);
      const sourceCount = (sourceCounts.get(key) ?? 0) + 1;
      sourceCounts.set(key, sourceCount);
      if (sourceCount > (mergedCounts.get(key) ?? 0)) {
        mergedCounts.set(key, sourceCount);
        mergedLines.push(line);
      }
    }
  }

  return mergedLines.length > 0 ? `${mergedLines.join("\n")}\n` : "";
}

async function readMergedRollout(group: RolloutFileGroup): Promise<string> {
  const reads = await Promise.all(group.filePaths.map(async (filePath) => {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }));
  return mergeRolloutContents(reads.filter((content): content is string => content !== null));
}

function timestampInRange(timestamp: string | null, start: Date, end: Date): boolean {
  if (!timestamp) {
    return false;
  }
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) && value >= start.getTime() && value <= end.getTime();
}

/** 在时间范围内有活动的 Codex rollout 文件信息。 */
export interface ActiveCodexSessionFile {
  filePath: string;
  /** 相对于 Codex session 根目录的原始路径。 */
  relativePath: string;
  /** 标准 Codex 与 Orca 副本去重合并后的完整 JSONL。 */
  content: string;
}

/**
 * 找出标准 Codex 与 Orca sessions 中在指定时间范围内有活动的 rollout 文件。
 *
 * 只判断合并后的文件里是否存在范围内的记录，不过滤内容，导出时写入完整合并结果。
 */
export async function findActiveCodexSessionFiles(start: Date, end: Date): Promise<ActiveCodexSessionFile[]> {
  const groups = await collectRolloutFileGroups();
  const result: ActiveCodexSessionFile[] = [];

  for (const group of groups) {
    try {
      const content = await readMergedRollout(group);
      const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      let hasInRange = false;
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as unknown;
          if (isRecord(record) && timestampInRange(getString(record.timestamp), start, end)) {
            hasInRange = true;
            break;
          }
        } catch {
          continue;
        }
      }
      if (hasInRange) {
        result.push({
          filePath: group.filePaths[0],
          relativePath: group.relativePath,
          content,
        });
      }
    } catch {
      continue;
    }
  }

  return result;
}

/**
 * 从 `token_count` 事件的 `info.last_token_usage` 取 token 用量对象（缺失返回 null）。
 * 必须用 last_token_usage（本次增量），不能用 total_token_usage（会话累计，会重复计）。
 * `cached_input_tokens` 是 `input_tokens` 的子集；普通输入需扣除缓存输入并钳制为非负数。
 */
function extractLastTokenUsage(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(payload.info)) {
    return null;
  }
  return isRecord(payload.info.last_token_usage) ? payload.info.last_token_usage : null;
}

/**
 * 解析单个 Codex rollout 文件，收集范围内的 task_started turn 节点与 token_count 用量。
 *
 * Codex rollout 每行一个事件，timestamp 在 top-level：
 * - `event_msg` + `payload.type=="task_started"`：一个用户 turn，带全局唯一 `turn_id`。
 *   fork / spawn sub-agent / resume 会把历史 task_started 跨文件重放，故 turn 节点交上层按
 *   turn_id 全局去重（取最早 timestamp），不能在单文件层计数。
 * - `event_msg` + `payload.type=="token_count"`：一次模型请求，token 取 `info.last_token_usage` 增量。
 */
function summarizeRollout(content: string, start: Date, end: Date): RolloutParse {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const result: RolloutParse = {
    turns: [],
    apiRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    apiEquivalentCost: emptyApiEquivalentCost(),
  };
  let currentModel: string | null = null;

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as unknown;
      if (!isRecord(record) || !isRecord(record.payload)) {
        continue;
      }
      const payload = record.payload;
      if (record.type === "turn_context") {
        if (typeof payload.model === "string") {
          currentModel = payload.model;
        }
        continue;
      }
      const timestamp = getString(record.timestamp);
      if (!timestampInRange(timestamp, start, end) || record.type !== "event_msg") {
        continue;
      }

      if (payload.type === "task_started" && typeof payload.turn_id === "string") {
        const ms = new Date(timestamp ?? "").getTime();
        if (Number.isFinite(ms)) {
          result.turns.push({ turnId: payload.turn_id, ms });
        }
      }

      if (payload.type === "token_count") {
        const usage = extractLastTokenUsage(payload);
        if (usage) {
          const { inputTokens, cacheReadInputTokens } = splitInputTokens(usage);
          const outputTokens = getNumber(usage.output_tokens);
          result.apiRequestCount += 1;
          result.inputTokens += inputTokens;
          result.outputTokens += outputTokens;
          result.cacheReadInputTokens += cacheReadInputTokens;
          result.apiEquivalentCost = mergeApiEquivalentCosts([
            result.apiEquivalentCost,
            priceApiRequest({
              provider: "codex",
              timestamp: timestamp!,
              model: currentModel,
              inputTokens,
              outputTokens,
              cacheReadInputTokens,
            }),
          ]);
        }
      }
    } catch {
      continue;
    }
  }

  return result;
}

/**
 * 从标准 Codex 与 Orca 本地 session rollout 统计消息数、请求数、token 用量和标准 API 等效成本。
 * Codex Desktop 的 guardian 安全审查 rollout 整体排除，避免把内部审批轮次计为用户使用量。
 *
 * 消息数 = task_started 的 distinct turn_id（跨文件去重）。重放副本会让同一 turn_id 出现在多个文件，
 * 故用全局 Map<turn_id, minMs> 收集（取最早 timestamp = 真实发生时刻，早于任何重放副本），最后取 size。
 */
export async function summarizeCodexSessionUsage(
  start: Date,
  end: Date,
): Promise<CodexSessionUsageSummary & { matchedFileCount: number; codexDataDir: string }> {
  const codexDataDir = getCodexHome();
  const groups = await collectRolloutFileGroups();

  const turnMinMs = new Map<string, number>();
  let apiRequestCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let apiEquivalentCost = emptyApiEquivalentCost();

  for (const group of groups) {
    try {
      const content = await readMergedRollout(group);
      if (isGuardianRollout(content)) {
        continue;
      }
      const parsed = summarizeRollout(content, start, end);
      for (const turn of parsed.turns) {
        const prev = turnMinMs.get(turn.turnId);
        if (prev === undefined || turn.ms < prev) {
          turnMinMs.set(turn.turnId, turn.ms);
        }
      }
      apiRequestCount += parsed.apiRequestCount;
      inputTokens += parsed.inputTokens;
      outputTokens += parsed.outputTokens;
      cacheReadInputTokens += parsed.cacheReadInputTokens;
      apiEquivalentCost = mergeApiEquivalentCosts([apiEquivalentCost, parsed.apiEquivalentCost]);
    } catch {
      continue;
    }
  }

  return {
    userMessageCount: turnMinMs.size,
    apiRequestCount,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    apiEquivalentCost,
    matchedFileCount: groups.length,
    codexDataDir,
  };
}

/**
 * 按天汇总 Codex session rollout 中的消息数、请求数、token 用量和标准 API 等效成本。
 * 与周汇总一致，排除 Codex Desktop 的 guardian 安全审查 rollout。
 *
 * 消息数同 weekly：先全局 Map<turn_id, minMs> 去重，再按 minMs 的本地日归桶（保证 weekly = Σ daily、
 * 且重放副本跨天不重复）。token 维度按 token_count 事件 timestamp 的本地日累加。
 */
export async function summarizeCodexSessionUsageByDay(
  start: Date,
  end: Date,
): Promise<Map<string, CodexDailyUsageSummary>> {
  const groups = await collectRolloutFileGroups();

  const turnMinMs = new Map<string, number>();
  const daily = new Map<string, CodexDailyUsageSummary>();

  const ensureDay = (date: string): CodexDailyUsageSummary => {
    let current = daily.get(date);
    if (!current) {
      current = {
        date,
        userMessageCount: 0,
        apiRequestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        apiEquivalentCost: emptyApiEquivalentCost(),
      };
      daily.set(date, current);
    }
    return current;
  };

  for (const group of groups) {
    const content = await readMergedRollout(group);
    if (isGuardianRollout(content)) {
      continue;
    }

    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    let currentModel: string | null = null;
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as unknown;
        if (!isRecord(record) || !isRecord(record.payload)) {
          continue;
        }
        const payload = record.payload;
        if (record.type === "turn_context") {
          if (typeof payload.model === "string") {
            currentModel = payload.model;
          }
          continue;
        }
        const timestamp = getString(record.timestamp);
        if (!timestampInRange(timestamp, start, end)) {
          continue;
        }
        if (record.type !== "event_msg") {
          continue;
        }
        const ms = new Date(timestamp!).getTime();

        if (payload.type === "task_started" && typeof payload.turn_id === "string") {
          if (Number.isFinite(ms)) {
            const prev = turnMinMs.get(payload.turn_id);
            if (prev === undefined || ms < prev) {
              turnMinMs.set(payload.turn_id, ms);
            }
          }
        }

        if (payload.type === "token_count") {
          const usage = extractLastTokenUsage(payload);
          if (usage) {
            const current = ensureDay(localDateKey(new Date(ms)));
            const { inputTokens, cacheReadInputTokens } = splitInputTokens(usage);
            const outputTokens = getNumber(usage.output_tokens);
            current.apiRequestCount += 1;
            current.inputTokens += inputTokens;
            current.outputTokens += outputTokens;
            current.cacheReadInputTokens += cacheReadInputTokens;
            current.apiEquivalentCost = mergeApiEquivalentCosts([
              current.apiEquivalentCost,
              priceApiRequest({
                provider: "codex",
                timestamp: timestamp!,
                model: currentModel,
                inputTokens,
                outputTokens,
                cacheReadInputTokens,
              }),
            ]);
          }
        }
      } catch {
        continue;
      }
    }
  }

  for (const ms of turnMinMs.values()) {
    ensureDay(localDateKey(new Date(ms))).userMessageCount += 1;
  }

  return daily;
}
