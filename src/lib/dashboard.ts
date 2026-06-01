import { DashboardBucket, DashboardDailyMessagePoint, DashboardSummary, StatuslineEvent } from "../types";
import { formatLocalTimestamp, localDateKey, roundNumber } from "./time";

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

  return {
    fiveHourLatestUsagePct: latestUsagePct,
    fiveHourPeakUsagePct: usages.length > 0 ? roundNumber(Math.max(...usages), 1) : null,
    sevenDayLatestUsagePct: sevenDayUsages.length > 0 ? latestSevenDayUsagePct : null,
    sevenDayPeakUsagePct: sevenDayUsages.length > 0 ? roundNumber(Math.max(...sevenDayUsages), 1) : null,
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

  return [...buckets.entries()].map(([bucketStart, slot]) => ({
    bucketStart: new Date(bucketStart).toISOString(),
    avgUsagePct: slot.fiveHour.length > 0 ? roundNumber(average(slot.fiveHour), 1) : null,
    maxUsagePct: slot.fiveHour.length > 0 ? roundNumber(Math.max(...slot.fiveHour), 1) : null,
    minUsagePct: slot.fiveHour.length > 0 ? roundNumber(Math.min(...slot.fiveHour), 1) : null,
    avgSevenDayUsagePct: slot.sevenDay.length > 0 ? roundNumber(average(slot.sevenDay), 1) : null,
    sampleCount: slot.fiveHour.length,
  }));
}

/** 直接输出内联 SVG 曲线图，避免额外引入前端框架或图表依赖。 */
function renderChart(buckets: DashboardBucket[]): string {
  const width = 920;
  const height = 280;
  const paddingX = 36;
  const paddingY = 28;
  const innerWidth = width - paddingX * 2;
  const innerHeight = height - paddingY * 2;
  const xOf = (index: number): number => paddingX + (index / Math.max(buckets.length - 1, 1)) * innerWidth;
  const yOf = (usage: number): number => paddingY + ((100 - usage) / 100) * innerHeight;

  // 每条曲线只连有数据的桶，跨空桶直接相连，避免周视图里大量空桶把线拉回 0 变成锯齿。
  const collectPoints = (accessor: (bucket: DashboardBucket) => number | null) =>
    buckets
      .map((bucket, index) => ({ index, value: accessor(bucket), bucket }))
      .filter((entry): entry is { index: number; value: number; bucket: DashboardBucket } => entry.value !== null)
      .map((entry) => ({
        x: xOf(entry.index),
        y: yOf(entry.value),
        usage: entry.value,
        label: formatLocalTimestamp(new Date(entry.bucket.bucketStart)),
      }));

  const fiveHourPoints = collectPoints((bucket) => bucket.avgUsagePct);
  const sevenDayPoints = collectPoints((bucket) => bucket.avgSevenDayUsagePct);

  const linePathOf = (points: { x: number; y: number }[]): string =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");

  const fiveHourLine = linePathOf(fiveHourPoints);
  const fiveHourArea = fiveHourPoints.length > 0
    ? `${fiveHourLine} L${fiveHourPoints.at(-1)!.x.toFixed(2)} ${(height - paddingY).toFixed(2)} L${fiveHourPoints[0].x.toFixed(2)} ${(height - paddingY).toFixed(2)} Z`
    : "";
  const sevenDayLine = linePathOf(sevenDayPoints);

  const ticks = [0, 25, 50, 75, 100].map((tick) => {
    const y = yOf(tick);
    return `<g><line x1="${paddingX}" x2="${width - paddingX}" y1="${y}" y2="${y}" class="chart-grid" /><text x="8" y="${y + 4}" class="chart-axis">${tick}%</text></g>`;
  }).join("");

  // 跨多天的窗口（this-week / last-week）x 轴按自然日打刻度，每天一格、标签只显示月-日，
  // 更像“周视图”；当天/短窗口仍按时间桶等距取约 6 个时:分刻度。
  const firstTs = buckets.length > 0 ? new Date(buckets[0].bucketStart).getTime() : 0;
  const lastTs = buckets.length > 0 ? new Date(buckets.at(-1)!.bucketStart).getTime() : 0;
  const multiDay = lastTs - firstTs > 2 * 24 * 60 * 60 * 1000;

  let markerEntries: { index: number; label: string }[];
  if (multiDay) {
    const seenDays = new Set<string>();
    markerEntries = buckets
      .map((bucket, index) => ({ index, day: localDateKey(new Date(bucket.bucketStart)) }))
      .filter((entry) => {
        if (seenDays.has(entry.day)) {
          return false;
        }
        seenDays.add(entry.day);
        return true;
      })
      .map((entry) => ({ index: entry.index, label: entry.day.slice(5) }));
  } else {
    markerEntries = buckets
      .map((bucket, index) => ({ index, label: formatLocalTimestamp(new Date(bucket.bucketStart)) }))
      .filter((_, index) => index === buckets.length - 1 || index % Math.max(Math.floor(buckets.length / 6), 1) === 0);
  }

  const markers = markerEntries
    .map((entry) => {
      const x = xOf(entry.index);
      return `<g><line x1="${x}" x2="${x}" y1="${height - paddingY}" y2="${height - paddingY + 6}" class="chart-axis-line" /><text x="${x}" y="${height - 2}" text-anchor="middle" class="chart-axis">${escapeHtml(entry.label)}</text></g>`;
    })
    .join("");

  const dotsOf = (points: { x: number; y: number; usage: number; label: string }[], pointClass: string, seriesLabel: string): string =>
    points
      .map((point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3.5" class="${pointClass}"><title>${escapeHtml(point.label)} · ${seriesLabel} ${point.usage.toFixed(1)}%</title></circle>`)
      .join("");

  const noData = fiveHourPoints.length === 0 && sevenDayPoints.length === 0
    ? `<div class="empty-state">当前时间窗口里还没有可绘制的 Claude 使用率样本。</div>`
    : "";

  return `
    <section class="panel chart-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Recent Trend</p>
          <h2>Claude 使用率趋势</h2>
        </div>
        <p class="muted">按采样时间聚合，5h 来自 rate_limits.five_hour，7d 来自 rate_limits.seven_day</p>
      </div>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-swatch legend-5h"></span>5 小时使用率</span>
        <span class="legend-item"><span class="legend-swatch legend-7d"></span>7 天使用率</span>
      </div>
      ${noData}
      <svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Claude 使用率趋势（5h 与 7d）">
        ${ticks}
        ${fiveHourArea ? `<path d="${fiveHourArea}" class="chart-area"></path>` : ""}
        ${sevenDayLine ? `<path d="${sevenDayLine}" class="chart-line chart-line-7d"></path>` : ""}
        ${fiveHourLine ? `<path d="${fiveHourLine}" class="chart-line"></path>` : ""}
        ${markers}
        ${dotsOf(sevenDayPoints, "chart-point chart-point-7d", "7d")}
        ${dotsOf(fiveHourPoints, "chart-point", "5h")}
      </svg>
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
  const maxCount = Math.max(...points.map((point) => point.userMessageCount), 1);
  const width = 920;
  const height = 280;
  const paddingX = 36;
  const paddingY = 28;
  const innerWidth = width - paddingX * 2;
  const innerHeight = height - paddingY * 2;
  const slot = innerWidth / points.length;
  const barWidth = Math.max(Math.min(slot * 0.62, 48), 2);

  const bars = points
    .map((point, index) => {
      const cx = paddingX + slot * (index + 0.5);
      const barHeight = (point.userMessageCount / maxCount) * innerHeight;
      const y = paddingY + (innerHeight - barHeight);
      const dayLabel = point.date.slice(5);
      return `<g>
        <rect x="${(cx - barWidth / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(barHeight, 0).toFixed(2)}" rx="4" class="bar"><title>${escapeHtml(dayLabel)} · ${point.userMessageCount} 条</title></rect>
        <text x="${cx.toFixed(2)}" y="${(y - 6).toFixed(2)}" text-anchor="middle" class="bar-value">${point.userMessageCount > 0 ? point.userMessageCount : ""}</text>
        <text x="${cx.toFixed(2)}" y="${(height - 8).toFixed(2)}" text-anchor="middle" class="chart-axis">${escapeHtml(dayLabel)}</text>
      </g>`;
    })
    .join("");

  const baselineY = paddingY + innerHeight;
  const baseline = `<line x1="${paddingX}" x2="${width - paddingX}" y1="${baselineY}" y2="${baselineY}" class="chart-axis-line" />`;

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
      <svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="每日用户消息数">
        ${baseline}
        ${bars}
      </svg>
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
      .chart {
        width: 100%;
        height: auto;
        display: block;
        padding: 12px 20px 6px;
      }
      .chart-grid { stroke: var(--grid); stroke-width: 1; }
      .chart-axis { fill: var(--muted); font-size: 11px; }
      .chart-axis-line { stroke: var(--grid); stroke-width: 1; }
      .chart-area { fill: rgba(94, 234, 212, 0.14); }
      .chart-line { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
      .chart-point { fill: var(--accent); }
      .chart-line-7d { stroke: var(--warning); stroke-dasharray: 6 4; }
      .chart-point-7d { fill: var(--warning); }
      .chart-legend {
        display: flex;
        gap: 18px;
        padding: 10px 24px 0;
        color: var(--muted);
        font-size: 13px;
      }
      .legend-item { display: inline-flex; align-items: center; gap: 8px; }
      .legend-swatch { width: 18px; height: 0; border-top-width: 3px; border-top-style: solid; }
      .legend-5h { border-top-color: var(--accent); }
      .legend-7d { border-top-color: var(--warning); border-top-style: dashed; }
      .bar { fill: rgba(94, 234, 212, 0.55); }
      .bar:hover { fill: var(--accent); }
      .bar-value { fill: var(--muted); font-size: 11px; }
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
          <h2>Latest 7d usage</h2>
          <p class="stat-value">${escapeHtml(statValue(summary.sevenDayLatestUsagePct))}</p>
          <p class="stat-note">最新 7 天 usage 样本，峰值 ${escapeHtml(statValue(summary.sevenDayPeakUsagePct))}</p>
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
  </body>
</html>`;
}
