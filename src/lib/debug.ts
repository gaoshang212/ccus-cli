let debugEnabled = false;

/**
 * 打开 / 关闭调试日志。
 *
 * CLI 的 `--verbose` / `--debug` 参数，或 `CCUS_DEBUG=1` 环境变量都会调用它打开。
 */
export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

/** 当前是否在输出调试日志。 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * 从 CLI 参数和环境变量推断是否应该开启调试日志。
 *
 * 支持 `--verbose` / `--debug` / `-v` 三种写法，以及 `CCUS_DEBUG=1|true`。
 * 环境变量对 statusline 尤其有用：Claude Code 调用 `ccus statusline emit` 时不方便临时加参数。
 */
export function resolveDebugEnabled(args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const fromArgs = args.includes("--verbose") || args.includes("--debug") || args.includes("-v");
  const envValue = (env.CCUS_DEBUG ?? "").trim().toLowerCase();
  const fromEnv = envValue === "1" || envValue === "true" || envValue === "yes";
  return fromArgs || fromEnv;
}

/**
 * 统一的调试日志出口。
 *
 * 关键约束：日志一律写 stderr。statusline 的 stdout 契约只允许输出一行状态文本，
 * 调试信息绝不能混进 stdout，否则会污染 Claude Code 的 statusline 渲染。
 */
export function debugLog(scope: string, message: string, detail?: unknown): void {
  if (!debugEnabled) {
    return;
  }

  const timestamp = new Date().toISOString();
  let line = `[ccus ${timestamp}] ${scope}: ${message}`;

  if (detail !== undefined) {
    let serialized: string;
    if (typeof detail === "string") {
      serialized = detail;
    } else {
      try {
        serialized = JSON.stringify(detail);
      } catch {
        serialized = String(detail);
      }
    }
    line += ` ${serialized}`;
  }

  process.stderr.write(`${line}\n`);
}
