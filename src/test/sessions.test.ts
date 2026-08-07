import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../cli";

/** 读取 ZIP central directory 中的文件名，避免测试依赖外部解压工具。 */
function readZipEntryNames(zip: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;

  while (offset <= zip.length - 4) {
    const header = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset);
    if (header < 0) {
      break;
    }
    const nameLength = zip.readUInt16LE(header + 28);
    const extraLength = zip.readUInt16LE(header + 30);
    const commentLength = zip.readUInt16LE(header + 32);
    names.push(zip.subarray(header + 46, header + 46 + nameLength).toString("utf8"));
    offset = header + 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

test("ccus sessions exports active Claude and Codex sessions into one zip", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-sessions-"));
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const appData = path.join(root, "appdata");
  const orcaCodexHome = path.join(appData, "orca", "codex-runtime-home", "home");
  const previousClaudeHome = process.env.CCUS_CLAUDE_DATA_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousAppData = process.env.APPDATA;
  process.env.CCUS_CLAUDE_DATA_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  process.env.APPDATA = appData;

  const inRangeTimestamp = new Date().toISOString();
  const outsideTimestamp = "2000-01-01T00:00:00.000Z";
  const claudeProjectDir = path.join(claudeHome, "projects", "D--workspace-nodejs-ccus");
  const codexRolloutDir = path.join(codexHome, "sessions", "2026", "07", "31");
  const orcaRolloutDir = path.join(orcaCodexHome, "sessions", "2026", "07", "31");
  await fs.mkdir(claudeProjectDir, { recursive: true });
  await fs.mkdir(codexRolloutDir, { recursive: true });
  await fs.mkdir(orcaRolloutDir, { recursive: true });
  await fs.writeFile(path.join(claudeProjectDir, "claude-active.jsonl"), `${JSON.stringify({ timestamp: inRangeTimestamp })}\n`);
  await fs.writeFile(path.join(claudeProjectDir, "claude-old.jsonl"), `${JSON.stringify({ timestamp: outsideTimestamp })}\n`);
  await fs.writeFile(path.join(codexRolloutDir, "rollout-active.jsonl"), `${JSON.stringify({ timestamp: inRangeTimestamp })}\n`);
  await fs.writeFile(path.join(codexRolloutDir, "rollout-old.jsonl"), `${JSON.stringify({ timestamp: outsideTimestamp })}\n`);
  await fs.writeFile(path.join(orcaRolloutDir, "rollout-active.jsonl"), `${JSON.stringify({ timestamp: inRangeTimestamp })}\n`);
  await fs.writeFile(path.join(orcaRolloutDir, "rollout-orca.jsonl"), `${JSON.stringify({ timestamp: inRangeTimestamp })}\n`);

  let stdout = "";
  const stdoutMock = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  try {
    await main(["sessions", "this-week", "--data-dir", root]);

    const outputPath = stdout.trim();
    assert.equal(path.dirname(outputPath), path.join(root, "sessions"));
    assert.match(path.basename(outputPath), /^projects_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}_[a-z0-9._-]+\.zip$/);
    const names = readZipEntryNames(await fs.readFile(outputPath));
    assert.deepEqual(names.sort(), [
      "D--workspace-nodejs-ccus/claude-active.jsonl",
      "codex/2026/07/31/rollout-active.jsonl",
      "codex/2026/07/31/rollout-orca.jsonl",
    ]);
  } finally {
    stdoutMock.mock.restore();
    if (previousClaudeHome === undefined) {
      delete process.env.CCUS_CLAUDE_DATA_DIR;
    } else {
      process.env.CCUS_CLAUDE_DATA_DIR = previousClaudeHome;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
