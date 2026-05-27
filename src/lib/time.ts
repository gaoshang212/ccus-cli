import { RangeWindow } from "../types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 统一按本地时区切日，避免“今天 / 本周”与用户直觉不一致。
 */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/**
 * 以周一作为一周开始，便于输出 `this-week` 统计。
 */
function startOfLocalWeek(date: Date): Date {
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(date);
  start.setDate(date.getDate() + diff);
  return startOfLocalDay(start);
}

/**
 * 解析 CLI 传入的时间范围。
 *
 * 当前支持：`today`、`this-week`、`5h`、`30m` 这类相对窗口。
 */
export function resolveRange(range: string | undefined, now = new Date()): RangeWindow {
  const normalized = (range ?? "5h").trim().toLowerCase();

  if (normalized === "today") {
    return { label: "today", start: startOfLocalDay(now), end: now };
  }

  if (normalized === "this-week") {
    return { label: "this-week", start: startOfLocalWeek(now), end: now };
  }

  const match = normalized.match(/^(\d+)([hm])$/);
  if (!match) {
    throw new Error(`Unsupported range: ${range ?? ""}`);
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const duration = unit === "h" ? amount * HOUR_MS : amount * 60 * 1000;
  return {
    label: normalized,
    start: new Date(now.getTime() - duration),
    end: now,
  };
}

/**
 * 把日期映射成稳定的本地日键，用于事件按天分桶存储。
 */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 把时间窗口渲染成用于文件名的起止日期标记。
 */
export function formatRangeFileLabel(start: Date, end: Date): string {
  return `${localDateKey(start)}_to_${localDateKey(end)}`;
}

/**
 * 从 git email 中提取规范化的帐号名（@ 之前的部分，小写并清洗特殊字符）。
 *
 * 这是身份层使用的人类可读用户名，被持久化事件和 aggregate personKey 共用。
 */
export function extractGitEmailAccount(email: string | null): string | null {
  if (!email) {
    return null;
  }

  const localPart = email.split("@")[0]?.trim().toLowerCase();
  if (!localPart) {
    return null;
  }

  const sanitized = localPart.replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/-+/g, "-").replaceAll(/^[.-]+|[.-]+$/g, "");
  return sanitized.length === 0 ? null : sanitized;
}

/**
 * 从 git email 中提取适合放进文件名的帐号名前缀。
 *
 * 在 `extractGitEmailAccount` 基础上再排除 Windows 保留名，避免生成不可用的文件名。
 */
export function formatGitEmailFilePrefix(email: string | null): string | null {
  const account = extractGitEmailAccount(email);
  if (!account) {
    return null;
  }

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(account)) {
    return null;
  }

  return account;
}

/**
 * 生成一个时间窗口内所有涉及的日期键，供批量读取事件文件时使用。
 */
export function enumerateDateKeys(start: Date, end: Date): string[] {
  const keys: string[] = [];
  const cursor = startOfLocalDay(start);
  while (cursor.getTime() <= end.getTime()) {
    keys.push(localDateKey(cursor));
    cursor.setTime(cursor.getTime() + DAY_MS);
  }
  return keys;
}

/** dashboard 和表格中展示的人类可读时间。 */
export function formatLocalTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** statusline 上更紧凑的时间格式。 */
export function formatClock(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * 统一做数值舍入，避免不同模块各自处理导致展示不一致。
 */
export function roundNumber(value: number | null, digits = 1): number | null {
  if (value === null || Number.isNaN(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
