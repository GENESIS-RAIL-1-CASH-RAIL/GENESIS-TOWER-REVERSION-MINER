// ─── GENESIS TOWER REVERSION MINER — WD-043 Types ──────────────────────────
// Microstructure Fingerprint → Reversion Tail Harvester (Tower Remora)
// Spark #008 — Remora Doctrine (Grok, 2026-03-27)
// Academic: van Kervel et al. (2017) quote-skew reversion, Tower microstructure
// ─────────────────────────────────────────────────────────────────────────────

// ── Quote-Skew Fingerprint (consumed from Behavioural Cartographer WD-037) ──

export type SkewDirection = "BID_HEAVY" | "ASK_HEAVY";

export interface QuoteSkewFingerprint {
  fingerprintId: string;
  participantCodename: string; // NATO phonetic from Cartographer
  instrument: string;
  skewDirection: SkewDirection;
  amendmentRate: number; // amendments per second
  cadenceRegularity: number; // 0-1 (1 = perfectly regular)
  skewPersistenceMs: number; // how long skew has persisted
  observedAt: number;
}

// ── Reversion Pattern ──────────────────────────────────────────────────────

export interface ReversionPattern {
  patternId: string;
  fingerprint: QuoteSkewFingerprint;
  poolAddress: string;
  prePatternPrice: number;
  peakSkewPrice: number;
  expectedReversionPrice: number;
  reversionPct: number;
  reversionWindowBlocks: number;
  historicalConfidence: number; // 0-1
  sampleCount: number;
}

// ── Reversion Opportunity ──────────────────────────────────────────────────

export interface ReversionOpportunity {
  opportunityId: string;
  pattern: ReversionPattern;
  flashLoanGbp: number;
  expectedProfitGbp: number;
  gasEstimateGbp: number;
  netProfitGbp: number;
  deterministicGatePass: boolean;
  patternCompleted: boolean;
  blocksElapsedSincePattern: number;
  timestamp: number;
}

// ── Reversion Execution ────────────────────────────────────────────────────

export type ExecutionStatus = "SIMULATED" | "FIRED" | "REVERTED" | "CAPTURED";

export interface ReversionExecution {
  executionId: string;
  opportunityId: string;
  status: ExecutionStatus;
  capturedGbp: number;
  gasSpentGbp: number;
  blockNumber: number;
  txHash: string;
  timestamp: number;
}

// ── Broadcast Payloads ─────────────────────────────────────────────────────

export type BroadcastType =
  | "FINGERPRINT_DETECTED"
  | "REVERSION_OPPORTUNITY"
  | "CRUMB_CAPTURED";

export interface BroadcastPayload {
  source: "TOWER_REVERSION_MINER";
  type: BroadcastType;
  data: Record<string, unknown>;
  timestamp: number;
}

// ── Active Pattern Tracking ────────────────────────────────────────────────

export interface ActivePattern {
  fingerprint: QuoteSkewFingerprint;
  firstSeen: number;
  lastSeen: number;
  peakAmendmentRate: number;
  completed: boolean;
  completedAt: number | null;
}

// ── Pool Calibration ───────────────────────────────────────────────────────

export interface PoolCalibration {
  poolAddress: string;
  participantCodename: string;
  instrument: string;
  historicalReversions: number[];
  meanReversionPct: number;
  sampleCount: number;
  lastCalibrated: number;
}

// ── Stats ──────────────────────────────────────────────────────────────────

export interface MinerStats {
  activePatternsCount: number;
  completedPatternsCount: number;
  totalFingerprintsProcessed: number;
  totalOpportunities: number;
  totalGatePasses: number;
  totalGateRejects: number;
  totalExecutions: number;
  totalCapturedGbp: number;
  totalGasSpentGbp: number;
  broadcastsSent: number;
  passRate: number;
  uptime: number;
}

// ── Health Response ────────────────────────────────────────────────────────

export interface HealthResponse {
  service: string;
  version: string;
  port: number;
  status: "GREEN" | "YELLOW" | "RED";
  uptime: number;
  stats: MinerStats;
  loops: { name: string; intervalMs: number; lastRun: number }[];
}
