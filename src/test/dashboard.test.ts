import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardHtml, bucketizeEvents, summarizeEvents } from "../lib/dashboard";
import { computeStatuslineEvent } from "../lib/payload";
import { PersistedStatuslineEvent, StatuslineEvent } from "../types";

/** 这组固定样本同时供摘要、分桶和 HTML 输出测试复用。 */
const records: PersistedStatuslineEvent[] = [
  {
    schemaVersion: 2,
    timestamp: "2026-05-26T01:00:00.000Z",
    gitUserName: "alice",
    gitUserEmail: "alice@example.com",
    gitUserAccount: "alice",
    rawPayload: {
      session_id: "a",
      model: { display_name: "Opus" },
      workspace: { current_dir: "/repo/a" },
      context_window: { used_percentage: 18, used_tokens: 120, max_tokens: 1000 },
      rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 44 } },
    },
  },
  {
    schemaVersion: 2,
    timestamp: "2026-05-26T01:05:00.000Z",
    gitUserName: "alice",
    gitUserEmail: "alice@example.com",
    gitUserAccount: "alice",
    rawPayload: {
      session_id: "a",
      model: { display_name: "Opus" },
      workspace: { current_dir: "/repo/a" },
      context_window: { used_percentage: 26, used_tokens: 240, max_tokens: 1000 },
      rate_limits: { five_hour: { used_percentage: 24 }, seven_day: { used_percentage: 48 } },
    },
  },
];

const events: StatuslineEvent[] = records.map((record) => computeStatuslineEvent(record));

/** 校验 dashboard 顶部卡片用到的摘要指标是否正确。 */
test("summarizeEvents computes headline stats", () => {
  const summary = summarizeEvents(events);
  assert.equal(summary.fiveHourLatestUsagePct, 24);
  assert.equal(summary.fiveHourPeakUsagePct, 24);
  assert.equal(summary.sevenDayLatestUsagePct, 48);
  assert.equal(summary.sevenDayPeakUsagePct, 48);
});

/** 校验 5 分钟固定桶聚合是否稳定，避免曲线错位；同时 5h 与 7d 各自独立聚合。 */
test("bucketizeEvents creates fixed 5-minute buckets", () => {
  const buckets = bucketizeEvents(events, new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T01:10:00.000Z"), 5);
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].avgUsagePct, 12);
  assert.equal(buckets[1].avgUsagePct, 24);
  assert.equal(buckets[0].avgSevenDayUsagePct, 44);
  assert.equal(buckets[1].avgSevenDayUsagePct, 48);
});

/** 只验证关键内容是否进入 HTML，避免测试过度绑定具体样式细节。 */
test("buildDashboardHtml renders chart and recent events", () => {
  const html = buildDashboardHtml(events, "5h", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  assert.match(html, /Claude 使用率趋势/);
  assert.match(html, /最近 20 条采样/);
  assert.match(html, /5h 24.0%/);
});

/** 跨多天窗口的 x 轴应按自然日打刻度（只显示月-日），更像周视图。 */
test("buildDashboardHtml uses per-day x-axis ticks for multi-day windows", () => {
  const html = buildDashboardHtml(events, "this-week", new Date("2026-05-25T00:00:00.000Z"), new Date("2026-05-31T00:00:00.000Z"));
  assert.match(html, /class="chart-axis">05-25<\/text>/);
  assert.match(html, /class="chart-axis">05-29<\/text>/);
});

/** 5h 与 7d 两条曲线都应进入 HTML：图例、7d 线与 7d 数据点。 */
test("buildDashboardHtml overlays the 7d usage line", () => {
  const html = buildDashboardHtml(events, "5h", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  assert.match(html, /7 天使用率/);
  assert.match(html, /chart-line-7d/);
  assert.match(html, /7d 48.0%/);
});

/** 顶部统计卡应展示 7d 使用率与用户消息数合计，并移除 Sessions / Workspaces。 */
test("buildDashboardHtml shows 7d usage and total user messages stats", () => {
  const html = buildDashboardHtml(events, "this-week", new Date("2026-05-26T00:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"), [
    { date: "2026-05-25", userMessageCount: 4 },
    { date: "2026-05-26", userMessageCount: 6 },
  ]);
  assert.match(html, /Latest 7d usage/);
  assert.match(html, /用户消息数/);
  assert.match(html, /<p class="stat-value">10<\/p>/);
  assert.doesNotMatch(html, /Sessions/);
  assert.doesNotMatch(html, /Workspaces/);
});

/** 传入每日用户消息数时应渲染出对应柱状图面板与计数。 */
test("buildDashboardHtml renders daily user messages panel when provided", () => {
  const html = buildDashboardHtml(events, "this-week", new Date("2026-05-26T00:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"), [
    { date: "2026-05-25", userMessageCount: 3 },
    { date: "2026-05-26", userMessageCount: 7 },
  ]);
  assert.match(html, /每日用户消息数/);
  assert.match(html, /共 10 条/);
});

/** 不传每日用户消息数时不应出现该面板，保持向后兼容。 */
test("buildDashboardHtml omits daily messages panel without data", () => {
  const html = buildDashboardHtml(events, "today", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  assert.doesNotMatch(html, /每日用户消息数/);
});

/** 生成的 HTML 应该是完整文档，便于 serve 命令直接返回。 */
test("buildDashboardHtml returns a full html document", () => {
  const html = buildDashboardHtml(events, "today", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /ccus dashboard/);
});
