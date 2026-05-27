import test from "node:test";
import assert from "node:assert/strict";
import { computeStatuslineEvent, createPersistedStatuslineEvent, formatStatusLine, parseStatuslinePayload } from "../lib/payload";

/** 验证我们能正确读取官方文档里给出的核心字段。 */
test("computeStatuslineEvent reads official fields from raw payload", () => {
  const payload = parseStatuslinePayload(`{
    "model": { "display_name": "Opus" },
    "workspace": { "current_dir": "/home/user/project" },
    "context_window": { "used_percentage": 25 },
    "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 } },
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
  assert.equal(event.contextWindowPct, 25);
});

/** 新持久化事件不应该把派生分析字段直接写进日志。 */
test("createPersistedStatuslineEvent keeps only raw payload and external fields", () => {
  const payload = parseStatuslinePayload(`{"session_id":"abc"}`);
  const record = createPersistedStatuslineEvent(payload, new Date("2026-05-26T10:32:11.000Z"));

  assert.equal(record.schemaVersion, 2);
  assert.deepEqual(record.rawPayload, payload);
  assert.equal("usagePct" in record, false);
  assert.equal("statusLine" in record, false);
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
