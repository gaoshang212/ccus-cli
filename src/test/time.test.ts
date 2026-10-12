import test from "node:test";
import assert from "node:assert/strict";
import { expandToFullWeekWindow, formatRangeFileLabel, formatWeekDirName, resolveRange } from "../lib/time";

test("指定周接受周内日期，覆盖跨年与闰日，并沿用统计日边界", () => {
  for (const [date, expected] of [
    ["2026-09-28", "2026-09-28_to_2026-10-04"],
    ["2026-10-04", "2026-09-28_to_2026-10-04"],
    ["2026-01-01", "2025-12-29_to_2026-01-04"],
    ["2024-02-29", "2024-02-26_to_2024-03-03"],
  ]) {
    for (const dayStartMinutes of [0, 420, 450]) {
      const window = resolveRange(`week:${date}`, new Date(), dayStartMinutes);
      assert.equal(formatRangeFileLabel(window.start, window.end, dayStartMinutes), expected);
      assert.equal(window.start.getHours() * 60 + window.start.getMinutes(), dayStartMinutes);
      const nextMonday = new Date(window.start);
      nextMonday.setDate(nextMonday.getDate() + 7);
      assert.equal(window.end.getTime(), nextMonday.getTime() - 1);
    }
  }
  for (const date of ["", "2026-2-1", "2026-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00", "abc"]) {
    assert.throws(() => resolveRange(`week:${date}`), /日期/);
  }
});

test("formatWeekDirName renders an all-underscore year_month_day_year_month_day name", () => {
  const start = new Date(2026, 5, 1);
  const end = new Date(2026, 5, 7, 23, 59, 59, 999);
  assert.equal(formatWeekDirName(start, end), "2026_06_01_2026_06_07");
});

test("expandToFullWeekWindow stretches this-week to Monday..Sunday even before week ends", () => {
  // 2026-06-03 是周三，本周一是 06-01，本周日是 06-07。
  const now = new Date(2026, 5, 3, 14, 0, 0);
  const window = expandToFullWeekWindow(resolveRange("this-week", now));

  assert.equal(window.label, "this-week");
  assert.equal(formatRangeFileLabel(window.start, window.end, window.dayStartMinutes), "2026-06-01_to_2026-06-07");
});

test("expandToFullWeekWindow leaves last-week (already full Monday..Sunday) untouched", () => {
  const now = new Date(2026, 5, 3, 14, 0, 0);
  const resolved = resolveRange("last-week", now);
  const window = expandToFullWeekWindow(resolved);

  assert.equal(window.end, resolved.end);
  assert.equal(formatRangeFileLabel(window.start, window.end, window.dayStartMinutes), "2026-05-25_to_2026-05-31");
});

test("expandToFullWeekWindow does not touch non-week ranges", () => {
  const now = new Date(2026, 5, 3, 14, 0, 0);
  const resolved = resolveRange("today", now);
  const window = expandToFullWeekWindow(resolved);

  assert.equal(window.end, resolved.end);
});
