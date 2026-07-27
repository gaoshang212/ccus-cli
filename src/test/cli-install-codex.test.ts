import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../cli";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface HooksFile {
  hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> };
}

async function readHooks(hooksPath: string): Promise<HooksFile> {
  return JSON.parse(await fs.readFile(hooksPath, "utf8")) as HooksFile;
}

function stopCommands(parsed: HooksFile): string[] {
  return parsed.hooks?.Stop?.flatMap((group) => group.hooks ?? []).map((entry) => entry.command ?? "") ?? [];
}

test("ccus install --codex writes a Stop hook into hooks.json", async () => {
  const dir = await mkdtemp("ccus-cli-codex-install-");
  const hooksPath = path.join(dir, "hooks.json");

  await main(["install", "--codex", "--config", hooksPath]);

  const commands = stopCommands(await readHooks(hooksPath));
  assert.ok(commands.some((c) => c.includes("__codex-hook")), commands.join(","));

  await fs.rm(dir, { recursive: true, force: true });
});

test("ccus install --codex --data-dir appends --data-dir to the hook command", async () => {
  const dir = await mkdtemp("ccus-cli-codex-install-");
  const hooksPath = path.join(dir, "hooks.json");
  const dataDir = path.join(dir, "data").replaceAll("\\", "/");

  await main(["install", "--codex", "--config", hooksPath, "--data-dir", dataDir]);

  const parsed = await readHooks(hooksPath);
  const cmd = parsed.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
  assert.ok(cmd.includes("--data-dir"), cmd);
  assert.ok(cmd.includes(dataDir), cmd);

  await fs.rm(dir, { recursive: true, force: true });
});

test("ccus install --codex --uninstall removes only the ccus Stop hook", async () => {
  const dir = await mkdtemp("ccus-cli-codex-install-");
  const hooksPath = path.join(dir, "hooks.json");

  await main(["install", "--codex", "--config", hooksPath]);

  // 追加一个 orca 风格的 hook，验证卸载只移除 ccus 的、保留其它。
  const before = await readHooks(hooksPath);
  before.hooks!.Stop![0].hooks!.push({ command: "C:\\orca\\codex-hook.cmd" });
  await fs.writeFile(hooksPath, JSON.stringify(before), "utf8");

  await main(["install", "--codex", "--uninstall", "--config", hooksPath]);

  const commands = stopCommands(await readHooks(hooksPath));
  assert.ok(!commands.some((c) => c.includes("__codex-hook")), commands.join(","));
  assert.ok(commands.includes("C:\\orca\\codex-hook.cmd"), commands.join(","));

  await fs.rm(dir, { recursive: true, force: true });
});
