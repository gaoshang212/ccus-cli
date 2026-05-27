import test from "node:test";
import assert from "node:assert/strict";
import { computeStatuslineEvent, createPersistedStatuslineEvent, formatStatusLine, parseStatuslinePayload } from "../lib/payload";

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
    contextWindowPct: null,
    contextUsed: null,
    contextMax: null,
    modelName: null,
    workspaceName: null,
    timestamp: "2026-05-26T10:32:11.000Z",
  });

  assert.match(line, /5h --/);
  assert.match(line, /ctx --/);
});
