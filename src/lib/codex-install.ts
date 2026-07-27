import fs from "node:fs/promises";
import path from "node:path";

/** install --codex 写入 notify 后的结果，供 CLI 回显。 */
export interface CodexInstallResult {
  configPath: string;
  notify: string[];
  previousNotify: string[] | null;
  /** config.toml 是否是这次新建的。 */
  created: boolean;
  /** 顶层 notify 是否本来就等于目标数组。 */
  unchanged: boolean;
}

/** uninstall --codex 的结果。 */
export interface CodexUninstallResult {
  configPath: string;
  removed: boolean;
  previousNotify: string[] | null;
}

/** 序列化 notify 数组为 TOML 数组字面量（字符串元素，元素间带空格，符合 TOML 习惯）。 */
function serializeNotify(notify: string[]): string {
  return `[${notify.map((value) => JSON.stringify(value)).join(", ")}]`;
}

/**
 * 从 notify 赋值行的 `=` 之后提取字符串元素（兼容双引号 / 单引号）。
 * 提取不到任何字符串返回空数组（调用方另判多行数组）。
 */
function parseNotifyElements(line: string): string[] {
  const eq = line.indexOf("=");
  if (eq < 0) {
    return [];
  }
  const value = line.slice(eq + 1);
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? "");
}

/** 判断一行是否是顶层 notify 赋值（非注释、非 table 头、key 为 notify）。 */
function isTopLevelNotifyLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("[")) {
    return false;
  }
  return /^\s*notify\s*=/.test(line);
}

/** 判断一行是否是 TOML table 头（[section] / [[array-of-table]]）。 */
function isTableHeader(line: string): boolean {
  return /^\s*\[\[?/.test(line);
}

/** 顶层区域结束行号：第一个 table 头的索引，没有则为行数。 */
function findTopLevelEnd(lines: string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith("#")) {
      continue;
    }
    if (isTableHeader(lines[index])) {
      return index;
    }
  }
  return lines.length;
}

/** 读现有 config.toml；缺失返回空文本。 */
async function readConfig(configPath: string): Promise<{ raw: string; existed: boolean }> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return { raw, existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { raw: "", existed: false };
    }
    throw error;
  }
}

/** 统一以 \n 行尾写回，避免 split/join 产生多余空行。 */
async function writeConfig(configPath: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const content = `${lines.join("\n").replace(/\n+$/, "")}\n`;
  await fs.writeFile(configPath, content, "utf8");
}

function arrayEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * 把 notify 写进 Codex config.toml 的顶层。
 *
 * 只改顶层 notify 赋值行（table 头之前），保留其它顶层 key、所有 table、注释与格式。
 * 已等于目标时不动文件；现有 notify 是跨行数组时拒绝改写（避免破坏多行结构）。
 */
export async function installCodexNotify(configPath: string, notify: string[]): Promise<CodexInstallResult> {
  const { raw, existed } = await readConfig(configPath);
  const lines = raw.length > 0 ? raw.split(/\r?\n/) : [];
  const topLevelEnd = findTopLevelEnd(lines);
  const notifyIdx = lines.slice(0, topLevelEnd).findIndex((line) => isTopLevelNotifyLine(line));

  if (notifyIdx >= 0) {
    const line = lines[notifyIdx];
    const valuePart = line.slice(line.indexOf("=") + 1);
    // 跨行 notify 数组（行内有 [ 但无闭合 ]）无法安全单行替换，拒绝以免破坏结构。
    if (valuePart.includes("[") && !valuePart.includes("]")) {
      throw new Error(
        `Cannot update multi-line notify array in ${configPath}. Fold it into a single line, then retry.`,
      );
    }
    const current = parseNotifyElements(line);
    const unchanged = arrayEqual(current, notify);
    if (!unchanged) {
      lines[notifyIdx] = `notify = ${serializeNotify(notify)}`;
      await writeConfig(configPath, lines);
    }
    return {
      configPath,
      notify,
      previousNotify: current.length > 0 ? current : null,
      created: !existed,
      unchanged,
    };
  }

  // 顶层无 notify：顶层有实质 key 时紧跟其后插入（与上方空一行）；顶层为空则插到最前。
  const hasTopLevelContent = lines
    .slice(0, topLevelEnd)
    .some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  const notifyLine = `notify = ${serializeNotify(notify)}`;
  const insertAt = hasTopLevelContent ? topLevelEnd : 0;
  const needsBlankPrefix =
    hasTopLevelContent && insertAt > 0 && lines[insertAt - 1].trim() !== "";
  lines.splice(insertAt, 0, ...(needsBlankPrefix ? ["", notifyLine] : [notifyLine]));
  await writeConfig(configPath, lines);
  return { configPath, notify, previousNotify: null, created: !existed, unchanged: false };
}

/** 移除 Codex config.toml 顶层的 notify 赋值；不存在或无 notify 时 removed=false。 */
export async function uninstallCodexNotify(configPath: string): Promise<CodexUninstallResult> {
  const { raw, existed } = await readConfig(configPath);
  if (!existed) {
    return { configPath, removed: false, previousNotify: null };
  }
  const lines = raw.split(/\r?\n/);
  const topLevelEnd = findTopLevelEnd(lines);
  const notifyIdx = lines.slice(0, topLevelEnd).findIndex((line) => isTopLevelNotifyLine(line));
  if (notifyIdx < 0) {
    return { configPath, removed: false, previousNotify: null };
  }
  const previousNotify = parseNotifyElements(lines[notifyIdx]);
  lines.splice(notifyIdx, 1);
  await writeConfig(configPath, lines);
  return {
    configPath,
    removed: true,
    previousNotify: previousNotify.length > 0 ? previousNotify : null,
  };
}

// ===== hooks.json（Stop 事件）安装：orca 等 hook-only 环境的触发入口 =====

/** Codex hooks.json 里单个 command hook 条目。 */
export interface CodexHookEntry {
  type: string;
  command: string;
  timeout?: number;
}

/** Codex hooks.json 里一个 matcher 分组（含若干 hook 条目）。 */
interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookEntry[];
}

/** Codex hooks.json 顶层结构（只声明 hooks 字段，其余字段原样保留）。 */
interface CodexHooksFile {
  description?: string;
  hooks?: Record<string, CodexHookGroup[]>;
}

/** `install --codex` 写 hooks.json 后的结果，供 CLI 回显。 */
export interface CodexHookInstallResult {
  hooksPath: string;
  command: string;
  /** hooks.json 是否是这次新建的。 */
  created: boolean;
  /** Stop 事件里是否本来就有相同 command 的 hook。 */
  unchanged: boolean;
  /** Stop 事件原本是否存在（已存在则追加进其第一个分组，与现有 hook 并列并发）。 */
  stopExisted: boolean;
}

/** `uninstall --codex`（hooks.json）的结果。 */
export interface CodexHookUninstallResult {
  hooksPath: string;
  removed: boolean;
}

/** Stop hook 超时（秒）：ccus 缓存命中秒回、过期拉额度 ~10s，给足余量。 */
const CODEX_HOOK_TIMEOUT_SECONDS = 60;

/** 判断一个 hook 条目是否是 ccus 装的（command 含 `__codex-hook`，兼容带 `--data-dir`）。 */
function isCcusCodexHookEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const command = (entry as { command?: unknown }).command;
  return typeof command === "string" && command.includes("__codex-hook");
}

/**
 * 读 hooks.json；缺失返回空结构，非法 JSON 抛错（不静默覆盖，避免破坏 orca 等外部工具写入的文件）。
 */
async function readHooksFile(hooksPath: string): Promise<{ data: CodexHooksFile; existed: boolean }> {
  try {
    const raw = await fs.readFile(hooksPath, "utf8");
    if (raw.trim() === "") {
      return { data: {}, existed: true };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${hooksPath} is not a JSON object`);
    }
    return { data: parsed as CodexHooksFile, existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { data: {}, existed: false };
    }
    throw error;
  }
}

/** 以 2 空格缩进 + 末尾换行写回，保持 hooks.json 可读、对 git 友好。 */
async function writeHooksFile(hooksPath: string, data: CodexHooksFile): Promise<void> {
  await fs.mkdir(path.dirname(hooksPath), { recursive: true });
  await fs.writeFile(hooksPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/**
 * 把 ccus 的 Stop hook 挂进 Codex hooks.json。
 *
 * 只往 `hooks.Stop` 追加一条 command hook，保留其它事件、其它 hook（如 orca 的 codex-hook.cmd）、
 * description 与格式。Stop 已有相同 command 时不动文件（幂等）；Stop 不存在则新建一个分组。
 * 同一 Stop 事件下多条 hook 由 Codex 并发执行，互不阻塞。
 */
export async function installCodexHook(hooksPath: string, command: string): Promise<CodexHookInstallResult> {
  const { data, existed } = await readHooksFile(hooksPath);
  const hooksMap: Record<string, CodexHookGroup[]> = data.hooks ?? {};
  const stopGroups: CodexHookGroup[] = hooksMap.Stop ?? [];
  const stopExisted = stopGroups.length > 0;

  for (const group of stopGroups) {
    if ((group.hooks ?? []).some((entry) => entry.command === command)) {
      return { hooksPath, command, created: !existed, unchanged: true, stopExisted };
    }
  }

  const ccusHook: CodexHookEntry = { type: "command", command, timeout: CODEX_HOOK_TIMEOUT_SECONDS };
  if (stopGroups.length > 0) {
    const first = stopGroups[0];
    first.hooks = [...(first.hooks ?? []), ccusHook];
  } else {
    stopGroups.push({ hooks: [ccusHook] });
  }
  hooksMap.Stop = stopGroups;
  data.hooks = hooksMap;

  await writeHooksFile(hooksPath, data);
  return { hooksPath, command, created: !existed, unchanged: false, stopExisted };
}

/** 移除 hooks.json 里 ccus 装的 Stop hook（command 含 `__codex-hook`）；不存在时 removed=false。 */
export async function uninstallCodexHook(hooksPath: string): Promise<CodexHookUninstallResult> {
  const { data, existed } = await readHooksFile(hooksPath);
  if (!existed) {
    return { hooksPath, removed: false };
  }
  const hooksMap = data.hooks ?? {};
  const stopGroups = hooksMap.Stop ?? [];
  let removed = false;
  for (const group of stopGroups) {
    const before = group.hooks?.length ?? 0;
    group.hooks = (group.hooks ?? []).filter((entry) => !isCcusCodexHookEntry(entry));
    if (group.hooks.length !== before) {
      removed = true;
    }
  }
  if (removed) {
    hooksMap.Stop = stopGroups;
    data.hooks = hooksMap;
    await writeHooksFile(hooksPath, data);
  }
  return { hooksPath, removed };
}
