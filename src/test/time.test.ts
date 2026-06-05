import test from "node:test";
import assert from "node:assert/strict";
import { expandToFullWeekWindow, formatRangeFileLabel, formatWeekDirName, resolveRange } from "../lib/time";

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
  assert.equal(formatRangeFileLabel(window.start, window.end), "2026-06-01_to_2026-06-07");
});

test("expandToFullWeekWindow leaves last-week (already full Monday..Sunday) untouched", () => {
  const now = new Date(2026, 5, 3, 14, 0, 0);
  const resolved = resolveRange("last-week", now);
  const window = expandToFullWeekWindow(resolved);

  assert.equal(window.end, resolved.end);
  assert.equal(formatRangeFileLabel(window.start, window.end), "2026-05-25_to_2026-05-31");
});

test("expandToFullWeekWindow does not touch non-week ranges", () => {
  const now = new Date(2026, 5, 3, 14, 0, 0);
  const resolved = resolveRange("today", now);
  const window = expandToFullWeekWindow(resolved);

  assert.equal(window.end, resolved.end);
});
