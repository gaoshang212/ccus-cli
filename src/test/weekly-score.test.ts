import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { attendanceScoreScript, calculateWeeklyScore, DEFAULT_SCORE_SETTINGS, renderAttendanceControl, renderAttendanceScore, renderWeeklyScores } from "../lib/weekly-score";

test("出勤按比例调整两项达标线，默认五天且接受半天至七天、步进半天", () => {
  for (let days = 0.5; days <= 7; days += 0.5) {
    assert.equal(calculateWeeklyScore(40 * days, 14 * days, DEFAULT_SCORE_SETTINGS, days), 100);
  }
  assert.equal(calculateWeeklyScore(200, 70, DEFAULT_SCORE_SETTINGS, 5), calculateWeeklyScore(200, 70, DEFAULT_SCORE_SETTINGS));
  for (const days of [0, 0.25, 1.25, 7.5, 8, NaN, Infinity]) {
    assert.equal(calculateWeeklyScore(200, 70, DEFAULT_SCORE_SETTINGS, days), null);
  }
});

test("出勤选择更新单周及多周平均分，保留缺失额度，切回五天恢复默认", () => {
  const rows = [
    { userMessageCount: 120, sevenDayCumulativeUsagePct: 42 },
    { userMessageCount: 480, sevenDayCumulativeUsagePct: 168 },
  ];
  const original = JSON.stringify(rows);
  const elements = [[rows[0]], rows, [{ ...rows[0], sevenDayCumulativeUsagePct: null }], []].map(values => {
    const html = renderAttendanceScore(values);
    return {
      dataset: { attendanceScores: html.match(/data-attendance-scores="([^"]*)"/)![1].replaceAll("&quot;", '"') },
      textContent: html.match(/>(.*?)<\/span>/)![1],
    };
  });
  const defaults = elements.map(element => element.textContent);
  let change = () => {};
  const select = { value: "5", addEventListener: (event: string, callback: () => void) => {
    assert.equal(event, "change");
    change = callback;
  } };
  runInNewContext(attendanceScoreScript().replace(/<\/?script>/g, ""), {
    document: { getElementById: () => select, querySelectorAll: (selector: string) => selector === '[data-attendance-scores]' ? elements : [] },
  });
  select.value = "3";
  change();
  assert.deepEqual(elements.map(element => element.textContent), ["100.0", "150.0", "--", "--"]);
  select.value = "0.5";
  change();
  assert.deepEqual(elements.map(element => element.textContent), ["244.9", "367.4", "--", "--"]);
  select.value = "1.25";
  change();
  assert.equal(elements[0].textContent, "244.9");
  select.value = "5";
  change();
  assert.deepEqual(elements.map(element => element.textContent), defaults);
  assert.equal(JSON.stringify(rows), original);
  const control = renderAttendanceControl();
  assert.deepEqual([...control.matchAll(/<option value="([^"]+)"/g)].map(match => Number(match[1])),
    [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7]);
  assert.match(control, /value="5" selected/);
});

test("周评分支持零值、超基准、权重修改及无效数据", () => {
  const defaults = DEFAULT_SCORE_SETTINGS;
  assert.equal(calculateWeeklyScore(200, 70, defaults), 100);
  assert.equal(calculateWeeklyScore(800, 280, defaults), 200);
  assert.equal(calculateWeeklyScore(0, 0, defaults), 0);
  assert.equal(calculateWeeklyScore(200, null, defaults), null);
  assert.equal(calculateWeeklyScore(200, null, { ...defaults, messageWeight: 100 }), 100);
  assert.equal(calculateWeeklyScore(800, 70, { ...defaults, messageWeight: 80 }), 180);
  assert.equal(calculateWeeklyScore(400, 140, { ...defaults, messageBaseline: 400, quotaBaseline: 140 }), 100);
  for (const settings of [{ ...defaults, messageBaseline: 0 }, { ...defaults, quotaBaseline: -1 }, { ...defaults, messageWeight: 101 }, { ...defaults, messageWeight: NaN }]) {
    assert.equal(calculateWeeklyScore(200, 70, settings), null);
  }
});

test("评分区只显示分数，不提供参数控件或浏览器配置", () => {
  const html = renderWeeklyScores([{ week: "2026-06-01", personKey: "<用户>", userMessageCount: 800, sevenDayCumulativeUsagePct: 70 }]);
  assert.match(html, /&lt;用户&gt;/);
  assert.match(html, /<strong>150.0<\/strong>/);
  assert.doesNotMatch(html, /<form|<input|<button|<script|localStorage|占比|基准|√/);
});
