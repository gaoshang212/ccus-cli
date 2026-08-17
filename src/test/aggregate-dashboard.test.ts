import test from "node:test";
import assert from "node:assert/strict";
import { alignTimeSeries, buildAggregateDashboardHtml, summarizeOverall, summarizePeople } from "../lib/aggregate-dashboard";
import { AggregatedDailyRow, AggregatedEventRow, AggregatedWeeklyRow } from "../types";

/** 两个人、两天的样本，足够覆盖排序、累计和峰值逻辑。 */
const dailyRows: AggregatedDailyRow[] = [
  {
    personKey: "alice",
    date: "2026-05-26",
    userMessageCount: 5,
    apiRequestCount: 3,
    estimatedApiEquivalentCostUsd: 1,
    pricedApiRequestCount: 3,
    unpricedApiRequestCount: 0,
    pricingCatalogVersion: "2026-08-14",
    inputTokens: 1000,
    outputTokens: 120,
    cacheReadInputTokens: 50,
    sampleCount: 2,
    fiveHourPeakUsagePct: 18,
    fiveHourLatestUsagePct: 12,
    sevenDayPeakUsagePct: 36,
    sevenDayLatestUsagePct: 30,
    sevenDayCumulativeUsagePct: 12,
    uniqueSessions: 1,
    uniqueWorkspaces: 1,
  },
  {
    personKey: "alice",
    date: "2026-05-27",
    userMessageCount: 2,
    apiRequestCount: 1,
    estimatedApiEquivalentCostUsd: null,
    pricedApiRequestCount: 0,
    unpricedApiRequestCount: 1,
    pricingCatalogVersion: "2026-08-14",
    inputTokens: 200,
    outputTokens: 30,
    cacheReadInputTokens: 10,
    sampleCount: 1,
    fiveHourPeakUsagePct: 22,
    fiveHourLatestUsagePct: 22,
    sevenDayPeakUsagePct: 38,
    sevenDayLatestUsagePct: 33,
    sevenDayCumulativeUsagePct: 8,
    uniqueSessions: 1,
    uniqueWorkspaces: 1,
  },
  {
    personKey: "bob",
    date: "2026-05-27",
    userMessageCount: 9,
    apiRequestCount: 7,
    estimatedApiEquivalentCostUsd: 2.5,
    pricedApiRequestCount: 7,
    unpricedApiRequestCount: 0,
    pricingCatalogVersion: "2026-08-14",
    inputTokens: 800,
    outputTokens: 90,
    cacheReadInputTokens: 30,
    sampleCount: 3,
    fiveHourPeakUsagePct: 45,
    fiveHourLatestUsagePct: 40,
    sevenDayPeakUsagePct: 65,
    sevenDayLatestUsagePct: 60,
    sevenDayCumulativeUsagePct: 50,
    uniqueSessions: 2,
    uniqueWorkspaces: 1,
  },
];

const weeklyRows: AggregatedWeeklyRow[] = [
  {
    personKey: "alice",
    week: "2026-05-25",
    userMessageCount: 7,
    apiRequestCount: 4,
    estimatedApiEquivalentCostUsd: 1,
    pricedApiRequestCount: 3,
    unpricedApiRequestCount: 1,
    pricingCatalogVersion: "2026-08-14",
    inputTokens: 1200,
    outputTokens: 150,
    cacheReadInputTokens: 60,
    sampleCount: 3,
    fiveHourPeakUsagePct: 22,
    fiveHourLatestUsagePct: 22,
    sevenDayPeakUsagePct: 38,
    sevenDayLatestUsagePct: 33,
    sevenDayCumulativeUsagePct: 40,
    uniqueSessions: 1,
    uniqueWorkspaces: 1,
  },
  {
    personKey: "bob",
    week: "2026-05-25",
    userMessageCount: 9,
    apiRequestCount: 7,
    estimatedApiEquivalentCostUsd: 2.5,
    pricedApiRequestCount: 7,
    unpricedApiRequestCount: 0,
    pricingCatalogVersion: "2026-08-14",
    inputTokens: 800,
    outputTokens: 90,
    cacheReadInputTokens: 30,
    sampleCount: 3,
    fiveHourPeakUsagePct: 45,
    fiveHourLatestUsagePct: 40,
    sevenDayPeakUsagePct: 65,
    sevenDayLatestUsagePct: 60,
    sevenDayCumulativeUsagePct: 70,
    uniqueSessions: 2,
    uniqueWorkspaces: 1,
  },
];

/** 构造一条事件级 detail 行，省去重复写满 StatuslineEvent 的所有字段。 */
function makeDetailRow(personKey: string, timestamp: string, usagePct: number | null): AggregatedEventRow {
  return {
    timestamp,
    sessionId: `${personKey}-session`,
    workspaceDir: `/repo/${personKey}`,
    workspaceName: personKey,
    modelName: "Opus",
    gitUserName: personKey,
    gitUserEmail: `${personKey}@example.com`,
    gitUserAccount: personKey,
    usagePct,
    sevenDayUsagePct: 30,
    contextWindowPct: 20,
    contextUsed: 100,
    contextMax: 1000,
    statusLine: "",
    rawPayload: {},
    personKey,
    weekKey: "2026-05-25",
    dateKey: timestamp.slice(0, 10),
    source: "claude",
    inputTokens: 300,
    outputTokens: 40,
    cacheReadInputTokens: 20,
  };
}

const detailRows: AggregatedEventRow[] = [
  makeDetailRow("alice", "2026-05-27T01:00:00.000Z", 12),
  makeDetailRow("alice", "2026-05-27T03:00:00.000Z", 18),
  makeDetailRow("bob", "2026-05-27T02:00:00.000Z", 40),
];

test("summarizePeople rolls up daily rows per person and sorts by user messages desc", () => {
  const people = summarizePeople(dailyRows, weeklyRows);
  assert.equal(people.length, 2);
  assert.equal(people[0].personKey, "bob");
  assert.equal(people[0].userMessageCount, 9);
  assert.equal(people[0].apiRequestCount, 7);
  // 累计 7d 与 weekly.csv 同源：bob 单周 weekly 行 70。
  assert.equal(people[0].sevenDayCumulativeUsagePct, 70);
  assert.equal(people[1].personKey, "alice");
  assert.equal(people[1].apiRequestCount, 4);
  assert.equal(people[1].userMessageCount, 7);
  assert.equal(people[1].inputTokens, 1200);
  assert.equal(people[1].fiveHourPeakUsagePct, 22);
  assert.equal(people[1].fiveHourLatestUsagePct, 22);
  assert.equal(people[1].sevenDayPeakUsagePct, 38);
  assert.equal(people[1].sevenDayLatestUsagePct, 33);
  // alice 单周 weekly 行累计 40（来自 weekly.csv，而非 daily 12+8=20 求和）。
  assert.equal(people[1].sevenDayCumulativeUsagePct, 40);
  assert.equal(people[1].activeDays, 2);
  assert.equal(people[1].firstDate, "2026-05-26");
  assert.equal(people[1].lastDate, "2026-05-27");
  assert.equal(people[1].estimatedApiEquivalentCostUsd, 1);
  assert.equal(people[1].pricedApiRequestCount, 3);
  assert.equal(people[1].unpricedApiRequestCount, 1);
});

test("summarizeOverall aggregates the whole team", () => {
  const people = summarizePeople(dailyRows);
  const overall = summarizeOverall(dailyRows, people);
  assert.equal(overall.personCount, 2);
  assert.equal(overall.totalApiRequestCount, 11);
  assert.equal(overall.totalUserMessageCount, 16);
  assert.equal(overall.totalInputTokens, 2000);
  assert.equal(overall.totalOutputTokens, 240);
  assert.equal(overall.totalCacheReadInputTokens, 90);
  assert.equal(overall.startDate, "2026-05-26");
  assert.equal(overall.endDate, "2026-05-27");
  assert.equal(overall.estimatedApiEquivalentCostUsd, 3.5);
  assert.equal(overall.pricedApiRequestCount, 10);
  assert.equal(overall.unpricedApiRequestCount, 1);
});

test("buildAggregateDashboardHtml renders people, charts, and weekly rollup", () => {
  const html = buildAggregateDashboardHtml(detailRows, dailyRows, weeklyRows, new Date("2026-05-27T08:00:00.000Z"));
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /ccus team dashboard/);
  assert.match(html, /多人对比/);
  assert.match(html, /周使用量累计对比/);
  // 对比图改用累计口径：标题、eyebrow、ARIA 标签都切到累计，不再出现「峰值对比」。
  assert.match(html, /Weekly Cumulative Usage/);
  assert.doesNotMatch(html, /周使用量峰值对比/);
  assert.match(html, /5h \/ 7d 使用率详细曲线/);
  assert.match(html, /按真实时间戳绘制/);
  assert.match(html, /每日用户请求数对比/);
  assert.match(html, /按周聚合/);
  // 7d 累计指标在排行榜与周表的表头都出现，bob 的累计值 70.0% 被渲染。
  assert.match(html, /7d 累计/);
  assert.match(html, /70\.0%/);
  assert.match(html, />alice</);
  assert.match(html, />bob</);
  const topStats = html.match(/<section class="stats">([\s\S]*?)<\/section>/)?.[1] ?? "";
  const topStatArticles = topStats.match(/<article\b[\s\S]*?<\/article>/g) ?? [];
  assert.equal(topStatArticles.length, 6);
  assert.match(topStatArticles[4], /<h2>Peak 7d usage<\/h2>/);
  assert.match(topStatArticles[5], /<h2>合计等效 API 成本<\/h2>/);
  assert.match(topStatArticles[5], /href="pricing\.html" target="_blank" rel="noopener noreferrer"[\s\S]*查看当前价格表/);
  assert.doesNotMatch(html, /Total API requests/);
  const peopleSection = html.match(/<section class="panel table-panel">[\s\S]*?<h2>多人对比<\/h2>[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.notEqual(peopleSection, "");
  assert.doesNotMatch(peopleSection, /<th class="muted-col">API 请求<\/th>/);
  assert.match(html, /等效 API 成本/);
  assert.match(html, /≥ \$3\.50/);
  assert.match(html, /\$2\.50/);
  assert.match(html, /价格目录/);
  assert.doesNotMatch(html, /<h2>当前模型价格<\/h2>/);
});

test("buildAggregateDashboardHtml renders unavailable and mixed pricing states", () => {
  const unavailableDaily = [{
    ...dailyRows[0],
    estimatedApiEquivalentCostUsd: null,
    pricedApiRequestCount: 0,
    unpricedApiRequestCount: dailyRows[0].apiRequestCount,
    pricingCatalogVersion: null,
  }];
  const unavailableWeekly = [{
    ...weeklyRows[0],
    estimatedApiEquivalentCostUsd: null,
    pricedApiRequestCount: 0,
    unpricedApiRequestCount: weeklyRows[0].apiRequestCount,
    pricingCatalogVersion: "mixed",
  }];
  const html = buildAggregateDashboardHtml([], unavailableDaily, unavailableWeekly, new Date("2026-05-27T08:00:00Z"));
  assert.match(html, /不可用/);

  const mixedHtml = buildAggregateDashboardHtml([], [{ ...dailyRows[0], pricingCatalogVersion: "mixed" }], [{ ...weeklyRows[0], pricingCatalogVersion: "mixed" }]);
  assert.match(mixedHtml, /旧版 schema 或不同价格目录/);
  assert.match(mixedHtml, /价格目录：mixed/);
});

test("dashboard summaries mark legacy requests on another day or person as mixed", () => {
  const legacyDay = {
    ...dailyRows[1],
    estimatedApiEquivalentCostUsd: null,
    pricedApiRequestCount: 0,
    unpricedApiRequestCount: dailyRows[1].apiRequestCount,
    pricingCatalogVersion: null,
  };
  const person = summarizePeople([dailyRows[0], legacyDay]);
  assert.equal(person[0].pricingCatalogVersion, "mixed");

  const legacyPerson = summarizePeople([{ ...legacyDay, personKey: "legacy" }]);
  const overall = summarizeOverall([dailyRows[0], { ...legacyDay, personKey: "legacy" }], [
    summarizePeople([dailyRows[0]])[0],
    legacyPerson[0],
  ]);
  assert.equal(overall.pricingCatalogVersion, "mixed");
});

/** 两张折线改用 uPlot：断言从 SVG path/title 改为容器 + 内联 series 配置（5h 实线 / 7d 虚线）。 */
test("buildAggregateDashboardHtml renders the two line charts as uPlot", () => {
  const html = buildAggregateDashboardHtml(detailRows, dailyRows, weeklyRows, new Date("2026-05-27T08:00:00.000Z"));
  // 5h/7d 详细曲线：uPlot 容器 + 每人 5h/7d series 标签 + 7d 虚线 dash 配置
  assert.match(html, /class="uplot-host" id="chart-usage-detail"/);
  assert.match(html, /"label":"alice · 5h"/);
  assert.match(html, /"label":"alice · 7d"/);
  assert.match(html, /"dash":\[5,4\]/);
  // 每日用户请求对比：uPlot 容器 + 按人 series 标签（category x）
  assert.match(html, /class="uplot-host" id="chart-daily-requests"/);
  assert.match(html, /"label":"bob"/);
  assert.match(html, /"xType":"category"/);
  // 不再有旧 SVG 折线手写图例与点击高亮脚本
  assert.doesNotMatch(html, /legend-toggle/);
  assert.doesNotMatch(html, /data-person=/);
  assert.doesNotMatch(html, /stroke-dasharray/);
});

/** 多人折线读数走跟随 tooltip；原生 legend 关闭、改自绘「每人一项」图例，一项联动该人 5h+7d 两条 series。 */
test("buildAggregateDashboardHtml moves multi-person readouts to a follow tooltip with per-person legend", () => {
  const html = buildAggregateDashboardHtml(detailRows, dailyRows, weeklyRows, new Date("2026-05-27T08:00:00.000Z"));
  assert.match(html, /legend: \{ show: false \}/);
  assert.match(html, /ccus-tooltip/);
  assert.match(html, /dataIdx: nearestPointIdx/);
  assert.match(html, /buildLegend/);
  // alice 在 5h/7d 详细曲线里有 5h + 7d 两条 series，图例分组把两条索引归到一个人名（小写 alice）下。
  assert.match(html, /"label":"alice","color":"[^"]+","seriesIdx":\[\d+,\d+\]/);
  // 人名不强制大写：CSS 不对图例项做 uppercase
  assert.match(html, /\.ccus-legend-item \{[^}]*text-transform: none/);
});

/** 周累计横向排行榜仍自绘 SVG：保留 bar-fill / bar-track 与百分比标注（不迁 uPlot）。 */
test("buildAggregateDashboardHtml keeps the cumulative ranking as self-drawn SVG", () => {
  const html = buildAggregateDashboardHtml(detailRows, dailyRows, weeklyRows, new Date("2026-05-27T08:00:00.000Z"));
  assert.match(html, /class="bar-fill"/);
  assert.match(html, /class="bar-track"/);
  // 横向排行榜是 SVG，bob 累计 70% 的条与标注仍在
  assert.match(html, /aria-label="周使用量累计对比"/);
});

/** 离线自包含：uPlot 库与官方 CSS 内联进多人看板 HTML。 */
test("buildAggregateDashboardHtml inlines the uPlot library and CSS for offline use", () => {
  const html = buildAggregateDashboardHtml(detailRows, dailyRows, weeklyRows, new Date("2026-05-27T08:00:00.000Z"));
  assert.match(html, /uPlot \(v1\.6\.32\)/);
  assert.match(html, /var uPlot=function/);
  assert.match(html, /\.u-legend/);
  // 不走 CDN：没有任何外链 script/style
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
});

test("cumulative chart keeps a 100% full scale when no one exceeds 100%", () => {
  // bob 累计 70%、alice 40%，都不超过 100% → maxValue=100：bob fill=70/100*690=483.00、alice=276.00，均非满条。
  const html = buildAggregateDashboardHtml(detailRows, dailyRows, weeklyRows, new Date("2026-05-27T08:00:00.000Z"));
  assert.match(html, /width="483\.00"/);
  assert.match(html, /width="276\.00"/);
  // 没人到满刻度，满条 fill 宽度（trackWidth 690.00，带小数）不应出现。
  assert.doesNotMatch(html, /width="690\.00"/);
});

test("cumulative chart normalizes bars by the in-group max, allowing values over 100%", () => {
  // bob 累计 240%（超过 100），alice 60%。最大值 240 对应满条（fill 宽 = trackWidth 690.00）。
  const overWeekly: AggregatedWeeklyRow[] = [
    { ...weeklyRows[0], personKey: "alice", sevenDayCumulativeUsagePct: 60 },
    { ...weeklyRows[1], personKey: "bob", sevenDayCumulativeUsagePct: 240 },
  ];
  const overDaily: AggregatedDailyRow[] = [
    { ...dailyRows[2], personKey: "alice", sevenDayCumulativeUsagePct: 60 },
    { ...dailyRows[2], personKey: "bob", sevenDayCumulativeUsagePct: 240 },
  ];
  const html = buildAggregateDashboardHtml([], overDaily, overWeekly, new Date("2026-05-27T08:00:00.000Z"));
  // 累计绝对值标注保留，超过 100% 照常显示。
  assert.match(html, /240\.0%/);
  assert.match(html, /60\.0%/);
  // 最大累计值对应满条：fill 宽度等于 trackWidth（690），带两位小数。
  assert.match(html, /class="bar-fill" \/>\s*<text[^>]*>240\.0%/);
  assert.match(html, /width="690\.00"/);
});

test("cumulative chart shows empty state when no one has a cumulative value", () => {
  const nullWeekly: AggregatedWeeklyRow[] = [
    { ...weeklyRows[0], personKey: "alice", sevenDayCumulativeUsagePct: null },
    { ...weeklyRows[1], personKey: "bob", sevenDayCumulativeUsagePct: null },
  ];
  const nullDaily: AggregatedDailyRow[] = [
    { ...dailyRows[2], personKey: "alice", sevenDayCumulativeUsagePct: null },
    { ...dailyRows[2], personKey: "bob", sevenDayCumulativeUsagePct: null },
  ];
  const html = buildAggregateDashboardHtml([], nullDaily, nullWeekly, new Date("2026-05-27T08:00:00.000Z"));
  assert.match(html, /还没有 7 天额度累计使用量样本/);
});

test("buildAggregateDashboardHtml stays graceful with empty rows", () => {
  const html = buildAggregateDashboardHtml([], [], [], new Date("2026-05-27T08:00:00.000Z"));
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /人数：0/);
  assert.match(html, /href="pricing\.html"/);
  assert.doesNotMatch(html, /<h2>当前模型价格<\/h2>/);
});

/** 多人时间戳并集对齐：不同 series 的不规则时间戳合成统一 x 轴，缺失点填 null。 */
test("alignTimeSeries unions irregular timestamps and fills gaps with null", () => {
  const a = [
    { t: 10, v: 1 },
    { t: 30, v: 3 },
  ];
  const b = [
    { t: 20, v: 2 },
    { t: 30, v: 5 },
  ];
  const { xs, columns } = alignTimeSeries([a, b]);
  assert.deepEqual(xs, [10, 20, 30]);
  // a 在 t=20 没有采样 → null；b 在 t=10 没有采样 → null；t=30 两者都有。
  assert.deepEqual(columns[0], [1, null, 3]);
  assert.deepEqual(columns[1], [null, 2, 5]);
});

/** 端到端：两个人时间戳完全不同，5h/7d 详细曲线内联数据应是并集 x + 缺失填 null。 */
test("multi-person 5h/7d uPlot data aligns different people's timestamps with null gaps", () => {
  const rows: AggregatedEventRow[] = [
    makeDetailRow("alice", "2026-05-27T01:00:00.000Z", 12),
    makeDetailRow("bob", "2026-05-27T02:00:00.000Z", 40),
  ];
  const html = buildAggregateDashboardHtml(rows, dailyRows, weeklyRows, new Date("2026-05-27T08:00:00.000Z"));
  assert.match(html, /class="uplot-host" id="chart-usage-detail"/);
  // people 按消息数降序为 [bob, alice]；bob 5h 在 alice 的时间点为 null、alice 5h 在 bob 的时间点为 null。
  assert.match(html, /\[null,40\]/);
  assert.match(html, /\[12,null\]/);
});
