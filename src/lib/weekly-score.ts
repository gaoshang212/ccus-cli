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

export function calculateWeeklyScore(messages: number, quota: number | null, settings: ScoreSettings, attendanceDays = 5): number | null {
  const { messageWeight, messageBaseline, quotaBaseline } = settings;
  if (!Number.isInteger(attendanceDays) || attendanceDays < 1 || attendanceDays > 7
    || !Number.isFinite(messageWeight) || messageWeight < 0 || messageWeight > 100
    || !Number.isFinite(messageBaseline) || messageBaseline <= 0
    || !Number.isFinite(quotaBaseline) || quotaBaseline <= 0
    || !Number.isFinite(messages) || messages < 0
    || (quota !== null && (!Number.isFinite(quota) || quota < 0))) return null;
  if (quota === null && messageWeight < 100) return null;
  const attendanceRatio = attendanceDays / 5;
  return messageWeight * Math.sqrt(messages / (messageBaseline * attendanceRatio))
    + (100 - messageWeight) * Math.sqrt((quota ?? 0) / (quotaBaseline * attendanceRatio));
}

export function renderAttendanceControl(personKey?: string): string {
  const attributes = personKey === undefined ? 'id="attendance-days"' : `data-attendance-person="${escapeHtml(personKey)}" aria-label="出勤天数"`;
  const select = `<select ${attributes}>${[1, 2, 3, 4, 5, 6, 7].map(days =>
    `<option value="${days}"${days === 5 ? " selected" : ""}>${days} 天</option>`).join("")}</select>`;
  return personKey === undefined ? `<label>出勤天数 ${select}</label>` : select;
}

/** 多周逐周评分后取平均；浏览器切换预先按各出勤天数算好的结果。 */
export function renderAttendanceScore(rows: Pick<WeeklyScoreRow, "userMessageCount" | "sevenDayCumulativeUsagePct">[]): string {
  const scores = [1, 2, 3, 4, 5, 6, 7].map(days => {
    const values = rows.map(row => calculateWeeklyScore(row.userMessageCount, row.sevenDayCumulativeUsagePct, DEFAULT_SCORE_SETTINGS, days));
    if (!values.length || values.some(value => value === null)) return "--";
    return (values.reduce<number>((sum, value) => sum + (value ?? 0), 0) / values.length).toFixed(1);
  });
  return `<span data-attendance-scores="${escapeHtml(JSON.stringify(scores))}">${scores[4]}</span>`;
}

export function attendanceScoreScript(): string {
  return `<script>
    (() => {
      const select = document.getElementById('attendance-days');
      if (!select) return;
      select.addEventListener('change', () => {
        const days = Number(select.value);
        if (!Number.isInteger(days) || days < 1 || days > 7) return;
        document.querySelectorAll('[data-attendance-scores]').forEach(element => {
          element.textContent = JSON.parse(element.dataset.attendanceScores)[days - 1];
        });
        document.querySelectorAll('[data-attendance-person]').forEach(element => { element.value = select.value; });
      });
      document.querySelectorAll('[data-attendance-person]').forEach(control => {
        control.addEventListener('change', () => {
          const days = Number(control.value);
          if (!Number.isInteger(days) || days < 1 || days > 7) return;
          const score = control.closest('tr').querySelector('[data-attendance-scores]');
          score.textContent = JSON.parse(score.dataset.attendanceScores)[days - 1];
        });
      });
    })();
  </script>`;
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
