import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiModeConfig } from "../types";
import { ZHIPU_EXTRACTOR, defaultApiConfig, extractCustomQuota, readApiConfig, readClaudeSettingsEnvTokenSync, resolveApiQuota, resolveApiTokenWithSettings, runExtractor, writeApiConfig } from "../lib/api-mode";
import { getApiConfigPath } from "../lib/paths";

/** 造一个临时数据目录，避免污染真实 data-dir。 */
async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 一份 enabled 的默认配置，供 resolveApiQuota 测试复用。 */
function makeConfig(): ApiModeConfig {
  return { ...defaultApiConfig(), enabled: true };
}

test("zhipu preset extractor maps 5h/7d by nextResetTime order", () => {
  const sample = {
    code: 200,
    msg: "操作成功",
    success: true,
    data: {
      limits: [
        { type: "TIME_LIMIT", percentage: 7, usage: 1000, currentValue: 72, remaining: 928, nextResetTime: 1774663282997 },
        { type: "TOKENS_LIMIT", percentage: 44, nextResetTime: 1773734366338 },
        { type: "TOKENS_LIMIT", percentage: 53, nextResetTime: 1774663282997 },
      ],
      level: "pro",
    },
  };
  const q = runExtractor(ZHIPU_EXTRACTOR, sample);
  assert.equal(q?.fiveHour, 44);
  assert.equal(q?.sevenDay, 53);
  assert.equal(q?.level, "pro");
});

test("zhipu preset extractor keeps array order when nextResetTime missing", () => {
  const q = runExtractor(ZHIPU_EXTRACTOR, {
    success: true,
    data: {
      limits: [
        { type: "TOKENS_LIMIT", percentage: 44 },
        { type: "TOKENS_LIMIT", percentage: 53 },
      ],
      level: null,
    },
  });
  assert.equal(q?.fiveHour, 44);
  assert.equal(q?.sevenDay, 53);
  assert.equal(q?.level, null);
});

test("zhipu preset extractor maps missing nextResetTime to 5h bucket", () => {
  // 智谱在 5h 桶=0% 时会省略该条的 nextResetTime；缺字段的那条必须归 5h，否则 5h/weekly 槽位互换
  // （bug 表现：fiveHour=8、sevenDay=0）。对照 cc-switch v3.16.0 的同类修复。
  const q = runExtractor(ZHIPU_EXTRACTOR, {
    success: true,
    data: {
      limits: [
        { type: "TOKENS_LIMIT", percentage: 0 },
        { type: "TOKENS_LIMIT", percentage: 8, nextResetTime: 1774663282997 },
      ],
    },
  });
  assert.equal(q?.fiveHour, 0);
  assert.equal(q?.sevenDay, 8);
});

test("zhipu preset extractor tolerates single TOKENS_LIMIT", () => {
  const q = runExtractor(ZHIPU_EXTRACTOR, {
    success: true,
    data: { limits: [{ type: "TOKENS_LIMIT", percentage: 44 }] },
  });
  assert.equal(q?.fiveHour, 44);
  assert.equal(q?.sevenDay, null);
});

test("zhipu preset extractor returns null on failure / missing fields", () => {
  assert.equal(runExtractor(ZHIPU_EXTRACTOR, null), null);
  assert.equal(runExtractor(ZHIPU_EXTRACTOR, { success: true }), null);
  assert.equal(runExtractor(ZHIPU_EXTRACTOR, { success: false, msg: "查询失败", data: { limits: [] } }), null);
  assert.equal(runExtractor(ZHIPU_EXTRACTOR, { code: 500, data: { limits: [] } }), null);
  assert.equal(
    runExtractor(ZHIPU_EXTRACTOR, { success: true, data: { limits: [{ type: "TIME_LIMIT", percentage: 7 }] } }),
    null,
  );
});

test("extractCustomQuota reads dotted path with array index", () => {
  const json = { data: { items: [{ pct: 12.5 }, { pct: 88 }] } };
  const q = extractCustomQuota(json, "data.items.0.pct", "data.items.1.pct");
  assert.equal(q?.fiveHour, 12.5);
  assert.equal(q?.sevenDay, 88);
});

test("extractCustomQuota returns null when both paths missing", () => {
  assert.equal(extractCustomQuota({ data: {} }, "data.a", "data.b"), null);
});

test("extractCustomQuota tolerates one missing path", () => {
  const q = extractCustomQuota({ data: { a: 5 } }, "data.a", "data.b");
  assert.equal(q?.fiveHour, 5);
  assert.equal(q?.sevenDay, null);
});

test("writeApiConfig then readApiConfig round-trips", async () => {
  const dataDir = await mkdtemp("ccus-api-cfg-");
  const config = defaultApiConfig();
  config.enabled = true;
  config.provider = "zhipu";
  config.zhipu.project = "p1";
  config.zhipu.organization = "o1";
  await writeApiConfig(dataDir, config);
  const read = readApiConfig(dataDir);
  assert.equal(read.enabled, true);
  assert.equal(read.provider, "zhipu");
  assert.equal(read.zhipu.project, "p1");
  assert.equal(read.zhipu.organization, "o1");
});

test("readApiConfig returns disabled defaults when file missing", async () => {
  const dataDir = await mkdtemp("ccus-api-cfg-");
  const read = readApiConfig(dataDir);
  assert.equal(read.enabled, false);
  assert.equal(read.provider, "zhipu");
  assert.equal(read.cacheTtlMs, 5 * 60 * 1000);
  assert.equal(read.timeoutMs, 4000);
  assert.equal(read.tokenEnv, "ANTHROPIC_AUTH_TOKEN");
});

test("readApiConfig falls back on corrupt file", async () => {
  const dataDir = await mkdtemp("ccus-api-cfg-");
  await fs.writeFile(getApiConfigPath(dataDir), "{not json", "utf8");
  const read = readApiConfig(dataDir);
  assert.equal(read.enabled, false);
});

test("resolveApiQuota fetches once and serves cache while fresh", async () => {
  const dataDir = await mkdtemp("ccus-api-quota-");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { fiveHour: 10, sevenDay: 20, level: "pro" };
  };
  const now = new Date("2026-06-30T10:00:00Z");
  const q1 = await resolveApiQuota(dataDir, makeConfig(), {}, { now, fetcher });
  assert.equal(calls, 1);
  assert.deepEqual(q1, { fiveHour: 10, sevenDay: 20, level: "pro" });

  const q2 = await resolveApiQuota(dataDir, makeConfig(), {}, { now, fetcher });
  assert.equal(calls, 1);
  assert.deepEqual(q2, { fiveHour: 10, sevenDay: 20, level: "pro" });
});

test("resolveApiQuota refetches after ttl expires", async () => {
  const dataDir = await mkdtemp("ccus-api-quota-");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { fiveHour: 1, sevenDay: 2, level: null };
  };
  const t0 = new Date("2026-06-30T10:00:00Z");
  await resolveApiQuota(dataDir, makeConfig(), {}, { now: t0, fetcher });
  const later = new Date("2026-06-30T10:06:00Z"); // +6 分钟 > 5 分钟 TTL
  await resolveApiQuota(dataDir, makeConfig(), {}, { now: later, fetcher });
  assert.equal(calls, 2);
});

test("resolveApiQuota falls back to stale cache on fetch error", async () => {
  const dataDir = await mkdtemp("ccus-api-quota-");
  const ok = async () => ({ fiveHour: 10, sevenDay: 20, level: "pro" });
  const fail = async () => {
    throw new Error("boom");
  };
  const t0 = new Date("2026-06-30T10:00:00Z");
  await resolveApiQuota(dataDir, makeConfig(), {}, { now: t0, fetcher: ok });
  const later = new Date("2026-06-30T10:06:00Z");
  const q = await resolveApiQuota(dataDir, makeConfig(), {}, { now: later, fetcher: fail });
  assert.deepEqual(q, { fiveHour: 10, sevenDay: 20, level: "pro" });
});

test("resolveApiQuota returns null when fetch fails and no cache", async () => {
  const dataDir = await mkdtemp("ccus-api-quota-");
  const fail = async () => {
    throw new Error("boom");
  };
  const q = await resolveApiQuota(dataDir, makeConfig(), {}, { now: new Date(), fetcher: fail });
  assert.equal(q, null);
});

test("runExtractor runs function extractor returning object", () => {
  const script = `function(response) { return { fiveHour: response.a, sevenDay: response.b }; }`;
  const q = runExtractor(script, { a: 11, b: 22 });
  assert.equal(q?.fiveHour, 11);
  assert.equal(q?.sevenDay, 22);
  assert.equal(q?.level, null);
});

test("runExtractor runs arrow extractor with level", () => {
  const q = runExtractor(`(r) => ({ fiveHour: r.x, sevenDay: r.y, level: "pro" })`, { x: 1, y: 2 });
  assert.deepEqual(q, { fiveHour: 1, sevenDay: 2, level: "pro" });
});

test("runExtractor reuses cc-switch style array return", () => {
  // 直接复用用户给的 cc-switch extractor 逻辑，验证兼容（无需改写即可用）
  const script = `function(response) {
    const limits = response.data.limits;
    const tokenLimits = limits.filter((l) => l.type === "TOKENS_LIMIT");
    tokenLimits.sort((a, b) => a.nextResetTime - b.nextResetTime);
    return [
      { used: tokenLimits[0].percentage },
      { used: tokenLimits[1].percentage },
    ];
  }`;
  const q = runExtractor(script, {
    data: { limits: [
      { type: "TOKENS_LIMIT", percentage: 44, nextResetTime: 1 },
      { type: "TOKENS_LIMIT", percentage: 53, nextResetTime: 2 },
    ] },
  });
  assert.equal(q?.fiveHour, 44);
  assert.equal(q?.sevenDay, 53);
});

test("runExtractor tolerates number array return", () => {
  const q = runExtractor(`() => [5, 9]`, {});
  assert.equal(q?.fiveHour, 5);
  assert.equal(q?.sevenDay, 9);
});

test("runExtractor returns null on thrown error", () => {
  const q = runExtractor(`function() { throw new Error("boom"); }`, {});
  assert.equal(q, null);
});

test("runExtractor returns null when script does not evaluate to a function", () => {
  const q = runExtractor(`({ fiveHour: 1 })`, {});
  assert.equal(q, null);
});

test("runExtractor returns null for empty script", () => {
  assert.equal(runExtractor("", {}), null);
  assert.equal(runExtractor("   ", {}), null);
});

test("writeApiConfig round-trips custom extractor", async () => {
  const dataDir = await mkdtemp("ccus-api-cfg-");
  const config = defaultApiConfig();
  config.custom.extractor = `(r) => ({ fiveHour: r.a, sevenDay: r.b })`;
  await writeApiConfig(dataDir, config);
  const read = readApiConfig(dataDir);
  assert.equal(read.custom.extractor, `(r) => ({ fiveHour: r.a, sevenDay: r.b })`);
});

// --- ~/.claude/settings.json 的 token 回退（ccus api test 手动路径专用） ---

/** 临时造一个 settings.json 路径，避免污染真实 ~/.claude。 */
async function makeTempSettings(): Promise<{ dir: string; settingsPath: string }> {
  const dir = await mkdtemp("ccus-api-settings-");
  return { dir, settingsPath: path.join(dir, "settings.json") };
}

test("readClaudeSettingsEnvTokenSync reads token from settings env field", async () => {
  const { dir, settingsPath } = await makeTempSettings();
  await fs.writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "tok-from-settings" } }), "utf8");
  try {
    assert.equal(readClaudeSettingsEnvTokenSync("ANTHROPIC_AUTH_TOKEN", settingsPath), "tok-from-settings");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readClaudeSettingsEnvTokenSync returns null when env field missing", async () => {
  const { dir, settingsPath } = await makeTempSettings();
  await fs.writeFile(settingsPath, JSON.stringify({ model: "opus" }), "utf8");
  try {
    assert.equal(readClaudeSettingsEnvTokenSync("ANTHROPIC_AUTH_TOKEN", settingsPath), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readClaudeSettingsEnvTokenSync returns null when settings file missing", async () => {
  const { dir, settingsPath } = await makeTempSettings();
  try {
    assert.equal(readClaudeSettingsEnvTokenSync("ANTHROPIC_AUTH_TOKEN", settingsPath), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readClaudeSettingsEnvTokenSync returns null on unparseable settings", async () => {
  const { dir, settingsPath } = await makeTempSettings();
  await fs.writeFile(settingsPath, "{not valid json", "utf8");
  try {
    assert.equal(readClaudeSettingsEnvTokenSync("ANTHROPIC_AUTH_TOKEN", settingsPath), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readClaudeSettingsEnvTokenSync ignores blank token value", async () => {
  const { dir, settingsPath } = await makeTempSettings();
  await fs.writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "   " } }), "utf8");
  try {
    assert.equal(readClaudeSettingsEnvTokenSync("ANTHROPIC_AUTH_TOKEN", settingsPath), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readClaudeSettingsEnvTokenSync does not consult apiKeyHelper", async () => {
  const { dir, settingsPath } = await makeTempSettings();
  await fs.writeFile(settingsPath, JSON.stringify({ apiKeyHelper: "echo never-used" }), "utf8");
  try {
    assert.equal(readClaudeSettingsEnvTokenSync("ANTHROPIC_AUTH_TOKEN", settingsPath), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resolveApiTokenWithSettings prefers environment variable over config.token", () => {
  const config = { ...defaultApiConfig(), token: "config-fallback" };
  assert.equal(resolveApiTokenWithSettings(config, { ANTHROPIC_AUTH_TOKEN: "from-env" }), "from-env");
});

test("resolveApiTokenWithSettings falls back to config.token when env missing", () => {
  // 用一个保证不存在于真实 settings.json 的键名，避免读真实 ~/.claude 干扰断言。
  const config = { ...defaultApiConfig(), tokenEnv: "CCUS_TEST_MISSING_TOKEN_ENV", token: "config-fallback" };
  assert.equal(resolveApiTokenWithSettings(config, {}), "config-fallback");
});

test("resolveApiTokenWithSettings returns null when no source has a token", () => {
  const config = { ...defaultApiConfig(), tokenEnv: "CCUS_TEST_MISSING_TOKEN_ENV", token: null };
  assert.equal(resolveApiTokenWithSettings(config, {}), null);
});
