import { spawnSync } from "node:child_process";
import { debugLog } from "./debug";

/** 系统调度器里使用的任务名（Windows 计划任务 / cron 注释里都用它）。 */
export const SCHEDULER_TASK_NAME = "ccus-sync";

/** 调度时间：每周五 18:00（下午 6 点）。 */
export const SCHEDULE_WEEKDAY_SHORT = "FRI"; // schtasks 用
export const SCHEDULE_CRON = "0 18 * * 5"; // cron 用（周五 = 5）
export const SCHEDULE_TIME = "18:00";

/** 一次调度器安装的计划：可读命令 + （Windows 下）可直接执行的参数。 */
export interface SchedulerPlan {
  platform: NodeJS.Platform;
  /** 当前平台是否支持由 ccus 自动执行安装（仅 Windows）。 */
  autoInstallable: boolean;
  /** 任务实际要运行的 ccus 调用串（带绝对路径，保证调度环境也能跑）。 */
  invocation: string;
  /** 供 spawnSync 使用的可执行文件（仅 Windows 有值）。 */
  command: string | null;
  /** 供 spawnSync 使用的参数数组（仅 Windows 有值）。 */
  args: string[] | null;
  /** 给用户看的、可复制粘贴的安装命令（所有平台都有）。 */
  displayCommand: string;
  /** 卸载提示命令。 */
  uninstallHint: string;
}

/** 给路径/命令片段加双引号，避免空格被拆分。 */
function quote(value: string): string {
  return `"${value}"`;
}

/**
 * 构造 ccus sync 的调用串。
 *
 * 优先用绝对的 node + cli.js 路径（调度任务运行时 PATH 可能不含全局 npm bin）；
 * 拿不到脚本路径时退回 `ccus`。始终带显式 `--data-dir`，与交互式同步用同一目录。
 */
export function buildCcusSyncInvocation(execPath: string, scriptPath: string | undefined, dataDir: string): string {
  if (!scriptPath) {
    return `ccus sync --data-dir ${quote(dataDir)}`;
  }
  return `${quote(execPath)} ${quote(scriptPath)} sync --data-dir ${quote(dataDir)}`;
}

/**
 * 根据平台构造「每周五 18:00 跑 ccus sync」的调度器安装计划。
 *
 * Windows 用 `schtasks` 创建计划任务（ccus 可自动执行）；
 * macOS / Linux 给出 cron 一行命令（由用户手动执行，避免自动改 crontab 的风险）。
 */
export function buildSchedulerPlan(
  platform: NodeJS.Platform,
  execPath: string,
  scriptPath: string | undefined,
  dataDir: string,
): SchedulerPlan {
  const invocation = buildCcusSyncInvocation(execPath, scriptPath, dataDir);

  if (platform === "win32") {
    const args = [
      "/create",
      "/tn",
      SCHEDULER_TASK_NAME,
      "/tr",
      invocation,
      "/sc",
      "weekly",
      "/d",
      SCHEDULE_WEEKDAY_SHORT,
      "/st",
      SCHEDULE_TIME,
      "/f",
    ];
    return {
      platform,
      autoInstallable: true,
      invocation,
      command: "schtasks",
      args,
      displayCommand: `schtasks /create /tn ${SCHEDULER_TASK_NAME} /tr ${quote(invocation)} /sc weekly /d ${SCHEDULE_WEEKDAY_SHORT} /st ${SCHEDULE_TIME} /f`,
      uninstallHint: `schtasks /delete /tn ${SCHEDULER_TASK_NAME} /f`,
    };
  }

  // macOS / Linux：给出 cron 一行命令，由用户手动安装。
  const cronLine = `${SCHEDULE_CRON} ${invocation} # ${SCHEDULER_TASK_NAME}`;
  return {
    platform,
    autoInstallable: false,
    invocation,
    command: null,
    args: null,
    displayCommand: `(crontab -l 2>/dev/null; echo '${cronLine}') | crontab -`,
    uninstallHint: `crontab -e  # 删除标注 ${SCHEDULER_TASK_NAME} 的那一行`,
  };
}

/** 调度器安装结果。 */
export interface InstallSchedulerResult {
  plan: SchedulerPlan;
  /** 是否真正执行了安装（Windows 自动安装成功为 true；--print 或非 Windows 为 false）。 */
  installed: boolean;
}

/**
 * 执行调度器安装。
 *
 * `print` 为 true 时只返回计划、不执行。Windows 下调用 schtasks 真正创建任务；
 * 其它平台不自动改系统，交由调用方打印 displayCommand 引导用户手动安装。
 */
export function installScheduler(
  execPath: string,
  scriptPath: string | undefined,
  dataDir: string,
  options: { print?: boolean; platform?: NodeJS.Platform } = {},
): InstallSchedulerResult {
  const platform = options.platform ?? process.platform;
  const plan = buildSchedulerPlan(platform, execPath, scriptPath, dataDir);

  if (options.print || !plan.autoInstallable || !plan.command || !plan.args) {
    return { plan, installed: false };
  }

  debugLog("scheduler", "installing", { command: plan.command, args: plan.args });
  const result = spawnSync(plan.command, plan.args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`调度器安装失败（${plan.command} 退出码 ${result.status ?? "未知"}）。可手动运行：\n  ${plan.displayCommand}`);
  }
  return { plan, installed: true };
}

/** 调度器卸载结果。 */
export interface UninstallSchedulerResult {
  platform: NodeJS.Platform;
  /** 当前平台是否支持由 ccus 自动卸载（仅 Windows）。 */
  autoUninstallable: boolean;
  /** 是否真正卸载成功（Windows 执行成功为 true；--print、非 Windows、任务不存在为 false）。 */
  uninstalled: boolean;
  /** 给用户看的卸载命令。 */
  displayCommand: string;
}

/**
 * 卸载「每周五同步」的系统调度器。
 *
 * `print` 为 true 时只返回命令、不执行。Windows 调用 `schtasks /delete` 删除任务
 * （任务不存在时 schtasks 返回非 0，这里视为「未卸载」而非抛错）；其它平台只打印 crontab 提示。
 */
export function uninstallScheduler(
  options: { print?: boolean; platform?: NodeJS.Platform } = {},
): UninstallSchedulerResult {
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    const displayCommand = `schtasks /delete /tn ${SCHEDULER_TASK_NAME} /f`;
    if (options.print) {
      return { platform, autoUninstallable: true, uninstalled: false, displayCommand };
    }
    debugLog("scheduler", "uninstalling", { task: SCHEDULER_TASK_NAME });
    const result = spawnSync("schtasks", ["/delete", "/tn", SCHEDULER_TASK_NAME, "/f"], { stdio: "inherit" });
    return { platform, autoUninstallable: true, uninstalled: result.status === 0, displayCommand };
  }

  return {
    platform,
    autoUninstallable: false,
    uninstalled: false,
    displayCommand: `crontab -e  # 删除标注 ${SCHEDULER_TASK_NAME} 的那一行`,
  };
}
