import test from "node:test";
import assert from "node:assert/strict";
import { calculateWeeklyScore, DEFAULT_SCORE_SETTINGS, renderWeeklyScores } from "../lib/weekly-score";

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
