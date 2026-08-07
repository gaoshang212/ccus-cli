import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findActiveCodexSessionFiles, summarizeCodexSessionUsage, summarizeCodexSessionUsageByDay } from "../lib/codex-sessions";
import { getCodexSessionHomes } from "../lib/paths";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 把 ccus 指向一个临时 CODEX_HOME，返回它和恢复函数。 */
async function withTempCodexHome(prefix: string): Promise<{ home: string; orcaHome: string; restore: () => void }> {
  const home = await mkdtemp(prefix);
  const appData = path.join(home, "appdata");
  const orcaHome = path.join(appData, "orca", "codex-runtime-home", "home");
  const previous = process.env.CODEX_HOME;
  const previousAppData = process.env.APPDATA;
  process.env.CODEX_HOME = home;
  process.env.APPDATA = appData;
  return { home, orcaHome, restore: () => {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
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

test("getCodexSessionHomes keeps ~/.codex when CODEX_HOME points to Orca", async () => {
  const root = await mkdtemp("ccus-codex-session-homes-");
  const appData = path.join(root, "appdata");
  const orcaHome = path.join(appData, "orca", "codex-runtime-home", "home");
  const previousCodexHome = process.env.CODEX_HOME;
  const previousAppData = process.env.APPDATA;
  process.env.CODEX_HOME = orcaHome;
  process.env.APPDATA = appData;

  try {
    assert.deepEqual(getCodexSessionHomes(), [
      path.resolve(os.homedir(), ".codex"),
      path.resolve(orcaHome),
    ]);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }
  }
});

test("summarizeCodexSessionUsage counts task_started distinct turn_id and sums last_token_usage", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-a.jsonl", [
      `{"timestamp":"${ts(37, 48)}","type":"session_meta"}`,
      `{"timestamp":"${ts(37, 48)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}`,
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

test("summarizeCodexSessionUsage excludes guardian rollout usage", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-main.jsonl", [
      `{"timestamp":"${ts(10, 0)}","type":"session_meta","payload":{"source":"vscode"}}`,
      `{"timestamp":"${ts(10, 1)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-main"}}`,
      `{"timestamp":"${ts(10, 2)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":10,"cached_input_tokens":20}}}}`,
    ]);
    await writeRollout(home, "2026/07/27/rollout-guardian.jsonl", [
      `{"timestamp":"${ts(20, 0)}","type":"session_meta","payload":{"source":{"subagent":{"other":"guardian"}}}}`,
      `{"timestamp":"${ts(20, 1)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-guardian"}}`,
      `{"timestamp":"${ts(20, 2)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":900,"output_tokens":90,"cached_input_tokens":200}}}}`,
    ]);

    const summary = await summarizeCodexSessionUsage(RANGE_START, RANGE_END);

    assert.deepEqual(
      {
        userMessageCount: summary.userMessageCount,
        apiRequestCount: summary.apiRequestCount,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cacheReadInputTokens: summary.cacheReadInputTokens,
      },
      {
        userMessageCount: 1,
        apiRequestCount: 1,
        inputTokens: 80,
        outputTokens: 10,
        cacheReadInputTokens: 20,
      },
    );
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

    // 净输入：(1000-0)+(500-50)=1450；累加 last 而非 total（1000+1500=2500）。
    assert.equal(summary.apiRequestCount, 2);
    assert.equal(summary.inputTokens, 1450);
    assert.equal(summary.outputTokens, 15);
    assert.equal(summary.cacheReadInputTokens, 50);
  } finally {
    restore();
  }
});

test("summarizeCodexSessionUsage ignores task_started outside the time window", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-c.jsonl", [
      `{"timestamp":"2026-07-27T02:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-in"}}`,
      `{"timestamp":"2026-07-28T02:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-out"}}`,
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

test("summarizeCodexSessionUsage dedups task_started by turn_id across files", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    // 同一 turn_id（fork/sub-agent/resume 重放）在 3 个文件各出现一次 + 一个不同 turn_id。
    await writeRollout(home, "2026/07/27/rollout-r1.jsonl", [
      `{"timestamp":"${ts(10, 0)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-replay"}}`,
    ]);
    await writeRollout(home, "2026/07/27/rollout-r2.jsonl", [
      `{"timestamp":"${ts(11, 0)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-replay"}}`,
    ]);
    await writeRollout(home, "2026/07/27/rollout-r3.jsonl", [
      `{"timestamp":"${ts(12, 0)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-replay"}}`,
      `{"timestamp":"${ts(12, 30)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-unique"}}`,
    ]);

    const summary = await summarizeCodexSessionUsage(RANGE_START, RANGE_END);

    // 3 份 turn-replay 只算 1 + turn-unique 1 = 2。
    assert.equal(summary.userMessageCount, 2);
  } finally {
    restore();
  }
});

test("Codex session 统计合并 Orca runtime home 并对重复 rollout 去重", async () => {
  const { home, orcaHome, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    const relativePath = "2026/07/27/rollout-shared.jsonl";
    const sharedTask = `{"timestamp":"${ts(10, 0)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-shared"}}`;
    const sharedTokens = `{"timestamp":"${ts(10, 1)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":10,"cached_input_tokens":20}}}}`;
    const orcaTask = `{"timestamp":"${ts(20, 0)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-orca"}}`;
    const orcaTokens = `{"timestamp":"${ts(20, 1)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"output_tokens":20,"cached_input_tokens":50}}}}`;

    await writeRollout(home, relativePath, [sharedTask, sharedTokens]);
    await writeRollout(orcaHome, relativePath, [sharedTask, sharedTokens, orcaTask, orcaTokens]);

    const summary = await summarizeCodexSessionUsage(RANGE_START, RANGE_END);
    assert.deepEqual(
      {
        userMessageCount: summary.userMessageCount,
        apiRequestCount: summary.apiRequestCount,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cacheReadInputTokens: summary.cacheReadInputTokens,
        matchedFileCount: summary.matchedFileCount,
      },
      {
        userMessageCount: 2,
        apiRequestCount: 2,
        inputTokens: 230,
        outputTokens: 30,
        cacheReadInputTokens: 70,
        matchedFileCount: 1,
      },
    );

    const daily = await summarizeCodexSessionUsageByDay(RANGE_START, RANGE_END);
    assert.deepEqual(daily.get(DAY), {
      date: DAY,
      userMessageCount: 2,
      apiRequestCount: 2,
      inputTokens: 230,
      outputTokens: 30,
      cacheReadInputTokens: 70,
    });

    const active = await findActiveCodexSessionFiles(RANGE_START, RANGE_END);
    assert.equal(active.length, 1);
    assert.equal(active[0].relativePath.replaceAll("\\", "/"), relativePath);
    assert.equal(active[0].content.trim().split(/\r?\n/).length, 4);
  } finally {
    restore();
  }
});

test("summarizeCodexSessionUsageByDay buckets task_started by local date", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-e.jsonl", [
      `{"timestamp":"2026-07-27T02:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-a"}}`,
      `{"timestamp":"2026-07-27T02:05:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":1,"cached_input_tokens":0}}}}`,
    ]);
    await writeRollout(home, "2026/07/28/rollout-f.jsonl", [
      `{"timestamp":"2026-07-28T02:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-b"}}`,
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

test("summarizeCodexSessionUsageByDay excludes guardian rollout usage", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    await writeRollout(home, "2026/07/27/rollout-main-daily.jsonl", [
      `{"timestamp":"${ts(10, 0)}","type":"session_meta","payload":{"source":"vscode"}}`,
      `{"timestamp":"${ts(10, 1)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-main"}}`,
      `{"timestamp":"${ts(10, 2)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":10,"cached_input_tokens":20}}}}`,
    ]);
    await writeRollout(home, "2026/07/27/rollout-guardian-daily.jsonl", [
      `{"timestamp":"${ts(20, 0)}","type":"session_meta","payload":{"source":{"subagent":{"other":"guardian"}}}}`,
      `{"timestamp":"${ts(20, 1)}","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-guardian"}}`,
      `{"timestamp":"${ts(20, 2)}","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":900,"output_tokens":90,"cached_input_tokens":200}}}}`,
    ]);

    const daily = await summarizeCodexSessionUsageByDay(RANGE_START, RANGE_END);

    assert.deepEqual(daily.get(DAY), {
      date: DAY,
      userMessageCount: 1,
      apiRequestCount: 1,
      inputTokens: 80,
      outputTokens: 10,
      cacheReadInputTokens: 20,
    });
  } finally {
    restore();
  }
});

test("summarizeCodexSessionUsageByDay dedups task_started by turn_id and buckets by earliest timestamp", async () => {
  const { home, restore } = await withTempCodexHome("ccus-codex-sessions-");
  try {
    // turn-replay 真实发生在 07-27，重放副本（更晚 timestamp）在 07-28 → 只算 1 且归到最早 timestamp 的本地日 07-27。
    await writeRollout(home, "2026/07/27/rollout-g1.jsonl", [
      `{"timestamp":"2026-07-27T02:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-replay"}}`,
    ]);
    await writeRollout(home, "2026/07/28/rollout-g2.jsonl", [
      `{"timestamp":"2026-07-28T02:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-replay"}}`,
    ]);

    const daily = await summarizeCodexSessionUsageByDay(
      new Date("2026-07-27T00:00:00Z"),
      new Date("2026-07-28T23:59:59Z"),
    );

    // 去重后 1 个 turn，归到最早 timestamp 的本地日 07-27；07-28 无 token_count 故无 entry。
    assert.equal(daily.get("2026-07-27")?.userMessageCount, 1);
    assert.equal(daily.get("2026-07-28")?.userMessageCount, undefined);
  } finally {
    restore();
  }
});

// 防止上面 DAY 常量未使用告警（保留可读性）。
void DAY;
