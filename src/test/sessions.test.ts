import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../cli";
import { summarizeClaudeProjectUsage } from "../lib/claude";
import { summarizeCodexSessionUsage } from "../lib/codex-sessions";

test("sessions repair 支持按类型修复与预览，恢复统计且重复运行不改动", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-repair-mtime-"));
  const env = { CCUS_CLAUDE_DATA_DIR: path.join(root, "claude"), CODEX_HOME: path.join(root, "codex"), APPDATA: path.join(root, "appdata") };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const old = new Date("2000-01-01T00:00:00Z");
  const recent = new Date("2026-08-20T10:00:00Z");
  const newer = new Date("2026-08-21T00:00:00Z");
  const start = new Date("2026-08-20T00:00:00Z");
  const end = new Date("2026-08-20T23:59:59Z");
  const projects = path.join(env.CCUS_CLAUDE_DATA_DIR, "projects", "project");
  const codex = path.join(env.CODEX_HOME, "sessions");
  const orca = path.join(env.APPDATA, "orca", "codex-runtime-home", "home", "sessions");
  const hardlink = path.join(orca, "rollout-hardlink.jsonl");
  const turn = JSON.stringify({ timestamp: recent.toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } });
  const fixtures: [string, string, Date][] = [
    [path.join(projects, "long.jsonl"), `${JSON.stringify({ timestamp: old.toISOString() })}\n${JSON.stringify({ type: "user", message: { content: "中文".repeat(20_000) }, timestamp: recent.toISOString() })}\r\n \r\n`, old],
    [path.join(projects, "unchanged.jsonl"), JSON.stringify({ timestamp: recent.toISOString() }), newer],
    [path.join(projects, "partial.jsonl"), `${turn}\n{"timestamp":`, old],
    [path.join(projects, "missing.jsonl"), `${turn}\n{}`, old],
    [path.join(projects, "invalid.jsonl"), '{"timestamp":"invalid"}', old],
    [path.join(projects, "empty.jsonl"), "", old],
    [path.join(codex, "rollout-copy.jsonl"), turn, old],
    [path.join(orca, "rollout-copy.jsonl"), `${turn}\n${" \r\n".repeat(6_000)}`, old],
    [path.join(projects, "ignored.json"), turn, old],
  ];
  let stdout = "";
  let stderr = "";
  const stdoutMock = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; });
  const stderrMock = mock.method(process.stderr, "write", (chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; });
  try {
    for (const [filePath, content, mtime] of fixtures) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
      await fs.utimes(filePath, old, mtime);
    }
    await fs.link(path.join(codex, "rollout-copy.jsonl"), hardlink);
    assert.equal((await summarizeClaudeProjectUsage(start, end)).userMessageCount, 0);
    assert.equal((await summarizeCodexSessionUsage(start, end)).userMessageCount, 0);

    for (const args of [["unknown"], ["codex", "claude"], ["--type", "codex"], ["--dryrun"]]) {
      await assert.rejects(main(["sessions", "repair", ...args]), /不支持的修复参数/);
    }
    await main(["sessions", "repair", "--dry-run"]);
    assert.match(stdout, /扫描 8，待修复 3，无需修复 1，跳过 4，失败 0/);
    assert.ok(!stdout.includes(hardlink), "同一实际文件的硬链接不重复显示");
    assert.equal((await fs.stat(hardlink)).mtimeMs, old.getTime());
    assert.match(stderr, /partial.jsonl.*末条记录无有效时间戳/);
    for (const [filePath, , mtime] of fixtures) assert.equal((await fs.stat(filePath)).mtimeMs, mtime.getTime());

    stdout = "";
    await main(["sessions", "repair", "codex", "--dry-run"]);
    assert.match(stdout, /扫描 2，待修复 2/);
    for (const [filePath, , mtime] of fixtures) assert.equal((await fs.stat(filePath)).mtimeMs, mtime.getTime());
    stdout = "";
    await main(["sessions", "repair", "--dry-run", "claude"]);
    assert.match(stdout, /扫描 6，待修复 1/);
    for (const [filePath, , mtime] of fixtures) assert.equal((await fs.stat(filePath)).mtimeMs, mtime.getTime());

    await main(["sessions", "repair", "codex"]);
    assert.equal((await fs.stat(path.join(projects, "long.jsonl"))).mtimeMs, old.getTime());
    for (const home of [codex, orca]) {
      assert.equal((await fs.stat(path.join(home, "rollout-copy.jsonl"))).mtimeMs, recent.getTime());
      await fs.utimes(path.join(home, "rollout-copy.jsonl"), old, old);
    }
    await main(["sessions", "repair", "claude"]);
    assert.equal((await fs.stat(path.join(projects, "long.jsonl"))).mtimeMs, recent.getTime());
    for (const home of [codex, orca]) assert.equal((await fs.stat(path.join(home, "rollout-copy.jsonl"))).mtimeMs, old.getTime());
    await fs.utimes(path.join(projects, "long.jsonl"), old, old);

    stdout = "";
    await main(["sessions", "repair"]);
    assert.match(stdout, /扫描 8，已修复 3，无需修复 1，跳过 4，失败 0/);
    assert.ok(!stdout.includes(hardlink));
    assert.equal((await fs.stat(hardlink)).mtimeMs, recent.getTime());
    for (const [filePath, content, mtime] of fixtures) {
      const repaired = filePath.endsWith("long.jsonl") || filePath.endsWith("rollout-copy.jsonl");
      assert.equal((await fs.stat(filePath)).mtimeMs, (repaired ? recent : mtime).getTime());
      assert.equal(await fs.readFile(filePath, "utf8"), content);
    }
    assert.equal((await summarizeClaudeProjectUsage(start, end)).userMessageCount, 1);
    assert.equal((await summarizeCodexSessionUsage(start, end)).userMessageCount, 1);

    stdout = "";
    await main(["sessions", "repair"]);
    assert.match(stdout, /扫描 8，已修复 0，无需修复 4，跳过 4，失败 0/);
  } finally {
    stdoutMock.mock.restore();
    stderrMock.mock.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sessions repair 默认按本地跨天判断，显式阈值按实际时差且包含边界", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-repair-gap-"));
  const previous = process.env.CCUS_CLAUDE_DATA_DIR;
  process.env.CCUS_CLAUDE_DATA_DIR = root;
  const directory = path.join(root, "projects", "project");
  const samples: [Date, Date][] = [
    [new Date(2026, 7, 20, 1), new Date(2026, 7, 20, 23)],
    [new Date(2026, 7, 20, 23, 55), new Date(2026, 7, 21, 0, 5)],
    [new Date(2026, 7, 20, 9), new Date(2026, 7, 20, 12)],
    [new Date(2026, 7, 20, 9, 1), new Date(2026, 7, 20, 12)],
    [new Date(2026, 7, 19, 12), new Date(2026, 7, 21, 12)],
    [new Date(2026, 7, 21, 12), new Date(2026, 7, 20, 12)],
    [new Date(2026, 7, 20, 12), new Date(2026, 7, 20, 12)],
  ];
  const cases: [string[], number[]][] = [
    [[], [1, 4]],
    [["--min-gap", "3h"], [0, 2, 4]],
    [["--min-gap", "30m"], [0, 2, 3, 4]],
    [["--min-gap", "1d"], [4]],
    [["--min-gap", "0m"], [0, 1, 2, 3, 4]],
  ];
  const stdoutMock = mock.method(process.stdout, "write", () => true);
  try {
    await fs.mkdir(directory, { recursive: true });
    for (const [args, changed] of cases) {
      for (const [index, [before, after]] of samples.entries()) {
        const file = path.join(directory, `${index}.jsonl`);
        await fs.writeFile(file, JSON.stringify({ timestamp: after.toISOString() }));
        await fs.utimes(file, before, before);
      }
      await main(["sessions", "repair", "claude", ...args, "--dry-run"]);
      for (const [index, [before]] of samples.entries()) {
        assert.equal((await fs.stat(path.join(directory, `${index}.jsonl`))).mtimeMs, before.getTime());
      }
      await main(["sessions", "repair", "claude", ...args]);
      for (const [index, [before, after]] of samples.entries()) {
        assert.equal((await fs.stat(path.join(directory, `${index}.jsonl`))).mtimeMs,
          (changed.includes(index) ? after : before).getTime(), `${args.join(" ")} 文件 ${index}`);
      }
    }
    for (const value of [undefined, "-1h", "1.5h", "3", "day", "999999999999999999h"]) {
      await assert.rejects(main(["sessions", "repair", "claude", "--min-gap", ...(value === undefined ? [] : [value])]), /--min-gap/);
    }
  } finally {
    stdoutMock.mock.restore();
    if (previous === undefined) delete process.env.CCUS_CLAUDE_DATA_DIR;
    else process.env.CCUS_CLAUDE_DATA_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
