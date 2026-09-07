import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardHtml, bucketizeEvents, summarizeEvents } from "../lib/dashboard";
import { buildApiPricingPage } from "../lib/api-pricing-table";
import { renderDashboardPage } from "../lib/dashboard-pages";
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
  // 7d 分区叠加累计：44 → 48 一个上升段，贡献 48 − 44 = 4。
  assert.equal(summary.sevenDayCumulativeUsagePct, 4);
});

/** 额度叠加 Codex（与 aggregate 同口径）：peak 取两源 max、latest 两源相加。 */
test("summarizeEvents stacks codex usage onto claude (peak max, latest add)", () => {
  // claude events 的 5h latest=24（t01:05）；codex 5h=30（t02:00，更新）。
  // 叠加后：peak=max(24,30)=30、latest=24+30=54。
  const codexEvent = computeStatuslineEvent({
    schemaVersion: 3,
    timestamp: "2026-05-26T02:00:00.000Z",
    gitUserName: "alice",
    gitUserEmail: "alice@example.com",
    gitUserAccount: "alice",
    rawPayload: { source: "codex", session_id: "codex-1", rate_limits: { five_hour: { used_percentage: 30 } } },
  });
  const summary = summarizeEvents([...events, codexEvent]);
  assert.equal(summary.fiveHourPeakUsagePct, 30);
  assert.equal(summary.fiveHourLatestUsagePct, 54);
  // codex 事件无 seven_day 读数：7d 累计仍只来自 Claude（44→48，累计 4），不被 codex 干扰。
  assert.equal(summary.sevenDayCumulativeUsagePct, 4);
});

/** 7d 累计分源相加：Claude 与 Codex 各自上升段的累计贡献相加，而非混算虚高。 */
test("summarizeEvents sums seven-day cumulative per source (claude + codex)", () => {
  // Claude [50→80]（累计 30）、Codex [0→10]（累计 10）；混算会让 codex 低位触发假 reset、虚高到 80。
  const mixed: StatuslineEvent[] = [
    computeStatuslineEvent({ schemaVersion: 3, timestamp: "2026-05-26T01:00:00.000Z", gitUserName: "k", gitUserEmail: "k@e.com", gitUserAccount: "k", rawPayload: { source: "claude", rate_limits: { seven_day: { used_percentage: 50 } } } }),
    computeStatuslineEvent({ schemaVersion: 3, timestamp: "2026-05-26T02:00:00.000Z", gitUserName: "k", gitUserEmail: "k@e.com", gitUserAccount: "k", rawPayload: { source: "codex", rate_limits: { seven_day: { used_percentage: 0 } } } }),
    computeStatuslineEvent({ schemaVersion: 3, timestamp: "2026-05-26T03:00:00.000Z", gitUserName: "k", gitUserEmail: "k@e.com", gitUserAccount: "k", rawPayload: { source: "claude", rate_limits: { seven_day: { used_percentage: 80 } } } }),
    computeStatuslineEvent({ schemaVersion: 3, timestamp: "2026-05-26T04:00:00.000Z", gitUserName: "k", gitUserEmail: "k@e.com", gitUserAccount: "k", rawPayload: { source: "codex", rate_limits: { seven_day: { used_percentage: 10 } } } }),
  ];
  const summary = summarizeEvents(mixed);
  // 分源相加 = Claude 30 + Codex 10 = 40（而非混算虚高的 80）。
  assert.equal(summary.sevenDayCumulativeUsagePct, 40);
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

/**
 * 使用率趋势图迁到 uPlot：断言从旧 SVG path/dot 改为「容器 + 内联数据 + series 配置」。
 *
 * 不再有 SVG `<path>` / dot title，改为校验 uPlot 容器 id、内联数据 script、以及
 * spec 里的 5h/7d series 标签与固定 0–100% Y 轴。
 */
test("buildDashboardHtml renders the usage uPlot chart and recent events", () => {
  const html = buildDashboardHtml(events, "5h", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  assert.match(html, /Claude 使用率趋势/);
  assert.match(html, /最近 20 条采样/);
  // uPlot 容器 + 内联数据 script
  assert.match(html, /class="uplot-host" id="chart-usage"/);
  assert.match(html, /class="ccus-chart" data-target="chart-usage"/);
  // 不再有旧 SVG 折线 / 数据点 class
  assert.doesNotMatch(html, /class="chart-line"/);
});

/** 跨多天窗口仍用同一张 uPlot 时间轴图，x 轴格式由客户端按时间自适应。 */
test("buildDashboardHtml uses a time x-axis uPlot chart for multi-day windows", () => {
  const html = buildDashboardHtml(events, "this-week", new Date("2026-05-25T00:00:00.000Z"), new Date("2026-05-31T00:00:00.000Z"));
  assert.match(html, /class="uplot-host" id="chart-usage"/);
  assert.match(html, /"xType":"time"/);
});

/** 5h 与 7d 两条曲线都应进入 uPlot spec：series 标签 + 7d 虚线 dash + 固定 0–100% Y 轴。 */
test("buildDashboardHtml overlays the 7d usage series in the uPlot spec", () => {
  const html = buildDashboardHtml(events, "5h", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  assert.match(html, /"label":"5 小时使用率"/);
  assert.match(html, /"label":"7 天使用率"/);
  assert.match(html, /"dash":\[6,4\]/);
  assert.match(html, /"yRange":\[0,100\]/);
  // 7d 分区叠加累计单独走右侧 y2 轴：spec 里有第三条 series 且 y2 scale 配置存在。
  assert.match(html, /"label":"7d 分区叠加累计"/);
  assert.match(html, /"y2":\{"scale":"y2"/);
  assert.match(html, /"scale":"y2"/);
});

/** 顶部统计卡应展示 7d 使用率与用户消息数合计，并移除 Sessions / Workspaces。 */
test("buildDashboardHtml shows 7d usage and total user messages stats", () => {
  const html = buildDashboardHtml(events, "this-week", new Date("2026-05-26T00:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"), [
    { date: "2026-05-25", userMessageCount: 4 },
    { date: "2026-05-26", userMessageCount: 6 },
  ]);
  assert.match(html, /7d 分区叠加累计/);
  assert.match(html, /用户消息数/);
  assert.match(html, /<p class="stat-value">10<\/p>/);
  assert.doesNotMatch(html, /Sessions/);
  assert.doesNotMatch(html, /Workspaces/);
});

test("buildDashboardHtml renders complete, partial, and unavailable API equivalent costs", () => {
  const partial = buildDashboardHtml(events, "today", new Date("2026-05-26T00:00:00Z"), new Date("2026-05-26T23:59:59Z"), [], {
    claude: { estimatedUsd: 0.005, pricedApiRequestCount: 2, unpricedApiRequestCount: 1 },
    codex: { estimatedUsd: 1.25, pricedApiRequestCount: 3, unpricedApiRequestCount: 0 },
    total: { estimatedUsd: 1.255, pricedApiRequestCount: 5, unpricedApiRequestCount: 1 },
  }, "2026-08-14");
  const topStats = partial.match(/<section class="stats">([\s\S]*?)<\/section>/)?.[1] ?? "";
  assert.equal((topStats.match(/<article/g) ?? []).length, 5);
  assert.doesNotMatch(partial, /cost-stats/);
  assert.match(partial, /合计等效 API 成本/);
  assert.doesNotMatch(partial, /Claude 等效 API 成本/);
  assert.doesNotMatch(partial, /Codex 等效 API 成本/);
  assert.match(partial, /≥ \$1\.25/);
  assert.doesNotMatch(partial, /\$0\.0050/);
  assert.match(partial, /1 个请求未定价，结果不完整/);
  assert.match(partial, /目录 2026-08-14/);
  assert.match(partial, /合计等效 API 成本[\s\S]*href="pricing\.html" target="_blank" rel="noopener noreferrer"[\s\S]*查看当前价格表/);
  assert.doesNotMatch(partial, /<h2>当前模型价格<\/h2>/);

  const unavailable = buildDashboardHtml([], "today", new Date("2026-05-26T00:00:00Z"), new Date("2026-05-26T23:59:59Z"), [], {
    claude: { estimatedUsd: null, pricedApiRequestCount: 0, unpricedApiRequestCount: 2 },
    codex: { estimatedUsd: 0, pricedApiRequestCount: 0, unpricedApiRequestCount: 0 },
    total: { estimatedUsd: null, pricedApiRequestCount: 0, unpricedApiRequestCount: 2 },
  }, "2026-08-14");
  assert.match(unavailable, /不可用/);
  assert.match(unavailable, /2 个请求未定价/);
});

/** 传入每日用户消息数时应渲染出 uPlot 纵向柱状图面板：容器 + bars 配置 + 计数。 */
test("buildDashboardHtml renders daily user messages uPlot bar chart when provided", () => {
  const html = buildDashboardHtml(events, "this-week", new Date("2026-05-26T00:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"), [
    { date: "2026-05-25", userMessageCount: 3 },
    { date: "2026-05-26", userMessageCount: 7 },
  ]);
  assert.match(html, /每日用户消息数/);
  assert.match(html, /共 10 条/);
  // uPlot 纵向柱：容器 + bars spec
  assert.match(html, /class="uplot-host" id="chart-daily-messages"/);
  assert.match(html, /"bars":true/);
  // category x 的日期标签内联进数据
  assert.match(html, /"xLabels":\["05-25","05-26"\]/);
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

test("buildApiPricingPage renders a standalone current pricing page with Codex first", () => {
  const html = buildApiPricingPage(new Date("2026-08-17T00:00:00.000Z"));
  const currentHtml = buildApiPricingPage(new Date("2026-09-07T00:00:00.000Z"));
  assert.match(currentHtml, /gpt-6-astra/);
  assert.ok(currentHtml.indexOf("gpt-6-astra") < currentHtml.indexOf("gpt-5.6-sol"));
  assert.doesNotMatch(html, /gpt-6-astra/);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<h1>当前模型价格<\/h1>/);
  assert.equal(html.match(/<h[12]>当前模型价格<\/h[12]>/g)?.length, 1);
  assert.doesNotMatch(html, /<h2>当前模型价格<\/h2>/);
  assert.match(html, /USD \/ 百万 token/);
  assert.match(html, /长上下文/);
  assert.match(html, /200,000/);
  assert.match(html, /5 分钟缓存写入/);
  assert.match(html, /1 小时缓存写入/);
  assert.match(html, /<td>\$22\.5<\/td>/);
  assert.ok(html.indexOf("gpt-5.6-sol") < html.indexOf("claude-sonnet-4"));
  assert.ok(html.indexOf("gpt-5.6-sol") < html.indexOf("gpt-5.5"));
  assert.ok(html.indexOf("gpt-5.5") < html.indexOf("gpt-5.4"));
  assert.match(html, /claude-opus-4\.7/);
  assert.match(html, /claude-opus-4\.8/);
  assert.match(html, /claude-opus-5/);
  assert.match(html, /claude-sonnet-5/);
  assert.match(html, /claude-fable-5/);
});

test("renderDashboardPage serves dashboard, pricing page, and 404 distinctly", async () => {
  assert.equal(await renderDashboardPage("/", async () => "dashboard"), "dashboard");
  assert.match(await renderDashboardPage("/pricing.html", async () => "dashboard", new Date("2026-08-17T00:00:00Z")) ?? "", /当前模型价格/);
  assert.equal(await renderDashboardPage("/missing", async () => "dashboard"), null);
});

/** 离线自包含：uPlot 库与官方 CSS 必须内联进 HTML，不依赖任何 CDN。 */
test("buildDashboardHtml inlines the uPlot library and CSS for offline use", () => {
  const html = buildDashboardHtml(events, "5h", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  // uPlot IIFE 库源码（banner + 全局定义）内联
  assert.match(html, /uPlot \(v1\.6\.32\)/);
  assert.match(html, /var uPlot=function/);
  // uPlot 官方 CSS 内联
  assert.match(html, /\.u-legend/);
  // 不走 CDN：没有任何外链 script/style
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
});

/** 纵向柱柱顶数值标签由 bootstrap 的 draw-hook 插件绘制，HTML 应内联该插件。 */
test("buildDashboardHtml inlines the bar value-label draw hook", () => {
  const html = buildDashboardHtml(events, "this-week", new Date("2026-05-26T00:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"), [
    { date: "2026-05-25", userMessageCount: 3 },
    { date: "2026-05-26", userMessageCount: 7 },
  ]);
  assert.match(html, /barLabelHook/);
});

/** 读数走跟随 tooltip、原生 legend 关闭改自绘图例；内联 tooltip 与 2D / nearest-non-null 吸附。 */
test("buildDashboardHtml moves readouts to a follow tooltip with 2D snapping and custom legend", () => {
  const html = buildDashboardHtml(events, "5h", new Date("2026-05-26T01:00:00.000Z"), new Date("2026-05-26T06:00:00.000Z"));
  // 关掉 uPlot 原生 legend，改自绘图例
  assert.match(html, /legend: \{ show: false \}/);
  assert.match(html, /buildLegend/);
  assert.match(html, /"legendGroups":/);
  // 跟随 tooltip 浮层 + 2D 吸附 + nearest-non-null 兜底
  assert.match(html, /ccus-tooltip/);
  assert.match(html, /nearestNonNull/);
  assert.match(html, /dataIdx: nearestPointIdx/);
  // 时间轴改 24 小时制（去掉 uPlot 默认 12h + am/pm）
  assert.match(html, /function timeAxisVals/);
  assert.match(html, /xAxis\.values = timeAxisVals/);
});
