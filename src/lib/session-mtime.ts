import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { collectProjectJsonlFiles } from "./claude";
import { getClaudeDataDir, getCodexSessionHomes } from "./paths";
import { localDateKey } from "./time";

interface RepairResult {
  filePath: string;
  status: "repaired" | "unchanged" | "skipped" | "failed";
  before?: Date;
  after?: Date;
  reason?: string;
}

/** 从尾部按块取最后一条非空 JSON；异常末行不猜测时间。 */
async function readLastTimestamp(file: FileHandle, size: number): Promise<number | null> {
  let position = size;
  const chunks: Buffer[] = [];
  while (position > 0) {
    const length = Math.min(position, 16 * 1024);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    if (bytesRead !== length) return null;
    let end = length;
    if (chunks.length === 0) {
      while (end > 0 && [9, 10, 13, 32].includes(buffer[end - 1])) end -= 1;
      if (end === 0) continue;
    }
    const newline = buffer.lastIndexOf(10, end - 1);
    chunks.push(buffer.subarray(newline + 1, end));
    if (newline >= 0 || position === 0) {
      try {
        const record: unknown = JSON.parse(Buffer.concat(chunks.reverse()).toString("utf8"));
        if (typeof record !== "object" || record === null || !("timestamp" in record)
          || typeof record.timestamp !== "string") return null;
        const timestamp = new Date(record.timestamp).getTime();
        return Number.isFinite(timestamp) ? timestamp : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function repairSessionMtimes(dryRun: boolean, source?: "codex" | "claude", minGapMs?: number): Promise<RepairResult[]> {
  const directories = [
    ...(source !== "codex" ? [path.join(getClaudeDataDir(), "projects")] : []),
    ...(source !== "claude" ? getCodexSessionHomes().map((home) => path.join(home, "sessions")) : []),
  ];
  const files = [...new Set((await Promise.all(directories.map(collectProjectJsonlFiles))).flat())];
  const results: RepairResult[] = [];
  const seenFiles = new Set<string>();
  for (const filePath of files) {
    try {
      const file = await fs.open(filePath, dryRun ? "r" : "r+");
      try {
        const before = await file.stat({ bigint: true });
        const identity = before.ino === 0n ? `path:${filePath}` : `${before.dev}:${before.ino}`;
        if (seenFiles.has(identity)) continue;
        seenFiles.add(identity);
        const timestamp = await readLastTimestamp(file, Number(before.size));
        if (timestamp === null) {
          results.push({ filePath, status: "skipped", reason: "末条记录无有效时间戳" });
          continue;
        }
        const current = await file.stat({ bigint: true });
        if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
          results.push({ filePath, status: "skipped", reason: "读取期间文件发生变化，请稍后重试" });
          continue;
        }
        const after = new Date(timestamp);
        const gap = timestamp - Number(current.mtimeMs);
        const meetsThreshold = minGapMs === undefined
          ? localDateKey(current.mtime) !== localDateKey(after)
          : gap >= minGapMs;
        if (gap <= 0 || !meetsThreshold) {
          results.push({ filePath, status: "unchanged" });
          continue;
        }
        if (!dryRun) await file.utimes(before.atime, after);
        results.push({ filePath, status: "repaired", before: current.mtime, after });
      } finally {
        await file.close();
      }
    } catch (error) {
      results.push({ filePath, status: "failed", reason: (error as Error).message });
    }
  }
  return results;
}
