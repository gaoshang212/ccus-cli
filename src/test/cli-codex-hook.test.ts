import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleCodexHook } from "../cli";
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

test("__codex-hook reads stdin payload, persists source=codex event with cwd/session_id, writes no stdout", async () => {
  const dir = await mkdtemp("ccus-codex-hook-");
  await precacheCodexQuota(dir, 55, 33);
  const payload = JSON.stringify({
    session_id: "sess_xyz",
    cwd: "/repo/ccus",
    hook_event_name: "Stop",
    turn_id: "t1",
  });

  const writeMock = mock.method(process.stdout, "write", () => true);
  try {
    await handleCodexHook(["--data-dir", dir], { readStdin: async () => payload });
  } finally {
    writeMock.mock.restore();
  }

  assert.equal(writeMock.mock.calls.length, 0, "hook 路径不得写 stdout（Stop 要求 stdout 空或 JSON）");

  const events = await readEventsForRange(dir, "today", new Date());
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.rawPayload.source, "codex");
  assert.equal(ev.rawPayload.session_id, "sess_xyz");
  assert.deepEqual(ev.rawPayload.workspace, { current_dir: "/repo/ccus" });
  const rateLimits = ev.rawPayload.rate_limits as { five_hour: { used_percentage: number }; seven_day: { used_percentage: number } };
  assert.equal(rateLimits.five_hour.used_percentage, 55);
  assert.equal(rateLimits.seven_day.used_percentage, 33);

  const computed = computeStatuslineEvent(ev);
  assert.equal(computed.usagePct, 55);
  assert.equal(computed.sevenDayUsagePct, 33);

  // 心跳文件证明 hook 被触发（与 notify 共用同一个心跳）。
  const heartbeat = await fs.readFile(path.join(dir, "codex-notify.heartbeat"), "utf8");
  assert.ok(heartbeat.trim().length > 0);

  await fs.rm(dir, { recursive: true, force: true });
});

test("__codex-hook tolerates malformed stdin (Windows Stop #23784) and still persists", async () => {
  const dir = await mkdtemp("ccus-codex-hook-");
  await precacheCodexQuota(dir, 8, 4);

  await handleCodexHook(["--data-dir", dir], { readStdin: async () => "{not valid json" });

  const events = await readEventsForRange(dir, "today", new Date());
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.rawPayload.source, "codex");
  assert.equal(ev.rawPayload.session_id, undefined);
  assert.equal(ev.rawPayload.workspace, undefined);
  // 额度仍正常落盘（身份缺失不影响额度采集）。
  const rateLimits = ev.rawPayload.rate_limits as { five_hour: { used_percentage: number } };
  assert.equal(rateLimits.five_hour.used_percentage, 8);

  await fs.rm(dir, { recursive: true, force: true });
});

test("__codex-hook tolerates empty stdin and still persists", async () => {
  const dir = await mkdtemp("ccus-codex-hook-");
  await precacheCodexQuota(dir, 12, 6);

  await handleCodexHook(["--data-dir", dir], { readStdin: async () => "" });

  const events = await readEventsForRange(dir, "today", new Date());
  assert.equal(events.length, 1);

  await fs.rm(dir, { recursive: true, force: true });
});
