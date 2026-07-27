import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugLog } from "./debug";
import { getCodexQuotaCachePath } from "./paths";

// app-server 子进程参数：read-only + untrusted，Codex 官方推荐的最低权限拉额度姿态。
const CODEX_ARGS = ["-s", "read-only", "-a", "untrusted", "app-server"];
const DEFAULT_TIMEOUT_MS = 10_000;
// notify 每 turn 触发，额度缓存 5 分钟，命中秒回避免阻塞 Codex 主流程。
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** 从 Codex 解析出的额度快照。`resetsAt` 统一为毫秒。 */
export interface CodexQuota {
  fiveHour: number | null;
  sevenDay: number | null;
  resetsAt: number | null;
}

export type CodexFetchStatus = "ok" | "unavailable" | "error";

/** 一次拉取的结果：额度 + 终态（供缓存层决定是否落盘 / 回退）。 */
export interface CodexFetchOutcome extends CodexQuota {
  status: CodexFetchStatus;
}

/** 测试注入用：替代 child_process.spawn 的最小子进程形状。 */
export interface CodexChildProcess {
  stdin: { write(chunk: string): boolean };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
  kill(signal?: string): void;
}

export type CodexSpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean; shell?: boolean },
) => CodexChildProcess;

/** 落盘的额度缓存：quota + 抓取时间。 */
export interface CodexQuotaCache extends CodexQuota {
  fetchedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return Math.min(100, Math.max(0, value));
}

/**
 * 读窗口使用率：驼峰优先（app-server RPC 实际返回 usedPercent），
 * used_percentage / usedPercentage fallback（对齐 ccus 生态字段名，防御未来协议变更）。
 */
function readUsedPercent(window: unknown): number | null {
  if (!isRecord(window)) {
    return null;
  }
  return clampPercent(toFiniteNumber(window.usedPercent ?? window.used_percentage ?? window.usedPercentage));
}

/**
 * 读重置时间：Codex app-server 返回 Unix 秒；< 10^10 视为秒转毫秒，否则按毫秒。
 */
function readResetsAtMs(window: unknown): number | null {
  if (!isRecord(window)) {
    return null;
  }
  const raw = window.resetsAt ?? window.reset_at ?? window.resetsAtMs;
  const n = toFiniteNumber(raw);
  if (n === null) {
    return null;
  }
  return n < 10_000_000_000 ? n * 1000 : n;
}

// Codex app-server 各 rate-limit 窗口自带的时长（分钟）：5h 窗 300、周窗 10080。
const CODEX_SESSION_WINDOW_MINUTES = 300;
const CODEX_WEEKLY_WINDOW_MINUTES = 10080;
// 容忍老版本 bucket 长度 off-by-one-minute 的漂移，不吸收其它时长。
const CODEX_WINDOW_DURATION_TOLERANCE_MINUTES = 1;

/** 读窗口时长（分钟）：驼峰 windowDurationMins 优先，兼容下划线变体。 */
function readWindowDurationMins(window: unknown): number | null {
  if (!isRecord(window)) {
    return null;
  }
  return toFiniteNumber(window.windowDurationMins ?? window.window_duration_mins ?? window.windowDurationMinutes);
}

/** 按时长认桶：300→session（5h）、10080→weekly（7d），未知时长返回 null。 */
function classifyWindowByDuration(durationMins: number | null): "session" | "weekly" | null {
  if (durationMins === null) {
    return null;
  }
  if (Math.abs(durationMins - CODEX_SESSION_WINDOW_MINUTES) <= CODEX_WINDOW_DURATION_TOLERANCE_MINUTES) {
    return "session";
  }
  if (Math.abs(durationMins - CODEX_WEEKLY_WINDOW_MINUTES) <= CODEX_WINDOW_DURATION_TOLERANCE_MINUTES) {
    return "weekly";
  }
  return null;
}

/**
 * 解析 account/rateLimits/read 的 result。
 *
 * 首选按各窗口自带的 `windowDurationMins` 认桶（300→5h、10080→7d，±1 容差），不依赖
 * primary/secondary 顺序——实测 app-server 可能把周额度放在 primary。`windowDurationMins`
 * 缺失或无法归类时，退回 legacy `primary→5h、secondary→weekly`。字段缺失时对应窗口为 null。
 */
function parseRateLimitsResult(result: unknown): CodexQuota {
  const wrapper = isRecord(result) && isRecord(result.rateLimits) ? result.rateLimits : null;
  if (!wrapper) {
    return { fiveHour: null, sevenDay: null, resetsAt: null };
  }
  const mappable = (window: unknown): Record<string, unknown> | null => {
    if (!isRecord(window) || readUsedPercent(window) === null) {
      return null;
    }
    return window;
  };
  const primary = mappable(wrapper.primary);
  const secondary = mappable(wrapper.secondary);

  let session: Record<string, unknown> | null = null;
  let weekly: Record<string, unknown> | null = null;
  for (const window of [primary, secondary]) {
    if (!window) {
      continue;
    }
    const kind = classifyWindowByDuration(readWindowDurationMins(window));
    if (kind === "session" && !session) {
      session = window;
    } else if (kind === "weekly" && !weekly) {
      weekly = window;
    }
  }
  // duration 缺失/未知时退回 legacy 位置映射（primary→5h、secondary→7d）。
  if (!session && primary && classifyWindowByDuration(readWindowDurationMins(primary)) === null) {
    session = primary;
  }
  if (!weekly && secondary && classifyWindowByDuration(readWindowDurationMins(secondary)) === null) {
    weekly = secondary;
  }

  return {
    fiveHour: readUsedPercent(session),
    sevenDay: readUsedPercent(weekly),
    resetsAt: readResetsAtMs(session) ?? readResetsAtMs(weekly),
  };
}

function getCodexHome(codexHomePath: string | null | undefined): string {
  return codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function buildRpcMessage(id: number, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`;
}

function buildRpcNotification(method: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params: {} })}\n`;
}

// 真实 spawn：Windows 上 codex 多为 codex.cmd，不带 shell 会失败，故 win32 走 shell。
const defaultSpawn: CodexSpawnFn = (command, args, options) => {
  const merged = process.platform === "win32" ? { ...options, shell: true } : options;
  return spawn(command, args, merged as unknown as Parameters<typeof spawn>[2]) as unknown as CodexChildProcess;
};

export interface FetchCodexQuotaOptions {
  codexHomePath?: string | null;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: CodexSpawnFn;
}

/**
 * spawn `codex app-server` 走 JSON-RPC 握手 + `account/rateLimits/read` 拉额度。
 *
 * 握手必须 initialize → 收响应 → 发 initialized 通知，否则后续方法被拒为 "Not initialized"。
 * 全程不抛错：ENOENT → unavailable，超时 / RPC error / 进程退出 → error。
 */
export async function fetchCodexQuota(options: FetchCodexQuotaOptions = {}): Promise<CodexFetchOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const spawnFn = options.spawn ?? defaultSpawn;
  const childEnv: NodeJS.ProcessEnv = { ...env, CODEX_HOME: getCodexHome(options.codexHomePath) };

  const empty = (status: CodexFetchStatus): CodexFetchOutcome => ({
    fiveHour: null,
    sevenDay: null,
    resetsAt: null,
    status,
  });

  return new Promise<CodexFetchOutcome>((resolve) => {
    let settled = false;
    let buffer = "";
    let rpcId = 0;
    let rateLimitsId: number | null = null;
    let child: CodexChildProcess | null = null;
    let timer: NodeJS.Timeout | null = null;

    const finish = (outcome: CodexFetchOutcome, kill = false): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // settled 标志已保证 resolve 幂等，无需再手动摘 listener；kill 终止子进程后其 stdio 自然关闭。
      if (kill && child) {
        try {
          child.kill();
        } catch {
          // kill 失败不影响结果。
        }
      }
      resolve(outcome);
    };

    try {
      child = spawnFn("codex", CODEX_ARGS, {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      debugLog("codex", "spawn threw", error instanceof Error ? error.message : String(error));
      resolve(empty("error"));
      return;
    }

    timer = setTimeout(() => {
      debugLog("codex", "rpc timeout", { timeoutMs });
      finish(empty("error"), true);
    }, timeoutMs);

    const send = (message: string): void => {
      try {
        child?.stdin.write(message);
      } catch (error) {
        debugLog("codex", "stdin write failed", error instanceof Error ? error.message : String(error));
      }
    };

    const initId = (rpcId += 1);
    send(buildRpcMessage(initId, "initialize", { clientInfo: { name: "ccus", version: "1.0.0" } }));

    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          continue;
        }
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue; // 非 JSON 行（server 日志等）忽略。
        }
        if (message.id === undefined) {
          continue; // server 通知无 id。
        }
        if (message.id === initId) {
          // 握手成功，发 initialized 通知后再请求额度。
          send(buildRpcNotification("initialized"));
          rateLimitsId = rpcId += 1;
          send(buildRpcMessage(rateLimitsId, "account/rateLimits/read"));
          continue;
        }
        if (rateLimitsId !== null && message.id === rateLimitsId) {
          if (message.error) {
            debugLog("codex", "rateLimits rpc error", message.error.message ?? "unknown");
            finish(empty("error"), true);
            return;
          }
          const quota = parseRateLimitsResult(message.result);
          debugLog("codex", "quota parsed", quota);
          finish({ ...quota, status: "ok" }, true);
        }
      }
    });

    child.on("error", (err: Error & { code?: string }) => {
      const enoent = err.code === "ENOENT";
      debugLog("codex", "spawn error", { code: err.code, message: err.message });
      finish(empty(enoent ? "unavailable" : "error"));
    });

    child.on("close", (code: number | null) => {
      debugLog("codex", "app-server exited before quota", { code });
      finish(empty("error"));
    });
  });
}

/** 同步读取额度缓存；损坏 / 缺失返回 null。 */
export function readCodexQuotaCacheSync(dataDir: string): CodexQuotaCache | null {
  try {
    const raw = fs.readFileSync(getCodexQuotaCachePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<CodexQuotaCache>;
    if (typeof parsed.fetchedAt !== "string") {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      fiveHour: typeof parsed.fiveHour === "number" ? parsed.fiveHour : null,
      sevenDay: typeof parsed.sevenDay === "number" ? parsed.sevenDay : null,
      resetsAt: typeof parsed.resetsAt === "number" ? parsed.resetsAt : null,
    };
  } catch {
    return null;
  }
}

/** 写入额度缓存；失败静默（不能因缓存写失败影响采集主流程）。 */
async function writeCodexQuotaCache(dataDir: string, cache: CodexQuotaCache): Promise<void> {
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(getCodexQuotaCachePath(dataDir), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch (error) {
    debugLog("codex", "failed to write quota cache", error instanceof Error ? error.message : String(error));
  }
}

function isCodexCacheFresh(cache: CodexQuotaCache, ttlMs: number, now: Date): boolean {
  const fetched = Date.parse(cache.fetchedAt);
  return Number.isFinite(fetched) && now.getTime() - fetched < ttlMs;
}

function quotaFromCache(cache: CodexQuotaCache): CodexQuota {
  return { fiveHour: cache.fiveHour, sevenDay: cache.sevenDay, resetsAt: cache.resetsAt };
}

function hasAnyQuota(quota: CodexQuota): boolean {
  return quota.fiveHour !== null || quota.sevenDay !== null;
}

/** 拉取动作类型，供 resolveCodexQuota 注入可替换实现（测试用）。 */
export type CodexFetcher = (options?: FetchCodexQuotaOptions) => Promise<CodexFetchOutcome>;

/**
 * 缓存优先解析额度：新鲜直接返回；过期拉一次（带超时）；拉取失败 / 无有效数据回退旧缓存，全失败返回 null。
 *
 * notify 路径用，全程不抛错、不写 stdout。`options.fetcher` 供测试注入。
 */
export async function resolveCodexQuota(
  dataDir: string,
  options: { now?: Date; ttlMs?: number; fetcher?: CodexFetcher; fetchOptions?: FetchCodexQuotaOptions } = {},
): Promise<CodexQuota | null> {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const fetcher = options.fetcher ?? fetchCodexQuota;

  const cached = readCodexQuotaCacheSync(dataDir);
  if (cached && isCodexCacheFresh(cached, ttlMs, now)) {
    return quotaFromCache(cached);
  }

  try {
    const outcome = await fetcher(options.fetchOptions);
    if (outcome.status === "ok" && hasAnyQuota(outcome)) {
      const quota: CodexQuota = {
        fiveHour: outcome.fiveHour,
        sevenDay: outcome.sevenDay,
        resetsAt: outcome.resetsAt,
      };
      await writeCodexQuotaCache(dataDir, { ...quota, fetchedAt: now.toISOString() });
      return quota;
    }
    debugLog("codex", "fetch did not yield usable quota", { status: outcome.status });
  } catch (error) {
    debugLog("codex", "fetch threw, fallback to cache", error instanceof Error ? error.message : String(error));
  }

  return cached ? quotaFromCache(cached) : null;
}
