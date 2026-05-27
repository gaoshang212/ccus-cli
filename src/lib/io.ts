/**
 * 读取完整 stdin 内容。
 *
 * Claude Code statusline 官方契约就是把 session JSON 通过 stdin 传给命令。
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
