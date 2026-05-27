/**
 * Claude Code statusline 通过 stdin 传入的原始 JSON。
 *
 * 这里用宽松结构承接，后续再在解析层做字段提取和归一化。
 */
export interface RawStatuslinePayload {
  session_id?: unknown;
  model?: unknown;
  workspace?: unknown;
  context_window?: unknown;
  rate_limits?: unknown;
  cwd?: unknown;
  [key: string]: unknown;
}

/**
 * 持久化到日志中的事件模型。
 *
 * 这里尽量只保留原始 payload 与外部补充数据，分析字段在读取时按需计算。
 */
export interface PersistedStatuslineEvent {
  schemaVersion?: number;
  timestamp: string;
  gitUserName: string | null;
  gitUserEmail: string | null;
  rawPayload: RawStatuslinePayload;
}

/**
 * 读取/导出/dashboard 使用的计算视图。
 *
 * 这份结构不要求完整持久化，可由 `rawPayload` 在读时重新推导。
 */
export interface StatuslineEvent {
  timestamp: string;
  sessionId: string | null;
  workspaceDir: string | null;
  workspaceName: string | null;
  modelName: string | null;
  gitUserName: string | null;
  gitUserEmail: string | null;
  /** Claude 的 5 小时额度使用百分比。 */
  usagePct: number | null;
  contextWindowPct: number | null;
  contextUsed: number | null;
  contextMax: number | null;
  statusLine: string;
  rawPayload: RawStatuslinePayload;
}

/** 命令行解析后的时间窗口。 */
export interface RangeWindow {
  label: string;
  start: Date;
  end: Date;
}

/** dashboard 折线图使用的聚合桶结构。 */
export interface DashboardBucket {
  bucketStart: string;
  avgUsagePct: number | null;
  maxUsagePct: number | null;
  minUsagePct: number | null;
  sampleCount: number;
}

/** dashboard 顶部摘要卡片使用的统计结果。 */
export interface DashboardSummary {
  latestUsagePct: number | null;
  averageUsagePct: number | null;
  peakUsagePct: number | null;
  sampleCount: number;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}

/** 导出 summary 模式时按天汇总的行结构。 */
export interface ExportSummaryRow {
  date: string;
  sampleCount: number;
  averageUsagePct: number | null;
  peakUsagePct: number | null;
  minimumUsagePct: number | null;
  latestUsagePct: number | null;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}
