import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarizeCodexSessionUsage, summarizeCodexSessionUsageByDay } from "../lib/codex-sessions";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 把 ccus 指向一个临时 CODEX_HOME，返回它和恢复函数。 */
async function withTempCodexHome(prefix: string): Promise<{ home: string; restore: () => void }> {
  const home = await mkdtemp(prefix);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  return { home, restore: () => {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  } };
}

/** 造一份 rollout 文件，lines 是逐行 JSON 字符串数组。 */
async function writeRollout(home: string, relPath: string, lines: string[]): Promise<void> {
  const filePath = path.join(home, "sessions", relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

const DAY = "2026-07-27";
const RANGE_START = new Date("2026-07-27T00:00:00Z");
const RANGE_END = new Date("2026-07-27T23:59:59Z");

function ts(minute: number, second = 0): string {
  return `2026-07-27T02:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

test("summarizeCodexSessionUsage counts user_message and sums last_token_usage", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-a.jsonl", [
      `{"timestamp":"${ts(37, 48)}","type":"session_meta"}`,
      `{"timestamp":"${ts(37, 48)}","type":"event_msg","payload":{"type":"user_message","message":"你好"}}`,
      `{"timestamp":"${ts(37, 55)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":9862,"output_tokens":141,"cached_input_tokens":0},"total_token_usage":{"input_tokens":9862,"output_tokens":141,"cached_input_tokens":0}}}}`,
      `{"timestamp":"${ts(40, 0)}","type":"event_msg","payload":{"type":"agent_message","message":"hi"}}`,
    ]);

    const summary = await summarizeCodexSessionUsage(RANGE_START, RANGE_END);

    assert.equal(summary.userMessageCount, 1);
    assert.equal(summary.apiRequestCount, 1);
    assert.equal(summary.inputTokens, 9862);
    assert.equal(summary.outputTokens, 141);
    assert.equal(summary.cacheReadInputTokens, 0);
    assert.equal(summary.matchedFileCount, 1);
    assert.equal(summary.codexDataDir, home);
  } finally {
    restore();
  }
});

test("summarizeCodexSessionUsage uses last_token_usage increment, not total_token_usage cumulative", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-b.jsonl", [
      // 第 1 turn：last=input 1000；第 2 turn：last=input 500 但 total=1500（累计）。
      `{"timestamp":"${ts(10, 0)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"output_tokens":10,"cached_input_tokens":0},"total_token_usage":{"input_tokens":1000,"output_tokens":10,"cached_input_tokens":0}}}}`,
      `{"timestamp":"${ts(20, 0)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":500,"output_tokens":5,"cached_input_tokens":50},"total_token_usage":{"input_tokens":1500,"output_tokens":15,"cached_input_tokens":50}}}}`,
    ]);

    const summary = await summarizeCodexSessionUsage(RANGE_START, RANGE_END);

    // 累加 last（1000+500=1500），不是 total（1000+1500=2500）。
    assert.equal(summary.apiRequestCount, 2);
    assert.equal(summary.inputTokens, 1500);
    assert.equal(summary.outputTokens, 15);
    assert.equal(summary.cacheReadInputTokens, 50);
  } finally {
    restore();
  }
});

test("summarizeCodexSessionUsage ignores events outside the time window", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-c.jsonl", [
      `{"timestamp":"2026-07-27T02:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"in-range"}}`,
      `{"timestamp":"2026-07-28T02:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"out-of-range"}}`,
    ]);

    const summary = await summarizeCodexSessionUsage(RANGE_START, RANGE_END);

    assert.equal(summary.userMessageCount, 1);
  } finally {
    restore();
  }
});

test("summarizeCodexSessionUsage tolerates token_count missing info/usage", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-d.jsonl", [
      `{"timestamp":"${ts(5, 0)}","type":"event_msg","payload":{"type":"token_count"}}`,
      `{"timestamp":"${ts(6, 0)}","type":"event_msg","payload":{"type":"token_count","info":{}}}`,
      `{"timestamp":"${ts(7, 0)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"output_tokens":20,"cached_input_tokens":0}}}}`,
    ]);

    const summary = await summarizeCodexSessionUsage(RANGE_START, RANGE_END);

    // 只有第三个事件有 last_token_usage 才计入请求与 token。
    assert.equal(summary.apiRequestCount, 1);
    assert.equal(summary.inputTokens, 200);
  } finally {
    restore();
  }
});

test("summarizeCodexSessionUsage returns zeros when sessions dir missing", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    const summary = await summarizeCodexSessionUsage(RANGE_START, RANGE_END);

    assert.equal(summary.userMessageCount, 0);
    assert.equal(summary.apiRequestCount, 0);
    assert.equal(summary.matchedFileCount, 0);
  } finally {
    restore();
  }
});

test("summarizeCodexSessionUsageByDay buckets by local date", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-e.jsonl", [
      `{"timestamp":"2026-07-27T02:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"a"}}`,
      `{"timestamp":"2026-07-27T02:05:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":1,"cached_input_tokens":0}}}}`,
    ]);
    await writeRollout(home, "2026/07/28/rollout-f.jsonl", [
      `{"timestamp":"2026-07-28T02:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"b"}}`,
    ]);

    // 跨两天范围。
    const daily = await summarizeCodexSessionUsageByDay(
      new Date("2026-07-27T00:00:00Z"),
      new Date("2026-07-28T23:59:59Z"),
    );

    assert.equal(daily.size, 2);
    assert.equal(daily.get("2026-07-27")?.userMessageCount, 1);
    assert.equal(daily.get("2026-07-27")?.inputTokens, 10);
    assert.equal(daily.get("2026-07-28")?.userMessageCount, 1);
    assert.equal(daily.get("2026-07-28")?.inputTokens, 0);
  } finally {
    restore();
  }
});

// 防止上面 DAY 常量未使用告警（保留可读性）。
void DAY;
