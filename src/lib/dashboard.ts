import { DashboardBucket, DashboardSummary, StatuslineEvent } from "../types";
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
  const latestUsagePct = [...events]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .find((event) => event.usagePct !== null)?.usagePct ?? null;

  return {
    latestUsagePct,
    averageUsagePct: usages.length > 0 ? roundNumber(average(usages), 1) : null,
    peakUsagePct: usages.length > 0 ? roundNumber(Math.max(...usages), 1) : null,
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
  const buckets = new Map<number, number[]>();
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += bucketMs) {
    buckets.set(cursor, []);
  }

  for (const event of events) {
    if (event.usagePct === null) {
      continue;
    }
    const ts = new Date(event.timestamp).getTime();
    if (ts < start.getTime() || ts > end.getTime()) {
      continue;
    }
    const bucketStart = start.getTime() + Math.floor((ts - start.getTime()) / bucketMs) * bucketMs;
    const values = buckets.get(bucketStart);
    if (values) {
      values.push(event.usagePct);
    }
  }

  return [...buckets.entries()].map(([bucketStart, values]) => ({
    bucketStart: new Date(bucketStart).toISOString(),
    avgUsagePct: values.length > 0 ? roundNumber(average(values), 1) : null,
    maxUsagePct: values.length > 0 ? roundNumber(Math.max(...values), 1) : null,
    minUsagePct: values.length > 0 ? roundNumber(Math.min(...values), 1) : null,
    sampleCount: values.length,
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
  const values = buckets.map((bucket) => bucket.avgUsagePct ?? 0);
  const points = buckets.map((bucket, index) => {
    const x = paddingX + (index / Math.max(buckets.length - 1, 1)) * innerWidth;
    const usage = bucket.avgUsagePct ?? 0;
    const y = paddingY + ((100 - usage) / 100) * innerHeight;
    return { x, y, usage, label: formatLocalTimestamp(new Date(bucket.bucketStart)) };
  });
  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${points.at(-1)?.x.toFixed(2) ?? paddingX} ${(height - paddingY).toFixed(2)} L${points[0]?.x.toFixed(2) ?? paddingX} ${(height - paddingY).toFixed(2)} Z`;

  const ticks = [0, 25, 50, 75, 100].map((tick) => {
    const y = paddingY + ((100 - tick) / 100) * innerHeight;
    return `<g><line x1="${paddingX}" x2="${width - paddingX}" y1="${y}" y2="${y}" class="chart-grid" /><text x="8" y="${y + 4}" class="chart-axis">${tick}%</text></g>`;
  }).join("");

  const markers = points
    .filter((_, index) => index === points.length - 1 || index % Math.max(Math.floor(points.length / 6), 1) === 0)
    .map((point) => `<g><line x1="${point.x}" x2="${point.x}" y1="${height - paddingY}" y2="${height - paddingY + 6}" class="chart-axis-line" /><text x="${point.x}" y="${height - 2}" text-anchor="middle" class="chart-axis">${escapeHtml(point.label)}</text></g>`)
    .join("");

  const tooltips = points
    .filter((point) => point.usage > 0)
    .map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3.5" class="chart-point"><title>${escapeHtml(point.label)} · ${point.usage.toFixed(1)}%</title></circle>`)
    .join("");

  const noData = values.every((value) => value === 0)
    ? `<div class="empty-state">当前时间窗口里还没有可绘制的 Claude 5 小时使用率样本。</div>`
    : "";

  return `
    <section class="panel chart-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Recent Trend</p>
          <h2>Claude 5 小时使用率趋势</h2>
        </div>
        <p class="muted">按采样时间聚合，Y 轴为 rate_limits.five_hour.used_percentage</p>
      </div>
      ${noData}
      <svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Claude 5 小时使用率趋势">
        ${ticks}
        <path d="${areaPath}" class="chart-area"></path>
        <path d="${linePath}" class="chart-line"></path>
        ${markers}
        ${tooltips}
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
export function buildDashboardHtml(events: StatuslineEvent[], rangeLabel: string, start: Date, end: Date): string {
  const summary = summarizeEvents(events);
  const buckets = bucketizeEvents(events, start, end, 5);

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
          <h2>Latest usage</h2>
          <p class="stat-value">${escapeHtml(statValue(summary.latestUsagePct))}</p>
          <p class="stat-note">最后一条有效 usage 样本</p>
        </article>
        <article class="panel stat-card">
          <h2>Average usage</h2>
          <p class="stat-value">${escapeHtml(statValue(summary.averageUsagePct))}</p>
          <p class="stat-note">当前窗口内的平均使用率</p>
        </article>
        <article class="panel stat-card">
          <h2>Peak usage</h2>
          <p class="stat-value">${escapeHtml(statValue(summary.peakUsagePct))}</p>
          <p class="stat-note">窗口内观测到的峰值</p>
        </article>
        <article class="panel stat-card">
          <h2>Sessions</h2>
          <p class="stat-value">${summary.uniqueSessions}</p>
          <p class="stat-note">去重 session 数</p>
        </article>
        <article class="panel stat-card">
          <h2>Workspaces</h2>
          <p class="stat-value">${summary.uniqueWorkspaces}</p>
          <p class="stat-note">去重项目目录数</p>
        </article>
      </section>
      ${renderChart(buckets)}
      ${renderRecentEvents(events)}
    </main>
  </body>
</html>`;
}
