import fs from "node:fs/promises";
import path from "node:path";
import { WeeklyExportDaySummary, WeeklyExportSummary } from "../types";
import { getClaudeDataDir } from "./paths";

interface ClaudeProjectUsageSummary {
  userMessageCount: number;
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

interface ClaudeDailyUsageSummary extends ClaudeProjectUsageSummary {
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

async function collectProjectJsonlFiles(directoryPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          return collectProjectJsonlFiles(fullPath);
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

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function summarizeProjectTranscript(content: string, start: Date, end: Date): ClaudeProjectUsageSummary {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const summary: ClaudeProjectUsageSummary = {
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

      if (record.type === "user" && record.isMeta !== true) {
        summary.userMessageCount += 1;
      }

      if (record.type !== "assistant" || !isRecord(record.message) || !isRecord(record.message.usage)) {
        continue;
      }

      summary.apiRequestCount += 1;
      summary.inputTokens += getNumber(record.message.usage.input_tokens);
      summary.outputTokens += getNumber(record.message.usage.output_tokens);
      summary.cacheReadInputTokens += getNumber(record.message.usage.cache_read_input_tokens);
    } catch {
      continue;
    }
  }

  return summary;
}

/**
 * 从 Claude 本地 project transcript 中统计本周消息数、请求数和 token 用量。
 */
export async function summarizeClaudeProjectUsage(start: Date, end: Date): Promise<WeeklyExportSummary["counts"] & WeeklyExportSummary["tokens"] & { matchedFileCount: number; claudeDataDir: string }> {
  const claudeDataDir = getClaudeDataDir();
  const projectDir = path.join(claudeDataDir, "projects");
  const files = await collectProjectJsonlFiles(projectDir);

  const totals = {
    userMessageCount: 0,
    apiRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    matchedFileCount: files.length,
    claudeDataDir,
  };

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const summary = summarizeProjectTranscript(content, start, end);
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
 * 按天汇总 Claude project transcript 中的消息数、请求数和 token 用量。
 */
export async function summarizeClaudeProjectUsageByDay(start: Date, end: Date): Promise<Map<string, ClaudeDailyUsageSummary>> {
  const claudeDataDir = getClaudeDataDir();
  const projectDir = path.join(claudeDataDir, "projects");
  const files = await collectProjectJsonlFiles(projectDir);
  const daily = new Map<string, ClaudeDailyUsageSummary>();

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

        const date = localDateKey(new Date(timestamp!));
        const current = daily.get(date) ?? {
          date,
          userMessageCount: 0,
          apiRequestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
        };

        if (record.type === "user" && record.isMeta !== true) {
          current.userMessageCount += 1;
        }

        if (record.type === "assistant" && isRecord(record.message) && isRecord(record.message.usage)) {
          current.apiRequestCount += 1;
          current.inputTokens += getNumber(record.message.usage.input_tokens);
          current.outputTokens += getNumber(record.message.usage.output_tokens);
          current.cacheReadInputTokens += getNumber(record.message.usage.cache_read_input_tokens);
        }

        daily.set(date, current);
      } catch {
        continue;
      }
    }
  }

  return daily;
}
