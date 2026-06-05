import test from "node:test";
import assert from "node:assert/strict";
import { buildCcusSyncInvocation, buildSchedulerPlan, SCHEDULER_TASK_NAME, uninstallScheduler } from "../lib/scheduler";

test("buildCcusSyncInvocation uses absolute node + cli.js with explicit data-dir", () => {
  const inv = buildCcusSyncInvocation("/usr/bin/node", "/opt/ccus/dist/cli.js", "/data/ccus");
  assert.equal(inv, '"/usr/bin/node" "/opt/ccus/dist/cli.js" sync --data-dir "/data/ccus"');
});

test("buildCcusSyncInvocation falls back to bare ccus when script path is unknown", () => {
  const inv = buildCcusSyncInvocation("/usr/bin/node", undefined, "/data/ccus");
  assert.equal(inv, 'ccus sync --data-dir "/data/ccus"');
});

test("buildSchedulerPlan on win32 produces an auto-installable schtasks plan for Friday 18:00", () => {
  const plan = buildSchedulerPlan("win32", "C:/node/node.exe", "C:/ccus/dist/cli.js", "C:/data/ccus");
  assert.equal(plan.autoInstallable, true);
  assert.equal(plan.command, "schtasks");
  assert.ok(plan.args);
  const args = plan.args ?? [];
  // 关键调度参数齐全：每周、周五、18:00、固定任务名。
  assert.deepEqual(args.slice(0, 3), ["/create", "/tn", SCHEDULER_TASK_NAME]);
  assert.ok(args.includes("/sc") && args[args.indexOf("/sc") + 1] === "weekly");
  assert.ok(args.includes("/d") && args[args.indexOf("/d") + 1] === "FRI");
  assert.ok(args.includes("/st") && args[args.indexOf("/st") + 1] === "18:00");
  // /tr 携带 ccus sync 调用串
  assert.ok(args[args.indexOf("/tr") + 1].includes("sync --data-dir"));
});

test("uninstallScheduler on win32 (print) yields an auto schtasks delete command without executing", () => {
  const r = uninstallScheduler({ print: true, platform: "win32" });
  assert.equal(r.autoUninstallable, true);
  assert.equal(r.uninstalled, false);
  assert.equal(r.displayCommand, `schtasks /delete /tn ${SCHEDULER_TASK_NAME} /f`);
});

test("uninstallScheduler on non-Windows is not auto-uninstallable and points at crontab", () => {
  const r = uninstallScheduler({ platform: "linux" });
  assert.equal(r.autoUninstallable, false);
  assert.equal(r.uninstalled, false);
  assert.ok(r.displayCommand.includes("crontab"));
  assert.ok(r.displayCommand.includes(SCHEDULER_TASK_NAME));
});

test("buildSchedulerPlan on non-Windows is not auto-installable and yields a Friday cron line", () => {
  for (const platform of ["linux", "darwin"] as NodeJS.Platform[]) {
    const plan = buildSchedulerPlan(platform, "/usr/bin/node", "/opt/ccus/dist/cli.js", "/data/ccus");
    assert.equal(plan.autoInstallable, false);
    assert.equal(plan.command, null);
    // 周五 18:00 的 cron 表达式 + 任务名注释
    assert.ok(plan.displayCommand.includes("0 18 * * 5"));
    assert.ok(plan.displayCommand.includes(SCHEDULER_TASK_NAME));
    assert.ok(plan.displayCommand.includes("crontab -"));
  }
});
