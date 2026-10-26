import fs from "node:fs/promises";
import path from "node:path";
import { formatDayStart, parseDayStart } from "./time";

export type UsageSource = "claude" | "codex";
export type StatisticsConfig = Record<string, unknown> & { dayStart: string; disabledSources: UsageSource[] };

/** 来源必须显式有效，避免拼写错误静默变成全量统计。 */
function validateSources(value: unknown): UsageSource[] {
  if (!Array.isArray(value) || value.some((source) => source !== "claude" && source !== "codex")) {
    throw new Error("统计来源必须为 claude、codex 或 claude,codex。");
  }
  return (["claude", "codex"] as const).filter((source) => value.includes(source));
}

export function parseSources(value: string): UsageSource[] {
  return validateSources(value.split(",").map((source) => source.trim().toLowerCase()));
}

/** 配置缺失时使用 07:00；损坏配置报错，避免悄悄改变统计口径。 */
export async function readConfig(dataDir: string): Promise<StatisticsConfig> {
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dataDir, "config.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("ccus config.json 必须是 JSON 对象。");
    }
    config = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (config.dayStart !== undefined && typeof config.dayStart !== "string") {
    throw new Error("config.json 的 dayStart 必须是时间字符串，例如 07:00。");
  }
  return {
    ...config,
    dayStart: formatDayStart(parseDayStart((config.dayStart as string | undefined) ?? "07:00")),
    disabledSources: validateSources(config.disabledSources === undefined ? [] : config.disabledSources),
  };
}

/** 一次校验、一次写入，多个选项中有错误时不产生部分更新。 */
export async function writeConfig(dataDir: string, updates: { dayStart?: string; disabledSources?: UsageSource[] }): Promise<StatisticsConfig> {
  const config = { ...await readConfig(dataDir), ...updates };
  config.dayStart = formatDayStart(parseDayStart(config.dayStart));
  config.disabledSources = validateSources(config.disabledSources);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export async function writeDayStart(dataDir: string, value: string): Promise<string> {
  return (await writeConfig(dataDir, { dayStart: value })).dayStart;
}
