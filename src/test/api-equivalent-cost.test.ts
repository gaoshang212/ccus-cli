import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_PRICING_CATALOG,
  API_PRICING_METADATA,
  ApiPricingCatalog,
  emptyApiEquivalentCost,
  findApiModelPrice,
  mergeApiEquivalentCosts,
  normalizeApiModel,
  priceApiRequest,
  validatePricingCatalog,
} from "../lib/api-equivalent-cost";

test("default pricing catalog is loaded from the packaged JSON file", () => {
  const catalogPath = join(__dirname, "../lib/api-pricing-catalog.json");
  const catalogJson = JSON.parse(readFileSync(catalogPath, "utf8"));
  assert.deepEqual(API_PRICING_CATALOG, catalogJson);
  assert.deepEqual(API_PRICING_METADATA, {
    catalogVersion: catalogJson.catalogVersion,
    currency: catalogJson.currency,
    basis: catalogJson.basis,
  });
  assert.doesNotThrow(() => validatePricingCatalog(API_PRICING_CATALOG));
});

const TEST_CATALOG: ApiPricingCatalog = {
  catalogVersion: "test-v1",
  currency: "USD",
  basis: "event-time-standard-api",
  entries: [
    {
      provider: "claude",
      model: "claude-sonnet-4.5",
      effectiveFrom: "2025-09-29T00:00:00.000Z",
      effectiveTo: "2026-01-01T00:00:00.000Z",
      prices: {
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
        cacheReadInputUsdPerMillion: 0.3,
        cacheWrite5mInputUsdPerMillion: 3.75,
        cacheWrite1hInputUsdPerMillion: 6,
      },
      longContext: {
        thresholdInputTokens: 200_000,
        prices: {
          inputUsdPerMillion: 6,
          outputUsdPerMillion: 22.5,
          cacheReadInputUsdPerMillion: 0.6,
          cacheWrite5mInputUsdPerMillion: 7.5,
          cacheWrite1hInputUsdPerMillion: 12,
        },
      },
    },
    {
      provider: "claude",
      model: "claude-sonnet-4.5",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      prices: {
        inputUsdPerMillion: 4,
        outputUsdPerMillion: 20,
        cacheReadInputUsdPerMillion: 0.4,
        cacheWrite5mInputUsdPerMillion: 5,
        cacheWrite1hInputUsdPerMillion: 8,
      },
    },
    {
      provider: "codex",
      model: "gpt-5.2-codex",
      effectiveFrom: "2025-12-18T00:00:00.000Z",
      effectiveTo: null,
      prices: {
        inputUsdPerMillion: 1.75,
        outputUsdPerMillion: 14,
        cacheReadInputUsdPerMillion: 0.175,
      },
    },
  ],
};

test("validatePricingCatalog rejects overlapping effective ranges", () => {
  const overlapping: ApiPricingCatalog = {
    ...TEST_CATALOG,
    entries: [...TEST_CATALOG.entries, {
      ...TEST_CATALOG.entries[0],
      effectiveFrom: "2025-12-01T00:00:00.000Z",
      effectiveTo: "2026-02-01T00:00:00.000Z",
    }],
  };
  assert.throws(() => validatePricingCatalog(overlapping), /价格生效区间重叠/);
  assert.doesNotThrow(() => validatePricingCatalog(TEST_CATALOG));
});

test("validatePricingCatalog rejects invalid JSON price values", () => {
  const invalid = structuredClone(TEST_CATALOG);
  invalid.entries[0].prices.inputUsdPerMillion = -1;
  assert.throws(() => validatePricingCatalog(invalid), /无效模型价格/);
});

test("normalizeApiModel handles Claude snapshots and Codex reasoning tiers", () => {
  assert.equal(normalizeApiModel("claude", "claude-3-5-sonnet-20241022"), "claude-sonnet-3.5");
  assert.equal(normalizeApiModel("claude", "claude-sonnet-4-5-20250929"), "claude-sonnet-4.5");
  assert.equal(normalizeApiModel("claude", "anthropic/claude-opus-4-8-20260528"), "claude-opus-4.8");
  assert.equal(normalizeApiModel("claude", "claude-opus-4.8-20260528"), "claude-opus-4.8");
  assert.equal(normalizeApiModel("claude", "claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeApiModel("claude", "claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(normalizeApiModel("claude", "claude-fable-5"), "claude-fable-5");
  assert.equal(normalizeApiModel("codex", "openai/gpt-5.2-codex-xhigh"), "gpt-5.2-codex");
  assert.equal(normalizeApiModel("codex", "gpt-5.2-codex (reasoning: high)"), "gpt-5.2-codex");
  assert.equal(normalizeApiModel("claude", "unknown"), null);
});

test("normalizeApiModel handles Orca thinking aliases and the bare GPT 5.6 alias", () => {
  assert.equal(normalizeApiModel("claude", "claude-sonnet-5-thinking"), "claude-sonnet-5");
  assert.equal(normalizeApiModel("claude", "claude-opus-4-8-thinking"), "claude-opus-4.8");
  assert.equal(normalizeApiModel("claude", "anthropic/claude-opus-4-8-20260528-thinking[1m]"), "claude-opus-4.8");
  assert.equal(normalizeApiModel("claude", "anthropic/claude-opus-4.8-thinking-20260528[1m]"), "claude-opus-4.8");
  assert.equal(normalizeApiModel("codex", "gpt-5.6"), "gpt-5.6-sol");
  assert.equal(normalizeApiModel("codex", "gpt-5.6-terra-high"), "gpt-5.6-terra");
  assert.equal(normalizeApiModel("codex", "gpt-5.6-luna"), "gpt-5.6-luna");
});

test("default catalog includes current Orca Claude models and Sonnet 5 event-time pricing", () => {
  assert.equal(findApiModelPrice({ provider: "claude", model: "claude-opus-4-7", timestamp: "2026-04-16T00:00:00Z" })?.prices.inputUsdPerMillion, 5);
  assert.equal(findApiModelPrice({ provider: "claude", model: "claude-opus-4-8", timestamp: "2026-05-28T00:00:00Z" })?.prices.outputUsdPerMillion, 25);
  assert.equal(findApiModelPrice({ provider: "claude", model: "claude-fable-5", timestamp: "2026-06-09T00:00:00Z" })?.prices.cacheWrite1hInputUsdPerMillion, 20);
  assert.equal(findApiModelPrice({ provider: "claude", model: "claude-opus-5", timestamp: "2026-07-24T00:00:00Z" })?.prices.cacheReadInputUsdPerMillion, 0.5);
  assert.equal(findApiModelPrice({ provider: "claude", model: "claude-sonnet-5", timestamp: "2026-08-17T00:00:00Z" })?.prices.inputUsdPerMillion, 2);
  assert.equal(findApiModelPrice({ provider: "claude", model: "claude-sonnet-5", timestamp: "2026-09-01T00:00:00Z" })?.prices.inputUsdPerMillion, 3);
});

test("default catalog prices Claude Sonnet 4.6 above 200K input tokens", () => {
  const price = findApiModelPrice({ provider: "claude", model: "claude-sonnet-4-6-thinking", timestamp: "2026-08-17T00:00:00Z" });
  assert.deepEqual(price?.longContext, {
    thresholdInputTokens: 200_000,
    prices: {
      inputUsdPerMillion: 6,
      outputUsdPerMillion: 22.5,
      cacheReadInputUsdPerMillion: 0.6,
      cacheWrite5mInputUsdPerMillion: 7.5,
      cacheWrite1hInputUsdPerMillion: 12,
    },
  });
  const request = {
    provider: "claude" as const,
    timestamp: "2026-08-17T00:00:00Z",
    model: "claude-sonnet-4-6-thinking",
    outputTokens: 0,
    cacheReadInputTokens: 0,
  };
  assert.equal(priceApiRequest({ ...request, inputTokens: 200_000 }).estimatedUsd, 0.6);
  assert.equal(priceApiRequest({ ...request, inputTokens: 200_001 }).estimatedUsd, 1.200006);
});

test("default catalog prices current Codex models above 272K input tokens", () => {
  const cases = [
    { model: "gpt-5.4", standard: [2.5, 15, 0.25], long: [5, 22.5, 0.5] },
    { model: "gpt-5.5", standard: [5, 30, 0.5], long: [10, 45, 1] },
    { model: "gpt-5.6", canonical: "gpt-5.6-sol", standard: [5, 30, 0.5], long: [10, 45, 1] },
    { model: "gpt-5.6-terra", standard: [2.5, 15, 0.25], long: [5, 22.5, 0.5] },
    { model: "gpt-5.6-luna", standard: [1, 6, 0.1], long: [2, 9, 0.2] },
  ];
  for (const item of cases) {
    const price = findApiModelPrice({ provider: "codex", model: item.model, timestamp: "2026-08-17T00:00:00Z" });
    assert.equal(price?.model, item.canonical ?? item.model);
    assert.deepEqual(price?.longContext, {
      thresholdInputTokens: 272_000,
      prices: {
        inputUsdPerMillion: item.long[0],
        outputUsdPerMillion: item.long[1],
        cacheReadInputUsdPerMillion: item.long[2],
      },
    });
    const request = {
      provider: "codex" as const,
      timestamp: "2026-08-17T00:00:00Z",
      model: item.model,
      outputTokens: 0,
      cacheReadInputTokens: 0,
    };
    assert.equal(priceApiRequest({ ...request, inputTokens: 272_000 }).estimatedUsd, 272_000 * item.standard[0] / 1_000_000);
    assert.equal(priceApiRequest({ ...request, inputTokens: 272_001 }).estimatedUsd, 272_001 * item.long[0] / 1_000_000);
  }
});

test("findApiModelPrice uses event time and does not borrow another interval", () => {
  assert.equal(findApiModelPrice({ provider: "claude", model: "claude-sonnet-4-5-20250929", timestamp: "2025-12-31T23:59:59Z" }, TEST_CATALOG)?.prices.inputUsdPerMillion, 3);
  assert.equal(findApiModelPrice({ provider: "claude", model: "claude-sonnet-4-5-20250929", timestamp: "2026-01-01T00:00:00Z" }, TEST_CATALOG)?.prices.inputUsdPerMillion, 4);
  assert.equal(findApiModelPrice({ provider: "claude", model: "claude-sonnet-4-5-20250929", timestamp: "2025-01-01T00:00:00Z" }, TEST_CATALOG), null);
});

test("priceApiRequest prices all Claude token buckets", () => {
  const result = priceApiRequest({
    provider: "claude",
    timestamp: "2025-10-01T00:00:00Z",
    model: "claude-sonnet-4-5-20250929",
    inputTokens: 100_000,
    outputTokens: 10_000,
    cacheReadInputTokens: 20_000,
    cacheWrite5mInputTokens: 30_000,
    cacheWrite1hInputTokens: 40_000,
  }, TEST_CATALOG);
  assert.equal(result.pricedApiRequestCount, 1);
  assert.equal(result.unpricedApiRequestCount, 0);
  assert.equal(result.estimatedUsd, 0.8085);
});

test("priceApiRequest applies long context only above the request threshold", () => {
  const base = {
    provider: "claude" as const,
    timestamp: "2025-10-01T00:00:00Z",
    model: "claude-sonnet-4-5-20250929",
    outputTokens: 0,
    cacheReadInputTokens: 0,
  };
  assert.equal(priceApiRequest({ ...base, inputTokens: 200_000 }, TEST_CATALOG).estimatedUsd, 0.6);
  assert.equal(priceApiRequest({ ...base, inputTokens: 200_001 }, TEST_CATALOG).estimatedUsd, 1.200006);
});

test("priceApiRequest keeps Codex net input separate from cached input", () => {
  const result = priceApiRequest({
    provider: "codex",
    timestamp: "2026-01-01T00:00:00Z",
    model: "gpt-5.2-codex-high",
    inputTokens: 100_000,
    outputTokens: 10_000,
    cacheReadInputTokens: 50_000,
  }, TEST_CATALOG);
  assert.equal(result.estimatedUsd, 0.32375);
});

test("mergeApiEquivalentCosts preserves coverage semantics", () => {
  assert.deepEqual(mergeApiEquivalentCosts([]), emptyApiEquivalentCost());
  assert.deepEqual(mergeApiEquivalentCosts([{ estimatedUsd: 1.25, pricedApiRequestCount: 2, unpricedApiRequestCount: 0 }]), { estimatedUsd: 1.25, pricedApiRequestCount: 2, unpricedApiRequestCount: 0 });
  assert.deepEqual(mergeApiEquivalentCosts([
    { estimatedUsd: 1.25, pricedApiRequestCount: 2, unpricedApiRequestCount: 0 },
    { estimatedUsd: null, pricedApiRequestCount: 0, unpricedApiRequestCount: 1 },
  ]), { estimatedUsd: 1.25, pricedApiRequestCount: 2, unpricedApiRequestCount: 1 });
  assert.deepEqual(mergeApiEquivalentCosts([{ estimatedUsd: null, pricedApiRequestCount: 0, unpricedApiRequestCount: 3 }]), { estimatedUsd: null, pricedApiRequestCount: 0, unpricedApiRequestCount: 3 });
});
