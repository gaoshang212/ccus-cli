import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../cli";
import { readConfig, writeDayStart } from "../lib/config";
import { buildAggregatedDailyRows, buildAggregatedDetailRows, buildAggregatedWeeklyRows, loadWeeklyExportBundles } from "../lib/aggregate";
import { appendEvent, readEventsForRange } from "../lib/storage";
import { enumerateDateKeys, enumerateReportingDateKeys, expandToFullWeekWindow, formatDayStart, formatRangeFileLabel, formatWeekDirName, localDateKey, parseDayStart, reportingDateKey, resolveRange } from "../lib/time";
import { performSync, writeSyncConfig } from "../lib/sync";
import type { PersistedStatuslineEvent, WeeklyExportBundle } from "../types";

test("默认 7 点切日，支持分钟、午夜、跨月和跨年", () => {
  assert.equal(reportingDateKey(new Date(2026, 5, 2, 6, 59, 59, 999)), "2026-06-01");
  assert.equal(reportingDateKey(new Date(2026, 5, 2, 7)), "2026-06-02");
  assert.equal(reportingDateKey(new Date(2026, 5, 1, 1)), "2026-05-31");
  assert.equal(reportingDateKey(new Date(2026, 0, 1, 1)), "2025-12-31");
  assert.equal(reportingDateKey(new Date(2026, 5, 2, 7, 29), 450), "2026-06-01");
  assert.equal(reportingDateKey(new Date(2026, 5, 2, 7, 30), 450), "2026-06-02");
  assert.equal(reportingDateKey(new Date(2026, 5, 2), 0), "2026-06-02");
  assert.equal(parseDayStart("7"), 420);
  assert.equal(formatDayStart(parseDayStart("07:30")), "07:30");
  for (const value of ["24", "24:00", "-1", "07:60", "7:3", "", "NaN"]) {
    assert.throws(() => parseDayStart(value), /每天开始时间/);
  }
});

test("凌晨 today 与周一凌晨沿用前一统计日和前一周，滚动窗口不变", () => {
  const now = new Date(2026, 5, 1, 6, 59);
  assert.equal(resolveRange("today", now).start.getTime(), new Date(2026, 4, 31, 7).getTime());
  assert.equal(resolveRange("this-week", now).start.getTime(), new Date(2026, 4, 25, 7).getTime());
  assert.equal(resolveRange("last-week", now).end.getTime(), new Date(2026, 4, 25, 7).getTime() - 1);
  const monday = new Date(2026, 5, 1, 7);
  const week = expandToFullWeekWindow(resolveRange("this-week", monday));
  assert.equal(week.end.getTime(), new Date(2026, 5, 8, 7).getTime() - 1);
  assert.equal(enumerateReportingDateKeys(week.start, week.end).length, 7);
  assert.equal(enumerateDateKeys(week.start, week.end).length, 8);
  assert.equal(formatRangeFileLabel(week.start, week.end, 420), "2026-06-01_to_2026-06-07");
  assert.equal(formatWeekDirName(week.start, week.end, 420), "2026_06_01_2026_06_07");
  assert.equal(resolveRange("5h", monday, 450).start.getTime(), monday.getTime() - 5 * 3_600_000);
});

test("夏令时切换后仍按本地开始时间归天，不漂移到下一小时", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const today = resolveRange("today", new Date(2026, 2, 8, 3), 150);
    assert.equal(today.start.getTime(), new Date(2026, 2, 7, 2, 30).getTime());
    const week = expandToFullWeekWindow(resolveRange("this-week", new Date(2026, 2, 5, 12)));
    assert.equal(enumerateReportingDateKeys(week.start, week.end).length, 7);
    assert.equal(week.end.getTime(), new Date(2026, 2, 9, 7).getTime() - 1);
    assert.deepEqual(enumerateReportingDateKeys(new Date(2026, 2, 7, 2, 30), new Date(2026, 2, 9, 3), 150), ["2026-03-07", "2026-03-08", "2026-03-09"]);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test("配置可持久化、保留其它字段，非法输入不覆盖原文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-day-config-"));
  try {
    assert.equal((await readConfig(root)).dayStart, "07:00");
    await fs.writeFile(path.join(root, "config.json"), '{"other":true}', "utf8");
    await main(["config", "--day-start", "7:30", "--data-dir", root]);
    assert.deepEqual(await readConfig(root), { other: true, dayStart: "07:30" });
    await assert.rejects(() => writeDayStart(root, "24"), /每天开始时间/);
    await assert.rejects(() => main(["config", "--day-start"]), /缺少时间/);
    assert.equal((await readConfig(root)).dayStart, "07:30");
    await fs.writeFile(path.join(root, "config.json"), "not-json", "utf8");
    await assert.rejects(() => writeDayStart(root, "8"));
    assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), "not-json");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function event(date: Date, value: number): PersistedStatuslineEvent {
  return {
    schemaVersion: 3, timestamp: date.toISOString(), gitUserName: "test", gitUserEmail: "test@example.com", gitUserAccount: "test",
    rawPayload: { session_id: "test", rate_limits: { five_hour: { used_percentage: value }, seven_day: { used_percentage: value } } },
  };
}

test("跨午夜从两个自然日目录读取日志，统计开始时间调整后仍能读取历史数据", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-day-storage-"));
  try {
    const dates = [new Date(2026, 5, 1, 6, 59), new Date(2026, 5, 1, 7), new Date(2026, 5, 2, 6, 59), new Date(2026, 5, 2, 7)];
    for (const [i, date] of dates.entries()) await appendEvent(root, event(date, i));
    const before = await readEventsForRange(root, "today", dates[2]);
    assert.deepEqual(before.map((e) => e.timestamp), dates.slice(1, 3).map((d) => d.toISOString()));
    const after = await readEventsForRange(root, "today", dates[3]);
    assert.deepEqual(after.map((e) => e.timestamp), [dates[3].toISOString()]);
    const midnight = await readEventsForRange(root, "today", dates[2], 0);
    assert.deepEqual(midnight.map((e) => e.timestamp), [dates[2].toISOString()]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI 导出、Claude/Codex 消息和 token、额度、聚合与看板使用同一统计日", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-day-export-"));
  const saved = { CCUS_CLAUDE_DATA_DIR: process.env.CCUS_CLAUDE_DATA_DIR, CODEX_HOME: process.env.CODEX_HOME, APPDATA: process.env.APPDATA };
  try {
    process.env.CCUS_CLAUDE_DATA_DIR = path.join(root, "claude");
    process.env.CODEX_HOME = path.join(root, "codex");
    process.env.APPDATA = path.join(root, "appdata");
    const week = resolveRange("last-week");
    const night = new Date(week.start);
    night.setDate(night.getDate() + 1);
    night.setHours(6, 59);
    const next = new Date(night);
    next.setHours(7, 2); // 让读数持续超过去毛刺阈值，单独验证统计日切片。
    for (const [date, value] of [[week.start, 10], [night, 20], [next, 30], [week.end, 40]] as const) {
      await appendEvent(root, event(date, value));
    }
    const claudeFile = path.join(process.env.CCUS_CLAUDE_DATA_DIR, "projects", "test", "test.jsonl");
    const codexFile = path.join(process.env.CODEX_HOME, "sessions", "test.jsonl");
    await fs.mkdir(path.dirname(claudeFile), { recursive: true });
    await fs.mkdir(path.dirname(codexFile), { recursive: true });
    await fs.writeFile(claudeFile, [
      { type: "user", timestamp: night.toISOString(), message: { content: "测试" } },
      { type: "assistant", timestamp: night.toISOString(), message: { model: "unknown", usage: { input_tokens: 10, output_tokens: 2 } } },
    ].map((record) => JSON.stringify(record)).join("\n"));
    await fs.writeFile(codexFile, [
      { type: "event_msg", timestamp: night.toISOString(), payload: { type: "task_started", turn_id: "test-turn" } },
      { type: "event_msg", timestamp: night.toISOString(), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 3 } } } },
    ].map((record) => JSON.stringify(record)).join("\n"));
    const output = path.join(root, "exports", "test.json");
    await main(["export", "lw", "--data-dir", root, "--out", output]);
    const bundle: WeeklyExportBundle = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(bundle.schemaVersion, 12);
    assert.equal(bundle.weeklySummary.schemaVersion, 12);
    assert.equal(bundle.range.dayStart, "07:00");
    assert.equal(bundle.weeklySummary.range.dayStart, "07:00");
    assert.equal(bundle.dailySummaries.length, 7);
    const first = bundle.dailySummaries[0];
    assert.equal(first.date, localDateKey(week.start));
    assert.equal(first.sampleCount, 2);
    assert.equal(first.fiveHourLatestUsagePct, 20);
    assert.equal(first.userMessageCount, 1);
    assert.equal(first.inputTokens, 10);
    assert.equal(first.codex.userMessageCount, 1);
    assert.equal(first.codex.inputTokens, 20);
    assert.equal(first.codex.cacheReadInputTokens, 10);
    assert.equal(first.apiEquivalentCost.total.unpricedApiRequestCount, 2);
    const bundles = await loadWeeklyExportBundles(path.dirname(output));
    const daily = buildAggregatedDailyRows(bundles);
    assert.equal(daily[0].userMessageCount, 2);
    assert.equal(daily[0].inputTokens, 30);
    assert.equal(daily[0].sevenDayCumulativeUsagePct, 10);
    const detail = buildAggregatedDetailRows(bundles);
    assert.equal(detail.find((e) => e.timestamp === night.toISOString())?.dateKey, first.date);
    assert.equal(detail.find((e) => e.timestamp === week.end.toISOString())?.weekKey, first.date);
    assert.equal(buildAggregatedWeeklyRows(bundles)[0].sevenDayCumulativeUsagePct, 30);
    const legacy = structuredClone(bundle);
    legacy.schemaVersion = 11;
    assert.throws(() => buildAggregatedDailyRows([...bundles, { filePath: "legacy.json", bundle: legacy }]), /开始时间不一致/);
    for (const badStart of [undefined, "24:00", "7:00"]) {
      const invalid = structuredClone(bundle);
      invalid.range.dayStart = badStart;
      await fs.writeFile(path.join(path.dirname(output), "invalid.json"), JSON.stringify(invalid));
      await assert.rejects(() => loadWeeklyExportBundles(path.dirname(output)), /Unsupported export bundle/);
    }
    await fs.rm(path.join(path.dirname(output), "invalid.json"));
    const html = path.join(root, "dashboard.html");
    await main(["dashboard", "build", "--range", "lw", "--data-dir", root, "--out", html]);
    assert.match(await fs.readFile(html, "utf8"), /每天开始：07:00/);
    await writeDayStart(root, "07:30");
    await main(["export", "lw", "--data-dir", root, "--out", output]);
    const shifted: WeeklyExportBundle = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(shifted.range.dayStart, "07:30");
    assert.equal(new Date(shifted.range.start).getMinutes(), 30);
    assert.equal(shifted.dailySummaries[0].fiveHourLatestUsagePct, 30);
    await main(["export", "1000h", "--data-dir", root, "--out", output, "--day-start", "0"]);
    const midnight: WeeklyExportBundle = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(midnight.range.dayStart, "00:00");
    assert.equal(midnight.dailySummaries.find((day) => day.date === localDateKey(night))?.codex.userMessageCount, 1);
    assert.equal((await readConfig(root)).dayStart, "07:30");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("周一凌晨不提前归档，配置的周起点后归档一次", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-day-sync-"));
  try {
    await writeDayStart(root, "07:30");
    await writeSyncConfig(root, { targetDir: path.join(root, "target"), intervalLabel: "3h", range: "this-week", suffix: null });
    let now = new Date(2026, 5, 1, 7, 29);
    const runExport = async (options: Record<string, string | boolean | undefined>) => {
      const window = expandToFullWeekWindow(resolveRange(String(options.range), now, 450));
      const outputPath = path.join(root, `${options.range}.json`);
      await fs.writeFile(outputPath, "{}");
      return { outputPath, window };
    };
    assert.equal((await performSync(root, runExport, now)).archivedLastWeekDest, null);
    now = new Date(2026, 5, 1, 7, 30);
    const result = await performSync(root, runExport, now);
    assert.equal(result.weekDir, "2026_06_01_2026_06_07");
    assert.match(result.archivedLastWeekDest ?? "", /2026_05_25_2026_05_31/);
    assert.equal((await performSync(root, runExport, now)).archivedLastWeekDest, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
