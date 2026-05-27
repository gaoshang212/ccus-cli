import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAggregatedDailyRows, buildAggregatedDetailRows, buildAggregatedWeeklyRows, loadWeeklyExportBundles } from "../lib/aggregate";
import { buildAggregatedDailyCsv, buildAggregatedDetailCsv, buildAggregatedWeeklyCsv } from "../lib/export";

test("aggregate loaders and csv builders support multi-person bundle json input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-"));
  const aliceFile = path.join(root, "alice.json");
  const bobFile = path.join(root, "bob.json");

  try {
    await fs.writeFile(
      aliceFile,
      JSON.stringify(
        {
          schemaVersion: 4,
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
            schemaVersion: 4,
            generatedAt: "2026-05-27T08:00:00.000Z",
            range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
            identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
            counts: { userMessageCount: 5, apiRequestCount: 3 },
            tokens: { inputTokens: 1000, outputTokens: 120, cacheReadInputTokens: 50 },
            statusline: { sampleCount: 1, uniqueSessions: 1, uniqueWorkspaces: 1, fiveHourLatestUsagePct: 10, fiveHourPeakUsagePct: 10, weeklyUsagePct: 30 },
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
              weeklyUsagePct: 30,
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
          schemaVersion: 4,
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
            schemaVersion: 4,
            generatedAt: "2026-05-27T08:00:00.000Z",
            range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
            identity: { gitUserName: "bob", gitUserEmail: "bob@example.com" },
            counts: { userMessageCount: 4, apiRequestCount: 2 },
            tokens: { inputTokens: 800, outputTokens: 90, cacheReadInputTokens: 30 },
            statusline: { sampleCount: 1, uniqueSessions: 1, uniqueWorkspaces: 1, fiveHourLatestUsagePct: 15, fiveHourPeakUsagePct: 15, weeklyUsagePct: 45 },
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
              weeklyUsagePct: 45,
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
    assert.match(detailCsv, /personKey,timestamp,week,date,sourceFile/);
    assert.match(detailCsv, /alice@example.com/);
    assert.match(dailyCsv, /personKey,date,userMessageCount,apiRequestCount,inputTokens,outputTokens,cacheReadInputTokens,sampleCount/);
    assert.match(dailyCsv, /2026-05-26/);
    assert.match(dailyCsv, /,1,1/);
    assert.match(weeklyCsv, /personKey,week,userMessageCount,apiRequestCount,inputTokens,outputTokens,cacheReadInputTokens,sampleCount/);
    assert.match(weeklyCsv, /800/);
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
          schemaVersion: 3,
          generatedAt: "2026-05-27T08:00:00.000Z",
          range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
          identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
          rawEvents: [],
          weeklySummary: {
            schemaVersion: 3,
            generatedAt: "2026-05-27T08:00:00.000Z",
            range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-27T08:00:00.000Z" },
            identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
            counts: { userMessageCount: 0, apiRequestCount: 0 },
            tokens: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
            statusline: { sampleCount: 0, uniqueSessions: 0, uniqueWorkspaces: 0, fiveHourLatestUsagePct: null, fiveHourPeakUsagePct: null, weeklyUsagePct: null },
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
      /schemaVersion 4 bundles/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
