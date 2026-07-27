import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installCodexHook, installCodexNotify, uninstallCodexHook, uninstallCodexNotify } from "../lib/codex-install";

const TARGET = ["ccus", "__codex-notify"];
const TARGET_LINE = `notify = ["ccus", "__codex-notify"]`;

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeConfigPath(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp("ccus-codex-install-");
  return { dir, configPath: path.join(dir, "config.toml") };
}

test("installCodexNotify creates config.toml when missing", async () => {
  const { dir, configPath } = await makeConfigPath();
  const result = await installCodexNotify(configPath, TARGET);
  const content = await fs.readFile(configPath, "utf8");

  assert.equal(result.created, true);
  assert.equal(result.unchanged, false);
  assert.equal(result.previousNotify, null);
  assert.equal(content.trim(), TARGET_LINE);

  await fs.rm(dir, { recursive: true, force: true });
});

test("installCodexNotify preserves other top-level keys, sections and comments", async () => {
  const { dir, configPath } = await makeConfigPath();
  const original = `# top comment\nmodel = "gpt-5"\nnotify = ["old"]\n\n[sandbox]\nmode = "workspace-write"\n`;
  await fs.writeFile(configPath, original, "utf8");

  const result = await installCodexNotify(configPath, TARGET);
  const content = await fs.readFile(configPath, "utf8");

  assert.equal(result.created, false);
  assert.deepEqual(result.previousNotify, ["old"]);
  assert.match(content, /# top comment/);
  assert.match(content, /model = "gpt-5"/);
  assert.match(content, /\[sandbox\]/);
  assert.match(content, /mode = "workspace-write"/);
  assert.match(content, /notify = \["ccus", "__codex-notify"\]/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("installCodexNotify marks unchanged and leaves file untouched when notify matches", async () => {
  const { dir, configPath } = await makeConfigPath();
  await fs.writeFile(configPath, `model = "x"\nnotify = ["ccus", "__codex-notify"]\n`, "utf8");
  const before = await fs.readFile(configPath, "utf8");

  const result = await installCodexNotify(configPath, TARGET);
  const after = await fs.readFile(configPath, "utf8");

  assert.equal(result.unchanged, true);
  assert.equal(after, before);

  await fs.rm(dir, { recursive: true, force: true });
});

test("installCodexNotify treats single-quote notify as a match", async () => {
  const { dir, configPath } = await makeConfigPath();
  await fs.writeFile(configPath, `notify = ['ccus', '__codex-notify']\n`, "utf8");

  const result = await installCodexNotify(configPath, TARGET);

  assert.equal(result.unchanged, true);

  await fs.rm(dir, { recursive: true, force: true });
});

test("installCodexNotify inserts top-level notify before tables when top-level empty", async () => {
  const { dir, configPath } = await makeConfigPath();
  await fs.writeFile(configPath, `[sandbox]\nmode = "workspace-write"\n`, "utf8");

  const result = await installCodexNotify(configPath, TARGET);
  const content = await fs.readFile(configPath, "utf8");

  assert.equal(result.unchanged, false);
  assert.ok(content.indexOf(TARGET_LINE) < content.indexOf("[sandbox]"));
  assert.match(content, /\[sandbox\]/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("installCodexNotify leaves notify under a table untouched and adds top-level notify", async () => {
  const { dir, configPath } = await makeConfigPath();
  await fs.writeFile(configPath, `[hooks]\nnotify = ["under-hook"]\n`, "utf8");

  const result = await installCodexNotify(configPath, TARGET);
  const content = await fs.readFile(configPath, "utf8");

  assert.equal(result.unchanged, false);
  assert.match(content, /notify = \["ccus", "__codex-notify"\]/);
  assert.match(content, /notify = \["under-hook"\]/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("installCodexNotify refuses to overwrite a multi-line notify array", async () => {
  const { dir, configPath } = await makeConfigPath();
  const original = `notify = [\n  "a",\n  "b"\n]\n`;
  await fs.writeFile(configPath, original, "utf8");

  await assert.rejects(() => installCodexNotify(configPath, TARGET), /multi-line notify/);
  assert.equal(await fs.readFile(configPath, "utf8"), original);

  await fs.rm(dir, { recursive: true, force: true });
});

test("uninstallCodexNotify removes top-level notify and keeps the rest", async () => {
  const { dir, configPath } = await makeConfigPath();
  await fs.writeFile(configPath, `model = "x"\nnotify = ["ccus", "__codex-notify"]\n[sandbox]\nmode = "y"\n`, "utf8");

  const result = await uninstallCodexNotify(configPath);
  const content = await fs.readFile(configPath, "utf8");

  assert.equal(result.removed, true);
  assert.deepEqual(result.previousNotify, ["ccus", "__codex-notify"]);
  assert.doesNotMatch(content, /notify/);
  assert.match(content, /model = "x"/);
  assert.match(content, /\[sandbox\]/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("uninstallCodexNotify reports removed=false when no top-level notify", async () => {
  const { dir, configPath } = await makeConfigPath();
  await fs.writeFile(configPath, `model = "x"\n`, "utf8");

  const result = await uninstallCodexNotify(configPath);

  assert.equal(result.removed, false);

  await fs.rm(dir, { recursive: true, force: true });
});

test("uninstallCodexNotify reports removed=false when config missing", async () => {
  const { dir, configPath } = await makeConfigPath();

  const result = await uninstallCodexNotify(configPath);

  assert.equal(result.removed, false);

  await fs.rm(dir, { recursive: true, force: true });
});

// ===== hooks.json（Stop 事件）：orca 等 hook-only 环境的触发入口 =====

const HOOK_COMMAND = "ccus.cmd __codex-hook";

async function makeHooksPath(): Promise<{ dir: string; hooksPath: string }> {
  const dir = await mkdtemp("ccus-codex-hooks-");
  return { dir, hooksPath: path.join(dir, "hooks.json") };
}

test("installCodexHook creates hooks.json with a Stop hook when missing", async () => {
  const { dir, hooksPath } = await makeHooksPath();
  const result = await installCodexHook(hooksPath, HOOK_COMMAND);
  const parsed = JSON.parse(await fs.readFile(hooksPath, "utf8")) as { hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }> } };

  assert.equal(result.created, true);
  assert.equal(result.unchanged, false);
  assert.equal(result.stopExisted, false);
  assert.deepEqual(parsed.hooks.Stop[0].hooks[0], { type: "command", command: HOOK_COMMAND, timeout: 60 });

  await fs.rm(dir, { recursive: true, force: true });
});

test("installCodexHook appends into the existing Stop group, keeping the orca hook concurrent", async () => {
  const { dir, hooksPath } = await makeHooksPath();
  const original = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "C:\\orca\\codex-hook.cmd", timeout: 10 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "other", timeout: 10 }] }],
    },
  };
  await fs.writeFile(hooksPath, JSON.stringify(original), "utf8");

  const result = await installCodexHook(hooksPath, HOOK_COMMAND);
  const parsed = JSON.parse(await fs.readFile(hooksPath, "utf8")) as typeof original;

  assert.equal(result.created, false);
  assert.equal(result.stopExisted, true);
  assert.equal(result.unchanged, false);
  // orca hook 保留，ccus hook 追加进同一 group（同 Stop 事件下并发执行）。
  assert.equal(parsed.hooks.Stop[0].hooks.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, "C:\\orca\\codex-hook.cmd");
  assert.equal(parsed.hooks.Stop[0].hooks[1].command, HOOK_COMMAND);
  // 其它事件不动。
  assert.equal(parsed.hooks.UserPromptSubmit[0].hooks[0].command, "other");

  await fs.rm(dir, { recursive: true, force: true });
});

test("installCodexHook marks unchanged and leaves the file untouched when Stop already has the command", async () => {
  const { dir, hooksPath } = await makeHooksPath();
  const before = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] }] },
  });
  await fs.writeFile(hooksPath, before, "utf8");

  const result = await installCodexHook(hooksPath, HOOK_COMMAND);
  const after = await fs.readFile(hooksPath, "utf8");

  assert.equal(result.unchanged, true);
  assert.equal(after, before);

  await fs.rm(dir, { recursive: true, force: true });
});

test("uninstallCodexHook removes only the ccus hook and keeps the orca hook", async () => {
  const { dir, hooksPath } = await makeHooksPath();
  await fs.writeFile(
    hooksPath,
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "C:\\orca\\codex-hook.cmd", timeout: 10 },
              { type: "command", command: HOOK_COMMAND, timeout: 60 },
            ],
          },
        ],
      },
    }),
    "utf8",
  );

  const result = await uninstallCodexHook(hooksPath);
  const parsed = JSON.parse(await fs.readFile(hooksPath, "utf8")) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };

  assert.equal(result.removed, true);
  assert.equal(parsed.hooks.Stop[0].hooks.length, 1);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, "C:\\orca\\codex-hook.cmd");

  await fs.rm(dir, { recursive: true, force: true });
});

test("uninstallCodexHook reports removed=false when no ccus hook present", async () => {
  const { dir, hooksPath } = await makeHooksPath();
  await fs.writeFile(hooksPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }), "utf8");

  const result = await uninstallCodexHook(hooksPath);

  assert.equal(result.removed, false);

  await fs.rm(dir, { recursive: true, force: true });
});
