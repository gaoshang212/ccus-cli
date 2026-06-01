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

/** 跑一次 git 命令并归一化其 stdout，失败一律返回 null。 */
async function runGitCommand(args: string[]): Promise<string | null> {
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
 * 读取指定工作目录当前所在的 git 分支名。
 *
 * 仅用于 statusline 实时展示，不落盘、不进导出契约。
 * detached HEAD 等无分支场景下 `rev-parse` 会返回 `HEAD`，这里归一化为 null，避免误导。
 * 读取失败（非 git 仓库、git 不存在等）一律降级为 null。
 */
export async function readGitBranch(cwd: string | null): Promise<string | null> {
  const args = ["rev-parse", "--abbrev-ref", "HEAD"];
  if (cwd) {
    args.unshift("-C", cwd);
  }

  const branch = await runGitCommand(args);
  if (branch === null || branch === "HEAD") {
    return null;
  }
  return branch;
}

/**
 * 读取全局 Git 用户名和邮箱。
 *
 * 只读取全局 git config，不再读取仓库级配置。
 */
export async function readGitIdentity(): Promise<GitIdentity> {
  const [globalUserName, globalUserEmail] = await Promise.all([
    runGitCommand(["config", "--global", "--get", "user.name"]),
    runGitCommand(["config", "--global", "--get", "user.email"]),
  ]);

  return {
    userName: globalUserName,
    userEmail: globalUserEmail,
  };
}
