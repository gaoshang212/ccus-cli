import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExportOptions } from "../cli";
import { buildRawJsonl, buildWeeklyExportBundleJson, buildWeeklySummaryJson, writeTextFile } from "../lib/export";
import { computeStatuslineEvent } from "../lib/payload";
import { enumerateDateKeys, formatGitEmailFilePrefix, formatRangeFileLabel } from "../lib/time";
import { PersistedStatuslineEvent, WeeklyExportBundle, WeeklyExportSummary } from "../types";

/** 导出测试使用的基础样本，覆盖两个不同时间点和 workspace。 */
const records: PersistedStatuslineEvent[] = [
  {
    schemaVersion: 2,
    timestamp: "2026-05-26T01:00:00.000Z",
    gitUserName: "alice",
    gitUserEmail: "alice@example.com",
    rawPayload: {
      session_id: "a",
      model: { display_name: "Opus" },
      workspace: { current_dir: "/repo/a" },
      context_window: { used_percentage: 18, used_tokens: 120, max_tokens: 1000 },
      rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 41 } },
    },
  },
  {
    schemaVersion: 2,
    timestamp: "2026-05-26T05:00:00.000Z",
    gitUserName: "bob",
    gitUserEmail: "bob@example.com",
    rawPayload: {
      session_id: "b",
      model: { display_name: "Sonnet" },
      workspace: { current_dir: "/repo/b" },
      context_window: { used_percentage: 31, used_tokens: 280, max_tokens: 1000 },
      rate_limits: { five_hour: { used_percentage: 28 }, seven_day: { used_percentage: 62 } },
    },
  },
];

/** 原始 JSONL 导出应该保留持久化记录本身，而不是把分析字段再写回去。 */
test("buildRawJsonl exports persisted raw records", () => {
  const jsonl = buildRawJsonl(records);

  assert.match(jsonl, /"schemaVersion":2/);
  assert.match(jsonl, /"rawPayload"/);
  assert.equal(jsonl.includes("\"statusLine\""), false);
});

/** 默认导出已切到周汇总 JSON，需要稳定输出关键统计字段。 */
test("buildWeeklySummaryJson renders weekly summary document", () => {
  const summary: WeeklyExportSummary = {
    schemaVersion: 4,
    generatedAt: "2026-05-27T08:00:00.000Z",
    range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
    identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
    counts: { userMessageCount: 12, apiRequestCount: 7 },
    tokens: { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 890 },
      statusline: {
        sampleCount: 5,
        uniqueSessions: 2,
        uniqueWorkspaces: 1,
        fiveHourLatestUsagePct: 28,
        fiveHourPeakUsagePct: 31,
        weeklyUsagePct: 62,
      },
    sources: {
      ccusDataDir: "D:/ccus",
      claudeDataDir: "C:/Users/test/.claude",
      projectFilesMatched: 4,
      messageCountSource: "claude-projects:user-events",
      apiRequestCountSource: "claude-projects:assistant-usage-events",
      tokenSource: "claude-projects:assistant-usage-events",
    },
  };

  const json = buildWeeklySummaryJson(summary);

  assert.match(json, /"userMessageCount": 12/);
  assert.match(json, /"apiRequestCount": 7/);
  assert.match(json, /"cacheReadInputTokens": 890/);
  assert.match(json, /"apiRequestCountSource": "claude-projects:assistant-usage-events"/);
  assert.match(json, /"fiveHourLatestUsagePct": 28/);
  assert.match(json, /"fiveHourPeakUsagePct": 31/);
  assert.match(json, /"weeklyUsagePct": 62/);
});

/** 默认导出文件要同时包含原始事件和按天汇总，避免丢掉明细。 */
test("buildWeeklyExportBundleJson includes raw events and daily summaries", () => {
  const bundle: WeeklyExportBundle = {
    schemaVersion: 4,
    generatedAt: "2026-05-27T08:00:00.000Z",
    range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
    identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
    rawEvents: records,
    weeklySummary: {
      schemaVersion: 4,
      generatedAt: "2026-05-27T08:00:00.000Z",
      range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
      identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
      counts: { userMessageCount: 12, apiRequestCount: 7 },
      tokens: { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 890 },
      statusline: {
        sampleCount: 5,
        uniqueSessions: 2,
        uniqueWorkspaces: 1,
        fiveHourLatestUsagePct: 28,
        fiveHourPeakUsagePct: 31,
        weeklyUsagePct: 62,
      },
      sources: {
        ccusDataDir: "D:/ccus",
        claudeDataDir: "C:/Users/test/.claude",
        projectFilesMatched: 4,
        messageCountSource: "claude-projects:user-events",
        apiRequestCountSource: "claude-projects:assistant-usage-events",
        tokenSource: "claude-projects:assistant-usage-events",
      },
    },
    dailySummaries: [
      {
        date: "2026-05-26",
        userMessageCount: 3,
        apiRequestCount: 2,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 50,
        sampleCount: 2,
        fiveHourLatestUsagePct: 28,
        fiveHourPeakUsagePct: 31,
        weeklyUsagePct: 62,
        uniqueSessions: 2,
        uniqueWorkspaces: 1,
      },
    ],
  };

  const json = buildWeeklyExportBundleJson(bundle);

  assert.match(json, /"rawEvents": \[/);
  assert.match(json, /"dailySummaries": \[/);
  assert.match(json, /"date": "2026-05-26"/);
  assert.match(json, /"uniqueSessions": 2/);
  assert.match(json, /"fiveHourLatestUsagePct": 28/);
  assert.match(json, /"fiveHourPeakUsagePct": 31/);
  assert.match(json, /"weeklyUsagePct": 62/);
});

/** 周导出里的 dailySummaries 应该覆盖整个周范围，而不只是有 statusline 样本的日期。 */
test("enumerateDateKeys covers every local date in weekly range", () => {
  const keys = enumerateDateKeys(new Date("2026-05-25T00:00:00.000Z"), new Date("2026-05-27T08:00:00.000Z"));

  assert.deepEqual(keys, ["2026-05-25", "2026-05-26", "2026-05-27"]);
});

/** 读时计算仍然可用，但不再参与导出格式能力面。 */
test("computed event view is still derivable from persisted raw records", () => {
  const event = computeStatuslineEvent(records[0]);

  assert.equal(event.sessionId, "a");
  assert.equal(event.usagePct, 12);
  assert.equal(event.contextWindowPct, 18);
});

/** 默认导出文件名需要带起止日期，便于直接按文件名识别窗口。 */
test("formatRangeFileLabel renders start and end date keys", () => {
  const label = formatRangeFileLabel(new Date(2026, 4, 25, 10, 0, 0), new Date(2026, 4, 27, 18, 30, 0));

  assert.equal(label, "2026-05-25_to_2026-05-27");
});

/** 默认导出文件名前缀使用 git email 的帐号名，便于区分不同导出人。 */
test("formatGitEmailFilePrefix extracts sanitized account name from email", () => {
  assert.equal(formatGitEmailFilePrefix("Alice.Dev+ops@example.com"), "alice.dev-ops");
  assert.equal(formatGitEmailFilePrefix("...@example.com"), null);
  assert.equal(formatGitEmailFilePrefix("con@example.com"), null);
  assert.equal(formatGitEmailFilePrefix("  "), null);
  assert.equal(formatGitEmailFilePrefix(null), null);
});

/** 默认导出目录不存在时也应该自动创建，避免首次导出失败。 */
test("writeTextFile creates parent directories recursively", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-export-"));
  const outputPath = path.join(root, "nested", "exports", "sample.jsonl");

  try {
    await writeTextFile(outputPath, "hello\nworld");
    const written = await fs.readFile(outputPath, "utf8");
    assert.equal(written, "hello\nworld");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** 旧的 summary 子命令需要明确报错，避免用户误以为仍受支持。 */
test("resolveExportOptions rejects removed export summary subcommand", () => {
  assert.throws(
    () => resolveExportOptions("summary", ["export", "summary"], []),
    /`ccus export summary` has been removed/,
  );
});

/** 旧的 csv/jsonl 位置参数不能再被静默吞掉，否则会让旧脚本产生误判。 */
test("resolveExportOptions rejects legacy positional export arguments", () => {
  assert.throws(
    () => resolveExportOptions("csv", ["export", "csv"], []),
    /Unsupported export argument: csv/,
  );
});
