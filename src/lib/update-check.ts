import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import { debugLog } from "./debug";
import { getUpdateCachePath } from "./paths";
import { getCurrentVersion, isNewerVersion } from "./version";

/** npm 包名，更新检查向 registry 查询它的最新版本。 */
const PACKAGE_NAME = "ccus-cli";

/** 后台检查节流窗口：同一数据目录每天最多向 registry 查一次。 */
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** 网络请求超时，避免后台进程长时间挂着；statusline 主进程本身不等它。 */
const FETCH_TIMEOUT_MS = 4000;

interface UpdateCache {
  lastCheckedAt: string;
  latestVersion: string | null;
}

/**
 * 同步读取更新缓存。
 *
 * statusline 是高频短命进程，这里只读一个很小的 JSON，用同步 IO 换取最简单、最快的路径；
 * 任何异常都静默返回 null，绝不影响状态行输出。
 */
export function readUpdateCacheSync(dataDir: string): UpdateCache | null {
  try {
    const raw = fs.readFileSync(getUpdateCachePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    if (typeof parsed.lastCheckedAt !== "string") {
      return null;
    }
    return {
      lastCheckedAt: parsed.lastCheckedAt,
      latestVersion: typeof parsed.latestVersion === "string" ? parsed.latestVersion : null,
    };
  } catch {
    return null;
  }
}

/** 写入更新缓存；目录可能尚未创建，所以先 mkdir。失败静默。 */
async function writeUpdateCache(dataDir: string, cache: UpdateCache): Promise<void> {
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(getUpdateCachePath(dataDir), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch (error) {
    debugLog("update", "failed to write cache", error instanceof Error ? error.message : String(error));
  }
}

/** registry 基地址，允许用 CCUS_REGISTRY 指向私服或镜像（如 npmmirror）。 */
function getRegistryBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.CCUS_REGISTRY ?? "").trim();
  const base = configured || "https://registry.npmjs.org";
  return base.replace(/\/+$/, "");
}

/**
 * 向 npm registry 查询最新发布版本。
 *
 * 走 `/<pkg>/latest` 这个轻量端点，只取 `version` 字段；超时或任何错误都 reject，
 * 由调用方决定是否静默。
 */
export function fetchLatestVersion(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const url = `${getRegistryBase(env)}/${PACKAGE_NAME}/latest`;
  return new Promise<string>((resolve, reject) => {
    const request = https.get(url, { headers: { accept: "application/json" } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`registry responded ${status}`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { version?: unknown };
          if (typeof parsed.version === "string") {
            resolve(parsed.version);
          } else {
            reject(new Error("registry payload missing version"));
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

    request.setTimeout(FETCH_TIMEOUT_MS, () => {
      request.destroy(new Error("registry request timed out"));
    });
    request.on("error", reject);
  });
}

/**
 * 真正执行一次检查并把结果写进缓存。
 *
 * 供隐藏命令 `__check-update`（statusline 后台触发）和 `ccus update`（用户主动）复用。
 * 即使 registry 失败也会更新 lastCheckedAt，避免反复重试打爆 registry。
 */
export async function performUpdateCheck(dataDir: string): Promise<UpdateCache> {
  let latestVersion: string | null = null;
  try {
    latestVersion = await fetchLatestVersion();
    debugLog("update", "fetched latest version", latestVersion);
  } catch (error) {
    debugLog("update", "fetch failed", error instanceof Error ? error.message : String(error));
  }

  const cache: UpdateCache = {
    lastCheckedAt: new Date().toISOString(),
    latestVersion,
  };
  await writeUpdateCache(dataDir, cache);
  return cache;
}

/** 缓存是否已过 TTL（或根本不存在），需要重新向 registry 查询。 */
function isCacheStale(cache: UpdateCache | null, now: Date): boolean {
  if (!cache) {
    return true;
  }
  const last = Date.parse(cache.lastCheckedAt);
  if (!Number.isFinite(last)) {
    return true;
  }
  return now.getTime() - last >= CHECK_TTL_MS;
}

/**
 * 如缓存过期，spawn 一个 detached 后台进程刷新它，主进程不等待。
 *
 * 这是 statusline 路径能用的唯一安全方式：主进程同步读旧缓存决定是否提示，
 * 把网络请求甩给后台子进程，自己立刻输出单行状态文本并退出，绝不阻塞。
 */
export function maybeSpawnBackgroundCheck(dataDir: string, now: Date = new Date()): void {
  try {
    if (!isCacheStale(readUpdateCacheSync(dataDir), now)) {
      return;
    }

    const scriptPath = process.argv[1];
    if (!scriptPath) {
      return;
    }

    const child = spawn(process.execPath, [scriptPath, "__check-update", "--data-dir", dataDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    debugLog("update", "spawned background check");
  } catch (error) {
    debugLog("update", "failed to spawn background check", error instanceof Error ? error.message : String(error));
  }
}

/**
 * 根据缓存计算 statusline 末尾要追加的更新标记。
 *
 * 有严格新于当前版本的发布时返回形如 `⬆ v0.1.5` 的短标记，否则返回 null。
 */
export function computeUpdateNotice(dataDir: string, currentVersion: string = getCurrentVersion()): string | null {
  const cache = readUpdateCacheSync(dataDir);
  if (!cache || !cache.latestVersion) {
    return null;
  }
  if (!isNewerVersion(cache.latestVersion, currentVersion)) {
    return null;
  }
  return `⬆ v${cache.latestVersion}`;
}
