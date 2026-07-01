import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { ApiModeConfig, ApiQuota, ApiQuotaCache } from "../types";
import { debugLog } from "./debug";
import { getApiConfigPath, getApiQuotaCachePath, getClaudeSettingsPath } from "./paths";

/** 默认智谱额度查询地址（团队视图 query）。 */
const DEFAULT_ZHIPU_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2";
/** 默认从哪个环境变量读 token：Claude Code 用第三方 API 时通常注入它。 */
const DEFAULT_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
/** 额度缓存 TTL：statusline 高频调用，默认 5 分钟拉一次。 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
/** 单次额度请求超时。 */
const DEFAULT_TIMEOUT_MS = 4000;
/** 默认请求 UA；遇反爬虫可在配置里改成浏览器 UA。 */
const DEFAULT_USER_AGENT = "ccus/statusline";

/** 构造一份带默认值的 API 模式配置。 */
export function defaultApiConfig(): ApiModeConfig {
  return {
    enabled: false,
    provider: "zhipu",
    tokenEnv: DEFAULT_TOKEN_ENV,
    token: null,
    cacheTtlMs: DEFAULT_CACHE_TTL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    userAgent: DEFAULT_USER_AGENT,
    zhipu: { url: DEFAULT_ZHIPU_URL, project: "", organization: "" },
    custom: {
      url: "",
      method: "GET",
      headers: {},
      fiveHourPath: "data.five_hour.used_percentage",
      sevenDayPath: "data.seven_day.used_percentage",
      extractor: "",
    },
  };
}

/** 仅把普通对象视作可继续读取字段的记录类型。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宽松读取数字，兼容 number 和可转成 number 的字符串。 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 同步读取 API 模式配置；缺省补默认值，任何异常都回退到「未启用」的安全默认。
 *
 * statusline 兜底路径需要同步、极快、绝不抛错，所以这里用同步 IO（照搬 readSyncConfig）。
 */
export function readApiConfig(dataDir: string): ApiModeConfig {
  const base = defaultApiConfig();
  try {
    const raw = fs.readFileSync(getApiConfigPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<ApiModeConfig>;
    return {
      enabled: parsed.enabled === true,
      provider: parsed.provider === "custom" ? "custom" : "zhipu",
      tokenEnv: typeof parsed.tokenEnv === "string" && parsed.tokenEnv.trim() !== "" ? parsed.tokenEnv : base.tokenEnv,
      token: typeof parsed.token === "string" && parsed.token.trim() !== "" ? parsed.token : null,
      cacheTtlMs: typeof parsed.cacheTtlMs === "number" && Number.isFinite(parsed.cacheTtlMs) && parsed.cacheTtlMs >= 0 ? parsed.cacheTtlMs : base.cacheTtlMs,
      timeoutMs: typeof parsed.timeoutMs === "number" && Number.isFinite(parsed.timeoutMs) && parsed.timeoutMs > 0 ? parsed.timeoutMs : base.timeoutMs,
      userAgent: typeof parsed.userAgent === "string" && parsed.userAgent.trim() !== "" ? parsed.userAgent : base.userAgent,
      zhipu: {
        url: typeof parsed.zhipu?.url === "string" && parsed.zhipu.url.trim() !== "" ? parsed.zhipu.url : base.zhipu.url,
        project: typeof parsed.zhipu?.project === "string" ? parsed.zhipu.project : "",
        organization: typeof parsed.zhipu?.organization === "string" ? parsed.zhipu.organization : "",
      },
      custom: {
        url: typeof parsed.custom?.url === "string" ? parsed.custom.url : base.custom.url,
        method: typeof parsed.custom?.method === "string" && parsed.custom.method.trim() !== "" ? parsed.custom.method : base.custom.method,
        headers: isRecord(parsed.custom?.headers) ? (parsed.custom!.headers as Record<string, string>) : base.custom.headers,
        fiveHourPath: typeof parsed.custom?.fiveHourPath === "string" && parsed.custom.fiveHourPath.trim() !== "" ? parsed.custom.fiveHourPath : base.custom.fiveHourPath,
        sevenDayPath: typeof parsed.custom?.sevenDayPath === "string" && parsed.custom.sevenDayPath.trim() !== "" ? parsed.custom.sevenDayPath : base.custom.sevenDayPath,
        extractor: typeof parsed.custom?.extractor === "string" ? parsed.custom.extractor : "",
      },
    };
  } catch {
    return base;
  }
}

/** 写入 API 模式配置；目录可能尚未创建，先 mkdir。 */
export async function writeApiConfig(dataDir: string, config: ApiModeConfig): Promise<void> {
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(getApiConfigPath(dataDir), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 解析实际 token：优先环境变量，读不到再用配置兜底。 */
export function resolveApiToken(config: ApiModeConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = (env[config.tokenEnv] ?? "").trim();
  if (fromEnv !== "") {
    return fromEnv;
  }
  return typeof config.token === "string" && config.token.trim() !== "" ? config.token : null;
}

/**
 * 从 ~/.claude/settings.json 的 env 字段读 tokenEnv 指定的那个键。
 *
 * Claude Code 启动子进程时会把 settings.json 的 env 注入环境变量，但用户在终端手动跑
 * `ccus api test` 时不在 Claude Code 进程树下，环境变量里通常没有 ANTHROPIC_AUTH_TOKEN ——
 * 这时回退到 settings.json（env 是 Claude Code 持久化这些变量的地方）读取。
 * 只读 env 字段（apiKeyHelper 需要 spawn 子进程、有副作用，不在此支持）。任何缺失/异常返回 null。
 */
export function readClaudeSettingsEnvTokenSync(
  tokenEnv: string,
  settingsPath: string = getClaudeSettingsPath(),
): string | null {
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const envField = parsed.env;
    if (!isRecord(envField)) {
      return null;
    }
    const value = envField[tokenEnv];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

/**
 * 三层回退解析 token：环境变量 → config.token → ~/.claude/settings.json 的 env 字段。
 *
 * 仅供 `api test` / `api status` / `api config` 这类手动命令显示与判断用；statusline 高频路径
 * 仍走纯 `resolveApiToken`（不读文件），行为不变。
 */
export function resolveApiTokenWithSettings(
  config: ApiModeConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveApiToken(config, env) ?? readClaudeSettingsEnvTokenSync(config.tokenEnv);
}

/** 把 header 值里的 {{token}} / {{apikey}} 占位符替换成实际 token；token 为空则替换为空串。 */
function renderHeader(value: string, token: string | null): string {
  return value.replaceAll(/{{\s*(token|apikey)\s*}}/gi, token ?? "");
}

/**
 * 智谱 GLM Coding Plan 的内置 extractor 脚本（zhipu provider 的预设）。
 *
 * data.limits 里筛 type==="TOKENS_LIMIT"，按 nextResetTime 升序，第 1 条 = 5h、第 2 条 = 每周。
 * 智谱在 5h 桶利用率=0% 时会省略该条的 nextResetTime，缺字段兜底 -Infinity 排最前（归 5h 桶），
 * 否则会被当 weekly、和 weekly 槽位互换（对照 cc-switch v3.16.0 的同类修复）。
 * success !== true / code !== 200 / 缺 data.limits 时返回会让归一化判 null 的值。
 * zhipu 不再单独维护提取函数，与 custom 走同一条 `runExtractor` 路径，只是 extractor 用这组内置脚本。
 */
export const ZHIPU_EXTRACTOR = `function(response) {
  if (!response || typeof response !== "object") return null;
  if (response.success !== undefined && response.success !== true) return null;
  if (response.code !== undefined && response.code !== 200) return null;
  const data = response.data;
  if (!data || typeof data !== "object") return null;
  const limits = data.limits;
  if (!Array.isArray(limits)) return null;
  const tokenLimits = limits
    .filter((l) => l && l.type === "TOKENS_LIMIT")
    .map((l) => ({ p: l.percentage, r: l.nextResetTime }))
    // 缺 nextResetTime 的那条兜底 -Infinity 排最前（= 5h 桶）：智谱在 5h=0% 时会省略该字段，
    // 若兜底 Infinity 排最后会被当成 weekly，造成 5h/7d 槽位互换（见上方 JSDoc）。
    .sort((a, b) => (typeof a.r === "number" ? a.r : -Infinity) - (typeof b.r === "number" ? b.r : -Infinity));
  return {
    fiveHour: tokenLimits[0] ? tokenLimits[0].p : null,
    sevenDay: tokenLimits[1] ? tokenLimits[1].p : null,
    level: typeof data.level === "string" && data.level !== "" ? data.level : null,
  };
}`;

/** 按点分路径取值，支持数组索引（如 data.limits.0.percentage）。 */
function getByPath(value: unknown, path: string): unknown {
  const parts = path
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) {
        return undefined;
      }
      current = current[idx];
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** 自定义 provider 响应提取：按点分路径取 5h / 7d 数字。 */
export function extractCustomQuota(json: unknown, fiveHourPath: string, sevenDayPath: string): ApiQuota | null {
  const fiveHour = toNumber(getByPath(json, fiveHourPath));
  const sevenDay = toNumber(getByPath(json, sevenDayPath));
  if (fiveHour === null && sevenDay === null) {
    return null;
  }
  return { fiveHour, sevenDay, level: null };
}

interface HttpRequestOptions {
  method: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

/**
 * 用用户提供的 extractor 脚本从响应里提取额度。
 *
 * 脚本经 `new Function` 在受限作用域求值，求值结果应为函数，再以响应对象调用。
 * 返回值兼容三种：`{ fiveHour, sevenDay }`、`[{used|percentage|number}, {used|percentage|number}]`（cc-switch 风格）、`[number, number]`。
 * 任何异常或非法返回都静默返回 null（debugLog 到 stderr），不抛出、不影响 statusline。
 *
 * 注意：脚本在 ccus 进程内以当前权限执行，只配置信任的来源。
 */
export function runExtractor(script: string, response: unknown): ApiQuota | null {
  const trimmed = script.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    const factory = new Function(`"use strict"; return (${trimmed});`);
    const extractor = factory();
    if (typeof extractor !== "function") {
      debugLog("api-mode", "extractor script did not evaluate to a function");
      return null;
    }
    return normalizeExtractorResult(extractor(response));
  } catch (error) {
    debugLog("api-mode", "extractor script failed", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** 把 extractor 返回值归一化成 ApiQuota，兼容对象 / cc-switch 数组 / 数字数组。 */
export function normalizeExtractorResult(result: unknown): ApiQuota | null {
  if (result === null || result === undefined) {
    return null;
  }
  if (isRecord(result)) {
    const fiveHour = toNumber(result.fiveHour);
    const sevenDay = toNumber(result.sevenDay);
    if (fiveHour === null && sevenDay === null) {
      return null;
    }
    const levelRaw = result.level;
    const level = typeof levelRaw === "string" && levelRaw.trim() !== "" ? levelRaw : null;
    return { fiveHour, sevenDay, level };
  }
  if (Array.isArray(result)) {
    const fiveHour = extractArrayNumber(result[0]);
    const sevenDay = extractArrayNumber(result[1]);
    if (fiveHour === null && sevenDay === null) {
      return null;
    }
    return { fiveHour, sevenDay, level: null };
  }
  return null;
}

/** 从 extractor 数组单项里取数字：number 自身，或 {used|percentage|used_percentage}。 */
function extractArrayNumber(item: unknown): number | null {
  if (typeof item === "number") {
    return Number.isFinite(item) ? item : null;
  }
  if (isRecord(item)) {
    return toNumber(item.used) ?? toNumber(item.percentage) ?? toNumber(item.used_percentage);
  }
  return null;
}

/** 按 url 协议发起 HTTP(S) 请求，返回 {status, body}；超时或错误 reject（仿 fetchLatestVersion）。 */
function httpRequest(url: string, opts: HttpRequestOptions): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`invalid url: ${url}`));
      return;
    }
    const transport = parsed.protocol === "http:" ? http : https;
    const request = transport.request(url, { method: opts.method, headers: opts.headers }, (response) => {
      const status = response.statusCode ?? 0;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status, body }));
    });
    request.setTimeout(opts.timeoutMs, () => {
      request.destroy(new Error("api quota request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

interface PreparedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  extract: (json: unknown) => ApiQuota | null;
}

/** 根据配置与 token 构造一次额度请求（含 extractor）；配置不完整返回 null。 */
function prepareQuotaRequest(config: ApiModeConfig, token: string | null): PreparedRequest | null {
  if (config.provider === "custom") {
    const url = config.custom.url.trim();
    if (url === "") {
      return null;
    }
    const headers: Record<string, string> = { "User-Agent": config.userAgent };
    for (const [key, value] of Object.entries(config.custom.headers)) {
      headers[key] = renderHeader(value, token);
    }
    return {
      url,
      method: config.custom.method.toUpperCase() === "POST" ? "POST" : "GET",
      headers,
      extract: (json) => {
        if (config.custom.extractor.trim() !== "") {
          return runExtractor(config.custom.extractor, json);
        }
        return extractCustomQuota(json, config.custom.fiveHourPath, config.custom.sevenDayPath);
      },
    };
  }

  // 智谱：Authorization 裸 token + 可选 project/organization 头。
  const headers: Record<string, string> = {
    Authorization: token ?? "",
    "Content-Type": "application/json",
    "User-Agent": config.userAgent,
  };
  if (config.zhipu.project.trim() !== "") {
    headers["bigmodel-project"] = config.zhipu.project.trim();
  }
  if (config.zhipu.organization.trim() !== "") {
    headers["bigmodel-organization"] = config.zhipu.organization.trim();
  }
  return {
    url: config.zhipu.url,
    method: "GET",
    headers,
    extract: (json) => runExtractor(ZHIPU_EXTRACTOR, json),
  };
}

/** 拉取动作类型，供 resolveApiQuota 注入可替换实现（测试用）。 */
export type QuotaFetcher = (config: ApiModeConfig, env: NodeJS.ProcessEnv) => Promise<ApiQuota>;

/**
 * 真正发起一次请求并解析额度。
 *
 * 任何失败都 reject（HTTP 非 2xx、空响应、解析失败、字段缺失），由调用方决定静默/回退；
 * 错误信息尽量包含可排查原因（如反爬虫空响应提示改 UA）。
 */
export async function fetchQuota(config: ApiModeConfig, env: NodeJS.ProcessEnv = process.env): Promise<ApiQuota> {
  const token = resolveApiToken(config, env);
  const prepared = prepareQuotaRequest(config, token);
  if (!prepared) {
    throw new Error(`API 模式 provider=${config.provider} 配置不完整（缺少 url）`);
  }

  const { status, body } = await httpRequest(prepared.url, {
    method: prepared.method,
    headers: prepared.headers,
    timeoutMs: config.timeoutMs,
  });
  debugLog("api-mode", "quota response", { status, bodyLength: body.length, preview: body.slice(0, 200) });

  if (status < 200 || status >= 300) {
    throw new Error(`额度接口返回 HTTP ${status}`);
  }
  if (body.trim() === "") {
    throw new Error("额度接口返回空响应（可能被反爬虫拦截，尝试 `ccus api config --user-agent <浏览器UA>`）");
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new Error(`额度响应不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const quota = prepared.extract(json);
  if (!quota) {
    throw new Error("额度响应无法解析出 5h/7d（字段路径不对或接口未返回额度数据）");
  }
  return quota;
}

/** 同步读取额度缓存；损坏/缺失返回 null。 */
export function readApiQuotaCacheSync(dataDir: string): ApiQuotaCache | null {
  try {
    const raw = fs.readFileSync(getApiQuotaCachePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<ApiQuotaCache>;
    if (typeof parsed.fetchedAt !== "string") {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      fiveHour: typeof parsed.fiveHour === "number" ? parsed.fiveHour : null,
      sevenDay: typeof parsed.sevenDay === "number" ? parsed.sevenDay : null,
      level: typeof parsed.level === "string" && parsed.level.trim() !== "" ? parsed.level : null,
    };
  } catch {
    return null;
  }
}

/** 写入额度缓存；失败静默（不能因缓存写入失败影响 statusline 主流程）。 */
async function writeApiQuotaCache(dataDir: string, cache: ApiQuotaCache): Promise<void> {
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(getApiQuotaCachePath(dataDir), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch (error) {
    debugLog("api-mode", "failed to write quota cache", error instanceof Error ? error.message : String(error));
  }
}

function isCacheFresh(cache: ApiQuotaCache | null, ttlMs: number, now: Date): boolean {
  if (!cache) {
    return false;
  }
  const fetched = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetched)) {
    return false;
  }
  return now.getTime() - fetched < ttlMs;
}

function quotaFromCache(cache: ApiQuotaCache): ApiQuota {
  return { fiveHour: cache.fiveHour, sevenDay: cache.sevenDay, level: cache.level };
}

/**
 * 缓存优先解析额度：新鲜直接返回；过期同步拉一次（带超时）；拉取失败回退旧缓存，全失败返回 null。
 *
 * statusline 路径用，全程不抛错、不写 stdout。`options.fetcher` 供测试注入。
 */
export async function resolveApiQuota(
  dataDir: string,
  config: ApiModeConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: Date; fetcher?: QuotaFetcher } = {},
): Promise<ApiQuota | null> {
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetchQuota;

  const cached = readApiQuotaCacheSync(dataDir);
  if (isCacheFresh(cached, config.cacheTtlMs, now) && cached) {
    return quotaFromCache(cached);
  }

  try {
    const quota = await fetcher(config, env);
    await writeApiQuotaCache(dataDir, { ...quota, fetchedAt: now.toISOString() });
    return quota;
  } catch (error) {
    debugLog("api-mode", "quota fetch failed, fallback to cache", error instanceof Error ? error.message : String(error));
    if (cached) {
      return quotaFromCache(cached);
    }
    return null;
  }
}

/**
 * 把额度合并写进 rawPayload.rate_limits：保留已有官方字段，补 five_hour / seven_day 的 used_percentage。
 *
 * 之后 appendEvent 落盘即带 rate_limits，computeStatuslineEvent 自动算出 usage；raw-first，零契约改动。
 */
export function applyQuotaToPayload(
  rawPayload: { rate_limits?: unknown } & Record<string, unknown>,
  quota: ApiQuota,
): void {
  const existing = isRecord(rawPayload.rate_limits) ? rawPayload.rate_limits : {};
  const existingFiveHour = isRecord(existing.five_hour) ? existing.five_hour : {};
  const existingSevenDay = isRecord(existing.seven_day) ? existing.seven_day : {};
  rawPayload.rate_limits = {
    ...existing,
    five_hour: { ...existingFiveHour, used_percentage: quota.fiveHour },
    seven_day: { ...existingSevenDay, used_percentage: quota.sevenDay },
  };
}
