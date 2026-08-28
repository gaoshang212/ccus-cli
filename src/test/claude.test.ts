import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mergeApiEquivalentCosts } from "../lib/api-equivalent-cost";
import { summarizeClaudeProjectUsage, summarizeClaudeProjectUsageByDay, summarizeClaudeProjectUsageCombined } from "../lib/claude";

test("summarizeClaudeProjectUsage counts non-meta users and assistant usage tokens", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-claude-"));
  const projectsDir = path.join(root, "projects", "D--workspace-nodejs-ccus");
  const transcriptPath = path.join(projectsDir, "session-1.jsonl");
  process.env.CCUS_CLAUDE_DATA_DIR = root;

  try {
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "user", timestamp: "2026-05-26T01:00:00.000Z", isMeta: false, message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "user", timestamp: "2026-05-26T01:01:00.000Z", isMeta: true, message: { role: "user", content: "meta" } }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-26T01:02:00.000Z",
          message: {
            role: "assistant",
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 30,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const summary = await summarizeClaudeProjectUsage(new Date("2026-05-26T00:00:00.000Z"), new Date("2026-05-26T23:59:59.999Z"));

    assert.equal(summary.userMessageCount, 1);
    assert.equal(summary.apiRequestCount, 1);
    assert.equal(summary.inputTokens, 100);
    assert.equal(summary.outputTokens, 20);
    assert.equal(summary.cacheReadInputTokens, 30);
    assert.deepEqual(summary.apiEquivalentCost, {
      estimatedUsd: null,
      pricedApiRequestCount: 0,
      unpricedApiRequestCount: 1,
    });
    assert.equal(summary.matchedFileCount, 1);
  } finally {
    delete process.env.CCUS_CLAUDE_DATA_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("summarizeClaudeProjectUsage prices model switches, cache TTL details and fallback consistently by day", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-claude-cost-"));
  const firstProjectDir = path.join(root, "projects", "D--workspace-nodejs-ccus");
  const secondProjectDir = path.join(root, "projects", "D--workspace-nodejs-other");
  process.env.CCUS_CLAUDE_DATA_DIR = root;

  try {
    await fs.mkdir(firstProjectDir, { recursive: true });
    await fs.mkdir(secondProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(firstProjectDir, "session-1.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-26T01:00:00.000Z",
          message: {
            role: "assistant",
            model: "claude-4-sonnet-20250514",
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 1_000_000,
              cache_read_input_tokens: 1_000_000,
              cache_creation_input_tokens: 9_000_000,
              cache_creation: {
                ephemeral_5m_input_tokens: 1_000_000,
                ephemeral_1h_input_tokens: 1_000_000,
              },
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-26T02:00:00.000Z",
          message: {
            role: "assistant",
            model: "claude-4-sonnet-20250514",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 1_000_000,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(secondProjectDir, "session-2.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-27T01:00:00.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4-1-20250805",
            usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 },
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-27T02:00:00.000Z",
          message: {
            role: "assistant",
            model: "unknown-model",
            usage: { input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 13 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const start = new Date("2026-05-26T00:00:00.000Z");
    const end = new Date("2026-05-27T23:59:59.999Z");
    const weekly = await summarizeClaudeProjectUsage(start, end);
    const daily = await summarizeClaudeProjectUsageByDay(start, end);
    const combined = await summarizeClaudeProjectUsageCombined(start, end);
    const mergedDailyCost = mergeApiEquivalentCosts([...daily.values()].map((day) => day.apiEquivalentCost));

    assert.deepEqual(combined.weekly, weekly);
    assert.deepEqual(combined.daily, daily);

    assert.equal(weekly.apiRequestCount, 4);
    assert.equal(weekly.inputTokens, 2_000_007);
    assert.equal(weekly.outputTokens, 1_000_011);
    assert.equal(weekly.cacheReadInputTokens, 1_000_013);
    assert.deepEqual(daily.get("2026-05-26")?.apiEquivalentCost, {
      estimatedUsd: 56.1,
      pricedApiRequestCount: 2,
      unpricedApiRequestCount: 0,
    });
    assert.deepEqual(daily.get("2026-05-27")?.apiEquivalentCost, {
      estimatedUsd: 15,
      pricedApiRequestCount: 1,
      unpricedApiRequestCount: 1,
    });
    assert.deepEqual(weekly.apiEquivalentCost, mergedDailyCost);
    assert.equal(weekly.apiEquivalentCost.pricedApiRequestCount + weekly.apiEquivalentCost.unpricedApiRequestCount, weekly.apiRequestCount);
    for (const day of daily.values()) {
      assert.equal(day.apiEquivalentCost.pricedApiRequestCount + day.apiEquivalentCost.unpricedApiRequestCount, day.apiRequestCount);
    }
  } finally {
    delete process.env.CCUS_CLAUDE_DATA_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("summarizeClaudeProjectUsage excludes tool_result but keeps sidechain subagent prompts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-claude-filter-"));
  const projectsDir = path.join(root, "projects", "D--workspace-nodejs-ccus");
  const transcriptPath = path.join(projectsDir, "session-2.jsonl");
  process.env.CCUS_CLAUDE_DATA_DIR = root;

  try {
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      transcriptPath,
      [
        // 真用户字符串消息 → 计入
        JSON.stringify({ type: "user", timestamp: "2026-05-26T01:00:00.000Z", message: { role: "user", content: "hello" } }),
        // 真用户 array:text 消息 → 计入
        JSON.stringify({ type: "user", timestamp: "2026-05-26T01:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "with array" }] } }),
        // 工具回填的伪 user → 不计入
        JSON.stringify({
          type: "user",
          timestamp: "2026-05-26T01:02:00.000Z",
          toolUseResult: { stdout: "ok" },
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        }),
        // tool_result-only 数组、没有 toolUseResult 字段 → 仍不计入
        JSON.stringify({
          type: "user",
          timestamp: "2026-05-26T01:03:00.000Z",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "more" }] },
        }),
        // sidechain 子 agent 用户提示 → 现在保留计入
        JSON.stringify({ type: "user", timestamp: "2026-05-26T01:04:00.000Z", isSidechain: true, message: { role: "user", content: "sub" } }),
        // sidechain 内部工具结果回填 → 仍不计入（被 toolUseResult 过滤）
        JSON.stringify({
          type: "user",
          timestamp: "2026-05-26T01:05:00.000Z",
          isSidechain: true,
          toolUseResult: { stdout: "sub-tool" },
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "sub" }] },
        }),
        // isMeta=true → 不计入
        JSON.stringify({ type: "user", timestamp: "2026-05-26T01:06:00.000Z", isMeta: true, message: { role: "user", content: "meta" } }),
      ].join("\n"),
      "utf8",
    );

    const summary = await summarizeClaudeProjectUsage(new Date("2026-05-26T00:00:00.000Z"), new Date("2026-05-26T23:59:59.999Z"));

    assert.equal(summary.userMessageCount, 3);
    assert.equal(summary.apiRequestCount, 0);
  } finally {
    delete process.env.CCUS_CLAUDE_DATA_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});
