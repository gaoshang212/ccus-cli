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

/** 校验 5 分钟固定桶聚合是否稳定，避免曲线错位。 */
test("bucketizeEvents creates fixed 5-minute buckets", () => {
  const buckets = bucketizeEvents(events, new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T01:10:00.000Z"), 5);
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].avgUsagePct, 12);
  assert.equal(buckets[1].avgUsagePct, 24);
});

/** 只验证关键内容是否进入 HTML，避免测试过度绑定具体样式细节。 */
test("buildDashboardHtml renders chart and recent events", () => {
  const html = buildDashboardHtml(events, "5h", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  assert.match(html, /Claude 5 小时使用率趋势/);
  assert.match(html, /最近 20 条采样/);
  assert.match(html, /5h 24.0%/);
});

/** 生成的 HTML 应该是完整文档，便于 serve 命令直接返回。 */
test("buildDashboardHtml returns a full html document", () => {
  const html = buildDashboardHtml(events, "today", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /ccus dashboard/);
});
