import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../cli";
import { readEventsForRange } from "../lib/storage";
import { computeStatuslineEvent } from "../lib/payload";
import { getCodexQuotaCachePath } from "../lib/paths";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 预写新鲜额度缓存，让 resolveCodexQuota 命中、不 spawn 真实 codex。 */
async function precacheCodexQuota(dir: string, fiveHour: number, sevenDay: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    getCodexQuotaCachePath(dir),
    JSON.stringify({ fiveHour, sevenDay, resetsAt: null, fetchedAt: new Date().toISOString() }),
    "utf8",
  );
}

test("__codex-notify persists a source=codex event with 5h/7d and writes no stdout", async () => {
  const dir = await mkdtemp("ccus-codex-notify-");
  await precacheCodexQuota(dir, 42, 18);
  const notify = JSON.stringify({ type: "agent-turn-complete", "thread-id": "thr_abc", "turn-id": "turn_1", cwd: "/tmp/proj" });

  const writeMock = mock.method(process.stdout, "write", () => true);
  try {
    await main(["__codex-notify", notify, "--data-dir", dir]);
  } finally {
    writeMock.mock.restore();
  }

  assert.equal(writeMock.mock.calls.length, 0, "notify 路径不得写 stdout");

  const events = await readEventsForRange(dir, "today", new Date());
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.rawPayload.source, "codex");
  assert.equal(ev.rawPayload.session_id, "thr_abc");
  assert.deepEqual(ev.rawPayload.workspace, { current_dir: "/tmp/proj" });
  const rateLimits = ev.rawPayload.rate_limits as { five_hour: { used_percentage: number }; seven_day: { used_percentage: number } };
  assert.equal(rateLimits.five_hour.used_percentage, 42);
  assert.equal(rateLimits.seven_day.used_percentage, 18);

  const computed = computeStatuslineEvent(ev);
  assert.equal(computed.usagePct, 42);
  assert.equal(computed.sevenDayUsagePct, 18);
});

test("__codex-notify tolerates notify payload missing thread-id", async () => {
  const dir = await mkdtemp("ccus-codex-notify-");
  await precacheCodexQuota(dir, 7, 9);
  const notify = JSON.stringify({ type: "agent-turn-complete", cwd: "/tmp/other" });

  await main(["__codex-notify", notify, "--data-dir", dir]);

  const events = await readEventsForRange(dir, "today", new Date());
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.rawPayload.source, "codex");
  assert.equal(ev.rawPayload.session_id, undefined);
  assert.equal((ev.rawPayload.workspace as { current_dir: string }).current_dir, "/tmp/other");
});
