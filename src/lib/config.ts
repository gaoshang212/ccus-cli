import fs from "node:fs/promises";
import path from "node:path";
import { formatDayStart, parseDayStart } from "./time";

/** 配置缺失时使用 07:00；损坏配置报错，避免悄悄改变统计口径。 */
export async function readConfig(dataDir: string): Promise<Record<string, unknown> & { dayStart: string }> {
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
  return { ...config, dayStart: formatDayStart(parseDayStart((config.dayStart as string | undefined) ?? "07:00")) };
}

export async function writeDayStart(dataDir: string, value: string): Promise<string> {
  const dayStart = formatDayStart(parseDayStart(value));
  const config = await readConfig(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify({ ...config, dayStart }, null, 2)}\n`, "utf8");
  return dayStart;
}
