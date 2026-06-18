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
  gitUserAccount: string | null;
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
  gitUserAccount: string | null;
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
  /** 同一时间桶内的 7 天额度使用率均值，来源 rate_limits.seven_day.used_percentage，与 5h 桶独立聚合。 */
  avgSevenDayUsagePct: number | null;
  /**
   * 截至本桶的 7 天额度累计真实使用量（分区叠加 / 分段峰谷和的逐桶快照），单调非递减；该桶无 7d 样本时为 null。
   * 仅供个人看板趋势图叠加“累计曲线”展示，不进任何导出/聚合契约。
   */
  cumulativeSevenDayPct: number | null;
  sampleCount: number;
}

/** dashboard 顶部摘要卡片使用的统计结果。 */
export interface DashboardSummary {
  fiveHourLatestUsagePct: number | null;
  fiveHourPeakUsagePct: number | null;
  sevenDayLatestUsagePct: number | null;
  sevenDayPeakUsagePct: number | null;
  /** 窗口内 7 天额度的分区叠加（分段峰谷和）累计真实使用量，口径与 aggregate 一致；无样本为 null。 */
  sevenDayCumulativeUsagePct: number | null;
  sampleCount: number;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}

/**
 * dashboard 每日用户消息数柱状图的单日数据点。
 *
 * `userMessageCount` 来源与导出契约一致：Claude 本地 transcript 里按自然日统计的真实用户请求数，
 * 不是 statusline 采样数。仅供单文件 dashboard 展示，不进任何导出/聚合契约。
 */
export interface DashboardDailyMessagePoint {
  date: string;
  userMessageCount: number;
}

/** 导出 summary 模式时按天汇总的行结构。 */
export interface ExportSummaryRow {
  date: string;
  sampleCount: number;
  fiveHourPeakUsagePct: number | null;
  minimumUsagePct: number | null;
  fiveHourLatestUsagePct: number | null;
  sevenDayLatestUsagePct: number | null;
  sevenDayPeakUsagePct: number | null;
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
    sevenDayLatestUsagePct: number | null;
    sevenDayPeakUsagePct: number | null;
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
  sevenDayLatestUsagePct: number | null;
  sevenDayPeakUsagePct: number | null;
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
  personKey: string;
  weekKey: string;
  dateKey: string;
  /** 该事件所在自然日的 token 总量，来自同一 bundle 的 dailySummaries（按天总量，非单事件）。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
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
  sevenDayLatestUsagePct: number | null;
  sevenDayPeakUsagePct: number | null;
  /**
   * 当天合并曲线（全样本，不走 winner）的 7 天额度累计真实使用量：相邻样本正增量之和 Σ max(0, uᵢ−uᵢ₋₁)。
   * 区间内第一个有效样本无前值、不贡献增量，所以 daily 逐行相加只是全局总量的近似，weekly 更连续。
   */
  sevenDayCumulativeUsagePct: number | null;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}

/**
 * 定时同步的用户配置（写入 sync-config.json，允许手编）。
 *
 * `targetDir` 为同步目标根目录；`intervalLabel` 控制周期（默认 daily）；
 * `range` 是每次同步导出的范围（默认 this-week）。
 */
export interface SyncConfig {
  targetDir: string | null;
  intervalLabel: string;
  range: string;
  /** 同步到目标目录时追加到文件名（扩展名前）的固定后缀，用于区分多台电脑；null 表示不加。 */
  suffix: string | null;
}

/** 定时同步的运行时状态（写入 sync-state.json）：上次同步时间与结果。 */
export interface SyncState {
  lastSyncedAt: string | null;
  lastResult: "ok" | "error" | null;
  lastError?: string;
  /** 已归档的上一周子目录名（如 `2026_05_25_2026_05_31`），用于周一去重，避免当天每次同步重复归档上一周。 */
  lastArchivedWeek?: string;
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
  sevenDayLatestUsagePct: number | null;
  sevenDayPeakUsagePct: number | null;
  /**
   * 整周合并曲线（全样本，不走 winner）一次性求得的 7 天额度累计真实使用量。
   * 因跨天边界增量在整周连续计算时被计入，故 weekly ≥ Σ 同周 daily。
   */
  sevenDayCumulativeUsagePct: number | null;
  uniqueSessions: number;
  uniqueWorkspaces: number;
}
