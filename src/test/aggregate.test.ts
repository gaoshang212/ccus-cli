import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { buildAggregatedDailyRows, buildAggregatedDetailRows, buildAggregatedWeeklyRows, buildPersonSevenDayCurve, buildSevenDayCurveFromEvents, computeCumulativeSevenDay, deburrSevenDayEvents, loadWeeklyExportBundles } from "../lib/aggregate";
import { buildAggregatedDailyCsv, buildAggregatedDetailCsv, buildAggregatedWeeklyCsv } from "../lib/export";
import { StatuslineEvent } from "../types";

/** 构造一个最小可用的 schemaVersion 6 bundle，供 gzip 兼容性测试使用。 */
function buildMinimalBundle(personKey: string) {
  return {
    schemaVersion: 7,
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
      schemaVersion: 7,
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

function apiCost(estimatedUsd: number | null, pricedApiRequestCount: number, unpricedApiRequestCount: number) {
  return { estimatedUsd, pricedApiRequestCount, unpricedApiRequestCount };
}

/** 把单日旧版测试 bundle 升为结构完整的 v10，便于覆盖严格校验和成本聚合。 */
function upgradeBundleToV10(
  bundle: ReturnType<typeof buildMinimalBundle> | ReturnType<typeof buildBundleForMerge>,
  options: { catalogVersion?: string; estimatedUsd?: number | null; priced?: number; unpriced?: number } = {},
) {
  const catalogVersion = options.catalogVersion ?? "catalog-a";
  const estimatedUsd = options.estimatedUsd === undefined ? 0.25 : options.estimatedUsd;
  const priced = options.priced ?? 1;
  const unpriced = options.unpriced ?? 0;
  const claude = apiCost(estimatedUsd, priced, unpriced);
  const codex = apiCost(0, 0, 0);
  const total = apiCost(estimatedUsd, priced, unpriced);
  const breakdown = { claude, codex, total };

  const upgraded = bundle as any;
  upgraded.schemaVersion = 10;
  upgraded.pricing = { catalogVersion, currency: "USD", basis: "event-time-standard-api" };
  upgraded.weeklySummary.schemaVersion = 10;
  upgraded.weeklySummary.apiEquivalentCost = breakdown;
  for (const day of upgraded.dailySummaries) {
    day.apiEquivalentCost = breakdown;
  }
  return upgraded;
}

/** 含 Claude + Codex 混合事件的 v8 bundle，用于验证 source 分流（Claude usage 与 Codex 额度各算各的）。 */
function buildMixedBundle() {
  const makeEvent = (timestamp: string, five: number, seven: number, codex: boolean) => ({
    schemaVersion: 3,
    timestamp,
    gitUserName: "alice",
    gitUserEmail: "alice@example.com",
    gitUserAccount: "alice",
    rawPayload: codex
      ? { source: "codex", rate_limits: { five_hour: { used_percentage: five }, seven_day: { used_percentage: seven } } }
      : { session_id: "a-1", rate_limits: { five_hour: { used_percentage: five }, seven_day: { used_percentage: seven } } },
  });
  return {
    schemaVersion: 8,
    generatedAt: "2026-05-27T08:00:00.000Z",
    range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-31T00:00:00.000Z" },
    identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
    rawEvents: [
      makeEvent("2026-05-26T01:00:00.000Z", 80, 90, false),
      makeEvent("2026-05-26T02:00:00.000Z", 30, 40, true),
    ],
    weeklySummary: {
      schemaVersion: 8,
      generatedAt: "2026-05-27T08:00:00.000Z",
      range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-31T00:00:00.000Z" },
      identity: { gitUserName: "alice", gitUserEmail: "alice@example.com" },
      counts: { userMessageCount: 1, apiRequestCount: 1 },
      tokens: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5 },
      codex: { userMessageCount: 0, apiRequestCount: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, fiveHourPeakUsagePct: null, fiveHourLatestUsagePct: null, sevenDayPeakUsagePct: null, sevenDayLatestUsagePct: null },
      statusline: { sampleCount: 1, uniqueSessions: 1, uniqueWorkspaces: 1, fiveHourLatestUsagePct: 80, fiveHourPeakUsagePct: 80, sevenDayLatestUsagePct: 90, sevenDayPeakUsagePct: 90 },
      sources: { ccusDataDir: "D:/ccus", claudeDataDir: "C:/Users/test/.claude", projectFilesMatched: 1, messageCountSource: "claude-projects:user-events", apiRequestCountSource: "claude-projects:assistant-usage-events", tokenSource: "claude-projects:assistant-usage-events" },
    },
    dailySummaries: [
      {
        date: "2026-05-26",
        userMessageCount: 1,
        apiRequestCount: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 5,
        sampleCount: 1,
        fiveHourLatestUsagePct: 80,
        fiveHourPeakUsagePct: 80,
        sevenDayLatestUsagePct: 90,
        sevenDayPeakUsagePct: 90,
        uniqueSessions: 1,
        uniqueWorkspaces: 1,
        codex: { userMessageCount: 0, apiRequestCount: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, fiveHourPeakUsagePct: null, fiveHourLatestUsagePct: null, sevenDayPeakUsagePct: null, sevenDayLatestUsagePct: null },
      },
    ],
  };
}

/** Claude 与 Codex 事件混在同一 bundle 时，usage 必须按 source 分流，不能把 codex 额度算进 claude usage。 */
test("aggregate separates claude and codex usage by source", () => {
  const bundles = [{ filePath: "mixed.json", bundle: buildMixedBundle() as any }];
  const daily = buildAggregatedDailyRows(bundles);
  assert.equal(daily.length, 1);
  // Claude usage 只算 claude 事件（80/90），不含 codex 的 30/40。
  assert.equal(daily[0].fiveHourPeakUsagePct, 80);
  assert.equal(daily[0].sevenDayPeakUsagePct, 90);
  // detail 行保留两类事件，source 标记正确；codex 行 token 留 0（无单事件 token 语义）。
  const detail = buildAggregatedDetailRows(bundles);
  assert.equal(detail.length, 2);
  const claudeRow = detail.find((row) => row.source === "claude");
  const codexRow = detail.find((row) => row.source === "codex");
  assert.equal(claudeRow?.usagePct, 80);
  assert.equal(codexRow?.usagePct, 30);
  assert.equal(codexRow?.inputTokens, 0);
});

/** aggregate 接受 schemaVersion 6/7/8/9/10 的 bundle（向后兼容旧导出）。 */
test("loadWeeklyExportBundles accepts schemaVersion 6/7/8/9/10 bundles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-versions-"));
  try {
    for (const sv of [6, 7, 8, 9, 10]) {
      const b = buildMinimalBundle(`p${sv}`);
      if (sv === 10) {
        upgradeBundleToV10(b);
      } else {
        b.schemaVersion = sv;
        b.weeklySummary.schemaVersion = sv;
      }
      await fs.writeFile(path.join(root, `p${sv}.json`), JSON.stringify(b), "utf8");
    }
    const bundles = await loadWeeklyExportBundles(root);
    assert.equal(bundles.length, 5);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loadWeeklyExportBundles rejects v10 missing pricing or daily cost", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-v10-invalid-"));
  try {
    const missingPricing = buildMinimalBundle("missing-pricing");
    missingPricing.schemaVersion = 10;
    missingPricing.weeklySummary.schemaVersion = 10;
    await fs.writeFile(path.join(root, "missing-pricing.json"), JSON.stringify(missingPricing), "utf8");

    const missingDailyCost = upgradeBundleToV10(buildMinimalBundle("missing-daily"));
    delete (missingDailyCost.dailySummaries[0] as any).apiEquivalentCost;
    await fs.writeFile(path.join(root, "missing-daily.json"), JSON.stringify(missingDailyCost), "utf8");

    await assert.rejects(
      () => loadWeeklyExportBundles(root),
      /schemaVersion 6\/7\/8\/9\/10 bundles/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("aggregate loaders and csv builders support multi-person bundle json input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-"));
  const aliceFile = path.join(root, "alice.json");
  const bobFile = path.join(root, "bob.json");

  try {
    await fs.writeFile(
      aliceFile,
      JSON.stringify(
        {
          schemaVersion: 7,
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
            schemaVersion: 7,
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
          schemaVersion: 7,
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
            schemaVersion: 7,
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
    assert.match(detailCsv, /^personKey,timestamp,week,date,sessionId,workspaceName,modelName,source,fiveHourUsagePct,contextWindowPct,contextUsedM,contextMaxM,inputTokensM,outputTokensM,cacheReadInputTokensM$/m);
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
    assert.match(dailyCsv, /^personKey,date,userMessageCount,apiRequestCount,inputTokensM,outputTokensM,cacheReadInputTokensM,sampleCount,fiveHourPeakUsagePct,fiveHourLatestUsagePct,sevenDayPeakUsagePct,sevenDayLatestUsagePct,sevenDayCumulativeUsagePct,uniqueSessions,uniqueWorkspaces,estimatedApiEquivalentCostUsd,pricingCatalogVersion$/m);
    assert.match(dailyCsv, /2026-05-26/);
    // alice daily：input 300 → 0.0003，output 40 → 0.00004，cache 20 → 0.00002。
    assert.match(dailyCsv, /,2,1,0\.0003,0\.00004,0\.00002,/);
    assert.match(dailyCsv, /,1,1,,$/m);
    assert.match(dailyCsv, /,10,10,35,30,/);
    assert.match(weeklyCsv, /^personKey,week,userMessageCount,apiRequestCount,inputTokensM,outputTokensM,cacheReadInputTokensM,sampleCount,fiveHourPeakUsagePct,fiveHourLatestUsagePct,sevenDayPeakUsagePct,sevenDayLatestUsagePct,sevenDayCumulativeUsagePct,uniqueSessions,uniqueWorkspaces,estimatedApiEquivalentCostUsd,pricingCatalogVersion$/m);
    // bob weekly：input 800 → 0.0008，output 90 → 0.00009，cache 30 → 0.00003。
    assert.match(weeklyCsv, /,4,2,0\.0008,0\.00009,0\.00003,/);
    assert.match(weeklyCsv, /,1,1,,$/m);
    assert.match(weeklyCsv, /,15,15,50,45,/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 构造同一周、可调 generatedAt / 当天指标的单人 bundle，
 * 用于验证「同一个人多台电脑导出」时的合并叠加 / 同机去重。
 *
 * sessionId 控制机器识别逻辑：
 * - 同机多次导出：两份 bundle 共享同一 sessionId（模拟同一 session 在两次导出里都出现）→ 去重取最优
 * - 不同机器：两份 bundle 使用不同的 sessionId → 叠加
 */
function buildBundleForMerge(options: {
  personKey: string;
  generatedAt: string;
  date: string;
  eventTimestamp: string;
  userMessageCount: number;
  inputTokens: number;
  fiveHour: number;
  sessionId?: string;
}) {
  const { personKey, generatedAt, date, eventTimestamp, userMessageCount, inputTokens, fiveHour, sessionId } = options;
  return {
    schemaVersion: 7,
    generatedAt,
    range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-31T23:59:59.999Z" },
    identity: { gitUserName: personKey, gitUserEmail: `${personKey}@example.com` },
    rawEvents: [
      {
        schemaVersion: 3,
        timestamp: eventTimestamp,
        gitUserName: personKey,
        gitUserEmail: `${personKey}@example.com`,
        gitUserAccount: personKey,
        rawPayload: {
          session_id: sessionId ?? `${personKey}-${generatedAt}`,
          model: { display_name: "Opus" },
          workspace: { current_dir: `/repo/${personKey}` },
          context_window: { used_percentage: 20, used_tokens: 100, max_tokens: 1000 },
          rate_limits: { five_hour: { used_percentage: fiveHour } },
        },
      },
    ],
    weeklySummary: {
      schemaVersion: 7,
      generatedAt,
      range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-31T23:59:59.999Z" },
      identity: { gitUserName: personKey, gitUserEmail: `${personKey}@example.com` },
      counts: { userMessageCount, apiRequestCount: 1 },
      tokens: { inputTokens, outputTokens: 10, cacheReadInputTokens: 5 },
      statusline: { sampleCount: 1, uniqueSessions: 1, uniqueWorkspaces: 1, fiveHourLatestUsagePct: fiveHour, fiveHourPeakUsagePct: fiveHour, sevenDayLatestUsagePct: null, sevenDayPeakUsagePct: null },
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
        date,
        userMessageCount,
        apiRequestCount: 1,
        inputTokens,
        outputTokens: 10,
        cacheReadInputTokens: 5,
        sampleCount: 1,
        fiveHourLatestUsagePct: fiveHour,
        fiveHourPeakUsagePct: fiveHour,
        sevenDayLatestUsagePct: null,
        sevenDayPeakUsagePct: null,
        uniqueSessions: 1,
        uniqueWorkspaces: 1,
      },
    ],
  };
}

test("aggregate maps v10 cost and legacy request coverage on daily/weekly rows", () => {
  const v10 = upgradeBundleToV10(buildBundleForMerge({
    personKey: "cost-v10",
    generatedAt: "2026-05-27T08:00:00.000Z",
    date: "2026-05-26",
    eventTimestamp: "2026-05-26T01:00:00.000Z",
    userMessageCount: 2,
    inputTokens: 300,
    fiveHour: 10,
  }), { estimatedUsd: 0.75, priced: 1 });
  const v10Detail = buildAggregatedDetailRows([{ filePath: "v10.json", bundle: v10 as any }]);
  const v10Daily = buildAggregatedDailyRows([{ filePath: "v10.json", bundle: v10 as any }]);
  const v10Weekly = buildAggregatedWeeklyRows([{ filePath: "v10.json", bundle: v10 as any }]);
  assert.match(
    buildAggregatedDetailCsv(v10Detail),
    /^personKey,timestamp,week,date,sessionId,workspaceName,modelName,source,fiveHourUsagePct,contextWindowPct,contextUsedM,contextMaxM,inputTokensM,outputTokensM,cacheReadInputTokensM$/m,
  );
  assert.equal(buildAggregatedDetailCsv(v10Detail).includes("ApiEquivalentCost"), false);
  assert.deepEqual(
    [v10Daily[0].estimatedApiEquivalentCostUsd, v10Daily[0].pricedApiRequestCount, v10Daily[0].unpricedApiRequestCount, v10Daily[0].pricingCatalogVersion],
    [0.75, 1, 0, "catalog-a"],
  );
  assert.deepEqual(
    [v10Weekly[0].estimatedApiEquivalentCostUsd, v10Weekly[0].pricedApiRequestCount, v10Weekly[0].unpricedApiRequestCount, v10Weekly[0].pricingCatalogVersion],
    [0.75, 1, 0, "catalog-a"],
  );

  const legacy = buildBundleForMerge({ personKey: "cost-old", generatedAt: "2026-05-27T08:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T01:00:00.000Z", userMessageCount: 2, inputTokens: 300, fiveHour: 10 });
  const legacyDaily = buildAggregatedDailyRows([{ filePath: "old.json", bundle: legacy as any }]);
  const legacyWeekly = buildAggregatedWeeklyRows([{ filePath: "old.json", bundle: legacy as any }]);
  assert.deepEqual(
    [legacyDaily[0].estimatedApiEquivalentCostUsd, legacyDaily[0].pricedApiRequestCount, legacyDaily[0].unpricedApiRequestCount, legacyDaily[0].pricingCatalogVersion],
    [null, 0, 1, null],
  );
  assert.deepEqual(
    [legacyWeekly[0].estimatedApiEquivalentCostUsd, legacyWeekly[0].pricedApiRequestCount, legacyWeekly[0].unpricedApiRequestCount, legacyWeekly[0].pricingCatalogVersion],
    [null, 0, 1, null],
  );

  legacy.dailySummaries[0].apiRequestCount = 0;
  const emptyLegacyDaily = buildAggregatedDailyRows([{ filePath: "old-empty.json", bundle: legacy as any }]);
  const emptyLegacyWeekly = buildAggregatedWeeklyRows([{ filePath: "old-empty.json", bundle: legacy as any }]);
  assert.deepEqual(
    [emptyLegacyDaily[0].estimatedApiEquivalentCostUsd, emptyLegacyDaily[0].pricedApiRequestCount, emptyLegacyDaily[0].unpricedApiRequestCount, emptyLegacyDaily[0].pricingCatalogVersion],
    [0, 0, 0, null],
  );
  assert.deepEqual(
    [emptyLegacyWeekly[0].estimatedApiEquivalentCostUsd, emptyLegacyWeekly[0].pricedApiRequestCount, emptyLegacyWeekly[0].unpricedApiRequestCount, emptyLegacyWeekly[0].pricingCatalogVersion],
    [0, 0, 0, null],
  );
});

test("aggregate preserves known v10 cost and resolves mixed schema/catalog versions", () => {
  const v10 = upgradeBundleToV10(buildBundleForMerge({ personKey: "mix", generatedAt: "2026-05-27T08:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T01:00:00.000Z", userMessageCount: 2, inputTokens: 300, fiveHour: 10, sessionId: "mix-v10" }), { estimatedUsd: 0.4, priced: 1 });
  const legacy = buildBundleForMerge({ personKey: "mix", generatedAt: "2026-05-27T09:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T02:00:00.000Z", userMessageCount: 1, inputTokens: 100, fiveHour: 20, sessionId: "mix-old" });
  const bundles = [{ filePath: "v10.json", bundle: v10 as any }, { filePath: "old.json", bundle: legacy as any }];
  const daily = buildAggregatedDailyRows(bundles);
  const weekly = buildAggregatedWeeklyRows(bundles);
  assert.deepEqual(
    [daily[0].estimatedApiEquivalentCostUsd, daily[0].pricedApiRequestCount, daily[0].unpricedApiRequestCount, daily[0].pricingCatalogVersion],
    [0.4, 1, 1, "mixed"],
  );
  assert.deepEqual(
    [weekly[0].estimatedApiEquivalentCostUsd, weekly[0].pricedApiRequestCount, weekly[0].unpricedApiRequestCount, weekly[0].pricingCatalogVersion],
    [0.4, 1, 1, "mixed"],
  );

  legacy.dailySummaries[0].apiRequestCount = 0;
  const withEmptyLegacy = buildAggregatedDailyRows(bundles);
  assert.equal(withEmptyLegacy[0].pricingCatalogVersion, "catalog-a");
  assert.equal(withEmptyLegacy[0].unpricedApiRequestCount, 0);

  const zeroA = upgradeBundleToV10(buildBundleForMerge({ personKey: "zero-mix", generatedAt: "2026-05-27T08:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T01:00:00.000Z", userMessageCount: 1, inputTokens: 0, fiveHour: 10, sessionId: "zero-a" }), { catalogVersion: "catalog-a", estimatedUsd: 0, priced: 0 });
  const zeroB = upgradeBundleToV10(buildBundleForMerge({ personKey: "zero-mix", generatedAt: "2026-05-27T09:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T02:00:00.000Z", userMessageCount: 1, inputTokens: 0, fiveHour: 20, sessionId: "zero-b" }), { catalogVersion: "catalog-b", estimatedUsd: 0, priced: 0 });
  zeroA.dailySummaries[0].apiRequestCount = 0;
  zeroB.dailySummaries[0].apiRequestCount = 0;
  const zeroMixed = buildAggregatedDailyRows([{ filePath: "a.json", bundle: zeroA as any }, { filePath: "b.json", bundle: zeroB as any }]);
  assert.deepEqual(
    [zeroMixed[0].estimatedApiEquivalentCostUsd, zeroMixed[0].pricedApiRequestCount, zeroMixed[0].unpricedApiRequestCount, zeroMixed[0].pricingCatalogVersion],
    [0, 0, 0, "mixed"],
  );
});

test("aggregate same-machine repeated export: deduplicates by shared sessionId, keeps best", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-dedup-"));
  try {
    // 同一个人 erin、同一台机器、同一天导出两次（上午 2 条 / 下午 9 条）。
    // 两份 bundle 共享同一个 sessionId（同一机器的同一 session 在两次导出里都存在），
    // 视为同机器重复导出 → 取最优（msgs 多的 b，9 条），不相加成 11 条。
    const earlier = upgradeBundleToV10(buildBundleForMerge({ personKey: "erin", generatedAt: "2026-05-27T08:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T01:00:00.000Z", userMessageCount: 2, inputTokens: 300, fiveHour: 10, sessionId: "erin-machine-a" }), { estimatedUsd: 0.2 });
    const later = upgradeBundleToV10(buildBundleForMerge({ personKey: "erin", generatedAt: "2026-05-27T20:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T09:00:00.000Z", userMessageCount: 9, inputTokens: 999, fiveHour: 42, sessionId: "erin-machine-a" }), { estimatedUsd: 0.9 });
    await fs.writeFile(
      path.join(root, "erin_a.json"),
      JSON.stringify(earlier),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "erin_b.json"),
      JSON.stringify(later),
      "utf8",
    );

    const bundles = await loadWeeklyExportBundles(root);
    const detailRows = buildAggregatedDetailRows(bundles);
    const dailyRows = buildAggregatedDailyRows(bundles);
    const weeklyRows = buildAggregatedWeeklyRows(bundles);

    // 同机同天合并为一行，不重复。
    assert.equal(dailyRows.length, 1);
    assert.equal(weeklyRows.length, 1);
    assert.equal(detailRows.length, 1);

    // 取消息数更多（erin_b，9 条）那份，不相加成 11。
    assert.equal(dailyRows[0].userMessageCount, 9);
    assert.equal(dailyRows[0].inputTokens, 999);
    // usage 从代表的 rawEvents 重算（5h=42）。
    assert.equal(dailyRows[0].fiveHourPeakUsagePct, 42);
    assert.equal(dailyRows[0].fiveHourLatestUsagePct, 42);
    assert.equal(weeklyRows[0].userMessageCount, 9);
    assert.equal(weeklyRows[0].fiveHourPeakUsagePct, 42);
    assert.equal(dailyRows[0].estimatedApiEquivalentCostUsd, 0.9);
    assert.equal(weeklyRows[0].estimatedApiEquivalentCostUsd, 0.9);
    // detail 只来自代表那一条事件。
    assert.equal(detailRows[0].timestamp, "2026-05-26T09:00:00.000Z");
    assert.equal(detailRows[0].inputTokens, 999);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("aggregate repeated exports without sessionId: keeps one fallback representative", () => {
  const earlier = upgradeBundleToV10(buildBundleForMerge({ personKey: "empty-session", generatedAt: "2026-05-27T08:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T01:00:00.000Z", userMessageCount: 2, inputTokens: 300, fiveHour: 10 }), { estimatedUsd: 0.2 });
  const later = upgradeBundleToV10(buildBundleForMerge({ personKey: "empty-session", generatedAt: "2026-05-27T20:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T09:00:00.000Z", userMessageCount: 9, inputTokens: 999, fiveHour: 42 }), { estimatedUsd: 0.9 });
  delete earlier.rawEvents[0].rawPayload.session_id;
  delete later.rawEvents[0].rawPayload.session_id;
  const bundles = [
    { filePath: "empty-session-a.json", bundle: earlier as any },
    { filePath: "empty-session-b.json", bundle: later as any },
  ];

  const detailRows = buildAggregatedDetailRows(bundles);
  const dailyRows = buildAggregatedDailyRows(bundles);
  const weeklyRows = buildAggregatedWeeklyRows(bundles);

  assert.equal(detailRows.length, 1);
  assert.equal(dailyRows[0].userMessageCount, 9);
  assert.equal(dailyRows[0].inputTokens, 999);
  assert.equal(dailyRows[0].estimatedApiEquivalentCostUsd, 0.9);
  assert.equal(weeklyRows[0].userMessageCount, 9);
  assert.equal(weeklyRows[0].estimatedApiEquivalentCostUsd, 0.9);
});

test("aggregate sessionId bridge merges all transitively connected exports", () => {
  const first = upgradeBundleToV10(buildBundleForMerge({ personKey: "bridge", generatedAt: "2026-05-27T08:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T01:00:00.000Z", userMessageCount: 2, inputTokens: 200, fiveHour: 10, sessionId: "session-a" }), { estimatedUsd: 0.2 });
  const second = upgradeBundleToV10(buildBundleForMerge({ personKey: "bridge", generatedAt: "2026-05-27T09:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T02:00:00.000Z", userMessageCount: 3, inputTokens: 300, fiveHour: 20, sessionId: "session-b" }), { estimatedUsd: 0.3 });
  const bridge = upgradeBundleToV10(buildBundleForMerge({ personKey: "bridge", generatedAt: "2026-05-27T10:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T03:00:00.000Z", userMessageCount: 9, inputTokens: 900, fiveHour: 40, sessionId: "session-a" }), { estimatedUsd: 0.9 });
  bridge.rawEvents.push({
    ...bridge.rawEvents[0],
    timestamp: "2026-05-26T03:01:00.000Z",
    rawPayload: { ...bridge.rawEvents[0].rawPayload, session_id: "session-b" },
  });
  const bundles = [
    { filePath: "bridge-a.json", bundle: first as any },
    { filePath: "bridge-b.json", bundle: second as any },
    { filePath: "bridge-link.json", bundle: bridge as any },
  ];

  const detailRows = buildAggregatedDetailRows(bundles);
  const dailyRows = buildAggregatedDailyRows(bundles);
  const weeklyRows = buildAggregatedWeeklyRows(bundles);

  assert.equal(detailRows.length, 2);
  assert.equal(dailyRows[0].userMessageCount, 9);
  assert.equal(dailyRows[0].inputTokens, 900);
  assert.equal(dailyRows[0].estimatedApiEquivalentCostUsd, 0.9);
  assert.equal(weeklyRows[0].userMessageCount, 9);
  assert.equal(weeklyRows[0].estimatedApiEquivalentCostUsd, 0.9);
});

test("aggregate same day different machines: stacks up independently", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-stack-"));
  try {
    // 同一个人同一天，tj 机器（msgs=111，sessionId 独立）和 tj2 机器（msgs=3，sessionId 独立）。
    // sessionId 集合不相交 → 视为不同机器 → 叠加 → msgs=114。
    const machineA = upgradeBundleToV10(buildBundleForMerge({ personKey: "user", generatedAt: "2026-05-27T15:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T10:00:00.000Z", userMessageCount: 111, inputTokens: 5000, fiveHour: 60, sessionId: "user-session-tj" }), { estimatedUsd: 0.5 });
    const machineB = upgradeBundleToV10(buildBundleForMerge({ personKey: "user", generatedAt: "2026-05-27T17:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T16:00:00.000Z", userMessageCount: 3, inputTokens: 100, fiveHour: 20, sessionId: "user-session-tj2" }), { estimatedUsd: 0.1 });
    await fs.writeFile(
      path.join(root, "user_tj.json"),
      JSON.stringify(machineA),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "user_tj2.json"),
      JSON.stringify(machineB),
      "utf8",
    );

    const bundles = await loadWeeklyExportBundles(root);
    const dailyRows = buildAggregatedDailyRows(bundles);
    const weeklyRows = buildAggregatedWeeklyRows(bundles);

    assert.equal(dailyRows.length, 1);
    assert.equal(weeklyRows.length, 1);
    // 叠加：111+3=114，5000+100=5100，usage peak = max(60,20)=60。
    assert.equal(dailyRows[0].userMessageCount, 114);
    assert.equal(dailyRows[0].inputTokens, 5100);
    assert.equal(dailyRows[0].fiveHourPeakUsagePct, 60);
    assert.equal(weeklyRows[0].userMessageCount, 114);
    assert.equal(dailyRows[0].estimatedApiEquivalentCostUsd, 0.6);
    assert.equal(dailyRows[0].pricedApiRequestCount, 2);
    assert.equal(weeklyRows[0].estimatedApiEquivalentCostUsd, 0.6);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("aggregate stacks codex counts/usage into claude main fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-codex-stack-"));
  try {
    // 一台机器：claude msgs=5 / codex msgs=3；claude 5h=40、codex 5h=30。
    // 累加量相加：msgs=8、tokens=150；额度 peak=max(40,30)=40、latest=40+30=70。
    const bundle = {
      schemaVersion: 8,
      generatedAt: "2026-05-27T08:00:00.000Z",
      range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-31T23:59:59.999Z" },
      identity: { gitUserName: "zoe", gitUserEmail: "zoe@example.com" },
      rawEvents: [
        {
          schemaVersion: 3,
          timestamp: "2026-05-26T01:00:00.000Z",
          gitUserName: "zoe",
          gitUserEmail: "zoe@example.com",
          gitUserAccount: "zoe",
          rawPayload: {
            session_id: "zoe-claude",
            model: { display_name: "Opus" },
            workspace: { current_dir: "/repo/zoe" },
            rate_limits: { five_hour: { used_percentage: 40 } },
          },
        },
        {
          schemaVersion: 3,
          timestamp: "2026-05-26T02:00:00.000Z",
          gitUserName: "zoe",
          gitUserEmail: "zoe@example.com",
          gitUserAccount: "zoe",
          rawPayload: {
            source: "codex",
            session_id: "zoe-codex",
            rate_limits: { five_hour: { used_percentage: 30 } },
          },
        },
      ],
      weeklySummary: {
        schemaVersion: 8,
        generatedAt: "2026-05-27T08:00:00.000Z",
        range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-31T23:59:59.999Z" },
        identity: { gitUserName: "zoe", gitUserEmail: "zoe@example.com" },
        counts: { userMessageCount: 5, apiRequestCount: 1 },
        tokens: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5 },
        codex: { userMessageCount: 3, apiRequestCount: 1, inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 2, fiveHourPeakUsagePct: 30, fiveHourLatestUsagePct: 30, sevenDayPeakUsagePct: null, sevenDayLatestUsagePct: null },
        statusline: { sampleCount: 1, uniqueSessions: 1, uniqueWorkspaces: 1, fiveHourLatestUsagePct: 40, fiveHourPeakUsagePct: 40, sevenDayLatestUsagePct: null, sevenDayPeakUsagePct: null },
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
          userMessageCount: 5,
          apiRequestCount: 1,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 5,
          sampleCount: 1,
          fiveHourLatestUsagePct: 40,
          fiveHourPeakUsagePct: 40,
          sevenDayLatestUsagePct: null,
          sevenDayPeakUsagePct: null,
          uniqueSessions: 1,
          uniqueWorkspaces: 1,
          codex: { userMessageCount: 3, apiRequestCount: 1, inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 2, fiveHourPeakUsagePct: 30, fiveHourLatestUsagePct: 30, sevenDayPeakUsagePct: null, sevenDayLatestUsagePct: null },
        },
      ],
    };
    await fs.writeFile(path.join(root, "zoe.json"), JSON.stringify(bundle), "utf8");

    const bundles = await loadWeeklyExportBundles(root);
    const dailyRows = buildAggregatedDailyRows(bundles);
    const weeklyRows = buildAggregatedWeeklyRows(bundles);

    // 累加量：claude + codex 相加
    assert.equal(dailyRows[0].userMessageCount, 8);
    assert.equal(dailyRows[0].inputTokens, 150);
    // 额度 peak 取两源 max
    assert.equal(dailyRows[0].fiveHourPeakUsagePct, 40);
    // 额度 latest 两源相加
    assert.equal(dailyRows[0].fiveHourLatestUsagePct, 70);
    // weekly 同口径
    assert.equal(weeklyRows[0].userMessageCount, 8);
    assert.equal(weeklyRows[0].fiveHourPeakUsagePct, 40);
    assert.equal(weeklyRows[0].fiveHourLatestUsagePct, 70);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("aggregate weekly rolls up multi-machine days within the same week", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-weekroll-"));
  try {
    // 同一个人 frank、同一周，但两台电脑各自在不同天有数据：
    // machine-a 在 2026-05-26 有数据，machine-b 在 2026-05-28 有数据。
    // 每台的 weeklySummary 都只含自己那天，旧逻辑取单份会丢另一台；新逻辑按天上卷应相加。
    await fs.writeFile(
      path.join(root, "frank_a.json"),
      JSON.stringify(buildBundleForMerge({ personKey: "frank", generatedAt: "2026-05-26T20:00:00.000Z", date: "2026-05-26", eventTimestamp: "2026-05-26T01:00:00.000Z", userMessageCount: 2, inputTokens: 300, fiveHour: 10 })),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "frank_b.json"),
      JSON.stringify(buildBundleForMerge({ personKey: "frank", generatedAt: "2026-05-28T20:00:00.000Z", date: "2026-05-28", eventTimestamp: "2026-05-28T01:00:00.000Z", userMessageCount: 5, inputTokens: 700, fiveHour: 30 })),
      "utf8",
    );

    const bundles = await loadWeeklyExportBundles(root);
    const dailyRows = buildAggregatedDailyRows(bundles);
    const weeklyRows = buildAggregatedWeeklyRows(bundles);

    // 两天各自一行 daily，整周合成一行 weekly。
    assert.equal(dailyRows.length, 2);
    assert.equal(weeklyRows.length, 1);

    // 累加类字段跨机按天上卷：2+5、300+700、计数与采样数同理。
    assert.equal(weeklyRows[0].userMessageCount, 7);
    assert.equal(weeklyRows[0].inputTokens, 1000);
    assert.equal(weeklyRows[0].apiRequestCount, 2);
    assert.equal(weeklyRows[0].sampleCount, 2);
    // usage 从该周全部事件重算：peak 取 max（30），latest 取时间戳最新（machine-b=30）。
    assert.equal(weeklyRows[0].fiveHourPeakUsagePct, 30);
    assert.equal(weeklyRows[0].fiveHourLatestUsagePct, 30);
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
      /schemaVersion 6\/7\/8\/9\/10 bundles/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** 只填 computeCumulativeSevenDay 关心的 timestamp / sevenDayUsagePct，其余字段补成空壳。 */
function makeSevenDayEvent(timestamp: string, sevenDayUsagePct: number | null): StatuslineEvent {
  return {
    timestamp,
    sessionId: null,
    workspaceDir: null,
    workspaceName: null,
    modelName: null,
    gitUserName: null,
    gitUserEmail: null,
    gitUserAccount: null,
    usagePct: null,
    sevenDayUsagePct,
    contextWindowPct: null,
    contextUsed: null,
    contextMax: null,
    statusLine: "",
    rawPayload: {},
  };
}

test("computeCumulativeSevenDay sums per-segment peak-to-trough across the four spec scenarios", () => {
  // 单调上升后归零再上升：段1[30,60]贡献30，0 跌破 60 的一半判定 reset，段2[0,25,50]贡献50，合计 80。
  const climbResetClimb = [30, 60, 0, 25, 50].map((value, index) => makeSevenDayEvent(`2026-05-26T0${index}:00:00.000Z`, value));
  assert.equal(computeCumulativeSevenDay(climbResetClimb), 80);

  // 含 null：剔除后按 [20,45,70] 单段算，70−20=50。
  const withNull = [20, null, 45, null, 70].map((value, index) => makeSevenDayEvent(`2026-05-26T0${index}:00:00.000Z`, value));
  assert.equal(computeCumulativeSevenDay(withNull), 50);

  // 单样本：无前值可比，累计 0。
  assert.equal(computeCumulativeSevenDay([makeSevenDayEvent("2026-05-26T01:00:00.000Z", 42)]), 0);

  // 无有效样本：null（区别于 0）。
  assert.equal(computeCumulativeSevenDay([]), null);
  assert.equal(computeCumulativeSevenDay([makeSevenDayEvent("2026-05-26T01:00:00.000Z", null)]), null);

  // spec daily 示例 [10,35,5,20]：5 跌破 35 的一半 reset，段1[10,35]贡献25，段2[5,20]贡献15，合计 40。
  const dailyExample = [10, 35, 5, 20].map((value, index) => makeSevenDayEvent(`2026-05-26T0${index}:00:00.000Z`, value));
  assert.equal(computeCumulativeSevenDay(dailyExample), 40);
});

test("computeCumulativeSevenDay is robust to same-level ±1 flutter (no naive over-counting)", () => {
  // 同一档位反复 14↔15 抖动：朴素正增量累加会得 3（每次 14→15 计 +1），
  // 分段峰谷和只取整段峰谷差 15−14=1，不被采样毛刺重复计数。
  const flutter = [14, 15, 14, 15, 14, 15].map((value, index) => makeSevenDayEvent(`2026-05-26T0${index}:00:00.000Z`, value));
  assert.equal(computeCumulativeSevenDay(flutter), 1);

  // aging 小回落（未跌破段峰一半）不分段：[20,40,30,55] 视为单段，55−20=35（朴素也会把 30→55 计成 25 而少看前半段）。
  const aging = [20, 40, 30, 55].map((value, index) => makeSevenDayEvent(`2026-05-26T0${index}:00:00.000Z`, value));
  assert.equal(computeCumulativeSevenDay(aging), 35);
});

test("deburrSevenDayEvents drops a short stale spike even when a sampling gap follows it", () => {
  // 稳定在 11（多样本、跨度 6min）→ 跌到 4（多样本、段内仅 1min）→ 之后一段 5min 采集间隙 → 回到 11 继续涨到 30。
  // 这个 4 是 stale 尖峰：段内只持续 1min（< 2min 阈值），本该被抹；但它后面紧跟 5min 间隙，
  // 若按「下一段起始 − 本段起始」(=6min) 度量持续时长会漏抹，残留的 4 会触发假 reset 把累计从 19 抬到 26。
  const seq = [
    ["2026-05-26T00:00:00.000Z", 11],
    ["2026-05-26T00:03:00.000Z", 11],
    ["2026-05-26T00:06:00.000Z", 11],
    ["2026-05-26T00:07:00.000Z", 4],
    ["2026-05-26T00:07:30.000Z", 4],
    ["2026-05-26T00:08:00.000Z", 4],
    ["2026-05-26T00:13:00.000Z", 11],
    ["2026-05-26T00:16:00.000Z", 11],
    ["2026-05-26T00:20:00.000Z", 30],
  ].map(([t, v]) => makeSevenDayEvent(t as string, v as number));

  // 中间那三个 4 应被抹成前值 11，曲线不再有跌破段峰一半的点。
  assert.deepEqual(
    deburrSevenDayEvents(seq).map((event) => event.sevenDayUsagePct),
    [11, 11, 11, 11, 11, 11, 11, 11, 30],
  );
  // 累计回到真实的单段 30 − 11 = 19（漏抹时会因假 reset 变成 26）。
  assert.equal(computeCumulativeSevenDay(buildSevenDayCurveFromEvents(seq)), 19);
});

/** 构造带 seven_day 序列的单人单天 bundle，用于多机合并曲线测试。 */
function buildSevenDayBundle(options: { personKey: string; generatedAt: string; date: string; samples: Array<{ timestamp: string; sevenDay: number; source?: "claude" | "codex" }> }) {
  const { personKey, generatedAt, date, samples } = options;
  return {
    schemaVersion: 7,
    generatedAt,
    range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-31T23:59:59.999Z" },
    identity: { gitUserName: personKey, gitUserEmail: `${personKey}@example.com` },
    rawEvents: samples.map((sample, index) => ({
      schemaVersion: 3,
      timestamp: sample.timestamp,
      gitUserName: personKey,
      gitUserEmail: `${personKey}@example.com`,
      gitUserAccount: personKey,
      rawPayload: {
        source: sample.source ?? "claude",
        session_id: `${personKey}-${generatedAt}-${index}`,
        model: { display_name: "Opus" },
        workspace: { current_dir: `/repo/${personKey}` },
        context_window: { used_percentage: 20, used_tokens: 100, max_tokens: 1000 },
        rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: sample.sevenDay } },
      },
    })),
    weeklySummary: {
      schemaVersion: 7,
      generatedAt,
      range: { label: "this-week", start: "2026-05-25T00:00:00.000Z", end: "2026-05-31T23:59:59.999Z" },
      identity: { gitUserName: personKey, gitUserEmail: `${personKey}@example.com` },
      counts: { userMessageCount: 1, apiRequestCount: 1 },
      tokens: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5 },
      statusline: { sampleCount: samples.length, uniqueSessions: 1, uniqueWorkspaces: 1, fiveHourLatestUsagePct: 10, fiveHourPeakUsagePct: 10, sevenDayLatestUsagePct: samples.at(-1)?.sevenDay ?? null, sevenDayPeakUsagePct: Math.max(...samples.map((s) => s.sevenDay)) },
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
        date,
        userMessageCount: 1,
        apiRequestCount: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 5,
        sampleCount: samples.length,
        fiveHourLatestUsagePct: 10,
        fiveHourPeakUsagePct: 10,
        sevenDayLatestUsagePct: samples.at(-1)?.sevenDay ?? null,
        sevenDayPeakUsagePct: Math.max(...samples.map((s) => s.sevenDay)),
        uniqueSessions: 1,
        uniqueWorkspaces: 1,
      },
    ],
  };
}

test("buildPersonSevenDayCurve merges two machines into one curve without per-machine summing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-curve-"));
  try {
    // 同一账号 gina，同一天，两台机器交错采样：A=[t1:30, t3:60]，B=[t2:45, t4:0, t5:40]。
    // 合并后应为一条曲线 [30,45,60,0,40]，去重相同时间戳，累计 15+15+0+40=70（不分机相加）。
    await fs.writeFile(
      path.join(root, "gina_a.json"),
      JSON.stringify(buildSevenDayBundle({ personKey: "gina", generatedAt: "2026-05-26T20:00:00.000Z", date: "2026-05-26", samples: [
        { timestamp: "2026-05-26T01:00:00.000Z", sevenDay: 30 },
        { timestamp: "2026-05-26T03:00:00.000Z", sevenDay: 60 },
      ] })),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "gina_b.json"),
      JSON.stringify(buildSevenDayBundle({ personKey: "gina", generatedAt: "2026-05-26T21:00:00.000Z", date: "2026-05-26", samples: [
        { timestamp: "2026-05-26T02:00:00.000Z", sevenDay: 45 },
        { timestamp: "2026-05-26T04:00:00.000Z", sevenDay: 0 },
        // 与机器 A 的 t3 完全相同 timestamp：合并后应去重，只留一条。
        { timestamp: "2026-05-26T03:00:00.000Z", sevenDay: 60 },
        { timestamp: "2026-05-26T05:00:00.000Z", sevenDay: 40 },
      ] })),
      "utf8",
    );

    const bundles = await loadWeeklyExportBundles(root);
    const curves = buildPersonSevenDayCurve(bundles).get("gina");
    // 该 bundle 全是 Claude 事件：codex 源为空。
    assert.deepEqual((curves?.codex ?? []).map((event) => event.sevenDayUsagePct), []);
    const curve = curves?.claude ?? [];
    // 6 条原始事件里有 1 对相同 timestamp，去重后剩 5 条。
    assert.equal(curve.length, 5);
    assert.deepEqual(curve.map((event) => event.sevenDayUsagePct), [30, 45, 60, 0, 40]);
    assert.equal(computeCumulativeSevenDay(curve), 70);

    // daily / weekly 都应写入累计 70，而非两台机器各自累计相加。
    const dailyRows = buildAggregatedDailyRows(bundles);
    const weeklyRows = buildAggregatedWeeklyRows(bundles);
    assert.equal(dailyRows.length, 1);
    assert.equal(dailyRows[0].sevenDayCumulativeUsagePct, 70);
    assert.equal(weeklyRows.length, 1);
    assert.equal(weeklyRows[0].sevenDayCumulativeUsagePct, 70);
    // weekly ≥ Σ daily（此处单天，相等）。
    assert.ok((weeklyRows[0].sevenDayCumulativeUsagePct ?? 0) >= (dailyRows[0].sevenDayCumulativeUsagePct ?? 0));

    // detail 列集合不含累计列。
    const detailCsv = buildAggregatedDetailCsv(buildAggregatedDetailRows(bundles));
    assert.equal(detailCsv.includes("sevenDayCumulativeUsagePct"), false);

    // daily/weekly CSV 含累计列与数值 70。
    assert.match(buildAggregatedDailyCsv(dailyRows), /,70,/);
    assert.match(buildAggregatedWeeklyCsv(weeklyRows), /,70,/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildPersonSevenDayCurve splits claude/codex sources and sums per-source cumulative (no mixed over-counting)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-split-"));
  try {
    // 同一人 karl：Claude 高位曲线 [50→80]（累计 30），Codex 低位曲线 [0→10]（累计 10）。
    // 时间交错：合并排序后 [50(c), 0(codex), 80(c), 10(codex)]，混算会让 codex 低位反复触发假 reset，
    // 把 Claude 上升段切断重算（混算会得 80，虚高）；分源相加应为 30 + 10 = 40。
    await fs.writeFile(
      path.join(root, "karl.json"),
      JSON.stringify(buildSevenDayBundle({ personKey: "karl", generatedAt: "2026-05-26T20:00:00.000Z", date: "2026-05-26", samples: [
        { timestamp: "2026-05-26T01:00:00.000Z", sevenDay: 50, source: "claude" },
        { timestamp: "2026-05-26T02:00:00.000Z", sevenDay: 0, source: "codex" },
        { timestamp: "2026-05-26T03:00:00.000Z", sevenDay: 80, source: "claude" },
        { timestamp: "2026-05-26T04:00:00.000Z", sevenDay: 10, source: "codex" },
      ] })),
      "utf8",
    );

    const bundles = await loadWeeklyExportBundles(root);
    const curves = buildPersonSevenDayCurve(bundles).get("karl");
    // 分源：Claude 一条 [50,80]、Codex 一条 [0,10]，互不混入。
    assert.deepEqual(curves?.claude.map((event) => event.sevenDayUsagePct), [50, 80]);
    assert.deepEqual(curves?.codex.map((event) => event.sevenDayUsagePct), [0, 10]);

    // daily / weekly 累计 = Claude 30 + Codex 10 = 40（而非混算虚高的 80）。
    const dailyRows = buildAggregatedDailyRows(bundles);
    const weeklyRows = buildAggregatedWeeklyRows(bundles);
    assert.equal(dailyRows[0].sevenDayCumulativeUsagePct, 40);
    assert.equal(weeklyRows[0].sevenDayCumulativeUsagePct, 40);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildPersonSevenDayCurve deburrs short stale spikes before cumulative", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-deburr-"));
  try {
    // 同一账号 ivan、同一天：长 baseline 持续在 2%（高频采样 60 个样本、每 30s，跨 ~30min），
    // 中间夹两个 30% 的 stale 读数（每 30s、仅持续 ~30s），再回到 baseline 2%。
    // 去毛刺应抹掉中间短尖峰，当天累计 = 0（baseline 无净增长）；不去毛刺会被尖峰虚增到 ~28。
    const samples: Array<{ timestamp: string; sevenDay: number }> = [];
    let tick = 0;
    const at = (sec: number) => new Date(Date.UTC(2026, 4, 26, 9, 0, sec)).toISOString();
    for (let n = 0; n < 60; n += 1) { samples.push({ timestamp: at(tick), sevenDay: 2 }); tick += 30; }
    samples.push({ timestamp: at(tick), sevenDay: 30 }); tick += 30;
    samples.push({ timestamp: at(tick), sevenDay: 30 }); tick += 30;
    for (let n = 0; n < 60; n += 1) { samples.push({ timestamp: at(tick), sevenDay: 2 }); tick += 30; }

    await fs.writeFile(
      path.join(root, "ivan.json"),
      JSON.stringify(buildSevenDayBundle({ personKey: "ivan", generatedAt: "2026-05-26T20:00:00.000Z", date: "2026-05-26", samples })),
      "utf8",
    );

    const bundles = await loadWeeklyExportBundles(root);
    const curve = buildPersonSevenDayCurve(bundles).get("ivan")?.claude ?? [];
    // 去毛刺后中间的 30 尖峰被压回 2，曲线无 30。
    assert.equal(curve.some((event) => event.sevenDayUsagePct === 30), false);

    const dailyRows = buildAggregatedDailyRows(bundles);
    assert.equal(dailyRows.length, 1);
    // baseline 全程 2%、无净增长，去毛刺后累计 0；若不去毛刺会被尖峰虚增。
    assert.equal(dailyRows[0].sevenDayCumulativeUsagePct, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("weekly cumulative is at least the sum of daily cumulatives across the week", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-aggregate-weekcum-"));
  try {
    // 同一账号 hugo、同一周两天，跨天边界为正增量：
    // 周一 [10,40]→daily 30；周二 [45,50]→daily 5。Σ daily = 35。
    // 整周曲线 [10,40,45,50]→weekly (40−10)+(45−40)+(50−45)=30+5+5=40。
    // 跨天 40→45 这一步只在 weekly 连续计算时被计入，故 weekly(40) > Σ daily(35)。
    await fs.writeFile(
      path.join(root, "hugo_mon.json"),
      JSON.stringify(buildSevenDayBundle({ personKey: "hugo", generatedAt: "2026-05-25T20:00:00.000Z", date: "2026-05-25", samples: [
        { timestamp: "2026-05-25T01:00:00.000Z", sevenDay: 10 },
        { timestamp: "2026-05-25T05:00:00.000Z", sevenDay: 40 },
      ] })),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "hugo_tue.json"),
      JSON.stringify(buildSevenDayBundle({ personKey: "hugo", generatedAt: "2026-05-26T20:00:00.000Z", date: "2026-05-26", samples: [
        { timestamp: "2026-05-26T01:00:00.000Z", sevenDay: 45 },
        { timestamp: "2026-05-26T05:00:00.000Z", sevenDay: 50 },
      ] })),
      "utf8",
    );

    const bundles = await loadWeeklyExportBundles(root);
    const dailyRows = buildAggregatedDailyRows(bundles);
    const weeklyRows = buildAggregatedWeeklyRows(bundles);

    const mon = dailyRows.find((row) => row.date === "2026-05-25");
    const tue = dailyRows.find((row) => row.date === "2026-05-26");
    assert.equal(mon?.sevenDayCumulativeUsagePct, 30);
    assert.equal(tue?.sevenDayCumulativeUsagePct, 5);

    assert.equal(weeklyRows.length, 1);
    const dailySum = (mon?.sevenDayCumulativeUsagePct ?? 0) + (tue?.sevenDayCumulativeUsagePct ?? 0);
    assert.equal(weeklyRows[0].sevenDayCumulativeUsagePct, 40);
    assert.ok((weeklyRows[0].sevenDayCumulativeUsagePct ?? 0) > dailySum);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
