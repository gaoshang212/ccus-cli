import path from "node:path";
import { PersistedStatuslineEvent, RawStatuslinePayload, StatuslineEvent } from "../types";
import { formatClock, roundNumber } from "./time";

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

/**
 * 生成真正显示在 Claude Code statusline 上的短文本。
 *
 * 这里必须保持单行、紧凑，避免污染 statusline 展示区域。
 */
export function formatStatusLine(event: Pick<StatuslineEvent, "usagePct" | "contextWindowPct" | "contextUsed" | "contextMax" | "modelName" | "workspaceName" | "timestamp">): string {
  const timeLabel = formatClock(new Date(event.timestamp));
  const usageLabel = event.usagePct === null ? "5h --" : `5h ${event.usagePct.toFixed(1)}%`;
  const contextLabel =
    event.contextUsed !== null && event.contextMax !== null
      ? `ctx ${event.contextUsed}/${event.contextMax}`
      : event.contextWindowPct !== null
        ? `ctx ${event.contextWindowPct.toFixed(1)}%`
      : event.contextUsed !== null
        ? `ctx ${event.contextUsed}`
        : "ctx --";
  const modelLabel = event.modelName ?? "model --";
  const workspaceLabel = event.workspaceName ?? "workspace --";

  return `${usageLabel} | ${contextLabel} | ${modelLabel} | ${workspaceLabel} | ${timeLabel}`;
}

/**
 * 基于原始 payload 创建一条最小持久化事件。
 *
 * 分析字段不在这里持久化，而是在读取时按需计算。
 */
export function createPersistedStatuslineEvent(payload: RawStatuslinePayload, now = new Date()): PersistedStatuslineEvent {
  return {
    schemaVersion: 2,
    timestamp: now.toISOString(),
    gitUserName: null,
    gitUserEmail: null,
    rawPayload: payload,
  };
}

/**
 * 从持久化事件计算出 dashboard/export/statusline 使用的完整视图。
 *
 * 对旧日志会优先使用 rawPayload 重新推导；若个别旧字段缺失，再回退到历史持久化字段。
 */
export function computeStatuslineEvent(record: PersistedStatuslineEvent): StatuslineEvent {
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

  const baseEvent: StatuslineEvent = {
    timestamp: record.timestamp,
    sessionId,
    workspaceDir,
    workspaceName,
    modelName,
    gitUserName: record.gitUserName ?? null,
    gitUserEmail: record.gitUserEmail ?? null,
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
    statusLine: legacy.statusLine ?? formatStatusLine(baseEvent),
  };
}
