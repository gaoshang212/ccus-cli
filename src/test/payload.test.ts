import test from "node:test";
import assert from "node:assert/strict";
import { computeStatuslineEvent, createPersistedStatuslineEvent, formatStatusLine, parseStatuslinePayload, resolveCtxRedThresholds } from "../lib/payload";

/** ctx 段标红用的 ANSI 红色控制码，测试里用来断言是否标红。 */
const ANSI_RED = "\x1b[31m";

/** 验证我们能正确读取官方文档里给出的核心字段。 */
test("computeStatuslineEvent reads official fields from raw payload", () => {
  const payload = parseStatuslinePayload(`{
    "model": { "display_name": "Opus" },
    "workspace": { "current_dir": "/home/user/project" },
    "context_window": { "used_percentage": 25 },
    "rate_limits": {
      "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
      "seven_day": { "used_percentage": 61.2, "resets_at": 1739025600 }
    },
    "session_id": "test-session-abc"
  }`);

  const event = computeStatuslineEvent(createPersistedStatuslineEvent(payload, new Date("2026-05-26T10:32:11.000Z")));

  assert.equal(event.modelName, "Opus");
  assert.equal(event.workspaceDir, "/home/user/project");
  assert.equal(event.workspaceName, "project");
  assert.equal(event.sessionId, "test-session-abc");
  assert.equal(event.gitUserName, null);
  assert.equal(event.gitUserEmail, null);
  assert.equal(event.usagePct, 23.5);
  assert.equal(event.sevenDayUsagePct, 61.2);
  assert.equal(event.contextWindowPct, 25);
});

/** 新版 context_window 结构下，contextUsed/contextMax 需要从 totals 与 context_window_size 推导。 */
test("computeStatuslineEvent derives context used and max from modern context_window fields", () => {
  const payload = parseStatuslinePayload(`{
    "model": { "display_name": "Opus 4.7" },
    "workspace": { "current_dir": "/repo/zentao" },
    "context_window": {
      "total_input_tokens": 132177,
      "total_output_tokens": 353,
      "context_window_size": 1000000,
      "current_usage": {
        "input_tokens": 66129,
        "output_tokens": 353,
        "cache_read_input_tokens": 66048
      },
      "used_percentage": 13
    },
    "session_id": "modern-session"
  }`);

  const event = computeStatuslineEvent(createPersistedStatuslineEvent(payload, new Date("2026-05-27T06:40:56.488Z")));

  assert.equal(event.contextUsed, 132530);
  assert.equal(event.contextMax, 1000000);
  assert.equal(event.contextWindowPct, 13);
});

/** 新持久化事件不应该把派生分析字段直接写进日志。 */
test("createPersistedStatuslineEvent keeps only raw payload and external fields", () => {
  const payload = parseStatuslinePayload(`{"session_id":"abc"}`);
  const record = createPersistedStatuslineEvent(payload, new Date("2026-05-26T10:32:11.000Z"));

  assert.equal(record.schemaVersion, 3);
  assert.equal(record.gitUserAccount, null);
  assert.deepEqual(record.rawPayload, payload);
  assert.equal("usagePct" in record, false);
  assert.equal("statusLine" in record, false);
});

/** computeStatuslineEvent 在旧日志缺 gitUserAccount 时也能从 email 派生。 */
test("computeStatuslineEvent derives gitUserAccount from email when missing", () => {
  const payload = parseStatuslinePayload(`{"session_id":"abc"}`);
  const record = createPersistedStatuslineEvent(payload, new Date("2026-05-26T10:32:11.000Z"));
  record.gitUserEmail = "Alice.Dev+ops@example.com";

  const event = computeStatuslineEvent(record);

  assert.equal(event.gitUserAccount, "alice.dev-ops");
});

/** 即使缺字段，statusline 也应该输出可用的降级文本，而不是抛错。 */
test("formatStatusLine degrades gracefully when fields are missing", () => {
  const line = formatStatusLine({
    usagePct: null,
    sevenDayUsagePct: null,
    contextWindowPct: null,
    modelName: null,
    workspaceName: null,
    timestamp: "2026-05-26T10:32:11.000Z",
  });

  assert.match(line, /5h --/);
  assert.match(line, /7d --/);
  assert.match(line, /ctx --/);
});

/** ctx 走百分比、并带上 7 天额度使用率。 */
test("formatStatusLine renders context as percent and includes 7d usage", () => {
  const line = formatStatusLine({
    usagePct: 12.3,
    sevenDayUsagePct: 41.5,
    contextWindowPct: 18.7,
    modelName: "Opus",
    workspaceName: "repo",
    timestamp: "2026-05-26T10:32:11.000Z",
  });

  assert.match(line, /5h 12\.3%/);
  assert.match(line, /7d 41\.5%/);
  assert.match(line, /ctx 18\.7%/);
  assert.equal(line.includes("/"), false);
  // 占用低于 200K 档默认 80% 阈值时不应标红。
  assert.equal(line.includes(ANSI_RED), false);
});

/** 200K 档默认 80%：73.4% 不红，85% 红。 */
test("formatStatusLine uses 200K-tier default threshold (80%)", () => {
  const base = {
    usagePct: 12.3,
    sevenDayUsagePct: 41.5,
    modelName: "Opus",
    workspaceName: "repo",
    timestamp: "2026-05-26T10:32:11.000Z",
    contextMax: 200_000,
  };

  // 73.4% 低于 200K 档默认 80%，不标红。
  assert.equal(formatStatusLine({ ...base, contextWindowPct: 73.4 }, null, {}).includes(ANSI_RED), false);
  // 85% 超过 80%，标红。
  assert.equal(formatStatusLine({ ...base, contextWindowPct: 85 }, null, {}).includes(ANSI_RED), true);
});

/** 1M 档默认 50%：40% 不红，60% 红（同样 60% 在 200K 档反而不红）。 */
test("formatStatusLine uses 1M-tier default threshold (50%)", () => {
  const base = {
    usagePct: 12.3,
    sevenDayUsagePct: 41.5,
    modelName: "Opus",
    workspaceName: "repo",
    timestamp: "2026-05-26T10:32:11.000Z",
    contextMax: 1_000_000,
  };

  assert.equal(formatStatusLine({ ...base, contextWindowPct: 40 }, null, {}).includes(ANSI_RED), false);
  assert.equal(formatStatusLine({ ...base, contextWindowPct: 60 }, null, {}).includes(ANSI_RED), true);
  // 同样 60% 占用，换到 200K 档（默认 80%）就不标红，体现分档。
  assert.equal(
    formatStatusLine({ ...base, contextMax: 200_000, contextWindowPct: 60 }, null, {}).includes(ANSI_RED),
    false,
  );
});

/** 档位专属环境变量覆盖通用变量与档位默认。 */
test("formatStatusLine prefers tier-specific env over generic env", () => {
  const event = {
    usagePct: 12.3,
    sevenDayUsagePct: 41.5,
    contextWindowPct: 65,
    modelName: "Opus",
    workspaceName: "repo",
    timestamp: "2026-05-26T10:32:11.000Z",
    contextMax: 200_000,
  };

  // 通用阈值设 60（65% 会红），但 200K 专属阈值设 90 应优先生效，65% 不红。
  assert.equal(
    formatStatusLine(event, null, { CCUS_CTX_RED_PCT: "60", CCUS_CTX_RED_PCT_200K: "90" }).includes(ANSI_RED),
    false,
  );
  // 只设通用阈值 60 时回退到通用值，65% 标红。
  assert.equal(formatStatusLine(event, null, { CCUS_CTX_RED_PCT: "60" }).includes(ANSI_RED), true);
});

/** token 绝对值阈值（支持 k 写法）也能触发标红，且按档位区分。 */
test("formatStatusLine marks ctx red when used tokens exceed tier token threshold", () => {
  const event = {
    usagePct: 12.3,
    sevenDayUsagePct: 41.5,
    contextWindowPct: 40,
    contextUsed: 600_000,
    modelName: "Opus",
    workspaceName: "repo",
    timestamp: "2026-05-26T10:32:11.000Z",
    contextMax: 1_000_000,
  };

  // 百分比 40% 低于 1M 档默认 50%，但已用 token 超过 1M 档 token 阈值 500k，应标红。
  assert.equal(formatStatusLine(event, null, { CCUS_CTX_RED_TOKENS_1M: "500k" }).includes(ANSI_RED), true);
  assert.equal(formatStatusLine(event, null, { CCUS_CTX_RED_TOKENS_1M: "0.7m" }).includes(ANSI_RED), false);
});

/** 阈值解析：分档默认、专属/通用优先级、token 各种写法。 */
test("resolveCtxRedThresholds resolves per-tier thresholds", () => {
  // 默认档位：拿不到 contextMax → 200K 档默认 80%；1M 档默认 50%。
  assert.deepEqual(resolveCtxRedThresholds(null, {}), { tier: "200k", pct: 80, tokens: null });
  assert.deepEqual(resolveCtxRedThresholds(200_000, {}), { tier: "200k", pct: 80, tokens: null });
  assert.deepEqual(resolveCtxRedThresholds(1_000_000, {}), { tier: "1m", pct: 50, tokens: null });

  // 专属变量优先于通用变量。
  assert.deepEqual(
    resolveCtxRedThresholds(200_000, { CCUS_CTX_RED_PCT: "60", CCUS_CTX_RED_PCT_200K: "90" }),
    { tier: "200k", pct: 90, tokens: null },
  );
  // 无专属变量时回退通用变量。
  assert.deepEqual(resolveCtxRedThresholds(1_000_000, { CCUS_CTX_RED_PCT: "55" }), { tier: "1m", pct: 55, tokens: null });

  // token 写法：k / m / 纯数字，非法回退默认 null。
  assert.deepEqual(resolveCtxRedThresholds(200_000, { CCUS_CTX_RED_TOKENS_200K: "120k" }).tokens, 120_000);
  assert.deepEqual(resolveCtxRedThresholds(1_000_000, { CCUS_CTX_RED_TOKENS_1M: "0.5m" }).tokens, 500_000);
  assert.deepEqual(resolveCtxRedThresholds(200_000, { CCUS_CTX_RED_TOKENS: "150000" }).tokens, 150_000);
  assert.deepEqual(resolveCtxRedThresholds(200_000, { CCUS_CTX_RED_TOKENS: "bad" }).tokens, null);
});

/** 拿得到分支名时，statusline 追加一段分支信息。 */
test("formatStatusLine appends git branch segment when provided", () => {
  const line = formatStatusLine(
    {
      usagePct: 12.3,
      sevenDayUsagePct: 41.5,
      contextWindowPct: 18.7,
      modelName: "Opus",
      workspaceName: "repo",
      timestamp: "2026-05-26T10:32:11.000Z",
    },
    "feature/login",
  );

  assert.match(line, /⎇ feature\/login/);
  // 分支段位于 workspace 之后、时间之前。
  assert.ok(line.indexOf("repo") < line.indexOf("⎇ feature/login"));
});

/** 没有分支名时不应出现分支段，避免历史日志重算时多出占位。 */
test("formatStatusLine omits branch segment when branch is null", () => {
  const line = formatStatusLine({
    usagePct: 12.3,
    sevenDayUsagePct: 41.5,
    contextWindowPct: 18.7,
    modelName: "Opus",
    workspaceName: "repo",
    timestamp: "2026-05-26T10:32:11.000Z",
  });

  assert.equal(line.includes("⎇"), false);
});

/** computeStatuslineEvent 透传分支名到 statusLine。 */
test("computeStatuslineEvent forwards gitBranch into statusLine", () => {
  const payload = parseStatuslinePayload(`{"workspace":{"current_dir":"/repo/app"},"session_id":"s1"}`);
  const record = createPersistedStatuslineEvent(payload, new Date("2026-05-26T10:32:11.000Z"));

  const event = computeStatuslineEvent(record, { gitBranch: "main" });

  assert.match(event.statusLine, /⎇ main/);
});
