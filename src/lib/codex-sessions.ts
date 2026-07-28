import fs from "node:fs/promises";
import path from "node:path";
import { getCodexHome } from "./paths";
import { localDateKey } from "./time";

interface CodexSessionUsageSummary {
  userMessageCount: number;
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
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

function timestampInRange(timestamp: string | null, start: Date, end: Date): boolean {
  if (!timestamp) {
    return false;
  }
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) && value >= start.getTime() && value <= end.getTime();
}

/**
 * 从 `token_count` 事件的 `info.last_token_usage` 取 token 用量对象（缺失返回 null）。
 * 必须用 last_token_usage（本次增量），不能用 total_token_usage（会话累计，会重复计）。
 * 注意：Codex 的 `input_tokens` 含缓存命中（`cached_input_tokens` 是其子集），
 * 累加 inputTokens 时要减去 cached 得到净输入，对齐 Claude 的 `input_tokens` 口径。
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
  };

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as unknown;
      if (!isRecord(record) || !timestampInRange(getString(record.timestamp), start, end)) {
        continue;
      }
      if (record.type !== "event_msg" || !isRecord(record.payload)) {
        continue;
      }
      const payload = record.payload;

      if (payload.type === "task_started" && typeof payload.turn_id === "string") {
        const ms = new Date(getString(record.timestamp) ?? "").getTime();
        if (Number.isFinite(ms)) {
          result.turns.push({ turnId: payload.turn_id, ms });
        }
      }

      if (payload.type === "token_count") {
        const usage = extractLastTokenUsage(payload);
        if (usage) {
          // 净输入 = input_tokens - cached_input_tokens（input_tokens 含缓存命中，减去对齐 Claude 口径）。
          const netInputTokens = Math.max(0, getNumber(usage.input_tokens) - getNumber(usage.cached_input_tokens));
          result.apiRequestCount += 1;
          result.inputTokens += netInputTokens;
          result.outputTokens += getNumber(usage.output_tokens);
          result.cacheReadInputTokens += getNumber(usage.cached_input_tokens);
        }
      }
    } catch {
      continue;
    }
  }

  return result;
}

/**
 * 从 Codex 本地 session rollout（<CODEX_HOME>/sessions 下递归的 .jsonl）统计消息数、请求数和 token 用量。
 *
 * 消息数 = task_started 的 distinct turn_id（跨文件去重）。重放副本会让同一 turn_id 出现在多个文件，
 * 故用全局 Map<turn_id, minMs> 收集（取最早 timestamp = 真实发生时刻，早于任何重放副本），最后取 size。
 */
export async function summarizeCodexSessionUsage(
  start: Date,
  end: Date,
): Promise<CodexSessionUsageSummary & { matchedFileCount: number; codexDataDir: string }> {
  const codexDataDir = getCodexHome();
  const sessionsDir = path.join(codexDataDir, "sessions");
  const files = await collectRolloutFiles(sessionsDir);

  const turnMinMs = new Map<string, number>();
  let apiRequestCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf8");
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
    matchedFileCount: files.length,
    codexDataDir,
  };
}

/**
 * 按天汇总 Codex session rollout 中的消息数、请求数和 token 用量。
 *
 * 消息数同 weekly：先全局 Map<turn_id, minMs> 去重，再按 minMs 的本地日归桶（保证 weekly = Σ daily、
 * 且重放副本跨天不重复）。token 维度按 token_count 事件 timestamp 的本地日累加。
 */
export async function summarizeCodexSessionUsageByDay(
  start: Date,
  end: Date,
): Promise<Map<string, CodexDailyUsageSummary>> {
  const codexDataDir = getCodexHome();
  const sessionsDir = path.join(codexDataDir, "sessions");
  const files = await collectRolloutFiles(sessionsDir);

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
      };
      daily.set(date, current);
    }
    return current;
  };

  for (const filePath of files) {
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as unknown;
        if (!isRecord(record)) {
          continue;
        }
        const timestamp = getString(record.timestamp);
        if (!timestampInRange(timestamp, start, end)) {
          continue;
        }
        if (record.type !== "event_msg" || !isRecord(record.payload)) {
          continue;
        }
        const payload = record.payload;
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
            // 同 summarizeRollout：累加净输入（input - cached），对齐 Claude 口径。
            const netInputTokens = Math.max(0, getNumber(usage.input_tokens) - getNumber(usage.cached_input_tokens));
            current.apiRequestCount += 1;
            current.inputTokens += netInputTokens;
            current.outputTokens += getNumber(usage.output_tokens);
            current.cacheReadInputTokens += getNumber(usage.cached_input_tokens);
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
