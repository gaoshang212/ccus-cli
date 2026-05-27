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
  /** Claude 的 7 天额度使用百分比。 */
  sevenDayUsagePct: number | null;
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
  fiveHourLatestUsagePct: number | null;
  fiveHourPeakUsagePct: number | null;
  sevenDayUsagePct: number | null;
  sampleCount: number;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}

/** 导出 summary 模式时按天汇总的行结构。 */
export interface ExportSummaryRow {
  date: string;
  sampleCount: number;
  fiveHourPeakUsagePct: number | null;
  minimumUsagePct: number | null;
  fiveHourLatestUsagePct: number | null;
  sevenDayUsagePct: number | null;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}

/** 默认导出使用的本周汇总结构。 */
export interface WeeklyExportSummary {
  schemaVersion: number;
  generatedAt: string;
  range: {
    label: string;
    start: string;
    end: string;
  };
  identity: {
    gitUserName: string | null;
    gitUserEmail: string | null;
  };
  counts: {
    userMessageCount: number;
    apiRequestCount: number;
  };
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
  };
  statusline: {
    sampleCount: number;
    uniqueSessions: number;
    uniqueWorkspaces: number;
    fiveHourLatestUsagePct: number | null;
    fiveHourPeakUsagePct: number | null;
    sevenDayUsagePct: number | null;
  };
  sources: {
    ccusDataDir: string;
    claudeDataDir: string;
    projectFilesMatched: number;
    messageCountSource: string;
    apiRequestCountSource: string;
    tokenSource: string;
  };
}

/** 本周导出中每一天的 usage / token / 计数汇总。 */
export interface WeeklyExportDaySummary {
  date: string;
  userMessageCount: number;
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  sampleCount: number;
  fiveHourLatestUsagePct: number | null;
  fiveHourPeakUsagePct: number | null;
  sevenDayUsagePct: number | null;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}

/** 默认导出文件结构：保留原始事件，同时附带按天周汇总。 */
export interface WeeklyExportBundle {
  schemaVersion: number;
  generatedAt: string;
  range: {
    label: string;
    start: string;
    end: string;
  };
  identity: {
    gitUserName: string | null;
    gitUserEmail: string | null;
  };
  rawEvents: PersistedStatuslineEvent[];
  weeklySummary: WeeklyExportSummary;
  dailySummaries: WeeklyExportDaySummary[];
}

/** 多人明细 / 按天 / 按周聚合时统一使用的行结构。 */
export interface AggregatedEventRow extends StatuslineEvent {
  sourceFile: string;
  personKey: string;
  weekKey: string;
  dateKey: string;
}

/** 多人按天汇总行。 */
export interface AggregatedDailyRow {
  personKey: string;
  date: string;
  userMessageCount: number;
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  sampleCount: number;
  fiveHourPeakUsagePct: number | null;
  fiveHourLatestUsagePct: number | null;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}

/** 多人按周汇总行。 */
export interface AggregatedWeeklyRow {
  personKey: string;
  week: string;
  userMessageCount: number;
  apiRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  sampleCount: number;
  fiveHourPeakUsagePct: number | null;
  fiveHourLatestUsagePct: number | null;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}
