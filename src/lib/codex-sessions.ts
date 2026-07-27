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
 */
function extractLastTokenUsage(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(payload.info)) {
    return null;
  }
  return isRecord(payload.info.last_token_usage) ? payload.info.last_token_usage : null;
}

/**
 * 统计单个 Codex rollout 文件内的 token / 消息。
 *
 * Codex rollout 每行一个事件，timestamp 在 top-level：
 * - `event_msg` + `payload.type=="user_message"`：一次用户消息（工具结果是 `function_call_output`，不命中，无需过滤）。
 * - `event_msg` + `payload.type=="token_count"`：一次模型请求，token 取 `info.last_token_usage` 增量。
 */
function summarizeRollout(content: string, start: Date, end: Date): CodexSessionUsageSummary {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const summary: CodexSessionUsageSummary = {
    userMessageCount: 0,
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

      if (payload.type === "user_message") {
        summary.userMessageCount += 1;
      }

      if (payload.type === "token_count") {
        const usage = extractLastTokenUsage(payload);
        if (usage) {
          summary.apiRequestCount += 1;
          summary.inputTokens += getNumber(usage.input_tokens);
          summary.outputTokens += getNumber(usage.output_tokens);
          summary.cacheReadInputTokens += getNumber(usage.cached_input_tokens);
        }
      }
    } catch {
      continue;
    }
  }

  return summary;
}

/**
 * 从 Codex 本地 session rollout（<CODEX_HOME>/sessions 下递归的 .jsonl）统计消息数、请求数和 token 用量。
 */
export async function summarizeCodexSessionUsage(
  start: Date,
  end: Date,
): Promise<CodexSessionUsageSummary & { matchedFileCount: number; codexDataDir: string }> {
  const codexDataDir = getCodexHome();
  const sessionsDir = path.join(codexDataDir, "sessions");
  const files = await collectRolloutFiles(sessionsDir);

  const totals = {
    userMessageCount: 0,
    apiRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    matchedFileCount: files.length,
    codexDataDir,
  };

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const summary = summarizeRollout(content, start, end);
      totals.userMessageCount += summary.userMessageCount;
      totals.apiRequestCount += summary.apiRequestCount;
      totals.inputTokens += summary.inputTokens;
      totals.outputTokens += summary.outputTokens;
      totals.cacheReadInputTokens += summary.cacheReadInputTokens;
    } catch {
      continue;
    }
  }

  return totals;
}

/**
 * 按天汇总 Codex session rollout 中的消息数、请求数和 token 用量。
 */
export async function summarizeCodexSessionUsageByDay(
  start: Date,
  end: Date,
): Promise<Map<string, CodexDailyUsageSummary>> {
  const codexDataDir = getCodexHome();
  const sessionsDir = path.join(codexDataDir, "sessions");
  const files = await collectRolloutFiles(sessionsDir);
  const daily = new Map<string, CodexDailyUsageSummary>();

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
        const isUserMessage = payload.type === "user_message";
        const usage = payload.type === "token_count" ? extractLastTokenUsage(payload) : null;
        if (!isUserMessage && !usage) {
          continue;
        }

        const date = localDateKey(new Date(timestamp!));
        const current = daily.get(date) ?? {
          date,
          userMessageCount: 0,
          apiRequestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
        };

        if (isUserMessage) {
          current.userMessageCount += 1;
        }
        if (usage) {
          current.apiRequestCount += 1;
          current.inputTokens += getNumber(usage.input_tokens);
          current.outputTokens += getNumber(usage.output_tokens);
          current.cacheReadInputTokens += getNumber(usage.cached_input_tokens);
        }

        daily.set(date, current);
      } catch {
        continue;
      }
    }
  }

  return daily;
}
