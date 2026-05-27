import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarizeClaudeProjectUsage } from "../lib/claude";

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
    assert.equal(summary.matchedFileCount, 1);
  } finally {
    delete process.env.CCUS_CLAUDE_DATA_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});
