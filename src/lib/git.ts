import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Git 用户身份信息。 */
export interface GitIdentity {
  userName: string | null;
  userEmail: string | null;
}

/** 去掉命令输出中的空白，空字符串视为 null。 */
function normalizeGitValue(value: string): string | null {
  const trimmed = value.replaceAll(/[\r\n\0]+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 读取一次 git config 键值。
 *
 * 先尝试仓库级配置；如果读取失败，再由上层决定是否回退到全局配置。
 */
async function readGitConfigValue(args: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
    });
    return normalizeGitValue(stdout);
  } catch {
    return null;
  }
}

/**
 * 读取工作区对应的 Git 用户名和邮箱。
 *
 * 优先读取当前仓库内的配置，取不到时再回退到全局 git config。
 */
export async function readGitIdentity(workspaceDir: string | null): Promise<GitIdentity> {
  const localUserName = workspaceDir
    ? await readGitConfigValue(["config", "--local", "--get", "user.name"], workspaceDir)
    : null;
  const localUserEmail = workspaceDir
    ? await readGitConfigValue(["config", "--local", "--get", "user.email"], workspaceDir)
    : null;

  if (localUserName !== null || localUserEmail !== null) {
    return {
      userName: localUserName,
      userEmail: localUserEmail,
    };
  }

  const [globalUserName, globalUserEmail] = await Promise.all([
    readGitConfigValue(["config", "--global", "--get", "user.name"]),
    readGitConfigValue(["config", "--global", "--get", "user.email"]),
  ]);

  return {
    userName: globalUserName,
    userEmail: globalUserEmail,
  };
}
