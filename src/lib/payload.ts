import path from "node:path";
import { PersistedStatuslineEvent, RawStatuslinePayload, StatuslineEvent } from "../types";
import { extractGitEmailAccount, formatClock, roundNumber } from "./time";

/** 仅把普通对象视作可继续读取字段的记录类型。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宽松读取数字，兼容 number 和可转成 number 的字符串。 */
function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/** 宽松读取非空字符串。 */
function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 从原始 payload 中提取 session id。 */
export function readSessionId(payload: RawStatuslinePayload): string | null {
  return getString(payload.session_id);
}

/**
 * 从 `context_window` 中提取上下文窗口占用相关字段。
 *
 * 这里提取的是上下文窗口占用，不是 Claude 的 5 小时额度使用率。
 * 优先信任官方给出的 `used_percentage`；如果不存在，再尝试由 `used/max` 反推。
 */
function readContextMetrics(payload: RawStatuslinePayload): {
  contextWindowPct: number | null;
  contextUsed: number | null;
  contextMax: number | null;
} {
  if (!isRecord(payload.context_window)) {
    return { contextWindowPct: null, contextUsed: null, contextMax: null };
  }

  const contextWindowPct = getNumber(payload.context_window.used_percentage);
  const legacyContextUsed =
    getNumber(payload.context_window.used_tokens) ??
    getNumber(payload.context_window.current_tokens) ??
    getNumber(payload.context_window.used);
  const legacyContextMax =
    getNumber(payload.context_window.max_tokens) ??
    getNumber(payload.context_window.limit_tokens) ??
    getNumber(payload.context_window.max);
  const totalInputTokens = getNumber(payload.context_window.total_input_tokens);
  const totalOutputTokens = getNumber(payload.context_window.total_output_tokens);
  const contextUsed =
    legacyContextUsed ??
    (totalInputTokens !== null || totalOutputTokens !== null ? (totalInputTokens ?? 0) + (totalOutputTokens ?? 0) : null);
  const contextMax = legacyContextMax ?? getNumber(payload.context_window.context_window_size);

  if (contextWindowPct !== null) {
    return {
      contextWindowPct: roundNumber(contextWindowPct, 1),
      contextUsed,
      contextMax,
    };
  }

  if (contextUsed !== null && contextMax !== null && contextMax > 0) {
    return {
      contextWindowPct: roundNumber((contextUsed / contextMax) * 100, 1),
      contextUsed,
      contextMax,
    };
  }

  return { contextWindowPct: null, contextUsed, contextMax };
}

/**
 * 读取 Claude 的 5 小时额度使用率。
 *
 * 官方字段位于 `rate_limits.five_hour.used_percentage`。
 */
function readFiveHourUsagePct(payload: RawStatuslinePayload): number | null {
  if (!isRecord(payload.rate_limits)) {
    return null;
  }

  const fiveHour = payload.rate_limits.five_hour;
  if (!isRecord(fiveHour)) {
    return null;
  }

  return roundNumber(getNumber(fiveHour.used_percentage), 1);
}

/**
 * 读取 Claude 的 7 天额度使用率。
 *
 * 官方字段位于 `rate_limits.seven_day.used_percentage`。
 */
function readSevenDayUsagePct(payload: RawStatuslinePayload): number | null {
  if (!isRecord(payload.rate_limits)) {
    return null;
  }

  const sevenDay = payload.rate_limits.seven_day;
  if (!isRecord(sevenDay)) {
    return null;
  }

  return roundNumber(getNumber(sevenDay.used_percentage), 1);
}

/**
 * 模型名称不同版本可能有 `display_name` 或 `name`，这里统一兼容。
 */
function readModelName(payload: RawStatuslinePayload): string | null {
  if (!isRecord(payload.model)) {
    return null;
  }

  return getString(payload.model.display_name) ?? getString(payload.model.name);
}

/**
 * 工作目录优先走官方 `workspace.current_dir`，兼容旧字段 `cwd`。
 */
function readWorkspaceDir(payload: RawStatuslinePayload): string | null {
  if (isRecord(payload.workspace)) {
    return getString(payload.workspace.current_dir) ?? getString(payload.workspace.cwd);
  }
  return getString(payload.cwd);
}

/** 对外暴露工作区目录提取，供存储分片与 git 读取复用。 */
export function extractWorkspaceDir(payload: RawStatuslinePayload): string | null {
  return readWorkspaceDir(payload);
}

/**
 * dashboard 和 statusline 里展示更短的项目名，而不是整段绝对路径。
 */
function readWorkspaceName(workspaceDir: string | null): string | null {
  if (!workspaceDir) {
    return null;
  }
  return path.basename(workspaceDir);
}

/**
 * 解析 stdin 传入的原始 payload。
 *
 * 空输入返回空对象，便于上层做降级而不是直接崩溃。
 */
export function parseStatuslinePayload(input: string): RawStatuslinePayload {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const parsed = JSON.parse(trimmed) as unknown;
  return isRecord(parsed) ? (parsed as RawStatuslinePayload) : {};
}

/** statusline 里 ctx 段标红用的 ANSI 颜色码，仅作用于展示，不进任何落盘/导出契约。 */
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";

/**
 * ctx 标红的「档位」：不同大小的上下文窗口余量差很多，标红挡位也应不同。
 *
 * - `200k`：约 200K token 的常规窗口。
 * - `1m`：约 1M token 的长上下文窗口。
 *
 * 档位由 contextMax 自动判断（见 resolveCtxTier），拿不到 contextMax 时按 `200k` 处理。
 */
export type CtxTier = "200k" | "1m";

/** contextMax 超过该值就当作 1M 长上下文窗口，否则按 200K 档。 */
const CTX_TIER_1M_MIN_MAX = 400_000;

/**
 * 各档位的内置默认阈值（百分比超阈值或已用 token 超阈值，任一满足即标红）。
 *
 * 200K 窗口余量小、到 80%（约 160K）才提醒；1M 窗口虽大但 50%（约 500K）已用很多，提前提醒。
 */
const CTX_TIER_DEFAULTS: Record<CtxTier, { pct: number; tokens: number | null }> = {
  "200k": { pct: 80, tokens: null },
  "1m": { pct: 50, tokens: null },
};

/** 根据 contextMax 判断当前上下文窗口档位；拿不到 contextMax 时回退到 200K 档。 */
export function resolveCtxTier(contextMax: number | null): CtxTier {
  return contextMax !== null && contextMax > CTX_TIER_1M_MIN_MAX ? "1m" : "200k";
}

/** 把 `120000` / `120k` / `0.5m` 这类写法解析成整数 token；非法或空返回 null。 */
function parseTokenThreshold(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text === "") {
    return null;
  }
  const multiplier = text.endsWith("m") ? 1_000_000 : text.endsWith("k") ? 1_000 : 1;
  const numericPart = multiplier === 1 ? text : text.slice(0, -1);
  const parsed = Number(numericPart) * multiplier;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 按顺序读第一个能解析成非负数的百分比环境变量；全部缺失/非法时返回 fallback。 */
function readPctEnv(env: NodeJS.ProcessEnv, keys: string[], fallback: number): number {
  for (const key of keys) {
    const raw = (env[key] ?? "").trim();
    if (raw === "") {
      continue;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return fallback;
}

/** 按顺序读第一个非空的 token 阈值环境变量；全部缺失时返回 fallback。 */
function readTokensEnv(env: NodeJS.ProcessEnv, keys: string[], fallback: number | null): number | null {
  for (const key of keys) {
    const raw = env[key] ?? "";
    if (raw.trim() === "") {
      continue;
    }
    return parseTokenThreshold(raw);
  }
  return fallback;
}

/**
 * 解析某个上下文档位的 ctx 标红阈值，两个条件取「或」：百分比超阈值，或已用 token 超阈值。
 *
 * 优先级：档位专属环境变量 > 通用环境变量 > 档位内置默认。
 *
 * - 百分比：`CCUS_CTX_RED_PCT_200K` / `CCUS_CTX_RED_PCT_1M` → `CCUS_CTX_RED_PCT` → 档位默认（200K=80，1M=50）。
 * - token：`CCUS_CTX_RED_TOKENS_200K` / `CCUS_CTX_RED_TOKENS_1M` → `CCUS_CTX_RED_TOKENS` → 档位默认（默认不启用）。
 *   token 支持 `120000` / `120k` / `0.5m` 写法。
 *
 * 阈值只影响 statusline 颜色展示，不改变 stdin/stdout 文本契约，也不落盘。
 */
export function resolveCtxRedThresholds(
  contextMax: number | null,
  env: NodeJS.ProcessEnv = process.env,
): { tier: CtxTier; pct: number; tokens: number | null } {
  const tier = resolveCtxTier(contextMax);
  const defaults = CTX_TIER_DEFAULTS[tier];
  const tierSuffix = tier === "1m" ? "1M" : "200K";
  const pct = readPctEnv(env, [`CCUS_CTX_RED_PCT_${tierSuffix}`, "CCUS_CTX_RED_PCT"], defaults.pct);
  const tokens = readTokensEnv(env, [`CCUS_CTX_RED_TOKENS_${tierSuffix}`, "CCUS_CTX_RED_TOKENS"], defaults.tokens);
  return { tier, pct, tokens };
}

/** 判断 ctx 是否达到标红条件：百分比超阈值，或已用 token 超阈值，任一满足即标红。 */
function isContextHot(
  contextWindowPct: number | null,
  contextUsed: number | null,
  thresholds: { pct: number; tokens: number | null },
): boolean {
  if (contextWindowPct !== null && contextWindowPct > thresholds.pct) {
    return true;
  }
  if (thresholds.tokens !== null && contextUsed !== null && contextUsed >= thresholds.tokens) {
    return true;
  }
  return false;
}

/**
 * 生成真正显示在 Claude Code statusline 上的短文本。
 *
 * 这里必须保持单行、紧凑，避免污染 statusline 展示区域。
 */
export function formatStatusLine(
  event: Pick<StatuslineEvent, "usagePct" | "sevenDayUsagePct" | "contextWindowPct" | "modelName" | "workspaceName" | "timestamp"> & {
    contextUsed?: number | null;
    contextMax?: number | null;
  },
  gitBranch: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const timeLabel = formatClock(new Date(event.timestamp));
  const usageLabel = event.usagePct === null ? "5h --" : `5h ${event.usagePct.toFixed(1)}%`;
  const sevenDayLabel = event.sevenDayUsagePct === null ? "7d --" : `7d ${event.sevenDayUsagePct.toFixed(1)}%`;
  const contextText = event.contextWindowPct === null ? "ctx --" : `ctx ${event.contextWindowPct.toFixed(1)}%`;
  // ctx 占用超阈值时整段标红，提醒上下文快满；阈值按窗口大小（200K / 1M）分档，由 resolveCtxRedThresholds 决定。
  const contextLabel = isContextHot(
    event.contextWindowPct,
    event.contextUsed ?? null,
    resolveCtxRedThresholds(event.contextMax ?? null, env),
  )
    ? `${ANSI_RED}${contextText}${ANSI_RESET}`
    : contextText;
  const modelLabel = event.modelName ?? "model --";
  const workspaceLabel = event.workspaceName ?? "workspace --";

  const segments = [usageLabel, sevenDayLabel, contextLabel, modelLabel, workspaceLabel];
  // 分支名是 statusline 实时读取的展示信息，仅在拿得到时追加一段；
  // 历史日志重算时通常没有分支，省略该段比硬塞 "branch --" 更干净。
  if (gitBranch) {
    segments.push(`⎇ ${gitBranch}`);
  }
  segments.push(timeLabel);

  return segments.join(" | ");
}

/**
 * 基于原始 payload 创建一条最小持久化事件。
 *
 * 分析字段不在这里持久化，而是在读取时按需计算。
 */
export function createPersistedStatuslineEvent(payload: RawStatuslinePayload, now = new Date()): PersistedStatuslineEvent {
  return {
    schemaVersion: 3,
    timestamp: now.toISOString(),
    gitUserName: null,
    gitUserEmail: null,
    gitUserAccount: null,
    rawPayload: payload,
  };
}

/** 判断事件是否来自 Codex（rawPayload.source === "codex"）；Claude statusline 事件无该字段，视为 claude。 */
export function isCodexSourceRecord(record: PersistedStatuslineEvent): boolean {
  return record.rawPayload?.source === "codex";
}

/** StatuslineEvent 视图版的 Codex 来源判断（event.rawPayload 透传自 record）。 */
export function isCodexSourceEvent(event: StatuslineEvent): boolean {
  return event.rawPayload?.source === "codex";
}

/**
 * 从持久化事件计算出 dashboard/export/statusline 使用的完整视图。
 *
 * 对旧日志会优先使用 rawPayload 重新推导；若个别旧字段缺失，再回退到历史持久化字段。
 */
export function computeStatuslineEvent(
  record: PersistedStatuslineEvent,
  options: { gitBranch?: string | null } = {},
): StatuslineEvent {
  const legacy = record as PersistedStatuslineEvent & Partial<StatuslineEvent>;
  const payload = record.rawPayload ?? {};

  const sessionId = readSessionId(payload) ?? legacy.sessionId ?? null;
  const modelName = readModelName(payload) ?? legacy.modelName ?? null;
  const workspaceDir = readWorkspaceDir(payload) ?? legacy.workspaceDir ?? null;
  const workspaceName = readWorkspaceName(workspaceDir) ?? legacy.workspaceName ?? null;
  const usagePct = readFiveHourUsagePct(payload) ?? legacy.usagePct ?? null;
  const sevenDayUsagePct = readSevenDayUsagePct(payload) ?? legacy.sevenDayUsagePct ?? null;
  const computedContext = readContextMetrics(payload);
  const contextWindowPct = computedContext.contextWindowPct ?? legacy.contextWindowPct ?? null;
  const contextUsed = computedContext.contextUsed ?? legacy.contextUsed ?? null;
  const contextMax = computedContext.contextMax ?? legacy.contextMax ?? null;

  const gitUserAccount = record.gitUserAccount ?? extractGitEmailAccount(record.gitUserEmail ?? null);

  const baseEvent: StatuslineEvent = {
    timestamp: record.timestamp,
    sessionId,
    workspaceDir,
    workspaceName,
    modelName,
    gitUserName: record.gitUserName ?? null,
    gitUserEmail: record.gitUserEmail ?? null,
    gitUserAccount,
    usagePct,
    sevenDayUsagePct,
    contextWindowPct,
    contextUsed,
    contextMax,
    statusLine: "",
    rawPayload: payload,
  };

  return {
    ...baseEvent,
    statusLine: legacy.statusLine ?? formatStatusLine(baseEvent, options.gitBranch ?? null),
  };
}
