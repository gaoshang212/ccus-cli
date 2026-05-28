import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installStatusline } from "../lib/install";

/** 在临时目录里造一个 settings 路径，避免污染真实 ~/.claude。 */
async function makeTempSettingsPath(): Promise<{ dir: string; settingsPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccus-install-"));
  return { dir, settingsPath: path.join(dir, "settings.json") };
}

/** 没有 settings.json 时应该新建文件并写入 statusLine。 */
test("installStatusline creates settings.json when it does not exist", async () => {
  const { dir, settingsPath } = await makeTempSettingsPath();
  const command = 'node "/abs/ccus/dist/cli.js" statusline emit';

  const result = await installStatusline(settingsPath, command);
  const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;

  assert.equal(result.created, true);
  assert.equal(result.unchanged, false);
  assert.equal(result.previousCommand, null);
  assert.deepEqual(written.statusLine, { type: "command", command });

  await fs.rm(dir, { recursive: true, force: true });
});

/** 写入 statusLine 时必须保留 settings.json 里已有的其它顶层字段。 */
test("installStatusline preserves other top-level settings", async () => {
  const { dir, settingsPath } = await makeTempSettingsPath();
  await fs.writeFile(
    settingsPath,
    JSON.stringify({ model: "opus", permissions: { allow: ["Bash"] } }, null, 2),
    "utf8",
  );
  const command = 'node "/abs/ccus/dist/cli.js" statusline emit';

  const result = await installStatusline(settingsPath, command);
  const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;

  assert.equal(result.created, false);
  assert.equal(written.model, "opus");
  assert.deepEqual(written.permissions, { allow: ["Bash"] });
  assert.deepEqual(written.statusLine, { type: "command", command });

  await fs.rm(dir, { recursive: true, force: true });
});

/** 替换已有 statusLine 时要回显旧命令，并保留 statusLine 下的其它键（如 padding）。 */
test("installStatusline reports the replaced command and keeps sibling statusLine keys", async () => {
  const { dir, settingsPath } = await makeTempSettingsPath();
  await fs.writeFile(
    settingsPath,
    JSON.stringify({ statusLine: { type: "command", command: "old-command", padding: 0 } }, null, 2),
    "utf8",
  );
  const command = 'node "/abs/ccus/dist/cli.js" statusline emit';

  const result = await installStatusline(settingsPath, command);
  const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;

  assert.equal(result.previousCommand, "old-command");
  assert.equal(result.unchanged, false);
  assert.deepEqual(written.statusLine, { type: "command", command, padding: 0 });

  await fs.rm(dir, { recursive: true, force: true });
});

/** 目标命令本来就一致时，unchanged 为 true。 */
test("installStatusline marks unchanged when command already matches", async () => {
  const { dir, settingsPath } = await makeTempSettingsPath();
  const command = 'node "/abs/ccus/dist/cli.js" statusline emit';
  await fs.writeFile(settingsPath, JSON.stringify({ statusLine: { type: "command", command } }, null, 2), "utf8");

  const result = await installStatusline(settingsPath, command);

  assert.equal(result.unchanged, true);
  assert.equal(result.previousCommand, command);

  await fs.rm(dir, { recursive: true, force: true });
});

/** 无法解析的 settings.json 不应被覆盖，而是直接报错。 */
test("installStatusline refuses to overwrite unparseable settings", async () => {
  const { dir, settingsPath } = await makeTempSettingsPath();
  await fs.writeFile(settingsPath, "{not valid json", "utf8");

  await assert.rejects(() => installStatusline(settingsPath, "node cli.js statusline emit"), /Cannot parse Claude settings/);
  assert.equal(await fs.readFile(settingsPath, "utf8"), "{not valid json");

  await fs.rm(dir, { recursive: true, force: true });
});

/** 空文件应被视为空配置，正常写入而不报错。 */
test("installStatusline treats an empty settings file as empty config", async () => {
  const { dir, settingsPath } = await makeTempSettingsPath();
  await fs.writeFile(settingsPath, "   \n", "utf8");
  const command = 'node "/abs/ccus/dist/cli.js" statusline emit';

  const result = await installStatusline(settingsPath, command);
  const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;

  assert.equal(result.created, false);
  assert.deepEqual(written.statusLine, { type: "command", command });

  await fs.rm(dir, { recursive: true, force: true });
});
