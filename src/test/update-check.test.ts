import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getUpdateCachePath } from "../lib/paths";
import { computeUpdateNotice, readUpdateCacheSync } from "../lib/update-check";
import { getCurrentVersion, isNewerVersion } from "../lib/version";

/** 写一个更新缓存文件，模拟后台检查已经跑过。 */
async function writeCache(dataDir: string, latestVersion: string | null, lastCheckedAt = new Date().toISOString()): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(getUpdateCachePath(dataDir), JSON.stringify({ lastCheckedAt, latestVersion }), "utf8");
}

test("isNewerVersion compares major.minor.patch numerically", () => {
  assert.equal(isNewerVersion("0.1.5", "0.1.4"), true);
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.1.4", "0.1.4"), false);
  assert.equal(isNewerVersion("0.1.3", "0.1.4"), false);
  assert.equal(isNewerVersion("v0.1.5", "0.1.4"), true);
  // 预发布后缀被忽略，只比较数字段。
  assert.equal(isNewerVersion("0.1.5-beta.1", "0.1.4"), true);
});

test("getCurrentVersion reads a non-empty semver-ish string from package.json", () => {
  const version = getCurrentVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("computeUpdateNotice returns a tag only when cache has a strictly newer version", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-update-"));

  // 无缓存：不提示。
  assert.equal(computeUpdateNotice(dataDir, "0.1.4"), null);

  // 缓存版本更新：提示。
  await writeCache(dataDir, "0.1.5");
  assert.equal(computeUpdateNotice(dataDir, "0.1.4"), "⬆ v0.1.5");

  // 缓存版本与当前相同：不提示。
  await writeCache(dataDir, "0.1.4");
  assert.equal(computeUpdateNotice(dataDir, "0.1.4"), null);

  // 缓存版本更旧：不提示。
  await writeCache(dataDir, "0.1.3");
  assert.equal(computeUpdateNotice(dataDir, "0.1.4"), null);

  // 缓存里没有 latestVersion（registry 当时失败）：不提示。
  await writeCache(dataDir, null);
  assert.equal(computeUpdateNotice(dataDir, "0.1.4"), null);
});

test("readUpdateCacheSync returns null for missing or broken cache", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-update-"));
  assert.equal(readUpdateCacheSync(dataDir), null);

  await fs.writeFile(getUpdateCachePath(dataDir), "not json", "utf8");
  assert.equal(readUpdateCacheSync(dataDir), null);

  await writeCache(dataDir, "0.1.5", "2026-06-01T00:00:00.000Z");
  const cache = readUpdateCacheSync(dataDir);
  assert.equal(cache?.latestVersion, "0.1.5");
  assert.equal(cache?.lastCheckedAt, "2026-06-01T00:00:00.000Z");
});
