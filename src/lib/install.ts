import fs from "node:fs/promises";
import path from "node:path";

/** install 命令写入 statusLine 后的结果，供 CLI 回显。 */
export interface InstallStatuslineResult {
  settingsPath: string;
  command: string;
  previousCommand: string | null;
  /** settings.json 是否是这次新建的。 */
  created: boolean;
  /** statusLine.command 是否本来就等于目标命令。 */
  unchanged: boolean;
}

/** 把 settings.json 解析成对象；文件缺失或为空时返回空对象，无法解析时直接报错。 */
async function readExistingSettings(
  settingsPath: string,
): Promise<{ settings: Record<string, unknown>; existed: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: {}, existed: false };
    }
    throw error;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { settings: {}, existed: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 不要覆盖无法解析的配置文件，否则可能连带破坏用户的其它 Claude 设置。
    throw new Error(`Cannot parse Claude settings as JSON: ${settingsPath}. Fix or remove it, then retry.`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Claude settings is not a JSON object: ${settingsPath}`);
  }

  return { settings: parsed as Record<string, unknown>, existed: true };
}

/** 读取现有 statusLine.command（如果有的话），用于回显被替换的旧值。 */
function readStatuslineCommand(settings: Record<string, unknown>): string | null {
  const statusLine = settings.statusLine;
  if (typeof statusLine !== "object" || statusLine === null || Array.isArray(statusLine)) {
    return null;
  }
  const command = (statusLine as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

/**
 * 把 ccus 的 statusLine 命令写进 Claude Code 的 settings.json。
 *
 * 只覆盖 statusLine 字段（并保留其下已有的其它键，如 padding），其它顶层设置原样保留。
 */
export async function installStatusline(settingsPath: string, command: string): Promise<InstallStatuslineResult> {
  const { settings, existed } = await readExistingSettings(settingsPath);
  const previousCommand = readStatuslineCommand(settings);

  const existingStatusLine =
    typeof settings.statusLine === "object" && settings.statusLine !== null && !Array.isArray(settings.statusLine)
      ? (settings.statusLine as Record<string, unknown>)
      : {};

  settings.statusLine = {
    ...existingStatusLine,
    type: "command",
    command,
  };

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  return {
    settingsPath,
    command,
    previousCommand,
    created: !existed,
    unchanged: previousCommand === command,
  };
}
