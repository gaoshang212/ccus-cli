export interface ScoreSettings {
  messageWeight: number;
  messageBaseline: number;
  quotaBaseline: number;
}

export const DEFAULT_SCORE_SETTINGS: ScoreSettings = {
  messageWeight: 50,
  messageBaseline: 200,
  quotaBaseline: 70,
};

export interface WeeklyScoreRow {
  week: string;
  personKey: string;
  userMessageCount: number;
  sevenDayCumulativeUsagePct: number | null;
}

export function calculateWeeklyScore(messages: number, quota: number | null, settings: ScoreSettings): number | null {
  const { messageWeight, messageBaseline, quotaBaseline } = settings;
  if (!Number.isFinite(messageWeight) || messageWeight < 0 || messageWeight > 100
    || !Number.isFinite(messageBaseline) || messageBaseline <= 0
    || !Number.isFinite(quotaBaseline) || quotaBaseline <= 0
    || !Number.isFinite(messages) || messages < 0
    || (quota !== null && (!Number.isFinite(quota) || quota < 0))) return null;
  if (quota === null && messageWeight < 100) return null;
  return messageWeight * Math.sqrt(messages / messageBaseline)
    + (100 - messageWeight) * Math.sqrt((quota ?? 0) / quotaBaseline);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** 两类面板共用评分；权重和基准统一在 DEFAULT_SCORE_SETTINGS 修改。 */
export function renderWeeklyScores(rows: WeeklyScoreRow[]): string {
  const settings = DEFAULT_SCORE_SETTINGS;
  const body = [...rows].sort((a, b) => b.week.localeCompare(a.week) || a.personKey.localeCompare(b.personKey)).map((row) => {
    const score = calculateWeeklyScore(row.userMessageCount, row.sevenDayCumulativeUsagePct, settings);
    return `<tr><td>${escapeHtml(row.week)}</td><td>${escapeHtml(row.personKey)}</td>
      <td><strong>${score?.toFixed(1) ?? "--"}</strong></td></tr>`;
  }).join("");
  return `<section class="panel table-panel" id="weekly-score">
    <h2>周评分</h2>
    <div class="table-wrap"><table><thead><tr><th>周起始</th><th>用户</th><th>评分</th></tr></thead>
    <tbody>${body || '<tr><td colspan="3">暂无评分数据</td></tr>'}</tbody></table></div>
  </section>`;
}
