import { spawn } from "node:child_process";

/**
 * 用系统默认程序打开一个文件或目录：HTML 走默认浏览器，目录走文件管理器。
 *
 * 这里不拼接 shell 字符串，而是显式传参数，降低路径注入风险。
 */
export async function openPath(target: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? { program: "cmd", args: ["/c", "start", "", target] }
      : process.platform === "darwin"
        ? { program: "open", args: [target] }
        : { program: "xdg-open", args: [target] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      detached: true,
      stdio: "ignore",
    });

    child.on("error", reject);
    child.unref();
    resolve();
  });
}

/** 用系统默认浏览器打开生成好的 dashboard。 */
export async function openInBrowser(filePath: string): Promise<void> {
  await openPath(filePath);
}
