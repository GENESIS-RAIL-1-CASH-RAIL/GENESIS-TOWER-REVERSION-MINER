// ─── Reversion Evaluator Service — Post-Fingerprint Profitability Engine ─────
// Takes completed Tower fingerprint patterns and evaluates whether the reversion
// tail is profitable to harvest via flash loan. Uses constant-product AMM math
// for swap simulation and enforces the deterministic 5-gate filter.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ActivePattern,
  QuoteSkewFingerprint,
  ReversionPattern,
  ReversionOpportunity,
  PoolCalibration,
} from "../types";

// ── Deterministic Gate Thresholds ───────────────────────────────────────────
const CONFIDENCE_THRESHOLD = 0.997; // 99.7% historical confidence required
const MIN_SAMPLE_COUNT = 20; // Minimum 20 historical samples
const MAX_NET_EXPOSURE_GBP = 100; // £100 clip ceiling
const FLASH_LOAN_MIN_GBP = 8_000; // £8k minimum flash loan notional
const FLASH_LOAN_MAX_GBP = 25_000; // £25k maximum flash loan notional
const GAS_ESTIMATE_GBP = 2.50; // Conservative gas estimate per execution
const REVERSION_WINDOW_BLOCKS = 2; // Tower reversion tail lasts 1-2 blocks

let opportunityCounter = 0;
let patternCounter = 0;

function generateOpportunityId(): string {
  return `OPP-TRM-${Date.now()}-${String(++opportunityCounter).padStart(5, "0")}`;
}

function generatePatternId(): string {
  return `PAT-TRM-${Date.now()}-${String(++patternCounter).padStart(5, "0")}`;
}

export class ReversionEvaluatorService {
  private calibrations: Map<string, PoolCalibration> = new Map();
  private recentEvaluations: ReversionOpportunity[] = [];
  private totalOpportunities = 0;
  private totalGatePasses = 0;
  private totalGateRejects = 0;

  constructor() {}

  // ── Evaluate a Completed Pattern ───────────────────────────────────────

  evaluate(completedPattern: ActivePattern): ReversionOpportunity | null {
    const fp = completedPattern.fingerprint;
    const poolAddress = this.derivePoolAddress(fp.instrument);
    const calibrationKey = `${poolAddress}:${fp.participantCodename}`;

    // Fetch or create pool calibration
    let calibration = this.calibrations.get(calibrationKey);
    if (!calibration) {
      calibration = this.bootstrapCalibration(poolAddress, fp.participantCodename, fp.instrument);
      this.calibrations.set(calibrationKey, calibration);
    }

    // Calculate expected reversion from skew magnitude + historical mean
    const skewMagnitudeFactor =
      fp.skewDirection === "BID_HEAVY" ? 1.0 : 1.0; // symmetric
    const baseReversion = calibration.meanReversionPct * skewMagnitudeFactor;

    // Adjust for amendment rate intensity (higher rate = stronger pattern = stronger reversion)
    const rateMultiplier = Math.min(fp.amendmentRate / 100, 1.5); // cap at 1.5x
    const adjustedReversion = baseReversion * rateMultiplier;

    // Clamp reversion to observed range (0.4% - 0.9% per spec)
    const reversionPct = Math.max(0.004, Math.min(0.009, adjustedReversion));

    // Build reversion pattern
    const pattern: ReversionPattern = {
      patternId: generatePatternId(),
      fingerprint: fp,
      poolAddress,
      prePatternPrice: this.estimatePrePatternPrice(fp),
      peakSkewPrice: this.estimatePeakSkewPrice(fp),
      expectedReversionPrice: 0, // calculated below
      reversionPct,
      reversionWindowBlocks: REVERSION_WINDOW_BLOCKS,
      historicalConfidence: calibration.sampleCount >= MIN_SAMPLE_COUNT
        ? this.calculateConfidence(calibration)
        : calibration.sampleCount / MIN_SAMPLE_COUNT * 0.95, // scale up as samples grow
      sampleCount: calibration.sampleCount,
    };

    pattern.expectedReversionPrice =
      pattern.peakSkewPrice * (1 - reversionPct * (fp.skewDirection === "BID_HEAVY" ? 1 : -1));

    // Simulate flash loan swap
    const simulation = this.simulateReversionSwap(poolAddress, reversionPct);

    // ── Deterministic 5-Gate Filter ──────────────────────────────────────
    const gate1_completed = completedPattern.completed === true;
    const gate2_confidence = pattern.historicalConfidence >= CONFIDENCE_THRESHOLD;
    const gate3_samples = pattern.sampleCount >= MIN_SAMPLE_COUNT;
    const gate4_profitable = simulation.netProfitGbp > 0;
    const gate5_exposure = simulation.netExposureGbp <= MAX_NET_EXPOSURE_GBP;

    const deterministicGatePass =
      gate1_completed &&
      gate2_confidence &&
      gate3_samples &&
      gate4_profitable &&
      gate5_exposure;

    const opportunity: ReversionOpportunity = {
      opportunityId: generateOpportunityId(),
      pattern,
      flashLoanGbp: simulation.flashLoanGbp,
      expectedProfitGbp: simulation.expectedProfitGbp,
      gasEstimateGbp: simulation.gasEstimateGbp,
      netProfitGbp: simulation.netProfitGbp,
      deterministicGatePass,
      patternCompleted: completedPattern.completed,
      blocksElapsedSincePattern: 0,
      timestamp: Date.now(),
    };

    this.totalOpportunities++;
    if (deterministicGatePass) {
      this.totalGatePasses++;
      console.log(
        `[EVALUATOR] GATE PASS: ${fp.instrument} | reversion=${(reversionPct * 100).toFixed(2)}% | net=£${simulation.netProfitGbp.toFixed(2)} | conf=${(pattern.historicalConfidence * 100).toFixed(1)}%`
      );

      // Add sample to calibration for learning
      calibration.historicalReversions.push(reversionPct);
      calibration.sampleCount++;
      calibration.meanReversionPct = this.calculateMeanReversion(calibration.historicalReversions);
      calibration.lastCalibrated = Date.now();
    } else {
      this.totalGateRejects++;
      const rejections: string[] = [];
      if (!gate1_completed) rejections.push("PATTERN_NOT_COMPLETED");
      if (!gate2_confidence) rejections.push(`CONFIDENCE_LOW(${(pattern.historicalConfidence * 100).toFixed(1)}%<99.7%)`);
      if (!gate3_samples) rejections.push(`SAMPLES_LOW(${pattern.sampleCount}<${MIN_SAMPLE_COUNT})`);
      if (!gate4_profitable) rejections.push(`UNPROFITABLE(net=£${simulation.netProfitGbp.toFixed(2)})`);
      if (!gate5_exposure) rejections.push(`EXPOSURE_BREACH(£${simulation.netExposureGbp.toFixed(2)}>£${MAX_NET_EXPOSURE_GBP})`);
      console.log(
        `[EVALUATOR] GATE REJECT: ${fp.instrument} | ${rejections.join(", ")}`
      );
    }

    // Store in recent evaluations (cap at 500)
    this.recentEvaluations.push(opportunity);
    if (this.recentEvaluations.length > 500) {
      this.recentEvaluations.splice(0, this.recentEvaluations.length - 500);
    }

    return opportunity;
  }

  // ── Constant Product AMM Swap Simulation ───────────────────────────────
  // Models: x * y = k (Uniswap V2 style)
  // Flash loan the pool, capture reversion delta, repay + profit.

  simulateReversionSwap(
    _poolAddress: string,
    expectedReversionPct: number
  ): {
    flashLoanGbp: number;
    expectedProfitGbp: number;
    gasEstimateGbp: number;
    netProfitGbp: number;
    netExposureGbp: number;
  } {
    // Size flash loan proportional to expected reversion magnitude
    // Higher reversion = can use smaller loan for same profit
    const reversionBps = expectedReversionPct * 10_000;

    // Scale loan: base £8k, scale up proportional to reversion strength
    const loanScale = Math.min(
      FLASH_LOAN_MAX_GBP,
      Math.max(FLASH_LOAN_MIN_GBP, FLASH_LOAN_MIN_GBP + (reversionBps - 40) * 200)
    );
    const flashLoanGbp = Math.round(loanScale * 100) / 100;

    // Constant product math:
    // dx = flashLoanGbp
    // dy = (y * dx) / (x + dx) — tokens received
    // After reversion, price moves by expectedReversionPct
    // Profit = dx * expectedReversionPct * (1 - slippage - fees)

    const slippage = 0.001; // 0.1% slippage
    const poolFee = 0.003; // 0.3% Uniswap-style fee
    const flashLoanFee = 0.0009; // 0.09% Aave-style flash loan fee

    const grossProfitPct = expectedReversionPct - slippage - poolFee - flashLoanFee;
    const expectedProfitGbp =
      Math.max(0, flashLoanGbp * grossProfitPct);

    const gasEstimateGbp = GAS_ESTIMATE_GBP;
    const netProfitGbp = expectedProfitGbp - gasEstimateGbp;

    // Net exposure = maximum loss if reversion doesn't happen
    // Flash loan is atomic — if reversion fails, tx reverts, exposure = gas only
    const netExposureGbp = gasEstimateGbp;

    return {
      flashLoanGbp,
      expectedProfitGbp: Math.round(expectedProfitGbp * 100) / 100,
      gasEstimateGbp,
      netProfitGbp: Math.round(netProfitGbp * 100) / 100,
      netExposureGbp,
    };
  }

  // ── Calibrate Pool (build/update historical reversion data) ────────────

  calibratePool(poolAddress: string, participantCodename: string, instrument: string): PoolCalibration {
    const key = `${poolAddress}:${participantCodename}`;
    let calibration = this.calibrations.get(key);
    if (!calibration) {
      calibration = this.bootstrapCalibration(poolAddress, participantCodename, instrument);
      this.calibrations.set(key, calibration);
    }
    return calibration;
  }

  // ── Bootstrap Calibration with Synthetic Historical Data ───────────────
  // In production, this would load from the Sovereign Ledger.
  // For now, we bootstrap with synthetic data based on the academic literature.

  private bootstrapCalibration(
    poolAddress: string,
    participantCodename: string,
    instrument: string
  ): PoolCalibration {
    // van Kervel et al. (2017): Tower-style HFTs trigger 0.4-0.9% mean reversion
    // Bootstrap with 25 synthetic samples centered on 0.65% reversion
    const syntheticReversions: number[] = [];
    for (let i = 0; i < 25; i++) {
      // Generate samples in the 0.004-0.009 range (0.4%-0.9%)
      const base = 0.0065;
      const noise = (Math.random() - 0.5) * 0.004; // +/- 0.2%
      syntheticReversions.push(Math.max(0.004, Math.min(0.009, base + noise)));
    }

    return {
      poolAddress,
      participantCodename,
      instrument,
      historicalReversions: syntheticReversions,
      meanReversionPct: this.calculateMeanReversion(syntheticReversions),
      sampleCount: syntheticReversions.length,
      lastCalibrated: Date.now(),
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private calculateMeanReversion(reversions: number[]): number {
    if (reversions.length === 0) return 0.0065;
    return reversions.reduce((sum, r) => sum + r, 0) / reversions.length;
  }

  private calculateConfidence(calibration: PoolCalibration): number {
    // Confidence = proportion of historical samples where reversion > 0
    if (calibration.sampleCount === 0) return 0;
    const positiveReversions = calibration.historicalReversions.filter((r) => r > 0.002).length;
    return positiveReversions / calibration.sampleCount;
  }

  private derivePoolAddress(instrument: string): string {
    // Deterministic pool address derivation from instrument name
    // In production, this maps to actual DEX pool addresses
    const hash = Array.from(instrument).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return `0x${hash.toString(16).padStart(8, "0")}pool${instrument.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
  }

  private estimatePrePatternPrice(fp: QuoteSkewFingerprint): number {
    // Synthetic pre-pattern price (in production, pulled from price feed)
    const basePrice = 1000 + (fp.instrument.length * 137) % 5000;
    return basePrice;
  }

  private estimatePeakSkewPrice(fp: QuoteSkewFingerprint): number {
    const prePrice = this.estimatePrePatternPrice(fp);
    // Skew moves price by ~0.1-0.5% from pre-pattern
    const skewImpact = fp.skewDirection === "BID_HEAVY" ? 0.003 : -0.003;
    return prePrice * (1 + skewImpact);
  }

  // ── Queries ────────────────────────────────────────────────────────────

  getPassRate(): number {
    if (this.totalOpportunities === 0) return 0;
    return this.totalGatePasses / this.totalOpportunities;
  }

  getRecentEvaluations(limit = 50): ReversionOpportunity[] {
    return this.recentEvaluations.slice(-limit);
  }

  getEvaluationById(opportunityId: string): ReversionOpportunity | undefined {
    return this.recentEvaluations.find((e) => e.opportunityId === opportunityId);
  }

  getCalibrations(): PoolCalibration[] {
    return Array.from(this.calibrations.values());
  }

  getStats(): {
    totalOpportunities: number;
    totalGatePasses: number;
    totalGateRejects: number;
    passRate: number;
    calibratedPools: number;
    recentEvaluationsCount: number;
  } {
    return {
      totalOpportunities: this.totalOpportunities,
      totalGatePasses: this.totalGatePasses,
      totalGateRejects: this.totalGateRejects,
      passRate: this.getPassRate(),
      calibratedPools: this.calibrations.size,
      recentEvaluationsCount: this.recentEvaluations.length,
    };
  }

  reset(): void {
    this.calibrations.clear();
    this.recentEvaluations = [];
    this.totalOpportunities = 0;
    this.totalGatePasses = 0;
    this.totalGateRejects = 0;
    console.log("[EVALUATOR] Reset complete");
  }
}
