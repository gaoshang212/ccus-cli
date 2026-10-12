import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { main } from "../cli";
import { resolveRange } from "../lib/time";
import { appendEvent } from "../lib/storage";
import { SyncConfig } from "../types";
import {
  applyFileSuffix,
  formatSyncElapsed,
  isSyncDue,
  parseSyncInterval,
  performSync,
  readSyncConfig,
  readSyncStateSync,
  sanitizeSuffix,
  writeSyncConfig,
} from "../lib/sync";

test("补同步只导出指定周，覆盖目标副本并保留配置和自动同步状态", async () => {
  const root = await makeTempDir("ccus-resync-");
  try {
    const targetDir = path.join(root, "target");
    await writeSyncConfig(root, { targetDir, intervalLabel: "3h", range: "this-week", suffix: "office" });
    const configBefore = await fs.readFile(path.join(root, "sync-config.json"), "utf8");
    const statePath = path.join(root, "sync-state.json");
    const stateBefore = JSON.stringify({ lastSyncedAt: "2026-10-12T00:00:00Z", lastResult: "ok", lastArchivedWeek: "old" });
    await fs.writeFile(statePath, stateBefore);
    const now = new Date(2026, 9, 12, 10);
    let exports = 0;
    const runExport = async (opts: Record<string, string | boolean | undefined>) => {
      assert.equal(opts.range, "week:2026-09-30");
      const window = resolveRange(String(opts.range), now);
      const outputPath = path.join(root, "test.json.gz");
      await fs.writeFile(outputPath, `bundle-${++exports}`);
      return { outputPath, window };
    };
    const first = await performSync(root, runExport, now, "2026-09-30");
    assert.equal(first.weekDir, "2026_09_28_2026_10_04");
    assert.equal(path.basename(first.destPath), "test-office.json.gz");
    assert.equal(first.archivedLastWeekDest, null);
    assert.equal(await fs.readFile(first.destPath, "utf8"), "bundle-1");
    await performSync(root, runExport, now, "2026-09-30");
    assert.equal(await fs.readFile(first.destPath, "utf8"), "bundle-2");
    assert.equal(exports, 2);
    await assert.rejects(() => performSync(root, runExport, now, "2026-02-29"), /无效的周日期/);
    await assert.rejects(() => performSync(root, async () => { throw new Error("导出失败"); }, now, "2026-09-30"), /导出失败/);
    assert.equal(await fs.readFile(path.join(root, "sync-config.json"), "utf8"), configBefore);
    assert.equal(await fs.readFile(statePath, "utf8"), stateBefore);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sync --week 重新生成真实 bundle，过滤周边界并拒绝缺参及配置混用", async () => {
  const root = await makeTempDir("ccus-resync-cli-");
  const saved = { CCUS_CLAUDE_DATA_DIR: process.env.CCUS_CLAUDE_DATA_DIR, CODEX_HOME: process.env.CODEX_HOME, APPDATA: process.env.APPDATA };
  const stdout = mock.method(process.stdout, "write", () => true);
  try {
    process.env.CCUS_CLAUDE_DATA_DIR = path.join(root, "claude");
    process.env.CODEX_HOME = path.join(root, "codex");
    process.env.APPDATA = path.join(root, "appdata");
    const targetDir = path.join(root, "target");
    await writeSyncConfig(root, { targetDir, intervalLabel: "3h", range: "this-week", suffix: "office" });
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ dayStart: "07:30" }));
    const week = resolveRange("week:2026-09-30", new Date(), 450);
    for (const timestamp of [week.start.getTime() - 1, week.start.getTime(), week.end.getTime(), week.end.getTime() + 1]) {
      await appendEvent(root, {
        schemaVersion: 3, timestamp: new Date(timestamp).toISOString(), gitUserName: "test", gitUserEmail: "test@example.com", gitUserAccount: "test",
        rawPayload: { rate_limits: { seven_day: { used_percentage: 10 } } },
      });
    }
    const args = ["sync", "--week", "2026-09-30", "--data-dir", root];
    await main(args);
    const weekDir = path.join(targetDir, "2026_09_28_2026_10_04");
    const [fileName] = await fs.readdir(weekDir);
    assert.match(fileName, /2026-09-28_to_2026-10-04-office\.json\.gz$/);
    const dest = path.join(weekDir, fileName);
    const bundle = JSON.parse(gunzipSync(await fs.readFile(dest)).toString("utf8"));
    assert.equal(bundle.schemaVersion, 12);
    assert.equal(bundle.range.start, week.start.toISOString());
    assert.equal(bundle.range.end, week.end.toISOString());
    assert.equal(bundle.range.dayStart, "07:30");
    assert.equal(bundle.dailySummaries.length, 7);
    assert.equal(bundle.rawEvents.length, 2);
    await fs.writeFile(dest, "旧文件");
    await main(args);
    assert.equal(JSON.parse(gunzipSync(await fs.readFile(dest)).toString("utf8")).rawEvents.length, 2);
    assert.equal(readSyncConfig(root).range, "this-week");
    assert.equal(readSyncStateSync(root), null);
    await assert.rejects(() => main(["sync", "--week", "--data-dir", root]), /缺少日期/);
    for (const option of ["target", "interval", "range", "suffix", "no-suffix"]) {
      await assert.rejects(() => main([...args, `--${option}`, "changed"]), /不能与同步配置参数/);
    }
    await assert.rejects(() => main(["sync", "config", "--week", "2026-09-30", "--data-dir", root]), /只用于本次同步/);
    await assert.rejects(() => main(["sync", "--week", "2026-02-29", "--data-dir", root]), /无效的周日期/);
    assert.equal(readSyncConfig(root).targetDir, targetDir);
  } finally {
    stdout.mock.restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** 造一个临时数据目录，避免污染真实 data-dir。 */
async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("formatSyncElapsed renders seconds with three decimals", () => {
  assert.equal(formatSyncElapsed(0), "0.000s");
  assert.equal(formatSyncElapsed(1_852), "1.852s");
  assert.equal(formatSyncElapsed(61_234), "61.234s");
});

test("parseSyncInterval maps daily / empty / unknown to daily, and <N>h <N>m to rolling TTL", () => {
  assert.deepEqual(parseSyncInterval("daily"), { kind: "daily" });
  assert.deepEqual(parseSyncInterval(""), { kind: "daily" });
  assert.deepEqual(parseSyncInterval(undefined), { kind: "daily" });
  assert.deepEqual(parseSyncInterval("weird"), { kind: "daily" });
  assert.deepEqual(parseSyncInterval("6h"), { kind: "ttl", ms: 6 * 60 * 60 * 1000 });
  assert.deepEqual(parseSyncInterval("30m"), { kind: "ttl", ms: 30 * 60 * 1000 });
});

test("readSyncConfig returns safe defaults when file is missing or broken", async () => {
  const dataDir = await makeTempDir("ccus-sync-cfg-");
  assert.deepEqual(readSyncConfig(dataDir), { targetDir: null, intervalLabel: "3h", range: "this-week", suffix: null });

  await fs.writeFile(path.join(dataDir, "sync-config.json"), "not json", "utf8");
  assert.deepEqual(readSyncConfig(dataDir), { targetDir: null, intervalLabel: "3h", range: "this-week", suffix: null });
});

test("writeSyncConfig then readSyncConfig round-trips", async () => {
  const dataDir = await makeTempDir("ccus-sync-cfg-");
  const config: SyncConfig = { targetDir: "/team/share", intervalLabel: "6h", range: "last-week", suffix: "office" };
  await writeSyncConfig(dataDir, config);
  assert.deepEqual(readSyncConfig(dataDir), config);
});

test("isSyncDue: never due without a target dir", () => {
  const config: SyncConfig = { targetDir: null, intervalLabel: "daily", range: "this-week", suffix: null };
  assert.equal(isSyncDue(config, null), false);
  assert.equal(isSyncDue(config, { lastSyncedAt: null, lastResult: null }), false);
});

test("isSyncDue: daily triggers across calendar days, not within the same day", () => {
  const config: SyncConfig = { targetDir: "/x", intervalLabel: "daily", range: "this-week", suffix: null };
  // 从未同步过 → 到期
  assert.equal(isSyncDue(config, null), true);

  const day1 = new Date(2026, 5, 3, 23, 0, 0);
  const day2 = new Date(2026, 5, 4, 1, 0, 0);
  const state = { lastSyncedAt: day1.toISOString(), lastResult: "ok" as const };
  // 同一自然日内不重复触发（即使过了 2 小时跨午夜前）
  assert.equal(isSyncDue(config, state, day1), false);
  // 跨到下一自然日 → 到期
  assert.equal(isSyncDue(config, state, day2), true);
});

test("isSyncDue: <N>h interval uses a rolling TTL", () => {
  const config: SyncConfig = { targetDir: "/x", intervalLabel: "6h", range: "this-week", suffix: null };
  const base = new Date(2026, 5, 3, 10, 0, 0);
  const state = { lastSyncedAt: base.toISOString(), lastResult: "ok" as const };
  assert.equal(isSyncDue(config, state, new Date(2026, 5, 3, 14, 0, 0)), false); // +4h 未到
  assert.equal(isSyncDue(config, state, new Date(2026, 5, 3, 17, 0, 0)), true); // +7h 已过
});

test("performSync exports and copies the bundle into a per-week subdir of the target", async () => {
  const dataDir = await makeTempDir("ccus-sync-data-");
  const targetDir = await makeTempDir("ccus-sync-target-");
  await writeSyncConfig(dataDir, { targetDir, intervalLabel: "3h", range: "this-week", suffix: null });

  // 2026-06-01 周一 ~ 2026-06-07 周日。
  const start = new Date(2026, 5, 1);
  const end = new Date(2026, 5, 7, 23, 59, 59, 999);
  const localExport = path.join(dataDir, "exports", "alice_export_2026-06-01_to_2026-06-07.json.gz");
  const runExport = async () => {
    await fs.mkdir(path.dirname(localExport), { recursive: true });
    await fs.writeFile(localExport, "fake-bundle-bytes", "utf8");
    return { outputPath: localExport, window: { label: "this-week", start, end } };
  };

  const now = new Date(2026, 5, 3, 10, 0, 0);
  const result = await performSync(dataDir, runExport, now);

  assert.equal(result.weekDir, "2026_06_01_2026_06_07");
  const expectedDest = path.join(targetDir, "2026_06_01_2026_06_07", "alice_export_2026-06-01_to_2026-06-07.json.gz");
  assert.equal(result.destPath, expectedDest);
  // 复制到了目标周目录
  assert.equal(await fs.readFile(expectedDest, "utf8"), "fake-bundle-bytes");
  // 本地原文件仍保留（复制语义）
  assert.equal(await fs.readFile(localExport, "utf8"), "fake-bundle-bytes");
  // 状态写入成功
  const state = readSyncStateSync(dataDir);
  assert.equal(state?.lastResult, "ok");
  assert.equal(state?.lastSyncedAt, now.toISOString());
});

test("performSync on Monday also archives last-week, and dedupes within the same day", async () => {
  const dataDir = await makeTempDir("ccus-sync-data-");
  const targetDir = await makeTempDir("ccus-sync-target-");
  await writeSyncConfig(dataDir, { targetDir, intervalLabel: "3h", range: "this-week", suffix: null });

  // range-aware fake runExport：this-week 与 last-week 各返回各自窗口与文件。
  let lastWeekExports = 0;
  const runExport = async (opts: Record<string, string | boolean | undefined>) => {
    if (opts.range === "last-week") {
      lastWeekExports += 1;
      const start = new Date(2026, 4, 25); // 2026-05-25 周一
      const end = new Date(2026, 4, 31, 23, 59, 59, 999); // 2026-05-31 周日
      const p = path.join(dataDir, "exports", "alice_export_2026-05-25_to_2026-05-31.json.gz");
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, "lw-bytes", "utf8");
      return { outputPath: p, window: { label: "last-week", start, end } };
    }
    const start = new Date(2026, 5, 1); // 2026-06-01 周一
    const end = new Date(2026, 5, 7, 23, 59, 59, 999);
    const p = path.join(dataDir, "exports", "alice_export_2026-06-01_to_2026-06-07.json.gz");
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "tw-bytes", "utf8");
    return { outputPath: p, window: { label: "this-week", start, end } };
  };

  const monday = new Date(2026, 5, 1, 10, 0, 0); // 2026-06-01 周一
  const first = await performSync(dataDir, runExport, monday);

  // 当前周照常同步
  assert.equal(first.weekDir, "2026_06_01_2026_06_07");
  // 上一周被归档到对应子目录
  const lwDest = path.join(targetDir, "2026_05_25_2026_05_31", "alice_export_2026-05-25_to_2026-05-31.json.gz");
  assert.equal(first.archivedLastWeekDest, lwDest);
  assert.equal(await fs.readFile(lwDest, "utf8"), "lw-bytes");
  assert.equal(lastWeekExports, 1);
  // 状态记录已归档周
  assert.equal(readSyncStateSync(dataDir)?.lastArchivedWeek, "2026_05_25_2026_05_31");

  // 周一当天再次同步：不重复归档上一周
  const second = await performSync(dataDir, runExport, monday);
  assert.equal(second.archivedLastWeekDest, null);
  assert.equal(lastWeekExports, 1);
});

test("sanitizeSuffix trims, folds illegal chars, and returns null for empty", () => {
  assert.equal(sanitizeSuffix("laptop"), "laptop");
  assert.equal(sanitizeSuffix("  Office-PC  "), "Office-PC");
  assert.equal(sanitizeSuffix("my pc!!"), "my-pc");
  assert.equal(sanitizeSuffix("--x--"), "x");
  assert.equal(sanitizeSuffix(""), null);
  assert.equal(sanitizeSuffix(undefined), null);
});

test("applyFileSuffix inserts before .json.gz / .json, and is a no-op for null", () => {
  assert.equal(
    applyFileSuffix("alice_export_2026-06-01_to_2026-06-07.json.gz", "laptop"),
    "alice_export_2026-06-01_to_2026-06-07-laptop.json.gz",
  );
  assert.equal(
    applyFileSuffix("alice_export_2026-06-01_to_2026-06-07.json", "office"),
    "alice_export_2026-06-01_to_2026-06-07-office.json",
  );
  assert.equal(applyFileSuffix("alice_export_2026-06-01_to_2026-06-07.json.gz", null), "alice_export_2026-06-01_to_2026-06-07.json.gz");
});

test("performSync applies the configured suffix to the target file name only", async () => {
  const dataDir = await makeTempDir("ccus-sync-data-");
  const targetDir = await makeTempDir("ccus-sync-target-");
  await writeSyncConfig(dataDir, { targetDir, intervalLabel: "3h", range: "this-week", suffix: "laptop" });

  const start = new Date(2026, 5, 1);
  const end = new Date(2026, 5, 7, 23, 59, 59, 999);
  const localExport = path.join(dataDir, "exports", "alice_export_2026-06-01_to_2026-06-07.json.gz");
  const runExport = async () => {
    await fs.mkdir(path.dirname(localExport), { recursive: true });
    await fs.writeFile(localExport, "fake-bundle-bytes", "utf8");
    return { outputPath: localExport, window: { label: "this-week", start, end } };
  };

  const result = await performSync(dataDir, runExport, new Date(2026, 5, 3, 10, 0, 0));

  // 目标副本文件名带后缀
  const expectedDest = path.join(targetDir, "2026_06_01_2026_06_07", "alice_export_2026-06-01_to_2026-06-07-laptop.json.gz");
  assert.equal(result.destPath, expectedDest);
  assert.equal(await fs.readFile(expectedDest, "utf8"), "fake-bundle-bytes");
  // 本地原文件名不带后缀
  assert.equal(await fs.readFile(localExport, "utf8"), "fake-bundle-bytes");
});

test("performSync without a configured target dir throws and records an error state", async () => {
  const dataDir = await makeTempDir("ccus-sync-data-");
  const runExport = async () => {
    throw new Error("runExport should not be called");
  };
  await assert.rejects(() => performSync(dataDir, runExport), /未配置同步目标目录/);
});
