import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PersistedStatuslineEvent } from "../types";
import { getEventsDir } from "./paths";
import { extractWorkspaceDir, readSessionId } from "./payload";
import { enumerateDateKeys, localDateKey, resolveRange } from "./time";

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RETRY_TIMES = 40;
const STALE_LOCK_TIMEOUT_MS = 10_000;

/** 所有写入前都先确保父目录存在。 */
async function ensureDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
}

/** 当前采用按天分目录的布局，便于按范围扫描和后续迁移。 */
function getDayDirectory(eventsDir: string, dateKey: string): string {
  return path.join(eventsDir, dateKey);
}

/** 兼容 v1 早期的 JSONL 单文件布局，避免旧数据无法读取。 */
function getLegacyJsonlPath(eventsDir: string, dateKey: string): string {
  return path.join(eventsDir, `${dateKey}.jsonl`);
}

/** 将任意字符串压缩成适合文件名的片段。 */
function sanitizeFilePart(value: string): string {
  const normalized = value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/-+/g, "-").replaceAll(/^[-.]+|[-.]+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

/** 为没有 sessionId 的事件生成一个稳定的 workspace 分片键。 */
function buildWorkspaceShardKey(workspaceDir: string | null): string {
  if (!workspaceDir) {
    return "workspace-unknown";
  }

  const digest = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
  return `workspace-${digest}`;
}

/**
 * 同一天、同一个 session 的事件写入同一个 shard 文件，减少碎文件数量。
 */
function getShardFileName(event: PersistedStatuslineEvent): string {
  const sessionId = readSessionId(event.rawPayload);
  if (sessionId) {
    return `${sanitizeFilePart(sessionId)}.jsonl`;
  }

  return `${buildWorkspaceShardKey(extractWorkspaceDir(event.rawPayload))}.jsonl`;
}

/** 简单休眠，用于锁竞争时退避重试。 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判断锁文件是否已经过期。
 *
 * statusline 写入应该很快完成；如果锁长期存在，通常意味着写入进程已经异常退出。
 */
async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(lockPath);
    return Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * 用独占锁文件做跨进程互斥，避免多个 Claude statusline 进程同时写坏同一 shard。
 */
async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < LOCK_RETRY_TIMES; attempt += 1) {
    try {
      await fs.writeFile(lockPath, `${process.pid}\n${Date.now()}`, { encoding: "utf8", flag: "wx" });

      try {
        return await action();
      } finally {
        await fs.rm(lockPath, { force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      if (await isStaleLock(lockPath)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Failed to acquire log shard lock: ${lockPath}`);
}

/** 读侧只接受我们认识的最小事件结构，避免脏数据污染报表。 */
function isPersistedStatuslineEvent(value: unknown): value is PersistedStatuslineEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.timestamp === "string" && typeof candidate.rawPayload === "object" && candidate.rawPayload !== null;
}

/**
 * 将事件追加到按天、按 session 分片的 JSONL 文件中。
 *
 * 这样既能减少碎文件数量，也能通过锁文件避免多进程同时写坏同一个 shard。
 */
export async function appendEvent(dataDir: string, event: PersistedStatuslineEvent): Promise<string> {
  const eventsDir = getEventsDir(dataDir);
  await ensureDirectory(eventsDir);

  const dateKey = localDateKey(new Date(event.timestamp));
  const dayDirectory = getDayDirectory(eventsDir, dateKey);
  await ensureDirectory(dayDirectory);

  const filePath = path.join(dayDirectory, getShardFileName(event));
  const lockPath = `${filePath}.lock`;

  await withFileLock(lockPath, async () => {
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  });

  return filePath;
}

/**
 * 兼容旧 JSONL 数据：逐行解析，坏行直接跳过，不让整批读取失败。
 */
async function readEventsFromJsonl(filePath: string): Promise<PersistedStatuslineEvent[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as unknown;
            return isPersistedStatuslineEvent(parsed) ? [parsed] : [];
          } catch {
            return [];
          }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * 读取单个事件文件时容忍损坏或被删掉的文件，返回 null 即可。
 */
async function readEventFile(filePath: string): Promise<PersistedStatuslineEvent | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return isPersistedStatuslineEvent(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

/** 扫描某一天目录下的所有事件文件。 */
async function readEventsFromDayDirectory(directoryPath: string): Promise<PersistedStatuslineEvent[]> {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const eventFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".tmp"))
      .map((entry) => path.join(directoryPath, entry.name));
    const shardFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".lock"))
      .map((entry) => path.join(directoryPath, entry.name));

    const [jsonEvents, jsonlEvents] = await Promise.all([
      Promise.all(eventFiles.map((filePath) => readEventFile(filePath))),
      Promise.all(shardFiles.map((filePath) => readEventsFromJsonl(filePath))),
    ]);

    return [...jsonEvents.filter((event): event is PersistedStatuslineEvent => event !== null), ...jsonlEvents.flat()];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * 读取指定时间窗口内的事件集合。
 *
 * 同时兼容“按天目录 JSON 文件”和“旧版 JSONL 文件”两种存储布局。
 */
export async function readEventsForRange(dataDir: string, range: string, now = new Date()): Promise<PersistedStatuslineEvent[]> {
  const window = resolveRange(range, now);
  const keys = enumerateDateKeys(window.start, window.end);
  const eventsDir = getEventsDir(dataDir);

  const lists = await Promise.all(
    keys.map(async (key) => {
      const [directoryEvents, legacyEvents] = await Promise.all([
        readEventsFromDayDirectory(getDayDirectory(eventsDir, key)),
        readEventsFromJsonl(getLegacyJsonlPath(eventsDir, key)),
      ]);

      return [...directoryEvents, ...legacyEvents];
    }),
  );

  return lists
    .flat()
    .filter((event) => {
      const timestamp = new Date(event.timestamp).getTime();
      return timestamp >= window.start.getTime() && timestamp <= window.end.getTime();
    })
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}
