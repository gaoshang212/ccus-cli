import fs from "node:fs";
import path from "node:path";

/**
 * 读取 ccus 自身的版本号（package.json 的 version）。
 *
 * dist/lib/version.js 与 src/lib/version.ts 距离包根都是 `../..`，
 * 所以编译产物和 tsx 直跑源码时都能定位到同一个 package.json。
 * 读不到时回退 "0.0.0"，让上层逻辑（更新检查）安全降级而不是抛错。
 */
let cachedVersion: string | null = null;

export function getCurrentVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }

  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }

  return cachedVersion;
}

/**
 * 语义化版本比较：判断 latest 是否严格新于 current。
 *
 * 只比较 `major.minor.patch` 三段数字，忽略预发布/构建元数据，
 * 对当前发布节奏足够；任意一段解析失败按 0 处理，避免误报更新。
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/, "")
      .split("-", 1)[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));

  const a = parse(latest);
  const b = parse(current);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left > right) {
      return true;
    }
    if (left < right) {
      return false;
    }
  }
  return false;
}
