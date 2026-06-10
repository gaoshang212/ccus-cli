import { AggregatedDailyRow, AggregatedEventRow, AggregatedWeeklyRow } from "../types";
import { roundNumber } from "./time";

/** 把多人 aggregate 行按 personKey 汇总成的一个人的总账。 */
export interface AggregatePersonSummary {
  personKey: string;
  userMessageCount: number;
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  sampleCount: number;
  uniqueSessions: number;
  uniqueWorkspaces: number;
  fiveHourPeakUsagePct: number | null;
  fiveHourLatestUsagePct: number | null;
  sevenDayPeakUsagePct: number | null;
  sevenDayLatestUsagePct: number | null;
  /** 与 weekly.csv 同源：把该人各周 weekly 行的 sevenDayCumulativeUsagePct 相加（无有效值则 null）。 */
  sevenDayCumulativeUsagePct: number | null;
  activeDays: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** aggregate dashboard 顶部展示用的总盘摘要。 */
export interface AggregateOverallSummary {
  personCount: number;
  totalUserMessageCount: number;
  totalApiRequestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalSampleCount: number;
  startDate: string | null;
  endDate: string | null;
}

/** 折线 / 图例统一的调色板，保证同一个人在不同图表里颜色一致。 */
const CHART_PALETTE = ["#5eead4", "#f59e0b", "#a855f7", "#22c55e", "#f87171", "#60a5fa", "#fbbf24", "#34d399"];

/**
 * 7d 虚线专用的配套色板，和 CHART_PALETTE 同序号但色相强反差。
 *
 * 5h / 7d 同图叠加时，5h 用 CHART_PALETTE 实线、7d 用这套对比色虚线，
 * 避免两条线颜色太接近看不清；人物对应关系靠图例里的双色点维持。
 */
const SEVEN_DAY_PALETTE = ["#fb7185", "#38bdf8", "#facc15", "#e879f9", "#4ade80", "#fb923c", "#818cf8", "#f472b6"];

/** 所有插入到 HTML 的文本字段都要先转义，避免本地页面被注入。 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function maxOrNull(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

/**
 * 按 personKey 聚合 daily 行，得到每个人的“整段时间”账单。
 *
 * 这里只信任 daily.csv 的口径，确保数字和 aggregate 输出的 CSV 一致。
 */
export function summarizePeople(dailyRows: AggregatedDailyRow[], weeklyRows: AggregatedWeeklyRow[] = []): AggregatePersonSummary[] {
  const grouped = new Map<string, AggregatedDailyRow[]>();
  for (const row of dailyRows) {
    const items = grouped.get(row.personKey);
    if (items) {
      items.push(row);
    } else {
      grouped.set(row.personKey, [row]);
    }
  }

  // 累计 7d 走 weekly.csv 同源：按 personKey 把各周 weekly 行的累计值相加（weekly ≥ Σ daily，不能用 daily 求和）。
  const cumulativeByPerson = new Map<string, number | null>();
  for (const row of weeklyRows) {
    if (row.sevenDayCumulativeUsagePct === null) {
      continue;
    }
    const current = cumulativeByPerson.get(row.personKey);
    cumulativeByPerson.set(row.personKey, (current ?? 0) + row.sevenDayCumulativeUsagePct);
  }

  const summaries: AggregatePersonSummary[] = [];
  for (const [personKey, items] of grouped.entries()) {
    const sortedByDate = [...items].sort((left, right) => left.date.localeCompare(right.date));
    const latestRowWithUsage = [...sortedByDate]
      .reverse()
      .find((row) => row.fiveHourLatestUsagePct !== null);
    const latestRowWithSevenDay = [...sortedByDate]
      .reverse()
      .find((row) => row.sevenDayLatestUsagePct !== null);
    const activeDays = items.filter((row) => row.sampleCount > 0 || row.userMessageCount > 0 || row.apiRequestCount > 0).length;

    summaries.push({
      personKey,
      userMessageCount: items.reduce((sum, row) => sum + row.userMessageCount, 0),
      apiRequestCount: items.reduce((sum, row) => sum + row.apiRequestCount, 0),
      inputTokens: items.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: items.reduce((sum, row) => sum + row.outputTokens, 0),
      cacheReadInputTokens: items.reduce((sum, row) => sum + row.cacheReadInputTokens, 0),
      sampleCount: items.reduce((sum, row) => sum + row.sampleCount, 0),
      uniqueSessions: items.reduce((sum, row) => sum + row.uniqueSessions, 0),
      uniqueWorkspaces: items.reduce((sum, row) => sum + row.uniqueWorkspaces, 0),
      fiveHourPeakUsagePct: maxOrNull(items.map((row) => row.fiveHourPeakUsagePct)),
      fiveHourLatestUsagePct: latestRowWithUsage?.fiveHourLatestUsagePct ?? null,
      sevenDayPeakUsagePct: maxOrNull(items.map((row) => row.sevenDayPeakUsagePct)),
      sevenDayLatestUsagePct: latestRowWithSevenDay?.sevenDayLatestUsagePct ?? null,
      sevenDayCumulativeUsagePct: cumulativeByPerson.get(personKey) ?? null,
      activeDays,
      firstDate: sortedByDate[0]?.date ?? null,
      lastDate: sortedByDate.at(-1)?.date ?? null,
    });
  }

  return summaries.sort((left, right) => {
    if (right.userMessageCount !== left.userMessageCount) {
      return right.userMessageCount - left.userMessageCount;
    }
    return left.personKey.localeCompare(right.personKey);
  });
}

/** 把整体摘要算出来，方便顶部卡片直接展示。 */
export function summarizeOverall(dailyRows: AggregatedDailyRow[], people: AggregatePersonSummary[]): AggregateOverallSummary {
  const dates = dailyRows.map((row) => row.date).sort((left, right) => left.localeCompare(right));
  return {
    personCount: people.length,
    totalUserMessageCount: people.reduce((sum, person) => sum + person.userMessageCount, 0),
    totalApiRequestCount: people.reduce((sum, person) => sum + person.apiRequestCount, 0),
    totalInputTokens: people.reduce((sum, person) => sum + person.inputTokens, 0),
    totalOutputTokens: people.reduce((sum, person) => sum + person.outputTokens, 0),
    totalCacheReadInputTokens: people.reduce((sum, person) => sum + person.cacheReadInputTokens, 0),
    totalSampleCount: people.reduce((sum, person) => sum + person.sampleCount, 0),
    startDate: dates[0] ?? null,
    endDate: dates.at(-1) ?? null,
  };
}

/** 列出所有日期键，用于在按日柱状图上对齐 X 轴。 */
function collectDateAxis(dailyRows: AggregatedDailyRow[]): string[] {
  const set = new Set(dailyRows.map((row) => row.date));
  return [...set].sort((left, right) => left.localeCompare(right));
}

/** 按 (personKey, date) 索引 daily 行，便于在不同视图里 O(1) 拿到原始数据。 */
function indexDailyRows(dailyRows: AggregatedDailyRow[]): Map<string, AggregatedDailyRow> {
  const map = new Map<string, AggregatedDailyRow>();
  for (const row of dailyRows) {
    map.set(`${row.personKey}|${row.date}`, row);
  }
  return map;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** token 数统一换算成百万展示，避免长串数字铺满表格列。 */
function formatTokensM(value: number): string {
  const millions = value / 1_000_000;
  return `${millions.toFixed(2)} M`;
}

function statValue(value: number | null, suffix = "%"): string {
  return value === null ? "--" : `${value.toFixed(1)}${suffix}`;
}

/**
 * 把每个人“按天用户请求数”渲染成 SVG 折线图。
 *
 * 让多个人的活跃度一眼可比，重点在节奏对比而不是绝对值精度。
 * 这里的“用户请求数”指 transcript 里的 `type:"user"` 事件，已剔除 tool_result 工具结果回填；
 * sidechain（子 agent）会话里的用户提示仍计入。
 */
function renderDailyUserRequestChart(people: AggregatePersonSummary[], dailyIndex: Map<string, AggregatedDailyRow>, dateAxis: string[]): string {
  if (people.length === 0 || dateAxis.length === 0) {
    return `
      <section class="panel chart-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Daily User Requests</p>
            <h2>每日用户请求数对比</h2>
          </div>
          <p class="muted">没有可绘制的日度数据。</p>
        </div>
      </section>
    `;
  }

  const width = 920;
  const height = 320;
  const paddingX = 56;
  const paddingY = 32;
  const innerWidth = width - paddingX * 2;
  const innerHeight = height - paddingY * 2;

  const seriesData = people.map((person) => ({
    person,
    values: dateAxis.map((date) => dailyIndex.get(`${person.personKey}|${date}`)?.userMessageCount ?? 0),
  }));
  const maxValue = Math.max(1, ...seriesData.flatMap((series) => series.values));
  const palette = CHART_PALETTE;

  const xFor = (index: number): number => paddingX + (index / Math.max(dateAxis.length - 1, 1)) * innerWidth;
  const yFor = (value: number): number => paddingY + (1 - value / maxValue) * innerHeight;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const tickValue = Math.round(maxValue * fraction);
    const y = paddingY + (1 - fraction) * innerHeight;
    return `<g><line x1="${paddingX}" x2="${width - paddingX}" y1="${y}" y2="${y}" class="chart-grid" /><text x="8" y="${y + 4}" class="chart-axis">${formatNumber(tickValue)}</text></g>`;
  }).join("");

  const stride = Math.max(1, Math.floor(dateAxis.length / 7));
  const xLabels = dateAxis
    .map((date, index) => ({ date, index }))
    .filter(({ index }) => index === dateAxis.length - 1 || index % stride === 0)
    .map(({ date, index }) => {
      const x = xFor(index);
      return `<g><line x1="${x}" x2="${x}" y1="${height - paddingY}" y2="${height - paddingY + 6}" class="chart-axis-line" /><text x="${x}" y="${height - 4}" text-anchor="middle" class="chart-axis">${escapeHtml(date.slice(5))}</text></g>`;
    })
    .join("");

  const seriesPaths = seriesData
    .map((series, seriesIndex) => {
      const color = palette[seriesIndex % palette.length];
      const path = series.values
        .map((value, index) => `${index === 0 ? "M" : "L"}${xFor(index).toFixed(2)} ${yFor(value).toFixed(2)}`)
        .join(" ");
      const points = series.values
        .map(
          (value, index) =>
            `<circle cx="${xFor(index).toFixed(2)}" cy="${yFor(value).toFixed(2)}" r="3" fill="${color}"><title>${escapeHtml(series.person.personKey)} · ${escapeHtml(dateAxis[index])} · ${formatNumber(value)} 用户请求</title></circle>`,
        )
        .join("");
      return `<g data-person="${escapeHtml(series.person.personKey)}"><path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />${points}</g>`;
    })
    .join("");

  const legend = seriesData
    .map((series, seriesIndex) => {
      const color = palette[seriesIndex % palette.length];
      return `<span class="legend-chip legend-toggle" data-person="${escapeHtml(series.person.personKey)}"><span class="legend-dot" style="background:${color}"></span>${escapeHtml(series.person.personKey)}</span>`;
    })
    .join("");

  return `
    <section class="panel chart-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Daily User Requests</p>
          <h2>每日用户请求数对比</h2>
        </div>
        <p class="muted">基于每人 daily 汇总中的 userMessageCount（已剔除 tool_result 工具回填；sidechain 子 agent 提示保留）。点击图例人名可只高亮该人曲线。</p>
      </div>
      <div class="legend">${legend}</div>
      <svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="每日用户请求数对比">
        ${ticks}
        ${xLabels}
        ${seriesPaths}
      </svg>
    </section>
  `;
}

/**
 * 用横向条形图对比每个人的「周使用量（7 天额度）峰值」。
 *
 * 7 天额度是 Claude 给出的滚动周额度使用率，峰值代表这段时间里每个人最接近用满周额度的程度。
 * 条长按固定的 100% 满刻度归一，直接反映绝对使用率水平；右侧仍标注绝对百分比。
 */
function renderSevenDayPeakChart(people: AggregatePersonSummary[]): string {
  const ranked = people
    .filter((person) => person.sevenDayPeakUsagePct !== null)
    .sort((left, right) => (right.sevenDayPeakUsagePct ?? 0) - (left.sevenDayPeakUsagePct ?? 0));

  if (ranked.length === 0) {
    return `
      <section class="panel chart-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Weekly Peak Usage</p>
            <h2>周使用量峰值对比</h2>
          </div>
          <p class="muted">还没有 7 天额度使用率样本。</p>
        </div>
      </section>
    `;
  }

  const rowHeight = 38;
  const paddingTop = 18;
  const paddingBottom = 18;
  const labelWidth = 150;
  const valueWidth = 64;
  const width = 920;
  const height = paddingTop + paddingBottom + ranked.length * rowHeight;
  const trackX = labelWidth;
  const trackWidth = width - labelWidth - valueWidth - 16;
  const maxValue = 100;

  const bars = ranked
    .map((person, index) => {
      const pct = person.sevenDayPeakUsagePct ?? 0;
      const rowTop = paddingTop + index * rowHeight;
      const barHeight = 18;
      const barY = rowTop + (rowHeight - barHeight) / 2;
      const barWidth = Math.max(2, (pct / maxValue) * trackWidth);
      const textY = barY + barHeight / 2 + 4;
      return `
        <g>
          <text x="8" y="${textY}" class="bar-label">${escapeHtml(person.personKey)}</text>
          <rect x="${trackX}" y="${barY}" width="${trackWidth}" height="${barHeight}" rx="6" class="bar-track" />
          <rect x="${trackX}" y="${barY}" width="${barWidth.toFixed(2)}" height="${barHeight}" rx="6" class="bar-fill" />
          <text x="${trackX + trackWidth + 10}" y="${textY}" class="bar-value">${pct.toFixed(1)}%</text>
        </g>`;
    })
    .join("");

  return `
    <section class="panel chart-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Weekly Peak Usage</p>
          <h2>周使用量峰值对比</h2>
        </div>
        <p class="muted">每个人 7 天额度使用率（sevenDayPeakUsagePct）的峰值，条越长越接近用满周额度。</p>
      </div>
      <svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="周使用量峰值对比">
        ${bars}
      </svg>
    </section>
  `;
}

/** 把时间戳格式化成图表 X 轴用的本地「MM-DD HH:mm」短标签。 */
function formatTickTime(t: number): string {
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/**
 * 用事件级 detail 行画出 5h 额度与 7d 周额度使用率的详细曲线。
 *
 * 与按天聚合的图不同，这里直接用每条 statusline 采样的真实时间戳，粒度最细，
 * 能看出每个人 5 小时额度在一天里的爬升与重置节奏，同时叠加 7 天周额度的走势。
 * X 轴是连续时间，Y 轴是百分比；同一个人 5h 用实线、7d 用虚线，共用颜色和 Y 轴。
 */
function renderFiveHourUsageChart(people: AggregatePersonSummary[], detailRows: AggregatedEventRow[]): string {
  const series = people
    .map((person, index) => {
      const personRows = detailRows
        .filter((row) => row.personKey === person.personKey)
        .map((row) => ({ t: new Date(row.timestamp).getTime(), five: row.usagePct, seven: row.sevenDayUsagePct }))
        .filter((point) => Number.isFinite(point.t))
        .sort((left, right) => left.t - right.t);
      const fivePoints = personRows
        .filter((point) => point.five !== null)
        .map((point) => ({ t: point.t, v: point.five as number }));
      const sevenPoints = personRows
        .filter((point) => point.seven !== null)
        .map((point) => ({ t: point.t, v: point.seven as number }));
      return { person, index, fivePoints, sevenPoints };
    })
    .filter((entry) => entry.fivePoints.length > 0 || entry.sevenPoints.length > 0);

  const allPoints = series.flatMap((entry) => [...entry.fivePoints, ...entry.sevenPoints]);
  if (allPoints.length === 0) {
    return `
      <section class="panel chart-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Usage Detail</p>
            <h2>5h / 7d 使用率详细曲线</h2>
          </div>
          <p class="muted">还没有带使用率的 statusline 采样。</p>
        </div>
      </section>
    `;
  }

  const width = 920;
  const height = 320;
  const paddingX = 56;
  const paddingY = 32;
  const innerWidth = width - paddingX * 2;
  const innerHeight = height - paddingY * 2;

  const minT = Math.min(...allPoints.map((point) => point.t));
  const maxT = Math.max(...allPoints.map((point) => point.t));
  const maxValue = Math.max(1, ...allPoints.map((point) => point.v));
  const spanT = maxT - minT;

  const xFor = (t: number): number => paddingX + (spanT === 0 ? 0.5 : (t - minT) / spanT) * innerWidth;
  const yFor = (value: number): number => paddingY + (1 - value / maxValue) * innerHeight;

  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const tickValue = maxValue * fraction;
      const y = paddingY + (1 - fraction) * innerHeight;
      return `<g><line x1="${paddingX}" x2="${width - paddingX}" y1="${y}" y2="${y}" class="chart-grid" /><text x="8" y="${y + 4}" class="chart-axis">${tickValue.toFixed(1)}%</text></g>`;
    })
    .join("");

  const labelCount = spanT === 0 ? 1 : 5;
  const xLabels = Array.from({ length: labelCount + 1 }, (_, i) => minT + (spanT * i) / labelCount)
    .map((t) => {
      const x = xFor(t);
      return `<g><line x1="${x}" x2="${x}" y1="${height - paddingY}" y2="${height - paddingY + 6}" class="chart-axis-line" /><text x="${x}" y="${height - 4}" text-anchor="middle" class="chart-axis">${escapeHtml(formatTickTime(t))}</text></g>`;
    })
    .join("");

  const pathFor = (points: Array<{ t: number; v: number }>): string =>
    points.map((point, pointIndex) => `${pointIndex === 0 ? "M" : "L"}${xFor(point.t).toFixed(2)} ${yFor(point.v).toFixed(2)}`).join(" ");

  const seriesPaths = series
    .map((entry) => {
      const color = CHART_PALETTE[entry.index % CHART_PALETTE.length];
      const sevenColor = SEVEN_DAY_PALETTE[entry.index % SEVEN_DAY_PALETTE.length];
      const fivePath =
        entry.fivePoints.length > 0
          ? `<path d="${pathFor(entry.fivePoints)}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>${escapeHtml(entry.person.personKey)} · 5h</title></path>`
          : "";
      const sevenPath =
        entry.sevenPoints.length > 0
          ? `<path d="${pathFor(entry.sevenPoints)}" fill="none" stroke="${sevenColor}" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round"><title>${escapeHtml(entry.person.personKey)} · 7d</title></path>`
          : "";
      return `<g data-person="${escapeHtml(entry.person.personKey)}">${fivePath}${sevenPath}</g>`;
    })
    .join("");

  const legend = series
    .map((entry) => {
      const color = CHART_PALETTE[entry.index % CHART_PALETTE.length];
      const sevenColor = SEVEN_DAY_PALETTE[entry.index % SEVEN_DAY_PALETTE.length];
      return `<span class="legend-chip legend-toggle" data-person="${escapeHtml(entry.person.personKey)}"><span class="legend-dot" style="background:${color}"></span><span class="legend-dot" style="background:${sevenColor}"></span>${escapeHtml(entry.person.personKey)}</span>`;
    })
    .join("");

  return `
    <section class="panel chart-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Usage Detail</p>
          <h2>5h / 7d 使用率详细曲线</h2>
        </div>
        <p class="muted">每条 statusline 采样的 5 小时额度（实线）与 7 天周额度（对比色虚线）使用率，按真实时间戳绘制、共用 Y 轴。点击图例人名可只高亮该人曲线。</p>
      </div>
      <div class="legend">
        ${legend}
        <span class="legend-chip"><span class="legend-line legend-line-solid"></span>5h 使用率（实线）</span>
        <span class="legend-chip"><span class="legend-line legend-line-dashed"></span>7d 周使用量（对比色虚线）</span>
      </div>
      <svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="5h / 7d 使用率详细曲线">
        ${ticks}
        ${xLabels}
        ${seriesPaths}
      </svg>
    </section>
  `;
}

/** 按人渲染汇总卡片，给出请求 / 消息 / token / usage 几个核心指标。 */
function renderPeopleLeaderboard(people: AggregatePersonSummary[]): string {
  if (people.length === 0) {
    return `
      <section class="panel table-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">People</p>
            <h2>多人对比</h2>
          </div>
          <p class="muted">还没有匹配的导出 bundle。</p>
        </div>
      </section>
    `;
  }

  const rows = people
    .map(
      (person, index) => `
      <tr>
        <td class="rank">${index + 1}</td>
        <td><strong>${escapeHtml(person.personKey)}</strong></td>
        <td>${formatNumber(person.userMessageCount)}</td>
        <td>${formatTokensM(person.inputTokens)}</td>
        <td>${formatTokensM(person.outputTokens)}</td>
        <td>${formatTokensM(person.cacheReadInputTokens)}</td>
        <td>${escapeHtml(statValue(person.fiveHourPeakUsagePct))}</td>
        <td>${escapeHtml(statValue(person.fiveHourLatestUsagePct))}</td>
        <td>${escapeHtml(statValue(person.sevenDayPeakUsagePct))}</td>
        <td>${escapeHtml(statValue(person.sevenDayLatestUsagePct))}</td>
        <td>${escapeHtml(statValue(person.sevenDayCumulativeUsagePct))}</td>
        <td>${person.activeDays}</td>
        <td class="muted-col">${formatNumber(person.apiRequestCount)}</td>
      </tr>`,
    )
    .join("");

  return `
    <section class="panel table-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">People</p>
          <h2>多人对比</h2>
        </div>
        <p class="muted">按用户消息数降序排列，所有数字直接来自 daily/weekly 汇总。</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>personKey</th>
              <th>消息</th>
              <th>Input tokens</th>
              <th>Output tokens</th>
              <th>Cache read tokens</th>
              <th>5h Peak</th>
              <th>5h Latest</th>
              <th>7d Peak</th>
              <th>7d Latest</th>
              <th>7d 累计</th>
              <th>活跃天数</th>
              <th class="muted-col">API 请求</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

/** 把 daily 行按 personKey × date 排成一个矩阵表。 */
function renderDailyMatrix(people: AggregatePersonSummary[], dailyIndex: Map<string, AggregatedDailyRow>, dateAxis: string[]): string {
  if (people.length === 0 || dateAxis.length === 0) {
    return "";
  }

  const headerCells = dateAxis.map((date) => `<th>${escapeHtml(date.slice(5))}</th>`).join("");
  const bodyRows = people
    .map((person) => {
      const cells = dateAxis
        .map((date) => {
          const row = dailyIndex.get(`${person.personKey}|${date}`);
          const requests = row?.apiRequestCount ?? 0;
          const messages = row?.userMessageCount ?? 0;
          if (requests === 0 && messages === 0) {
            return `<td class="muted-cell">·</td>`;
          }
          return `<td><span class="cell-primary">${formatNumber(messages)}</span><span class="cell-secondary">${formatNumber(requests)} req</span></td>`;
        })
        .join("");
      return `<tr><th class="row-head">${escapeHtml(person.personKey)}</th>${cells}</tr>`;
    })
    .join("");

  return `
    <section class="panel table-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Daily Matrix</p>
          <h2>按天 × 人 矩阵</h2>
        </div>
        <p class="muted">单元格上方为用户消息数，下方为 API 请求数。</p>
      </div>
      <div class="table-wrap">
        <table class="matrix">
          <thead>
            <tr>
              <th class="row-head">personKey</th>
              ${headerCells}
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </section>
  `;
}

/** 把 weekly 行也照搬出来，便于看每个人每个 ISO 周的总账。 */
function renderWeeklyTable(weeklyRows: AggregatedWeeklyRow[]): string {
  if (weeklyRows.length === 0) {
    return "";
  }

  const sorted = [...weeklyRows].sort((left, right) => {
    if (left.week !== right.week) {
      return left.week.localeCompare(right.week);
    }
    return left.personKey.localeCompare(right.personKey);
  });

  const rows = sorted
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.week)}</td>
        <td>${escapeHtml(row.personKey)}</td>
        <td>${formatNumber(row.userMessageCount)}</td>
        <td>${formatTokensM(row.inputTokens)}</td>
        <td>${formatTokensM(row.outputTokens)}</td>
        <td>${formatTokensM(row.cacheReadInputTokens)}</td>
        <td>${escapeHtml(statValue(row.fiveHourPeakUsagePct))}</td>
        <td>${escapeHtml(statValue(row.fiveHourLatestUsagePct))}</td>
        <td>${escapeHtml(statValue(row.sevenDayPeakUsagePct))}</td>
        <td>${escapeHtml(statValue(row.sevenDayLatestUsagePct))}</td>
        <td>${escapeHtml(statValue(row.sevenDayCumulativeUsagePct))}</td>
        <td class="muted-col">${formatNumber(row.apiRequestCount)}</td>
      </tr>`,
    )
    .join("");

  return `
    <section class="panel table-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Weekly Rollup</p>
          <h2>按周聚合</h2>
        </div>
        <p class="muted">直接来源于每个 bundle 的 weeklySummary。</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>周起始</th>
              <th>personKey</th>
              <th>消息</th>
              <th>Input tokens</th>
              <th>Output tokens</th>
              <th>Cache read tokens</th>
              <th>5h Peak</th>
              <th>5h Latest</th>
              <th>7d Peak</th>
              <th>7d Latest</th>
              <th>7d 累计</th>
              <th class="muted-col">API 请求</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

/**
 * 生成完整的多人 aggregate dashboard HTML。
 *
 * 这是一份单文件静态页面，所有数据已经内联，可直接打开或拷贝分享。
 */
export function buildAggregateDashboardHtml(
  detailRows: AggregatedEventRow[],
  dailyRows: AggregatedDailyRow[],
  weeklyRows: AggregatedWeeklyRow[],
  generatedAt: Date = new Date(),
): string {
  const people = summarizePeople(dailyRows, weeklyRows);
  const overall = summarizeOverall(dailyRows, people);
  const dateAxis = collectDateAxis(dailyRows);
  const dailyIndex = indexDailyRows(dailyRows);

  const totalTokens = overall.totalInputTokens + overall.totalOutputTokens;
  const peakUsage = maxOrNull(people.map((person) => person.fiveHourPeakUsagePct));
  const peakSevenDay = maxOrNull(people.map((person) => person.sevenDayPeakUsagePct));
  const rangeLabel = overall.startDate && overall.endDate ? `${overall.startDate} → ${overall.endDate}` : "--";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ccus team dashboard</title>
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
        max-width: 1240px;
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
      .stat-card { padding: 20px; min-height: 128px; }
      .stat-card h2 { font-size: 14px; color: var(--muted); font-weight: 500; }
      .stat-value { margin-top: 16px; font-size: 36px; line-height: 0.95; }
      .stat-note { margin-top: 12px; color: var(--muted); font-size: 13px; }
      .panel-header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 16px;
        padding: 24px 24px 0;
      }
      .panel-header h2 { font-size: 28px; line-height: 1; }
      .muted { color: var(--muted); font-size: 14px; }
      .chart-panel { padding-bottom: 22px; margin-top: 22px; }
      .chart { width: 100%; height: auto; display: block; padding: 12px 20px 6px; }
      .chart-grid { stroke: var(--grid); stroke-width: 1; }
      .chart-axis { fill: var(--muted); font-size: 11px; }
      .chart-axis-line { stroke: var(--grid); stroke-width: 1; }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 18px;
        padding: 14px 24px 0;
        color: var(--muted);
        font-size: 13px;
      }
      .legend-chip { display: inline-flex; align-items: center; gap: 8px; }
      .legend-toggle { cursor: pointer; user-select: none; transition: opacity 0.15s ease; }
      .legend-toggle:hover { color: var(--text); }
      .legend-toggle.is-active { color: var(--text); font-weight: 600; }
      .legend-toggle.is-dimmed { opacity: 0.4; }
      .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
      svg [data-person] { transition: opacity 0.15s ease; }
      svg [data-person].is-dimmed { opacity: 0.1; }
      svg [data-person].is-active { opacity: 1; }
      .legend-line { display: inline-block; width: 22px; height: 0; border-top-width: 2px; border-top-style: solid; border-top-color: var(--muted); }
      .legend-line-dashed { border-top-style: dashed; }
      .table-panel { margin-top: 22px; }
      .table-wrap { overflow: auto; padding: 16px 20px 22px; }
      table { width: 100%; border-collapse: collapse; min-width: 760px; }
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
      td.rank { color: var(--muted); width: 32px; }
      .muted-col { color: var(--muted); font-size: 12px; }
      .bar-label { fill: var(--text); font-size: 13px; }
      .bar-value { fill: var(--accent); font-size: 13px; font-weight: 600; }
      .bar-track { fill: rgba(145, 160, 184, 0.14); }
      .bar-fill { fill: var(--accent); }
      table.matrix th, table.matrix td { text-align: center; padding: 8px 10px; }
      table.matrix th.row-head { text-align: left; }
      table.matrix .cell-primary { display: block; color: var(--text); }
      table.matrix .cell-secondary { display: block; color: var(--muted); font-size: 11px; }
      table.matrix .muted-cell { color: rgba(145, 160, 184, 0.45); }
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
          <p class="eyebrow">Claude Code · Team Surface</p>
          <h1>ccus team dashboard</h1>
        </div>
        <p class="subtitle">把目录里所有 export bundle 聚合到一起，看团队里每个人的 Claude Code 使用节奏：消息数、API 请求数、token 用量，以及 5 小时与 7 天额度使用率。</p>
        <div class="hero-meta">
          <span class="hero-chip">人数：${overall.personCount}</span>
          <span class="hero-chip">时间范围：${escapeHtml(rangeLabel)}</span>
          <span class="hero-chip">生成时间：${escapeHtml(generatedAt.toISOString())}</span>
        </div>
      </section>
      <section class="stats">
        <article class="panel stat-card">
          <h2>Total user messages</h2>
          <p class="stat-value">${formatNumber(overall.totalUserMessageCount)}</p>
          <p class="stat-note">所有人发给 Claude 的非 meta 消息</p>
        </article>
        <article class="panel stat-card">
          <h2>Total tokens (in+out)</h2>
          <p class="stat-value">${formatTokensM(totalTokens)}</p>
          <p class="stat-note">${formatTokensM(overall.totalInputTokens)} input / ${formatTokensM(overall.totalOutputTokens)} output</p>
        </article>
        <article class="panel stat-card">
          <h2>Cache read tokens</h2>
          <p class="stat-value">${formatTokensM(overall.totalCacheReadInputTokens)}</p>
          <p class="stat-note">来自 assistant usage 的 cache_read_input_tokens</p>
        </article>
        <article class="panel stat-card">
          <h2>Total API requests</h2>
          <p class="stat-value">${formatNumber(overall.totalApiRequestCount)}</p>
          <p class="stat-note">所有人 API 请求数合计（次要参考）</p>
        </article>
        <article class="panel stat-card">
          <h2>Peak 5h usage</h2>
          <p class="stat-value">${escapeHtml(roundNumber(peakUsage, 1) === null ? "--" : statValue(roundNumber(peakUsage, 1)))}</p>
          <p class="stat-note">团队内观测到的 5 小时使用率峰值</p>
        </article>
        <article class="panel stat-card">
          <h2>Peak 7d usage</h2>
          <p class="stat-value">${escapeHtml(roundNumber(peakSevenDay, 1) === null ? "--" : statValue(roundNumber(peakSevenDay, 1)))}</p>
          <p class="stat-note">团队内观测到的 7 天额度峰值</p>
        </article>
      </section>
      ${renderPeopleLeaderboard(people)}
      ${renderSevenDayPeakChart(people)}
      ${renderFiveHourUsageChart(people, detailRows)}
      ${renderDailyUserRequestChart(people, dailyIndex, dateAxis)}
      ${renderDailyMatrix(people, dailyIndex, dateAxis)}
      ${renderWeeklyTable(weeklyRows)}
    </main>
    <script>
      (function () {
        // 点击图例里的人名：高亮该人在所有图表里的曲线，其余淡化；再次点击同名取消高亮。
        var active = null;
        function apply() {
          document.querySelectorAll("[data-person]").forEach(function (el) {
            el.classList.remove("is-active", "is-dimmed");
            if (active === null) return;
            el.classList.add(el.getAttribute("data-person") === active ? "is-active" : "is-dimmed");
          });
        }
        document.querySelectorAll(".legend-toggle").forEach(function (chip) {
          chip.addEventListener("click", function () {
            var person = chip.getAttribute("data-person");
            active = active === person ? null : person;
            apply();
          });
        });
      })();
    </script>
  </body>
</html>`;
}
