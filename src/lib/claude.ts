import fs from "node:fs/promises";
import path from "node:path";
import { WeeklyExportDaySummary, WeeklyExportSummary } from "../types";
import {
  ApiEquivalentCostResult,
  emptyApiEquivalentCost,
  mergeApiEquivalentCosts,
  priceApiRequest,
} from "./api-equivalent-cost";
import { getClaudeDataDir } from "./paths";

interface ClaudeProjectUsageSummary {
  userMessageCount: number;
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  apiEquivalentCost: ApiEquivalentCostResult;
}

interface ClaudeDailyUsageSummary extends ClaudeProjectUsageSummary {
  date: string;
}

type ClaudeWeeklyUsageSummary = WeeklyExportSummary["counts"]
  & WeeklyExportSummary["tokens"]
  & {
    matchedFileCount: number;
    claudeDataDir: string;
    apiEquivalentCost: ApiEquivalentCostResult;
  };

export interface ClaudeProjectUsageCombined {
  weekly: ClaudeWeeklyUsageSummary;
  daily: Map<string, ClaudeDailyUsageSummary>;
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

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function summarizeAssistantUsage(
  message: Record<string, unknown>,
  timestamp: string,
): Pick<ClaudeProjectUsageSummary, "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "apiEquivalentCost"> {
  const usage = message.usage as Record<string, unknown>;
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
  const hasFiveMinuteDetail = cacheCreation !== null && hasOwn(cacheCreation, "ephemeral_5m_input_tokens");
  const hasOneHourDetail = cacheCreation !== null && hasOwn(cacheCreation, "ephemeral_1h_input_tokens");
  const cacheWrite5mInputTokens = hasFiveMinuteDetail || hasOneHourDetail
    ? getNumber(cacheCreation?.ephemeral_5m_input_tokens)
    : getNumber(usage.cache_creation_input_tokens);
  const cacheWrite1hInputTokens = hasFiveMinuteDetail || hasOneHourDetail
    ? getNumber(cacheCreation?.ephemeral_1h_input_tokens)
    : 0;
  const inputTokens = getNumber(usage.input_tokens);
  const outputTokens = getNumber(usage.output_tokens);
  const cacheReadInputTokens = getNumber(usage.cache_read_input_tokens);

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    apiEquivalentCost: priceApiRequest({
      provider: "claude",
      timestamp,
      model: getString(message.model),
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheWrite5mInputTokens,
      cacheWrite1hInputTokens,
    }),
  };
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

async function fileMayContainRange(filePath: string, start: Date): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).mtimeMs >= start.getTime();
  } catch {
    return true;
  }
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

/**
 * 从 Claude 本地 project transcript 中统计本周消息数、请求数、token 用量和标准 API 等效成本。
 */
export async function summarizeClaudeProjectUsage(start: Date, end: Date): Promise<WeeklyExportSummary["counts"] & WeeklyExportSummary["tokens"] & { matchedFileCount: number; claudeDataDir: string; apiEquivalentCost: ApiEquivalentCostResult }> {
  return (await summarizeClaudeProjectUsageCombined(start, end)).weekly;
}

/** 单次扫描同时生成周汇总与按天汇总。 */
export async function summarizeClaudeProjectUsageCombined(
  start: Date,
  end: Date,
): Promise<ClaudeProjectUsageCombined> {
  const claudeDataDir = getClaudeDataDir();
  const projectDir = path.join(claudeDataDir, "projects");
  const files = await collectProjectJsonlFiles(projectDir);
  const weekly: ClaudeWeeklyUsageSummary = {
    userMessageCount: 0,
    apiRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    apiEquivalentCost: emptyApiEquivalentCost(),
    matchedFileCount: files.length,
    claudeDataDir,
  };
  const daily = new Map<string, ClaudeDailyUsageSummary>();

  for (const filePath of files) {
    if (!(await fileMayContainRange(filePath, start))) {
      continue;
    }

    let content = "";
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const fileSummary: ClaudeProjectUsageSummary = {
      userMessageCount: 0,
      apiRequestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      apiEquivalentCost: emptyApiEquivalentCost(),
    };
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as unknown;
        const timestamp = isRecord(record) ? getString(record.timestamp) : null;
        if (!isRecord(record) || !timestampInRange(timestamp, start, end)) {
          continue;
        }

        const date = localDateKey(new Date(timestamp!));
        const day = daily.get(date) ?? {
          date,
          userMessageCount: 0,
          apiRequestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          apiEquivalentCost: emptyApiEquivalentCost(),
        };

        if (isHumanUserMessage(record)) {
          fileSummary.userMessageCount += 1;
          day.userMessageCount += 1;
        }

        if (record.type === "assistant" && isRecord(record.message) && isRecord(record.message.usage)) {
          const usage = summarizeAssistantUsage(record.message, timestamp!);
          fileSummary.apiRequestCount += 1;
          fileSummary.inputTokens += usage.inputTokens;
          fileSummary.outputTokens += usage.outputTokens;
          fileSummary.cacheReadInputTokens += usage.cacheReadInputTokens;
          fileSummary.apiEquivalentCost = mergeApiEquivalentCosts([fileSummary.apiEquivalentCost, usage.apiEquivalentCost]);
          day.apiRequestCount += 1;
          day.inputTokens += usage.inputTokens;
          day.outputTokens += usage.outputTokens;
          day.cacheReadInputTokens += usage.cacheReadInputTokens;
          day.apiEquivalentCost = mergeApiEquivalentCosts([day.apiEquivalentCost, usage.apiEquivalentCost]);
        }

        daily.set(date, day);
      } catch {
        continue;
      }
    }

    weekly.userMessageCount += fileSummary.userMessageCount;
    weekly.apiRequestCount += fileSummary.apiRequestCount;
    weekly.inputTokens += fileSummary.inputTokens;
    weekly.outputTokens += fileSummary.outputTokens;
    weekly.cacheReadInputTokens += fileSummary.cacheReadInputTokens;
    weekly.apiEquivalentCost = mergeApiEquivalentCosts([weekly.apiEquivalentCost, fileSummary.apiEquivalentCost]);
  }

  return { weekly, daily };
}

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
 * 按天汇总 Claude project transcript 中的消息数、请求数、token 用量和标准 API 等效成本。
 */
export async function summarizeClaudeProjectUsageByDay(start: Date, end: Date): Promise<Map<string, ClaudeDailyUsageSummary>> {
  return (await summarizeClaudeProjectUsageCombined(start, end)).daily;
}
