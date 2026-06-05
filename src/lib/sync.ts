import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { RangeWindow, SyncConfig, SyncState } from "../types";
import { debugLog } from "./debug";
import { getSyncConfigPath, getSyncStatePath } from "./paths";
import { formatWeekDirName, resolveRange } from "./time";

/** 默认同步周期标签：每 3 小时最多同步一次（滚动 TTL）。 */
const DEFAULT_INTERVAL_LABEL = "3h";

/** 默认导出范围：当前周 bundle。 */
const DEFAULT_RANGE = "this-week";

/**
 * 注入式的 export 执行器类型。
 *
 * 由 cli.ts 把 `runExport` 传进来，避免 sync.ts ↔ cli.ts 循环依赖。
 */
export type RunExport = (
  options: Record<string, string | boolean | undefined>,
) => Promise<{ outputPath: string; window: RangeWindow }>;

/** 同步周期解析结果：按自然日，或滚动 TTL（毫秒）。 */
type SyncInterval = { kind: "daily" } | { kind: "ttl"; ms: number };

/**
 * 解析周期标签。
 *
 * `daily`（或空/无法识别）→ 按自然日；`<N>h` / `<N>m` → 滚动 TTL。
 */
export function parseSyncInterval(label: string | undefined): SyncInterval {
  const raw = (label ?? "").trim().toLowerCase();
  if (raw === "" || raw === "daily") {
    return { kind: "daily" };
  }

  const match = raw.match(/^(\d+)([hm])$/);
  if (match) {
    const amount = Number.parseInt(match[1], 10);
    const ms = match[2] === "h" ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
    return { kind: "ttl", ms };
  }

  // 无法识别的标签退回每天语义，保持「默认每天」的承诺。
  return { kind: "daily" };
}

/** 把同一本地日映射成稳定日键，用于 daily 周期的「是否跨天」判断。 */
function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 同步读取用户配置；缺省补齐默认值，任何异常都回退到「无目标目录」的安全默认。
 *
 * statusline 兜底路径需要同步、极快、绝不抛错，所以这里用同步 IO。
 */
export function readSyncConfig(dataDir: string): SyncConfig {
  const fallback: SyncConfig = { targetDir: null, intervalLabel: DEFAULT_INTERVAL_LABEL, range: DEFAULT_RANGE };
  try {
    const raw = fs.readFileSync(getSyncConfigPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    return {
      targetDir: typeof parsed.targetDir === "string" && parsed.targetDir.trim() !== "" ? parsed.targetDir : null,
      intervalLabel: typeof parsed.intervalLabel === "string" && parsed.intervalLabel.trim() !== "" ? parsed.intervalLabel : DEFAULT_INTERVAL_LABEL,
      range: typeof parsed.range === "string" && parsed.range.trim() !== "" ? parsed.range : DEFAULT_RANGE,
    };
  } catch {
    return fallback;
  }
}

/** 写入用户配置；目录可能尚未创建，先 mkdir。 */
export async function writeSyncConfig(dataDir: string, config: SyncConfig): Promise<void> {
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(getSyncConfigPath(dataDir), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 同步读取运行时状态；缺失或损坏一律返回 null。 */
export function readSyncStateSync(dataDir: string): SyncState | null {
  try {
    const raw = fs.readFileSync(getSyncStatePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return {
      lastSyncedAt: typeof parsed.lastSyncedAt === "string" ? parsed.lastSyncedAt : null,
      lastResult: parsed.lastResult === "ok" || parsed.lastResult === "error" ? parsed.lastResult : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
      lastArchivedWeek: typeof parsed.lastArchivedWeek === "string" ? parsed.lastArchivedWeek : undefined,
    };
  } catch {
    return null;
  }
}

/** 写入运行时状态；失败静默（不能因状态写入失败影响主流程）。 */
async function writeSyncState(dataDir: string, state: SyncState): Promise<void> {
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(getSyncStatePath(dataDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    debugLog("sync", "failed to write state", error instanceof Error ? error.message : String(error));
  }
}

/**
 * 判断当前是否到了该同步的时间点。
 *
 * 无目标目录永远返回 false；从未同步过返回 true；
 * `daily` 用「上次同步与现在不在同一自然日」判断（最贴近「每天」），其它用滚动 TTL。
 */
export function isSyncDue(config: SyncConfig, state: SyncState | null, now: Date = new Date()): boolean {
  if (!config.targetDir) {
    return false;
  }
  if (!state || !state.lastSyncedAt) {
    return true;
  }

  const last = Date.parse(state.lastSyncedAt);
  if (!Number.isFinite(last)) {
    return true;
  }

  const interval = parseSyncInterval(config.intervalLabel);
  if (interval.kind === "daily") {
    return localDayKey(new Date(last)) !== localDayKey(now);
  }
  return now.getTime() - last >= interval.ms;
}

/** 一次同步的结果摘要，供 CLI 展示。 */
export interface SyncResult {
  outputPath: string;
  destPath: string;
  weekDir: string;
  targetWeekDir: string;
  /** 本次顺带归档的上一周目标路径（仅周一首次归档时有值），否则为 null。 */
  archivedLastWeekDest: string | null;
}

/**
 * 导出某个 range 的 bundle，并复制到目标目录下对应的「按周」子目录。
 *
 * 复制语义：本地 exports 仍保留一份，目标目录再放一份。周目录名按导出窗口的周一~周日推导。
 */
async function exportAndCopy(
  dataDir: string,
  runExport: RunExport,
  targetDir: string,
  range: string,
): Promise<{ outputPath: string; destPath: string; weekDir: string; targetWeekDir: string }> {
  const { outputPath, window } = await runExport({ "data-dir": dataDir, range });
  const weekDir = formatWeekDirName(window.start, window.end);
  const targetWeekDir = path.join(targetDir, weekDir);
  await fsp.mkdir(targetWeekDir, { recursive: true });
  const destPath = path.join(targetWeekDir, path.basename(outputPath));
  await fsp.copyFile(outputPath, destPath);
  debugLog("sync", "copied bundle", { range, outputPath, destPath, weekDir });
  return { outputPath, destPath, weekDir, targetWeekDir };
}

/**
 * 执行一次同步：导出当前周 bundle，并复制到目标目录下的「按周」子目录。
 *
 * 复制语义：本地 exports 仍保留一份，目标目录再放一份，本地照旧可 aggregate / dashboard。
 * 周一时额外把上一周（last-week，刚结束的完整周）导出并归档到对应子目录；
 * 用 `sync-state.lastArchivedWeek` 去重，避免周一当天每次同步都重复归档。
 * 失败时写 error 状态后向上抛，由调用方决定展示或静默。
 */
export async function performSync(dataDir: string, runExport: RunExport, now: Date = new Date()): Promise<SyncResult> {
  const config = readSyncConfig(dataDir);
  if (!config.targetDir) {
    throw new Error("未配置同步目标目录。请先运行 `ccus sync config --target DIR`。");
  }

  const state = readSyncStateSync(dataDir);
  let lastArchivedWeek = state?.lastArchivedWeek;

  try {
    const primary = await exportAndCopy(dataDir, runExport, config.targetDir, config.range);

    // 周一（getDay() === 1）是上一周结束后第一个能拿到完整数据的日子：顺带归档 last-week。
    let archivedLastWeekDest: string | null = null;
    if (now.getDay() === 1) {
      const lastWeek = resolveRange("last-week", now);
      const lastWeekDir = formatWeekDirName(lastWeek.start, lastWeek.end);
      if (lastArchivedWeek !== lastWeekDir) {
        const archived = await exportAndCopy(dataDir, runExport, config.targetDir, "last-week");
        lastArchivedWeek = archived.weekDir;
        archivedLastWeekDest = archived.destPath;
        debugLog("sync", "archived last week", { weekDir: archived.weekDir, destPath: archived.destPath });
      }
    }

    await writeSyncState(dataDir, { lastSyncedAt: now.toISOString(), lastResult: "ok", lastArchivedWeek });
    return { ...primary, archivedLastWeekDest };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeSyncState(dataDir, { lastSyncedAt: now.toISOString(), lastResult: "error", lastError: message, lastArchivedWeek });
    throw error;
  }
}

/**
 * 如到了同步周期，spawn 一个 detached 后台进程执行同步，主进程不等待。
 *
 * 这是 statusline 路径能用的唯一安全方式（照搬 update-check 的 maybeSpawnBackgroundCheck）：
 * 同步读配置与状态决定是否触发，把 export + 复制甩给后台子进程，自己立刻返回。
 * 未配置目标目录、或未到周期，都直接返回，对 statusline 单行 stdout 契约零侵入。
 */
export function maybeSpawnBackgroundSync(dataDir: string, now: Date = new Date()): void {
  try {
    const config = readSyncConfig(dataDir);
    if (!config.targetDir) {
      return;
    }
    if (!isSyncDue(config, readSyncStateSync(dataDir), now)) {
      return;
    }

    const scriptPath = process.argv[1];
    if (!scriptPath) {
      return;
    }

    const child = spawn(process.execPath, [scriptPath, "__sync", "--data-dir", dataDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    debugLog("sync", "spawned background sync");
  } catch (error) {
    debugLog("sync", "failed to spawn background sync", error instanceof Error ? error.message : String(error));
  }
}
