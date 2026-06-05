import os from "node:os";
import path from "node:path";

/**
 * 按平台推导默认数据目录，同时允许通过环境变量显式覆盖。
 */
export function getDefaultDataDir(): string {
  const appData = process.env.CCUS_DATA_DIR;
  if (appData) {
    return path.resolve(appData);
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return path.join(localAppData, "ccus");
    }
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "ccus");
  }

  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) {
    return path.join(xdgDataHome, "ccus");
  }

  return path.join(os.homedir(), ".local", "share", "ccus");
}

/** 所有采样事件的根目录。 */
export function getEventsDir(dataDir: string): string {
  return path.join(dataDir, "events");
}

/** 生成 dashboard 文件的默认目录。 */
export function getDashboardDir(dataDir: string): string {
  return path.join(dataDir, "dashboard");
}

/** 版本更新检查的本地缓存文件，记录上次检查时间与拿到的最新版本。 */
export function getUpdateCachePath(dataDir: string): string {
  return path.join(dataDir, "update-check.json");
}

/** 定时同步的用户配置文件（目标目录、周期、范围），可手编。 */
export function getSyncConfigPath(dataDir: string): string {
  return path.join(dataDir, "sync-config.json");
}

/** 定时同步的运行时状态文件（上次同步时间与结果），由 ccus sync 写入。 */
export function getSyncStatePath(dataDir: string): string {
  return path.join(dataDir, "sync-state.json");
}

/** Claude Code 默认本地数据目录。 */
export function getClaudeDataDir(): string {
  const configured = process.env.CCUS_CLAUDE_DATA_DIR;
  if (configured) {
    return path.resolve(configured);
  }

  return path.join(os.homedir(), ".claude");
}

/** Claude Code 用户级 settings.json 路径，install 命令会往里写 statusLine 配置。 */
export function getClaudeSettingsPath(): string {
  return path.join(getClaudeDataDir(), "settings.json");
}
