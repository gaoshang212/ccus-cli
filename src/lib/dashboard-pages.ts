import { API_PRICING_PAGE_PATH, buildApiPricingPage } from "./api-pricing-table";

/** 两类 dashboard serve 共用的页面路由；null 表示 404。 */
export async function renderDashboardPage(
  pathname: string,
  renderDashboard: () => Promise<string>,
  generatedAt: Date = new Date(),
): Promise<string | null> {
  if (pathname === "/") {
    return renderDashboard();
  }
  if (pathname === API_PRICING_PAGE_PATH) {
    return buildApiPricingPage(generatedAt);
  }
  return null;
}
