import { spawn } from "node:child_process";

/**
 * 用系统默认浏览器打开生成好的 dashboard。
 *
 * 这里不拼接 shell 字符串，而是显式传参数，降低路径注入风险。
 */
export async function openInBrowser(filePath: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? { program: "cmd", args: ["/c", "start", "", filePath] }
      : process.platform === "darwin"
        ? { program: "open", args: [filePath] }
        : { program: "xdg-open", args: [filePath] };

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
