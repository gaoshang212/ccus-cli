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

/**
 * 判断一条 `type:"user"` 事件是否算作一次用户请求。
 *
 * Claude transcript 里 `type:"user"` 还会被用作 tool_result 回填——这种伪 user 事件必须排除，
 * 否则 userMessageCount 会被高估近 10×。sidechain（子 agent）会话里的用户提示保留计入，
 * 因为它们仍然代表团队让 Claude 做的事，不算工具机械回填。
 */
function isHumanUserMessage(record: Record<string, unknown>): boolean {
  if (record.type !== "user") {
    return false;
  }

  if (record.isMeta === true) {
    return false;
  }

  if (record.toolUseResult !== undefined && record.toolUseResult !== null) {
    return false;
  }

  if (!isRecord(record.message)) {
    return false;
  }

  const content = record.message.content;
  if (Array.isArray(content)) {
    const hasNonToolResult = content.some((item) => isRecord(item) && item.type !== "tool_result");
    if (!hasNonToolResult) {
      return false;
    }
  }

  return true;
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

      if (isHumanUserMessage(record)) {
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

/** 在时间范围内有活动的 session 文件信息。 */
export interface ActiveSessionFile {
  filePath: string;
  /** 相对于 ~/.claude/projects 的子目录名（Claude Code 对工作区路径的编码形式）。 */
  projectDir: string;
  sessionId: string;
}

/**
 * 找出 ~/.claude/projects 中在指定时间范围内有活动的 session 文件，返回文件路径及结构信息。
 *
 * 只判断文件里是否存在范围内的记录，不过滤内容，导出时完整复制原始文件。
 */
export async function findActiveSessionFiles(start: Date, end: Date): Promise<ActiveSessionFile[]> {
  const claudeDataDir = getClaudeDataDir();
  const projectsDir = path.join(claudeDataDir, "projects");
  const files = await collectProjectJsonlFiles(projectsDir);
  const result: ActiveSessionFile[] = [];

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      let hasInRange = false;
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as unknown;
          if (!isRecord(record)) continue;
          if (timestampInRange(getString(record.timestamp), start, end)) {
            hasInRange = true;
            break;
          }
        } catch {
          continue;
        }
      }
      if (hasInRange) {
        result.push({
          filePath,
          projectDir: path.relative(projectsDir, path.dirname(filePath)),
          sessionId: path.basename(filePath, ".jsonl"),
        });
      }
    } catch {
      continue;
    }
  }

  return result;
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

        if (isHumanUserMessage(record)) {
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
