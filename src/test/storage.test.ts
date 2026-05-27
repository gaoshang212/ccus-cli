import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeStatuslineEvent } from "../lib/payload";
import { appendEvent, readEventsForRange } from "../lib/storage";
import { getEventsDir } from "../lib/paths";
import { localDateKey } from "../lib/time";
import { PersistedStatuslineEvent } from "../types";

/** 构造一条持久化测试事件，避免每个用例重复手写完整结构。 */
function createEvent(date: Date, usagePct: number, sessionId: string): PersistedStatuslineEvent {
  return {
    schemaVersion: 2,
    timestamp: date.toISOString(),
    gitUserName: "tester",
    gitUserEmail: "tester@example.com",
    gitUserAccount: "tester",
    rawPayload: {
      session_id: sessionId,
      model: { display_name: "Opus" },
      workspace: { current_dir: "/repo/test" },
      context_window: { used_percentage: usagePct, used_tokens: 100, max_tokens: 1000 },
      rate_limits: { five_hour: { used_percentage: usagePct } },
    },
  };
}

/** 同一个 session 的事件应该聚合进同一个 shard JSONL 文件，而不是一条一个文件。 */
test("appendEvent appends events into the same session shard jsonl file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-storage-"));
  const now = new Date(2026, 4, 26, 12, 0, 0, 0);
  const firstEvent = createEvent(now, 25, "session-a");
  const secondEvent = createEvent(new Date(now.getTime() + 5 * 60 * 1000), 35, "session-a");

  const firstPath = await appendEvent(tempDir, firstEvent);
  const secondPath = await appendEvent(tempDir, secondEvent);
  const events = (await readEventsForRange(tempDir, "5h", new Date(now.getTime() + 10 * 60 * 1000))).map((record) => computeStatuslineEvent(record));
  const shardContent = await fs.readFile(firstPath, "utf8");

  assert.match(firstPath, /session-a\.jsonl$/);
  assert.equal(firstPath, secondPath);
  assert.equal(shardContent.trim().split(/\r?\n/).length, 2);
  assert.equal(events.length, 2);
  assert.equal(events[0].sessionId, "session-a");
  assert.equal(events[1].usagePct, 35);
  assert.equal(events[1].gitUserEmail, "tester@example.com");
  assert.equal(shardContent.includes("\"statusLine\""), false);

  await fs.rm(tempDir, { recursive: true, force: true });
});

/** 不同 session 应该拆分到不同 shard 文件，避免一个文件无限增长。 */
test("appendEvent splits events into different shard files by session", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-storage-"));
  const now = new Date(2026, 4, 26, 12, 0, 0, 0);

  const sessionAPath = await appendEvent(tempDir, createEvent(now, 25, "session-a"));
  const sessionBPath = await appendEvent(tempDir, createEvent(new Date(now.getTime() + 5 * 60 * 1000), 45, "session-b"));

  assert.notEqual(sessionAPath, sessionBPath);
  assert.match(sessionAPath, /session-a\.jsonl$/);
  assert.match(sessionBPath, /session-b\.jsonl$/);

  await fs.rm(tempDir, { recursive: true, force: true });
});

/** 读侧必须容忍坏 shard、坏旧文件和旧 JSONL 中的坏行，不能因为少量脏数据导致整批失败。 */
test("readEventsForRange tolerates malformed JSON files and legacy jsonl lines", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-storage-"));
  const now = new Date(2026, 4, 26, 12, 0, 0, 0);
  const dateKey = localDateKey(now);
  const eventsDir = getEventsDir(tempDir);
  const dayDir = path.join(eventsDir, dateKey);
  await fs.mkdir(dayDir, { recursive: true });

  const validEvent = createEvent(now, 42, "session-b");
  await fs.writeFile(
    path.join(dayDir, "session-shard.jsonl"),
    `${JSON.stringify(createEvent(new Date(now.getTime() + 2 * 60 * 1000), 48, "session-d"))}\nnot json\n`,
    "utf8",
  );
  await fs.writeFile(path.join(dayDir, "valid.json"), JSON.stringify(validEvent), "utf8");
  await fs.writeFile(path.join(dayDir, "broken.json"), "{not-valid-json", "utf8");
  await fs.writeFile(
    path.join(eventsDir, `${dateKey}.jsonl`),
    `${JSON.stringify(createEvent(new Date(now.getTime() + 5 * 60 * 1000), 55, "session-c"))}\nnot json\n`,
    "utf8",
  );

  const events = (await readEventsForRange(tempDir, "5h", new Date(now.getTime() + 10 * 60 * 1000))).map((record) => computeStatuslineEvent(record));

  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((event) => event.sessionId),
    ["session-b", "session-d", "session-c"],
  );
  assert.equal(events[0].gitUserName, "tester");

  await fs.rm(tempDir, { recursive: true, force: true });
});
