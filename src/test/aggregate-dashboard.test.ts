import test from "node:test";
import assert from "node:assert/strict";
import { buildAggregateDashboardHtml, summarizeOverall, summarizePeople } from "../lib/aggregate-dashboard";
import { AggregatedDailyRow, AggregatedEventRow, AggregatedWeeklyRow } from "../types";

/** 两个人、两天的样本，足够覆盖排序、累计和峰值逻辑。 */
const dailyRows: AggregatedDailyRow[] = [
  {
    personKey: "alice",
    date: "2026-05-26",
    userMessageCount: 5,
    apiRequestCount: 3,
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
  assert.match(html, /7d 周使用量/);
  assert.match(html, /stroke-dasharray/);
  assert.match(html, /每日用户请求数对比/);
  assert.match(html, /按周聚合/);
  // 7d 累计指标在排行榜与周表的表头都出现，bob 的累计值 70.0% 被渲染。
  assert.match(html, /7d 累计/);
  assert.match(html, /70\.0%/);
  assert.match(html, />alice</);
  assert.match(html, />bob</);
  assert.match(html, /Total API requests/);
  // 图例人名可点击高亮：曲线分组与图例 chip 都带 data-person，并注入点击交互脚本。
  assert.match(html, /class="legend-chip legend-toggle" data-person="alice"/);
  assert.match(html, /<g data-person="bob">/);
  assert.match(html, /legend-toggle/);
  assert.match(html, /addEventListener\("click"/);
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
});
