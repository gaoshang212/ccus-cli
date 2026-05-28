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

/** 读取一次全局 git config 键值。 */
async function readGitConfigValue(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      windowsHide: true,
    });
    return normalizeGitValue(stdout);
  } catch {
    return null;
  }
}

/**
 * 读取全局 Git 用户名和邮箱。
 *
 * 只读取全局 git config，不再读取仓库级配置。
 */
export async function readGitIdentity(): Promise<GitIdentity> {
  const [globalUserName, globalUserEmail] = await Promise.all([
    readGitConfigValue(["config", "--global", "--get", "user.name"]),
    readGitConfigValue(["config", "--global", "--get", "user.email"]),
  ]);

  return {
    userName: globalUserName,
    userEmail: globalUserEmail,
  };
}
