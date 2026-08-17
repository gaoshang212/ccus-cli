import {
  API_PRICING_CATALOG,
  ApiModelPrice,
  ApiPricingCatalog,
  ApiTokenPrices,
} from "./api-equivalent-cost";

export const API_PRICING_PAGE_FILE = "pricing.html";
export const API_PRICING_PAGE_PATH = `/${API_PRICING_PAGE_FILE}`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPrice(value: number | undefined): string {
  return value === undefined ? "--" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}

function renderPriceRow(entry: ApiModelPrice, tier: string, prices: ApiTokenPrices): string {
  return `
    <tr>
      <td>${entry.provider === "claude" ? "Claude" : "Codex"}</td>
      <td><code>${escapeHtml(entry.model)}</code></td>
      <td>${escapeHtml(tier)}</td>
      <td>${escapeHtml(entry.effectiveFrom.slice(0, 10))}</td>
      <td>${formatPrice(prices.inputUsdPerMillion)}</td>
      <td>${formatPrice(prices.outputUsdPerMillion)}</td>
      <td>${formatPrice(prices.cacheReadInputUsdPerMillion)}</td>
      <td>${formatPrice(prices.cacheWrite5mInputUsdPerMillion)}</td>
      <td>${formatPrice(prices.cacheWrite1hInputUsdPerMillion)}</td>
    </tr>`;
}

function providerRank(provider: ApiModelPrice["provider"]): number {
  return provider === "codex" ? 0 : 1;
}

function compareModelVersionsDescending(left: string, right: string): number {
  const leftParts = left.match(/\d+(?:\.\d+)*/)?.[0].split(".").map(Number) ?? [];
  const rightParts = right.match(/\d+(?:\.\d+)*/)?.[0].split(".").map(Number) ?? [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function comparePricingEntries(left: ApiModelPrice, right: ApiModelPrice): number {
  const providerDifference = providerRank(left.provider) - providerRank(right.provider);
  if (providerDifference !== 0) {
    return providerDifference;
  }
  return left.provider === "codex"
    ? compareModelVersionsDescending(left.model, right.model)
    : left.model.localeCompare(right.model);
}

/** 按页面生成时间渲染有效区间内的普通与长上下文价格。 */
export function renderCurrentApiPricingTable(
  catalog: ApiPricingCatalog = API_PRICING_CATALOG,
  generatedAt: Date = new Date(),
): string {
  const generatedAtMs = generatedAt.getTime();
  const entries = catalog.entries
    .filter((entry) => {
      const effectiveFromMs = new Date(entry.effectiveFrom).getTime();
      const effectiveToMs = entry.effectiveTo === null ? Number.POSITIVE_INFINITY : new Date(entry.effectiveTo).getTime();
      return generatedAtMs >= effectiveFromMs && generatedAtMs < effectiveToMs;
    })
    .sort(comparePricingEntries);
  const rows = entries.flatMap((entry) => {
    const itemRows = [renderPriceRow(entry, "普通", entry.prices)];
    if (entry.longContext) {
      itemRows.push(renderPriceRow(
        entry,
        `长上下文（输入类 token > ${entry.longContext.thresholdInputTokens.toLocaleString("en-US")}）`,
        entry.longContext.prices,
      ));
    }
    return itemRows;
  }).join("");

  return `
    <section class="panel table-panel">
      <div class="panel-header">
        <p class="muted">目录 ${escapeHtml(catalog.catalogVersion)} · USD / 百万 token · 标准同步 API</p>
      </div>
      <div class="table-wrap">
        <table class="pricing-table">
          <thead>
            <tr>
              <th>来源</th>
              <th>模型</th>
              <th>计价档位</th>
              <th>生效日期</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存读取</th>
              <th>5 分钟缓存写入</th>
              <th>1 小时缓存写入</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

/** 生成可独立打开的当前 API 价格页面。 */
export function buildApiPricingPage(
  generatedAt: Date = new Date(),
  catalog: ApiPricingCatalog = API_PRICING_CATALOG,
): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ccus 当前模型价格</title>
    <style>
      :root {
        --bg: #0a0d12;
        --panel: rgba(16, 21, 31, 0.84);
        --panel-border: rgba(120, 141, 173, 0.18);
        --text: #ecf3ff;
        --muted: #91a0b8;
        --accent: #5eead4;
        --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(34, 197, 94, 0.18), transparent 30%),
          radial-gradient(circle at top right, rgba(94, 234, 212, 0.16), transparent 28%),
          linear-gradient(160deg, #06080c 0%, #0a0d12 48%, #101520 100%);
      }
      .shell { max-width: 1240px; margin: 0 auto; padding: 40px 24px 64px; }
      .hero { display: grid; gap: 12px; padding: 28px 0 18px; }
      .eyebrow { margin: 0 0 8px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.14em; font-size: 12px; }
      h1, p { margin: 0; }
      h1 { font-size: clamp(36px, 5vw, 60px); line-height: 0.95; font-weight: 600; }
      .muted { color: var(--muted); font-size: 14px; }
      .panel { background: var(--panel); border: 1px solid var(--panel-border); border-radius: 24px; box-shadow: var(--shadow); }
      .table-panel { margin-top: 22px; }
      .panel-header { padding: 24px 24px 0; }
      .table-wrap { overflow: auto; padding: 16px 20px 22px; }
      table { width: 100%; min-width: 1080px; border-collapse: collapse; }
      th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid rgba(145, 160, 184, 0.12); vertical-align: top; }
      th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }
      td { font-size: 14px; }
      code { font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace; font-size: 12px; }
      @media (max-width: 720px) {
        .shell { padding-inline: 16px; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div>
          <p class="eyebrow">Current API Pricing</p>
          <h1>当前模型价格</h1>
        </div>
        <p class="muted">标准同步 API 参考价格，不是订阅或实际账单。</p>
      </section>
      ${renderCurrentApiPricingTable(catalog, generatedAt)}
    </main>
  </body>
</html>`;
}
