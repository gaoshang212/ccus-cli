import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { buildAggregatedDailyRows, buildAggregatedDetailRows, buildAggregatedWeeklyRows, loadWeeklyExportBundles } from "../lib/aggregate";
import { buildAggregatedDailyCsv, buildAggregatedDetailCsv, buildAggregatedWeeklyCsv } from "../lib/export";

/** 构造一个最小可用的 schemaVersion 6 bundle，供 gzip 兼容性测试使用。 */
function buildMinimalBundle(personKey: string) {
  return {
    schemaVersion: 6,
    generatedAt: "2026-05-27T08:00:00.000Z",
    range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
    identity: { gitUserName: personKey, gitUserEmail: `${personKey}@example.com` },
    rawEvents: [
      {
        schemaVersion: 3,
        timestamp: "2026-05-26T01:00:00.000Z",
        gitUserName: personKey,
        gitUserEmail: `${personKey}@example.com`,
        gitUserAccount: personKey,
        rawPayload: {
          session_id: `${personKey}-1`,
          model: { display_name: "Opus" },
          workspace: { current_dir: `/repo/${personKey}` },
          context_window: { used_percentage: 20, used_tokens: 100, max_tokens: 1000 },
          rate_limits: { five_hour: { used_percentage: 10 } },
        },
      },
    ],
    weeklySummary: {
      schemaVersion: 6,
      generatedAt: "2026-05-27T08:00:00.000Z",
      range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
      identity: { gitUserName: personKey, gitUserEmail: `${personKey}@example.com` },
      counts: { userMessageCount: 5, apiRequestCount: 3 },
      tokens: { inputTokens: 1000, outputTokens: 120, cacheReadInputTokens: 50 },
      statusline: { sampleCount: 1, uniqueSessions: 1, uniqueWorkspaces: 1, fiveHourLatestUsagePct: 10, fiveHourPeakUsagePct: 10, sevenDayLatestUsagePct: 30, sevenDayPeakUsagePct: 35 },
      sources: {
        ccusDataDir: "D:/ccus",
        claudeDataDir: "C:/Users/test/.claude",
        projectFilesMatched: 1,
        messageCountSource: "claude-projects:user-events",
        apiRequestCountSource: "claude-projects:assistant-usage-events",
        tokenSource: "claude-projects:assistant-usage-events",
      },
    },
    dailySummaries: [
      {
        date: "2026-05-26",
        userMessageCount: 2,
        apiRequestCount: 1,
        inputTokens: 300,
        outputTokens: 40,
        cacheReadInputTokens: 20,
        sampleCount: 1,
        fiveHourLatestUsagePct: 10,
        fiveHourPeakUsagePct: 10,
        sevenDayLatestUsagePct: 30,
        sevenDayPeakUsagePct: 35,
        uniqueSessions: 1,
        uniqueWorkspaces: 1,
      },
    ],
  };
}

test("aggregate loaders and csv builders support multi-person bundle json input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-"));
  const aliceFile = path.join(root, "alice.json");
  const bobFile = path.join(root, "bob.json");

  try {
    await fs.writeFile(
      aliceFile,
      JSON.stringify(
        {
          schemaVersion: 6,
          generatedAt: "2026-05-27T08:00:00.000Z",
          range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
          identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
          rawEvents: [
            {
              schemaVersion: 2,
              timestamp: "2026-05-26T01:00:00.000Z",
              gitUserName: "alice",
              gitUserEmail: "alice@example.com",
              rawPayload: {
                session_id: "a-1",
                model: { display_name: "Opus" },
                workspace: { current_dir: "/repo/a" },
                context_window: { used_percentage: 20, used_tokens: 100, max_tokens: 1000 },
                rate_limits: { five_hour: { used_percentage: 10 } },
              },
            },
          ],
          weeklySummary: {
            schemaVersion: 6,
            generatedAt: "2026-05-27T08:00:00.000Z",
            range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
            identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
            counts: { userMessageCount: 5, apiRequestCount: 3 },
            tokens: { inputTokens: 1000, outputTokens: 120, cacheReadInputTokens: 50 },
            statusline: { sampleCount: 1, uniqueSessions: 1, uniqueWorkspaces: 1, fiveHourLatestUsagePct: 10, fiveHourPeakUsagePct: 10, sevenDayLatestUsagePct: 30, sevenDayPeakUsagePct: 35 },
            sources: {
              ccusDataDir: "D:/ccus",
              claudeDataDir: "C:/Users/test/.claude",
              projectFilesMatched: 1,
              messageCountSource: "claude-projects:user-events",
              apiRequestCountSource: "claude-projects:assistant-usage-events",
              tokenSource: "claude-projects:assistant-usage-events",
            },
          },
          dailySummaries: [
            {
              date: "2026-05-26",
              userMessageCount: 2,
              apiRequestCount: 1,
              inputTokens: 300,
              outputTokens: 40,
              cacheReadInputTokens: 20,
              sampleCount: 1,
              fiveHourLatestUsagePct: 10,
              fiveHourPeakUsagePct: 10,
              sevenDayLatestUsagePct: 30,
              sevenDayPeakUsagePct: 35,
              uniqueSessions: 1,
              uniqueWorkspaces: 1,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      bobFile,
      JSON.stringify(
        {
          schemaVersion: 6,
          generatedAt: "2026-05-27T08:00:00.000Z",
          range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
          identity: { gitUserName: "bob", gitUserEmail: "bob@example.com" },
          rawEvents: [
            {
              schemaVersion: 2,
              timestamp: "2026-05-27T05:00:00.000Z",
              gitUserName: "bob",
              gitUserEmail: "bob@example.com",
              rawPayload: {
                session_id: "b-1",
                model: { display_name: "Sonnet" },
                workspace: { current_dir: "/repo/b" },
                context_window: { used_percentage: 25, used_tokens: 110, max_tokens: 1000 },
                rate_limits: { five_hour: { used_percentage: 15 } },
              },
            },
          ],
          weeklySummary: {
            schemaVersion: 6,
            generatedAt: "2026-05-27T08:00:00.000Z",
            range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
            identity: { gitUserName: "bob", gitUserEmail: "bob@example.com" },
            counts: { userMessageCount: 4, apiRequestCount: 2 },
            tokens: { inputTokens: 800, outputTokens: 90, cacheReadInputTokens: 30 },
            statusline: { sampleCount: 1, uniqueSessions: 1, uniqueWorkspaces: 1, fiveHourLatestUsagePct: 15, fiveHourPeakUsagePct: 15, sevenDayLatestUsagePct: 45, sevenDayPeakUsagePct: 50 },
            sources: {
              ccusDataDir: "D:/ccus",
              claudeDataDir: "C:/Users/test/.claude",
              projectFilesMatched: 1,
              messageCountSource: "claude-projects:user-events",
              apiRequestCountSource: "claude-projects:assistant-usage-events",
              tokenSource: "claude-projects:assistant-usage-events",
            },
          },
          dailySummaries: [
            {
              date: "2026-05-27",
              userMessageCount: 4,
              apiRequestCount: 2,
              inputTokens: 800,
              outputTokens: 90,
              cacheReadInputTokens: 30,
              sampleCount: 1,
              fiveHourLatestUsagePct: 15,
              fiveHourPeakUsagePct: 15,
              sevenDayLatestUsagePct: 45,
              sevenDayPeakUsagePct: 50,
              uniqueSessions: 1,
              uniqueWorkspaces: 1,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const bundles = await loadWeeklyExportBundles(root);
    const detailRows = buildAggregatedDetailRows(bundles);
    const dailyRows = buildAggregatedDailyRows(bundles);
    const weeklyRows = buildAggregatedWeeklyRows(bundles);
    const detailCsv = buildAggregatedDetailCsv(detailRows);
    const dailyCsv = buildAggregatedDailyCsv(dailyRows);
    const weeklyCsv = buildAggregatedWeeklyCsv(weeklyRows);

    assert.equal(detailRows.length, 2);
    assert.equal(dailyRows.length, 2);
    assert.equal(weeklyRows.length, 2);
    assert.match(detailCsv, /^personKey,timestamp,week,date,sessionId,workspaceName,modelName,fiveHourUsagePct,contextWindowPct,contextUsedM,contextMaxM,inputTokensM,outputTokensM,cacheReadInputTokensM$/m);
    assert.equal(detailCsv.includes("statusLine"), false);
    assert.equal(detailCsv.includes("workspaceDir"), false);
    assert.equal(detailCsv.includes("sourceFile"), false);
    assert.equal(detailCsv.includes("gitUserName"), false);
    assert.equal(detailCsv.includes("gitUserEmail"), false);
    assert.match(detailCsv, /^"alice","2026-05-26T01:00:00\.000Z",/m);
    assert.match(detailCsv, /^"bob","2026-05-27T05:00:00\.000Z",/m);
    // detail 行尾：contextUsedM/contextMaxM 及当天 token（取自 dailySummaries）都换算成 M。
    // alice：contextUsed 100→0.0001，contextMax 1000→0.001，token 300/40/20。
    assert.match(detailCsv, /,0\.0001,0\.001,0\.0003,0\.00004,0\.00002$/m);
    // bob：contextUsed 110→0.00011，contextMax 1000→0.001，token 800/90/30。
    assert.match(detailCsv, /,0\.00011,0\.001,0\.0008,0\.00009,0\.00003$/m);
    assert.match(dailyCsv, /personKey,date,userMessageCount,apiRequestCount,inputTokensM,outputTokensM,cacheReadInputTokensM,sampleCount,fiveHourPeakUsagePct,fiveHourLatestUsagePct,sevenDayPeakUsagePct,sevenDayLatestUsagePct,uniqueSessions,uniqueWorkspaces/);
    assert.match(dailyCsv, /2026-05-26/);
    // alice daily：input 300 → 0.0003，output 40 → 0.00004，cache 20 → 0.00002。
    assert.match(dailyCsv, /,2,1,0\.0003,0\.00004,0\.00002,/);
    assert.match(dailyCsv, /,10,10,35,30,/);
    assert.match(weeklyCsv, /personKey,week,userMessageCount,apiRequestCount,inputTokensM,outputTokensM,cacheReadInputTokensM,sampleCount,fiveHourPeakUsagePct,fiveHourLatestUsagePct,sevenDayPeakUsagePct,sevenDayLatestUsagePct,uniqueSessions,uniqueWorkspaces/);
    // bob weekly：input 800 → 0.0008，output 90 → 0.00009，cache 30 → 0.00003。
    assert.match(weeklyCsv, /,4,2,0\.0008,0\.00009,0\.00003,/);
    assert.match(weeklyCsv, /,15,15,50,45,/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadWeeklyExportBundles reads gzip-compressed .json.gz bundles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-gz-"));
  const gzFile = path.join(root, "carol_export_2026-05-25_to_2026-05-31.json.gz");
  const plainFile = path.join(root, "dave.json");

  try {
    await fs.writeFile(gzFile, gzipSync(`${JSON.stringify(buildMinimalBundle("carol"))}\n`));
    await fs.writeFile(plainFile, JSON.stringify(buildMinimalBundle("dave")), "utf8");

    const bundles = await loadWeeklyExportBundles(root);
    // gzip 与明文 bundle 应同时被识别。
    assert.equal(bundles.length, 2);

    const detailRows = buildAggregatedDetailRows(bundles);
    assert.equal(detailRows.length, 2);
    assert.deepEqual(
      [...new Set(detailRows.map((row) => row.personKey))].sort(),
      ["carol", "dave"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadWeeklyExportBundles rejects old schema bundles explicitly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-old-"));
  const oldFile = path.join(root, "old.json");

  try {
    await fs.writeFile(
      oldFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          generatedAt: "2026-05-27T08:00:00.000Z",
          range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
          identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
          rawEvents: [],
          weeklySummary: {
            schemaVersion: 5,
            generatedAt: "2026-05-27T08:00:00.000Z",
            range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
            identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
            counts: { userMessageCount: 0, apiRequestCount: 0 },
            tokens: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
            statusline: { sampleCount: 0, uniqueSessions: 0, uniqueWorkspaces: 0, fiveHourLatestUsagePct: null, fiveHourPeakUsagePct: null, sevenDayUsagePct: null },
            sources: {
              ccusDataDir: "D:/ccus",
              claudeDataDir: "C:/Users/test/.claude",
              projectFilesMatched: 0,
              messageCountSource: "claude-projects:user-events",
              apiRequestCountSource: "claude-projects:assistant-usage-events",
              tokenSource: "claude-projects:assistant-usage-events",
            },
          },
          dailySummaries: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    await assert.rejects(
      () => loadWeeklyExportBundles(root),
      /schemaVersion 6 bundles/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
