import { DashboardBucket, DashboardDailyMessagePoint, DashboardSummary, StatuslineEvent } from "../types";
import { buildSevenDayCurveFromEvents, computeCumulativeSevenDay, computeCumulativeSevenDayCurve } from "./aggregate";
import { ChartSpec, renderUplotChart, uplotBodyScripts, uplotHeadAssets } from "./chart-assets";
import { formatLocalTimestamp, roundNumber } from "./time";

/** 所有插入到 HTML/SVG 的动态文本都先转义，避免本地页面被注入内容。 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 简单平均值计算，配合 roundNumber 做展示层聚合。 */
function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 生成 dashboard 顶部卡片需要的摘要指标。
 *
 * 这里的 usage 指 Claude 的 5 小时额度使用率，而不是 context window 百分比。
 */
export function summarizeEvents(events: StatuslineEvent[]): DashboardSummary {
  const usages = events.map((event) => event.usagePct).filter((value): value is number => value !== null);
  const sevenDayUsages = events.map((event) => event.sevenDayUsagePct).filter((value): value is number => value !== null);
  const latestUsagePct = [...events]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .find((event) => event.usagePct !== null)?.usagePct ?? null;
  const latestSevenDayUsagePct = [...events]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .find((event) => event.sevenDayUsagePct !== null)?.sevenDayUsagePct ?? null;
  // 7d 分区叠加累计：与 aggregate 同一套「去毛刺 + 分段峰谷和」，口径与团队看板一致。
  const sevenDayCumulativeUsagePct = computeCumulativeSevenDay(buildSevenDayCurveFromEvents(events));

  return {
    fiveHourLatestUsagePct: latestUsagePct,
    fiveHourPeakUsagePct: usages.length > 0 ? roundNumber(Math.max(...usages), 1) : null,
    sevenDayLatestUsagePct: sevenDayUsages.length > 0 ? latestSevenDayUsagePct : null,
    sevenDayPeakUsagePct: sevenDayUsages.length > 0 ? roundNumber(Math.max(...sevenDayUsages), 1) : null,
    sevenDayCumulativeUsagePct,
    sampleCount: events.length,
    uniqueSessions: new Set(events.map((event) => event.sessionId).filter(Boolean)).size,
    uniqueWorkspaces: new Set(events.map((event) => event.workspaceDir).filter(Boolean)).size,
  };
}

/**
 * 把事件按固定时间桶聚合，供“5 小时额度使用率趋势”绘制使用。
 */
export function bucketizeEvents(events: StatuslineEvent[], start: Date, end: Date, bucketMinutes = 5): DashboardBucket[] {
  const bucketMs = bucketMinutes * 60 * 1000;
  // 5h 与 7d 在同一时间桶里各自独立收集：某条采样可能只带其中一项，不应互相牵连。
  const buckets = new Map<number, { fiveHour: number[]; sevenDay: number[] }>();
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += bucketMs) {
    buckets.set(cursor, { fiveHour: [], sevenDay: [] });
  }

  for (const event of events) {
    if (event.usagePct === null && event.sevenDayUsagePct === null) {
      continue;
    }
    const ts = new Date(event.timestamp).getTime();
    if (ts < start.getTime() || ts > end.getTime()) {
      continue;
    }
    const bucketStart = start.getTime() + Math.floor((ts - start.getTime()) / bucketMs) * bucketMs;
    const slot = buckets.get(bucketStart);
    if (!slot) {
      continue;
    }
    if (event.usagePct !== null) {
      slot.fiveHour.push(event.usagePct);
    }
    if (event.sevenDayUsagePct !== null) {
      slot.sevenDay.push(event.sevenDayUsagePct);
    }
  }

  // 7d 累计曲线（去毛刺 + 分段峰谷和的逐点版本）映射到时间桶：曲线已按时间升序，
  // 同桶内后写覆盖前写，最终每个桶留下落在其区间内最后一个累计点的值（单调，等于桶内最大累计）。
  const cumulativeByBucket = new Map<number, number>();
  for (const point of computeCumulativeSevenDayCurve(buildSevenDayCurveFromEvents(events))) {
    const ts = new Date(point.timestamp).getTime();
    if (ts < start.getTime() || ts > end.getTime()) {
      continue;
    }
    const bucketStart = start.getTime() + Math.floor((ts - start.getTime()) / bucketMs) * bucketMs;
    cumulativeByBucket.set(bucketStart, point.cumulative);
  }

  return [...buckets.entries()].map(([bucketStart, slot]) => ({
    bucketStart: new Date(bucketStart).toISOString(),
    avgUsagePct: slot.fiveHour.length > 0 ? roundNumber(average(slot.fiveHour), 1) : null,
    maxUsagePct: slot.fiveHour.length > 0 ? roundNumber(Math.max(...slot.fiveHour), 1) : null,
    minUsagePct: slot.fiveHour.length > 0 ? roundNumber(Math.min(...slot.fiveHour), 1) : null,
    avgSevenDayUsagePct: slot.sevenDay.length > 0 ? roundNumber(average(slot.sevenDay), 1) : null,
    cumulativeSevenDayPct: cumulativeByBucket.has(bucketStart) ? (cumulativeByBucket.get(bucketStart) as number) : null,
    sampleCount: slot.fiveHour.length,
  }));
}

/**
 * Claude 5h/7d 使用率趋势折线图（uPlot 渲染）。
 *
 * 只把「至少有一项有数据」的桶喂进 uPlot，缺失项填 null 配 spanGaps 连接，
 * 沿用现状「跨空桶相连、不被空桶拉回 0」的视觉。x 为桶时间戳（uPlot 走时间轴、
 * 本地时区自动按自然日/时刻打刻度），y 固定 0–100%。悬停由 uPlot 原生 cursor
 * 提供十字线 + legend 跟随显示两条线当前值。
 */
function renderChart(buckets: DashboardBucket[]): string {
  // 每条曲线只连有数据的桶：取「5h / 7d / 累计 任一非空」的桶作为统一 x 轴，缺失填 null。
  const valued = buckets.filter(
    (bucket) => bucket.maxUsagePct !== null || bucket.avgSevenDayUsagePct !== null || bucket.cumulativeSevenDayPct !== null,
  );

  const noData = valued.length === 0
    ? `<div class="empty-state">当前时间窗口里还没有可绘制的 Claude 使用率样本。</div>`
    : "";

  const xs = valued.map((bucket) => Math.floor(new Date(bucket.bucketStart).getTime() / 1000));
  const fiveHour = valued.map((bucket) => bucket.maxUsagePct);
  const sevenDay = valued.map((bucket) => bucket.avgSevenDayUsagePct);
  // 7d 分区叠加累计：量纲可远超 0–100%，单独走右侧 Y 轴（y2 自适应），避免压扁固定 0–100 的 5h/7d 主轴。
  const cumulative = valued.map((bucket) => bucket.cumulativeSevenDayPct);

  const spec: ChartSpec = {
    height: 280,
    xType: "time",
    yUnit: "%",
    yRange: [0, 100],
    y2: { scale: "y2", unit: "%", min0: true },
    series: [
      { label: "5 小时使用率", stroke: "#5eead4", fill: "rgba(94, 234, 212, 0.14)", width: 3 },
      { label: "7 天使用率", stroke: "#f59e0b", dash: [6, 4], width: 2 },
      { label: "7d 分区叠加累计", stroke: "#a855f7", width: 2, scale: "y2" },
    ],
    legendGroups: [
      { label: "5 小时使用率", color: "#5eead4", seriesIdx: [1] },
      { label: "7 天使用率", color: "#f59e0b", seriesIdx: [2] },
      { label: "7d 分区叠加累计", color: "#a855f7", seriesIdx: [3] },
    ],
  };
  const chart = valued.length > 0 ? renderUplotChart("chart-usage", spec, [xs, fiveHour, sevenDay, cumulative]) : "";

  return `
    <section class="panel chart-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Recent Trend</p>
          <h2>Claude 使用率趋势</h2>
        </div>
        <p class="muted">按采样时间聚合：5h（实线）来自 rate_limits.five_hour，7d（虚线）来自 rate_limits.seven_day；紫色「7d 分区叠加累计」走右侧 Y 轴，是把 7d 锯齿波还原成的累计真实使用量（口径同团队看板）</p>
      </div>
      ${noData}
      ${chart}
    </section>
  `;
}

/**
 * 根据时间窗口跨度自适应选择曲线分桶粒度。
 *
 * today/5h 这类短窗口保持 5 分钟桶；this-week/last-week 这类跨多天窗口改用小时桶，
 * 否则一周会产生上千个点，曲线既慢又糊。
 */
function pickBucketMinutes(start: Date, end: Date): number {
  const spanMs = end.getTime() - start.getTime();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  return spanMs > twoDaysMs ? 60 : 5;
}

/**
 * 每日用户消息数柱状图。
 *
 * 口径与导出契约的 `userMessageCount` 一致：来自 Claude 本地 transcript 的真实用户请求数，
 * 不是 statusline 采样数，也不是 API 请求数。
 */
function renderDailyMessages(points: DashboardDailyMessagePoint[]): string {
  if (points.length === 0) {
    return "";
  }

  const total = points.reduce((sum, point) => sum + point.userMessageCount, 0);

  // 离散「天」用 category x（索引 0..n-1 + 月-日标签），单系列纵向柱；uPlot.paths.bars
  // 画柱、draw-hook 在柱顶标数值，cursor 悬停某天在 legend 显示当日计数。
  const xs = points.map((_, index) => index);
  const counts = points.map((point) => point.userMessageCount);
  const xLabels = points.map((point) => point.date.slice(5));

  const spec: ChartSpec = {
    height: 280,
    xType: "category",
    xLabels,
    yMin0: true,
    bars: true,
    series: [{ label: "用户消息数", stroke: "#5eead4", fill: "rgba(94, 234, 212, 0.55)", width: 1 }],
    legendGroups: [{ label: "用户消息数", color: "#5eead4", seriesIdx: [1] }],
  };
  const chart = renderUplotChart("chart-daily-messages", spec, [xs, counts]);

  const noData = total === 0
    ? `<div class="empty-state">当前时间窗口里还没有统计到 Claude 用户消息。</div>`
    : "";

  return `
    <section class="panel chart-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Daily Messages</p>
          <h2>每日用户消息数</h2>
        </div>
        <p class="muted">按自然日统计的真实用户请求数（口径同导出 userMessageCount），共 ${total} 条</p>
      </div>
      ${noData}
      ${chart}
    </section>
  `;
}

/** 摘要卡片统一的空值展示策略。 */
function statValue(value: number | null, suffix = "%"): string {
  return value === null ? "--" : `${value.toFixed(1)}${suffix}`;
}

/** 最近事件表帮助回看 statusline 在某一时刻到底输出了什么。 */
function renderRecentEvents(events: StatuslineEvent[]): string {
  const rows = [...events]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, 20)
    .map(
      (event) => `
      <tr>
        <td>${escapeHtml(formatLocalTimestamp(new Date(event.timestamp)))}</td>
        <td>${escapeHtml(event.workspaceName ?? "--")}</td>
        <td>${escapeHtml(event.modelName ?? "--")}</td>
        <td>${escapeHtml(event.sessionId ?? "--")}</td>
        <td>${escapeHtml(event.usagePct === null ? "--" : `${event.usagePct.toFixed(1)}%`)}</td>
        <td>${escapeHtml(event.statusLine)}</td>
      </tr>`,
    )
    .join("");

  return `
    <section class="panel table-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Recent Events</p>
          <h2>最近 20 条采样</h2>
        </div>
        <p class="muted">按时间倒序展示，便于回看 Claude 5 小时使用率与上下文占用。</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>项目</th>
              <th>模型</th>
              <th>Session</th>
              <th>5h 使用率</th>
              <th>Statusline</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

/**
 * 生成完整静态 HTML。
 *
 * 整个 dashboard 保持“单文件可打开”，方便导出和直接分享本地结果。
 */
export function buildDashboardHtml(
  events: StatuslineEvent[],
  rangeLabel: string,
  start: Date,
  end: Date,
  dailyUserMessages: DashboardDailyMessagePoint[] = [],
): string {
  const summary = summarizeEvents(events);
  const buckets = bucketizeEvents(events, start, end, pickBucketMinutes(start, end));
  const totalUserMessages = dailyUserMessages.reduce((sum, point) => sum + point.userMessageCount, 0);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ccus dashboard</title>
    <style>
      :root {
        --bg: #0a0d12;
        --panel: rgba(16, 21, 31, 0.84);
        --panel-border: rgba(120, 141, 173, 0.18);
        --text: #ecf3ff;
        --muted: #91a0b8;
        --accent: #5eead4;
        --accent-strong: #22c55e;
        --warning: #f59e0b;
        --grid: rgba(145, 160, 184, 0.15);
        --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(34, 197, 94, 0.18), transparent 30%),
          radial-gradient(circle at top right, rgba(94, 234, 212, 0.16), transparent 28%),
          linear-gradient(160deg, #06080c 0%, #0a0d12 48%, #101520 100%);
        min-height: 100vh;
      }
      .shell {
        max-width: 1180px;
        margin: 0 auto;
        padding: 40px 24px 64px;
      }
      .hero {
        display: grid;
        gap: 16px;
        padding: 28px 0 18px;
      }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 0.14em;
        font-size: 12px;
      }
      h1, h2, p { margin: 0; }
      h1 {
        font-size: clamp(36px, 5vw, 60px);
        line-height: 0.95;
        font-weight: 600;
      }
      .subtitle {
        max-width: 820px;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
      }
      .hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        color: var(--muted);
        font-size: 14px;
      }
      .hero-chip {
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--panel-border);
        background: rgba(9, 12, 18, 0.56);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 16px;
        margin: 24px 0 28px;
      }
      .panel {
        background: var(--panel);
        backdrop-filter: blur(18px);
        border: 1px solid var(--panel-border);
        border-radius: 24px;
        box-shadow: var(--shadow);
      }
      .stat-card {
        padding: 20px;
        min-height: 128px;
      }
      .stat-card h2 {
        font-size: 14px;
        color: var(--muted);
        font-weight: 500;
      }
      .stat-value {
        margin-top: 16px;
        font-size: 40px;
        line-height: 0.95;
      }
      .stat-note {
        margin-top: 12px;
        color: var(--muted);
        font-size: 14px;
      }
      .panel-header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 16px;
        padding: 24px 24px 0;
      }
      .panel-header h2 {
        font-size: 28px;
        line-height: 1;
      }
      .muted {
        color: var(--muted);
        font-size: 14px;
      }
      .chart-panel { padding-bottom: 22px; }
      .empty-state {
        margin: 18px 24px 0;
        padding: 16px 18px;
        border-radius: 16px;
        background: rgba(145, 160, 184, 0.08);
        color: var(--muted);
      }
      .table-panel { margin-top: 22px; }
      .table-wrap { overflow: auto; padding: 16px 20px 22px; }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 760px;
      }
      th, td {
        text-align: left;
        padding: 12px 10px;
        border-bottom: 1px solid rgba(145, 160, 184, 0.12);
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 500;
      }
      td { font-size: 14px; }
      code {
        font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
        font-size: 12px;
      }
      @media (max-width: 720px) {
        .shell { padding-inline: 16px; }
        .panel-header { flex-direction: column; align-items: start; }
      }
    </style>
    ${uplotHeadAssets()}
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div>
          <p class="eyebrow">Claude Code Usage Surface</p>
          <h1>ccus dashboard</h1>
        </div>
        <p class="subtitle">围绕 Claude Code statusline 的本地采样面板。每次刷新记录一条事件，再把 Claude 自带的 5 小时使用率百分比随时间的变化绘制成静态 Web 页面，适合快速回看与导出周报。</p>
        <div class="hero-meta">
          <span class="hero-chip">时间范围：${escapeHtml(rangeLabel)}</span>
          <span class="hero-chip">开始：${escapeHtml(formatLocalTimestamp(start))}</span>
          <span class="hero-chip">结束：${escapeHtml(formatLocalTimestamp(end))}</span>
          <span class="hero-chip">事件：${summary.sampleCount}</span>
        </div>
      </section>
      <section class="stats">
        <article class="panel stat-card">
          <h2>Latest 5h usage</h2>
          <p class="stat-value">${escapeHtml(statValue(summary.fiveHourLatestUsagePct))}</p>
          <p class="stat-note">最后一条有效 5 小时 usage 样本</p>
        </article>
        <article class="panel stat-card">
          <h2>Peak 5h usage</h2>
          <p class="stat-value">${escapeHtml(statValue(summary.fiveHourPeakUsagePct))}</p>
          <p class="stat-note">窗口内观测到的 5 小时使用率峰值</p>
        </article>
        <article class="panel stat-card">
          <h2>7d 分区叠加累计</h2>
          <p class="stat-value">${escapeHtml(statValue(summary.sevenDayCumulativeUsagePct))}</p>
          <p class="stat-note">7 天额度分区叠加累计真实使用量 · 峰值 ${escapeHtml(statValue(summary.sevenDayPeakUsagePct))} · 最新 ${escapeHtml(statValue(summary.sevenDayLatestUsagePct))}</p>
        </article>
        <article class="panel stat-card">
          <h2>用户消息数</h2>
          <p class="stat-value">${totalUserMessages}</p>
          <p class="stat-note">窗口内每日真实用户请求数合计</p>
        </article>
      </section>
      ${renderChart(buckets)}
      ${renderDailyMessages(dailyUserMessages)}
      ${renderRecentEvents(events)}
    </main>
    ${uplotBodyScripts()}
  </body>
</html>`;
}
