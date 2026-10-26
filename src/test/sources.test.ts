import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { main } from "../cli";
import { readConfig } from "../lib/config";
import { emptyApiEquivalentCost } from "../lib/api-equivalent-cost";
import { buildAggregatedDailyRows, loadWeeklyExportBundles } from "../lib/aggregate";
import { appendEvent, readEventsForRange } from "../lib/storage";
import { writeSyncConfig } from "../lib/sync";
import type { WeeklyExportBundle } from "../types";

test("来源配置默认全部启用，支持独立禁用、恢复、幂等及原子校验", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-source-config-"));
  try {
    assert.deepEqual((await readConfig(root)).disabledSources, []);
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ dayStart: "07:30", other: true }));
    const config = (...args: string[]) => main(["config", "--data-dir", root, ...args]);
    await config("--disable-source", "Claude");
    await config("--disable-source", "claude");
    assert.deepEqual(await readConfig(root), { dayStart: "07:30", other: true, disabledSources: ["claude"] });
    await config("--disable-source", "codex");
    assert.deepEqual((await readConfig(root)).disabledSources, ["claude", "codex"]);
    await config("--enable-source", "claude");
    assert.deepEqual((await readConfig(root)).disabledSources, ["codex"]);
    await config("--enable-source", "claude,codex", "--day-start", "8");
    assert.deepEqual((await readConfig(root)).disabledSources, []);
    assert.equal((await readConfig(root)).dayStart, "08:00");

    const before = await fs.readFile(path.join(root, "config.json"), "utf8");
    for (const args of [
      ["--disable-source"], ["--enable-source"], ["--disable-source", "unknown"],
      ["--disable-source", ""], ["--enable-source", "claude,"],
      ["--disable-source", "claude", "--enable-source", "claude"],
    ]) {
      await assert.rejects(() => config("--day-start", "9", ...args), /来源/);
      assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), before);
    }
    for (const disabledSources of [null, "claude", ["invalid"], [123]]) {
      const invalid = JSON.stringify({ disabledSources });
      await fs.writeFile(path.join(root, "config.json"), invalid);
      await assert.rejects(() => config("--day-start", "10"), /来源/);
      assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), invalid);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("禁用来源统一过滤消息/token/成本/历史额度，并覆盖看板、同步及临时恢复", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 5, 1, 12) });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-source-stats-"));
  const saved = { CCUS_CLAUDE_DATA_DIR: process.env.CCUS_CLAUDE_DATA_DIR, CODEX_HOME: process.env.CODEX_HOME, APPDATA: process.env.APPDATA };
  try {
    process.env.CCUS_CLAUDE_DATA_DIR = path.join(root, "claude");
    process.env.CODEX_HOME = path.join(root, "codex");
    process.env.APPDATA = path.join(root, "appdata");
    const claudeFile = path.join(process.env.CCUS_CLAUDE_DATA_DIR, "projects", "test", "test.jsonl");
    const codexFile = path.join(process.env.CODEX_HOME, "sessions", "test.jsonl");
    await fs.mkdir(path.dirname(claudeFile), { recursive: true });
    await fs.mkdir(path.dirname(codexFile), { recursive: true });
    const timestamps = [new Date(2026, 4, 25, 10).toISOString(), new Date(2026, 5, 1, 10).toISOString()];
    await fs.writeFile(claudeFile, timestamps.flatMap((timestamp) => [
      { type: "user", timestamp, message: { content: "test" } },
      { type: "assistant", timestamp, message: { model: "claude-sonnet-4.6", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 } } },
    ]).map((row) => JSON.stringify(row)).join("\n"));
    await fs.writeFile(codexFile, timestamps.flatMap((timestamp) => [
      { type: "turn_context", timestamp, payload: { model: "gpt-5" } },
      { type: "event_msg", timestamp, payload: { type: "task_started", turn_id: `turn-${timestamp}` } },
      { type: "event_msg", timestamp, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 40 } } } },
    ]).map((row) => JSON.stringify(row)).join("\n"));
    for (const timestamp of timestamps) {
      for (const [source, value] of [["claude", 80], ["codex", 20]] as const) {
        await appendEvent(root, {
          schemaVersion: 3, timestamp, gitUserName: "test", gitUserEmail: "test@example.com", gitUserAccount: "test",
          rawPayload: {
            ...(source === "codex" ? { source } : {}), // 旧 Claude 日志没有来源字段。
            session_id: `${source}-fixture`,
            rate_limits: { five_hour: { used_percentage: value }, seven_day: { used_percentage: value } },
          },
        });
      }
    }
    const output = path.join(root, "exports", "test.json");
    const exportBundle = async (...args: string[]): Promise<WeeklyExportBundle> => {
      await main(["export", "--data-dir", root, "--out", output, ...args]);
      return JSON.parse(await fs.readFile(output, "utf8"));
    };
    const baseline = await exportBundle();
    assert.equal(baseline.rawEvents.length, 2);
    assert.equal(baseline.weeklySummary.counts.userMessageCount, 1);
    assert.equal(baseline.weeklySummary.codex.userMessageCount, 1);
    assert.ok(baseline.weeklySummary.apiEquivalentCost.claude.estimatedUsd! > 0);
    assert.ok(baseline.weeklySummary.apiEquivalentCost.codex.estimatedUsd! > 0);

    await main(["config", "--disable-source", "claude", "--data-dir", root]);
    const oldTime = new Date(2020, 0, 1);
    await fs.utimes(claudeFile, oldTime, oldTime);
    const filtered = await exportBundle();
    assert.equal((await fs.stat(claudeFile)).mtimeMs, oldTime.getTime(), "禁用来源不自动修复会话");
    assert.equal(filtered.schemaVersion, 12);
    assert.deepEqual(Object.keys(filtered).sort(), Object.keys(baseline).sort());
    assert.equal(filtered.rawEvents.length, 1);
    assert.equal(filtered.rawEvents[0].rawPayload.source, "codex");
    assert.deepEqual(filtered.weeklySummary.counts, { userMessageCount: 0, apiRequestCount: 0 });
    assert.deepEqual(filtered.weeklySummary.tokens, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 });
    assert.equal(filtered.weeklySummary.statusline.sampleCount, 0);
    assert.equal(filtered.weeklySummary.statusline.sevenDayPeakUsagePct, null);
    assert.deepEqual(filtered.weeklySummary.codex, baseline.weeklySummary.codex);
    assert.deepEqual(filtered.weeklySummary.apiEquivalentCost.claude, emptyApiEquivalentCost());
    assert.deepEqual(filtered.weeklySummary.apiEquivalentCost.total, baseline.weeklySummary.apiEquivalentCost.codex);
    assert.equal(filtered.dailySummaries.length, 7);
    for (const day of filtered.dailySummaries) {
      assert.equal(day.userMessageCount, 0);
      assert.equal(day.inputTokens, 0);
      assert.equal(day.fiveHourLatestUsagePct, null);
      assert.deepEqual(day.apiEquivalentCost.claude, emptyApiEquivalentCost());
    }
    const aggregated = buildAggregatedDailyRows(await loadWeeklyExportBundles(path.dirname(output)));
    assert.equal(aggregated[0].userMessageCount, 1);
    assert.equal(aggregated[0].inputTokens, 200);
    assert.equal(aggregated[0].fiveHourLatestUsagePct, 20);

    const htmlPath = path.join(root, "dashboard.html");
    const dashboard = async (...args: string[]) => {
      await main(["dashboard", "build", "--range", "this-week", "--data-dir", root, "--out", htmlPath, ...args]);
      return fs.readFile(htmlPath, "utf8");
    };
    const html = await dashboard();
    assert.match(html, /共 0 条 Claude · 1 条 Codex/);
    assert.doesNotMatch(html, /claude-fixture/);
    assert.match(html, /codex-fixture/);
    assert.match(await dashboard("--enable-source", "claude", "--disable-source", "codex"), /共 1 条 Claude · 0 条 Codex/);

    const restored = await exportBundle("--enable-source", "claude");
    assert.equal(restored.rawEvents.length, 2);
    assert.deepEqual(restored.weeklySummary.counts, baseline.weeklySummary.counts);
    assert.deepEqual((await readConfig(root)).disabledSources, ["claude"]);
    const claudeOnly = await exportBundle("--enable-source", "claude", "--disable-source", "codex");
    assert.equal(claudeOnly.weeklySummary.codex.apiRequestCount, 0);
    assert.equal(claudeOnly.weeklySummary.codex.inputTokens, 0);
    assert.equal(claudeOnly.weeklySummary.codex.sevenDayLatestUsagePct, null);
    assert.deepEqual(claudeOnly.weeklySummary.apiEquivalentCost.codex, emptyApiEquivalentCost());
    assert.deepEqual(claudeOnly.weeklySummary.apiEquivalentCost.total, baseline.weeklySummary.apiEquivalentCost.claude);
    const empty = await exportBundle("--disable-source", "codex");
    assert.equal(empty.rawEvents.length, 0);
    assert.deepEqual(empty.weeklySummary.apiEquivalentCost.total, emptyApiEquivalentCost());
    assert.equal(empty.weeklySummary.counts.userMessageCount + empty.weeklySummary.codex.userMessageCount, 0);
    assert.equal((await readEventsForRange(root, "this-week")).length, 2, "历史日志保持完整");
    await assert.rejects(() => exportBundle("--disable-source"), /缺少来源/);
    await assert.rejects(() => dashboard("--enable-source", "unknown"), /来源/);

    const targetDir = path.join(root, "target");
    await writeSyncConfig(root, { targetDir, intervalLabel: "3h", range: "this-week", suffix: null });
    const readSynced = async (week: string): Promise<WeeklyExportBundle> => {
      const dir = path.join(targetDir, week);
      const [name] = await fs.readdir(dir);
      return JSON.parse(gunzipSync(await fs.readFile(path.join(dir, name))).toString("utf8"));
    };
    await main(["__sync", "--data-dir", root]);
    for (const week of ["2026_06_01_2026_06_07", "2026_05_25_2026_05_31"]) {
      const synced = await readSynced(week);
      assert.equal(synced.rawEvents.length, 1);
      assert.equal(synced.rawEvents[0].rawPayload.source, "codex");
      assert.equal(synced.weeklySummary.counts.userMessageCount, 0);
    }
    await main(["config", "--enable-source", "claude", "--disable-source", "codex", "--data-dir", root]);
    await main(["sync", "--week", "2026-05-25", "--data-dir", root]);
    const resynced = await readSynced("2026_05_25_2026_05_31");
    assert.equal(resynced.rawEvents.length, 1);
    assert.equal(resynced.rawEvents[0].rawPayload.source, undefined);
    assert.equal(resynced.weeklySummary.codex.userMessageCount, 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
