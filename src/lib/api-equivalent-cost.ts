import pricingCatalogJson from "./api-pricing-catalog.json";

export type ApiCostProvider = "claude" | "codex";

export interface ApiCostRequest {
  provider: ApiCostProvider;
  timestamp: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
}

export interface ApiEquivalentCostResult {
  estimatedUsd: number | null;
  pricedApiRequestCount: number;
  unpricedApiRequestCount: number;
}

export interface ApiTokenPrices {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadInputUsdPerMillion: number;
  cacheWrite5mInputUsdPerMillion?: number;
  cacheWrite1hInputUsdPerMillion?: number;
}

export interface LongContextPriceRule {
  /** 单次请求的所有输入类 token 之和必须严格大于该阈值。 */
  thresholdInputTokens: number;
  prices: ApiTokenPrices;
}

export interface ApiModelPrice {
  provider: ApiCostProvider;
  /** 归一化后的模型名。 */
  model: string;
  /** ISO 时间，生效区间为 [effectiveFrom, effectiveTo)。 */
  effectiveFrom: string;
  effectiveTo: string | null;
  prices: ApiTokenPrices;
  longContext?: LongContextPriceRule;
}

export interface ApiPricingCatalog {
  catalogVersion: string;
  currency: "USD";
  basis: "event-time-standard-api";
  entries: ApiModelPrice[];
}

/**
 * 随 ccus 发布的标准同步 API 价格目录。
 * 全部模型价格集中维护在同目录的 api-pricing-catalog.json；价格来源：
 * - https://platform.claude.com/docs/en/about-claude/pricing
 * - https://developers.openai.com/api/docs/models
 */
export const API_PRICING_CATALOG = pricingCatalogJson as ApiPricingCatalog;

/** 导出元数据直接派生自 JSON，避免版本和计价基准重复维护。 */
export const API_PRICING_METADATA = {
  catalogVersion: API_PRICING_CATALOG.catalogVersion,
  currency: API_PRICING_CATALOG.currency,
  basis: API_PRICING_CATALOG.basis,
};

function parseTime(value: string | null): number {
  if (value === null) {
    return Number.POSITIVE_INFINITY;
  }
  return new Date(value).getTime();
}

function validateTokenPrices(provider: ApiCostProvider, model: string, prices: ApiTokenPrices): void {
  const required: Array<keyof ApiTokenPrices> = [
    "inputUsdPerMillion",
    "outputUsdPerMillion",
    "cacheReadInputUsdPerMillion",
  ];
  if (provider === "claude") {
    required.push("cacheWrite5mInputUsdPerMillion", "cacheWrite1hInputUsdPerMillion");
  }
  for (const field of required) {
    const value = prices[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`无效模型价格：${provider}/${model}/${field}`);
    }
  }
}

/** 校验生效时间有效，且同来源同模型的半开区间不重叠。 */
export function validatePricingCatalog(catalog: ApiPricingCatalog): void {
  const groups = new Map<string, ApiModelPrice[]>();
  for (const price of catalog.entries) {
    if ((price.provider !== "claude" && price.provider !== "codex") || price.model.trim() === "") {
      throw new Error("无效价格目录模型");
    }
    validateTokenPrices(price.provider, price.model, price.prices);
    if (price.longContext) {
      if (!Number.isFinite(price.longContext.thresholdInputTokens) || price.longContext.thresholdInputTokens < 0) {
        throw new Error(`无效长上下文阈值：${price.provider}/${price.model}`);
      }
      validateTokenPrices(price.provider, price.model, price.longContext.prices);
    }
    const start = parseTime(price.effectiveFrom);
    const end = parseTime(price.effectiveTo);
    if (!Number.isFinite(start) || Number.isNaN(end) || end <= start) {
      throw new Error(`无效价格生效区间：${price.provider}/${price.model}`);
    }
    const key = `${price.provider}\0${price.model}`;
    const items = groups.get(key) ?? [];
    items.push(price);
    groups.set(key, items);
  }

  for (const [key, items] of groups) {
    items.sort((left, right) => parseTime(left.effectiveFrom) - parseTime(right.effectiveFrom));
    for (let index = 1; index < items.length; index += 1) {
      if (parseTime(items[index].effectiveFrom) < parseTime(items[index - 1].effectiveTo)) {
        throw new Error(`价格生效区间重叠：${key.replace("\0", "/")}`);
      }
    }
  }
}

function normalizeClaudeModel(model: string): string | null {
  const value = model.trim().toLowerCase()
    .replace(/^anthropic\//, "")
    .replaceAll("_", "-")
    .replace(/\[1m\]$/, "")
    .replace(/-thinking(?=-\d{8}$|$)/, "");
  const canonicalMinor = /^claude-(opus|sonnet|haiku|fable)-(\d+)\.(\d+)(?:-\d{8})?$/.exec(value);
  if (canonicalMinor) {
    return `claude-${canonicalMinor[1]}-${canonicalMinor[2]}.${canonicalMinor[3]}`;
  }
  const modern = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)(?:-\d{8})?$/.exec(value);
  if (modern) {
    return `claude-${modern[1]}-${modern[2]}.${modern[3]}`;
  }
  const modernMajor = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-\d{8})?$/.exec(value);
  if (modernMajor) {
    return `claude-${modernMajor[1]}-${modernMajor[2]}`;
  }
  const legacyMinor = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku|fable)(?:-\d{8})?$/.exec(value);
  if (legacyMinor) {
    return `claude-${legacyMinor[3]}-${legacyMinor[1]}.${legacyMinor[2]}`;
  }
  const legacyMajor = /^claude-(\d+)-(opus|sonnet|haiku|fable)(?:-\d{8})?$/.exec(value);
  if (legacyMajor) {
    return `claude-${legacyMajor[2]}-${legacyMajor[1]}`;
  }
  return null;
}

function normalizeCodexModel(model: string): string | null {
  let value = model.trim().toLowerCase().replace(/^openai\//, "").replaceAll("_", "-");
  value = value.replace(/[\s/(]+(?:reasoning\s*:?\s*)?(?:minimal|low|medium|high|xhigh|max|ultra)\)?$/, "");
  value = value.replace(/-(?:minimal|low|medium|high|xhigh|max|ultra)$/, "");
  value = value.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (value === "gpt-5.6") {
    return "gpt-5.6-sol";
  }
  return /^gpt-[a-z0-9.-]+$/.test(value) ? value : null;
}

export function normalizeApiModel(provider: ApiCostProvider, model: string | null): string | null {
  if (!model) {
    return null;
  }
  return provider === "claude" ? normalizeClaudeModel(model) : normalizeCodexModel(model);
}

export function findApiModelPrice(
  request: Pick<ApiCostRequest, "provider" | "model" | "timestamp">,
  catalog: ApiPricingCatalog = API_PRICING_CATALOG,
): ApiModelPrice | null {
  const model = normalizeApiModel(request.provider, request.model);
  const timestamp = new Date(request.timestamp).getTime();
  if (!model || !Number.isFinite(timestamp)) {
    return null;
  }
  return catalog.entries.find((price) => price.provider === request.provider
    && price.model === model
    && timestamp >= parseTime(price.effectiveFrom)
    && timestamp < parseTime(price.effectiveTo)) ?? null;
}

function tokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function computeRequestUsd(request: ApiCostRequest, price: ApiModelPrice): number {
  const inputTokens = tokenCount(request.inputTokens);
  const cacheReadInputTokens = tokenCount(request.cacheReadInputTokens);
  const cacheWrite5mInputTokens = tokenCount(request.cacheWrite5mInputTokens);
  const cacheWrite1hInputTokens = tokenCount(request.cacheWrite1hInputTokens);
  const totalInputTokens = inputTokens + cacheReadInputTokens + cacheWrite5mInputTokens + cacheWrite1hInputTokens;
  const prices = price.longContext && totalInputTokens > price.longContext.thresholdInputTokens
    ? price.longContext.prices
    : price.prices;

  return (
    inputTokens * prices.inputUsdPerMillion
    + tokenCount(request.outputTokens) * prices.outputUsdPerMillion
    + cacheReadInputTokens * prices.cacheReadInputUsdPerMillion
    + cacheWrite5mInputTokens * (prices.cacheWrite5mInputUsdPerMillion ?? 0)
    + cacheWrite1hInputTokens * (prices.cacheWrite1hInputUsdPerMillion ?? 0)
  ) / 1_000_000;
}

export function emptyApiEquivalentCost(): ApiEquivalentCostResult {
  return { estimatedUsd: 0, pricedApiRequestCount: 0, unpricedApiRequestCount: 0 };
}

/** 对单次请求计价；无法匹配价格时保留为一条未定价请求。 */
export function priceApiRequest(
  request: ApiCostRequest,
  catalog: ApiPricingCatalog = API_PRICING_CATALOG,
): ApiEquivalentCostResult {
  const price = findApiModelPrice(request, catalog);
  if (!price) {
    return { estimatedUsd: null, pricedApiRequestCount: 0, unpricedApiRequestCount: 1 };
  }
  return {
    estimatedUsd: computeRequestUsd(request, price),
    pricedApiRequestCount: 1,
    unpricedApiRequestCount: 0,
  };
}

/** 合并来源、日期或请求结果，并保持空范围/部分覆盖/全未定价语义。 */
export function mergeApiEquivalentCosts(results: Iterable<ApiEquivalentCostResult>): ApiEquivalentCostResult {
  let estimatedUsd = 0;
  let pricedApiRequestCount = 0;
  let unpricedApiRequestCount = 0;
  for (const result of results) {
    pricedApiRequestCount += result.pricedApiRequestCount;
    unpricedApiRequestCount += result.unpricedApiRequestCount;
    if (result.estimatedUsd !== null) {
      estimatedUsd += result.estimatedUsd;
    }
  }
  return {
    estimatedUsd: pricedApiRequestCount > 0 || unpricedApiRequestCount === 0 ? estimatedUsd : null,
    pricedApiRequestCount,
    unpricedApiRequestCount,
  };
}

validatePricingCatalog(API_PRICING_CATALOG);
