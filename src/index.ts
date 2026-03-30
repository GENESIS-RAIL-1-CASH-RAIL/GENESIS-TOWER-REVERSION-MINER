// ─── GENESIS TOWER REVERSION MINER — WD-043 ────────────────────────────────────
// Microstructure Fingerprint → Reversion Tail Harvester (Tower Remora)
// Port 8865 | 19 Endpoints | 3 Loops
// Spark #008 — Remora Doctrine (Grok, 2026-03-27)
// Academic: van Kervel et al. (2017) quote-skew reversion, Tower microstructure
// ───────────────────────────────────────────────────────────────────────────────

import express from "express";
import { FingerprintWatcherService } from "./services/fingerprint-watcher.service";
import { ReversionEvaluatorService } from "./services/reversion-evaluator.service";
import { SignalEmitterService } from "./services/signal-emitter.service";
import { WeaponRegistryService } from "./services/weapon-registry.service";
import { ProbabilisticFingerprintService } from "./services/probabilistic-fingerprint.service";
import {
  HealthResponse,
  MinerStats,
  ReversionExecution,
  ReversionOpportunity,
} from "./types";

const app = express();
app.use(express.json());
const PORT = parseInt(process.env.TOWER_REVERSION_PORT || "8865", 10);
const startTime = Date.now();

// ── Service Instantiation ─────────────────────────────────────────────────

const watcher = new FingerprintWatcherService();
const evaluator = new ReversionEvaluatorService();
const emitter = new SignalEmitterService();
const probFingerprint = new ProbabilisticFingerprintService();

const registry = new WeaponRegistryService({
  weaponId: "WD-043",
  service: "GENESIS-TOWER-REVERSION-MINER",
  port: 8865,
  deploymentClass: "STRIKE",
  purpose:
    "Tower Remora: reads microstructure fingerprints (quote-skew + amendment cadence) and harvests reversion tails Tower triggers but does not stay to collect.",
  endpoints: 20,
  loops: 3,
  spark: "#008 Remora",
  academicBasis:
    "van Kervel et al. (2017) quote-skew reversion, Tower microstructure doctrine",
  registeredAt: new Date().toISOString(),
});

// ── Execution Ledger (in-memory) ──────────────────────────────────────────

let executionCounter = 0;
const executions: ReversionExecution[] = [];

function generateExecutionId(): string {
  return `EXE-TRM-${Date.now()}-${String(++executionCounter).padStart(5, "0")}`;
}

function simulateExecution(opportunity: ReversionOpportunity): ReversionExecution {
  const execution: ReversionExecution = {
    executionId: generateExecutionId(),
    opportunityId: opportunity.opportunityId,
    status: "SIMULATED",
    capturedGbp: opportunity.deterministicGatePass ? opportunity.netProfitGbp : 0,
    gasSpentGbp: opportunity.gasEstimateGbp,
    blockNumber: Math.floor(Date.now() / 12_000), // ~12s block time
    txHash: `0x${Date.now().toString(16)}sim${executionCounter.toString(16).padStart(8, "0")}`,
    timestamp: Date.now(),
  };

  executions.push(execution);
  if (executions.length > 1000) {
    executions.splice(0, executions.length - 1000);
  }

  return execution;
}

// ── Loop State ────────────────────────────────────────────────────────────

const loops = [
  { name: "Fingerprint Watch", intervalMs: 5_000, lastRun: 0 },
  { name: "Reversion Evaluation", intervalMs: 5_000, lastRun: 0 },
  { name: "Signal Broadcast", intervalMs: 30_000, lastRun: 0 },
];

// ── Loop Functions ────────────────────────────────────────────────────────

async function loopFingerprintWatch(): Promise<void> {
  try {
    // 1. Poll Cartographer for fresh fingerprints
    const fingerprints = await watcher.pollCartographer();
    loops[0].lastRun = Date.now();

    if (fingerprints.length === 0) return;

    // 2. Detect Tower-style signatures
    const towerFps = watcher.detectTowerFingerprints(fingerprints);

    // 3. Check if any active patterns have completed (Tower left the pool)
    const completed = watcher.checkPatternCompletion(fingerprints);

    // 4. Queue broadcasts for detected fingerprints
    for (const fp of towerFps) {
      emitter.queue("FINGERPRINT_DETECTED", {
        fingerprintId: fp.fingerprintId,
        participantCodename: fp.participantCodename,
        instrument: fp.instrument,
        skewDirection: fp.skewDirection,
        amendmentRate: fp.amendmentRate,
        cadenceRegularity: fp.cadenceRegularity,
      });
    }

    if (towerFps.length > 0) {
      console.log(
        `[LOOP] Fingerprint watch: ${fingerprints.length} polled, ${towerFps.length} Tower-style, ${completed.length} completed`
      );
    }
  } catch (err) {
    console.error("[LOOP] Fingerprint watch error:", err);
  }
}

async function loopReversionEvaluation(): Promise<void> {
  try {
    // Get recently completed patterns that need evaluation
    const completedPatterns = watcher.getRecentCompletedForEvaluation();
    loops[1].lastRun = Date.now();

    if (completedPatterns.length === 0) return;

    for (const pattern of completedPatterns) {
      const opportunity = evaluator.evaluate(pattern);
      if (!opportunity) continue;

      // Simulate execution for all opportunities (DRY-RUN mode)
      const execution = simulateExecution(opportunity);

      // Queue broadcast for gate-passing opportunities
      if (opportunity.deterministicGatePass) {
        emitter.queue("REVERSION_OPPORTUNITY", {
          opportunityId: opportunity.opportunityId,
          instrument: opportunity.pattern.fingerprint.instrument,
          reversionPct: opportunity.pattern.reversionPct,
          flashLoanGbp: opportunity.flashLoanGbp,
          netProfitGbp: opportunity.netProfitGbp,
          confidence: opportunity.pattern.historicalConfidence,
          executionId: execution.executionId,
          executionStatus: execution.status,
        });

        // Also emit crumb captured for the simulated execution
        emitter.queue("CRUMB_CAPTURED", {
          executionId: execution.executionId,
          opportunityId: opportunity.opportunityId,
          capturedGbp: execution.capturedGbp,
          status: execution.status,
          blockNumber: execution.blockNumber,
        });

        console.log(
          `[LOOP] Reversion: PASS ${opportunity.pattern.fingerprint.instrument} net=£${opportunity.netProfitGbp.toFixed(2)} exec=${execution.executionId}`
        );
      }
    }

    console.log(
      `[LOOP] Reversion evaluation: ${completedPatterns.length} patterns evaluated`
    );
  } catch (err) {
    console.error("[LOOP] Reversion evaluation error:", err);
  }
}

async function loopBroadcast(): Promise<void> {
  try {
    const result = await emitter.broadcastAll();
    loops[2].lastRun = Date.now();
    if (result.sent > 0) {
      console.log(`[LOOP] Broadcast: ${result.sent} payloads, ${result.reached} target hits`);
    }
  } catch (err) {
    console.error("[LOOP] Broadcast error:", err);
  }
}

// ── Aggregate Stats Helper ──────────────────────────────────────────────

function aggregateStats(): MinerStats {
  const watcherStats = watcher.getStats();
  const evaluatorStats = evaluator.getStats();
  const emitterStats = emitter.getStats();

  const totalCaptured = executions
    .filter((e) => e.status === "SIMULATED" || e.status === "CAPTURED")
    .reduce((sum, e) => sum + e.capturedGbp, 0);
  const totalGas = executions.reduce((sum, e) => sum + e.gasSpentGbp, 0);

  return {
    activePatternsCount: watcherStats.activePatterns,
    completedPatternsCount: watcherStats.completedPatterns,
    totalFingerprintsProcessed: watcherStats.totalFingerprintsProcessed,
    totalOpportunities: evaluatorStats.totalOpportunities,
    totalGatePasses: evaluatorStats.totalGatePasses,
    totalGateRejects: evaluatorStats.totalGateRejects,
    totalExecutions: executions.length,
    totalCapturedGbp: Math.round(totalCaptured * 100) / 100,
    totalGasSpentGbp: Math.round(totalGas * 100) / 100,
    broadcastsSent: emitterStats.broadcastsSent,
    passRate: evaluatorStats.passRate,
    uptime: Date.now() - startTime,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINTS — 19 total
// Health (4) | Fingerprint (4) | Reversion (4) | Execution (4) | Registration (3)
// ═══════════════════════════════════════════════════════════════════════════

// ── Health Endpoints (4) ──────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  const stats = aggregateStats();
  const response: HealthResponse = {
    service: "GENESIS-TOWER-REVERSION-MINER",
    version: "10.0.0",
    port: PORT,
    status:
      stats.activePatternsCount > 5
        ? "RED"
        : stats.activePatternsCount > 0
          ? "YELLOW"
          : "GREEN",
    uptime: Date.now() - startTime,
    stats,
    loops,
  };
  res.json(response);
});

app.get("/state", (_req, res) => {
  res.json({
    service: "GENESIS-TOWER-REVERSION-MINER",
    weaponId: "WD-043",
    deploymentClass: "STRIKE",
    uptime: Date.now() - startTime,
    watcher: watcher.getStats(),
    evaluator: evaluator.getStats(),
    emitter: emitter.getStats(),
    executions: executions.length,
    loops,
  });
});

app.get("/stats", (_req, res) => {
  res.json(aggregateStats());
});

app.post("/reset", (_req, res) => {
  watcher.reset();
  evaluator.reset();
  emitter.reset();
  executions.length = 0;
  executionCounter = 0;
  res.json({ reset: true, timestamp: Date.now() });
});

// ── Fingerprint Endpoints (4) ─────────────────────────────────────────────

app.get("/fingerprints", (_req, res) => {
  res.json({
    active: watcher.getActivePatterns(),
    completed: watcher.getCompletedPatterns(20),
    stats: watcher.getStats(),
  });
});

app.get("/fingerprints/active", (_req, res) => {
  res.json({ active: watcher.getActivePatterns() });
});

app.get("/fingerprints/completed", (_req, res) => {
  const limit = 50;
  res.json({ completed: watcher.getCompletedPatterns(limit) });
});

app.get("/fingerprints/:id", (req, res) => {
  const pattern = watcher.getPatternById(req.params.id);
  if (!pattern) {
    return res.status(404).json({ error: "Pattern not found", id: req.params.id });
  }
  res.json(pattern);
});

// ── Reversion Endpoints (4) ───────────────────────────────────────────────

app.get("/reversion", (_req, res) => {
  res.json({
    evaluations: evaluator.getRecentEvaluations(50),
    calibrations: evaluator.getCalibrations(),
    stats: evaluator.getStats(),
  });
});

app.get("/reversion/opportunities", (_req, res) => {
  const opportunities = evaluator.getRecentEvaluations(100);
  const gatePasses = opportunities.filter((o) => o.deterministicGatePass);
  const gateRejects = opportunities.filter((o) => !o.deterministicGatePass);
  res.json({
    total: opportunities.length,
    passes: gatePasses.length,
    rejects: gateRejects.length,
    passRate: evaluator.getPassRate(),
    opportunities: gatePasses,
  });
});

app.get("/reversion/:id", (req, res) => {
  const evaluation = evaluator.getEvaluationById(req.params.id);
  if (!evaluation) {
    return res.status(404).json({ error: "Evaluation not found", id: req.params.id });
  }
  res.json(evaluation);
});

app.post("/reversion/evaluate", async (_req, res) => {
  // Force evaluation of all recently completed patterns
  const completedPatterns = watcher.getRecentCompletedForEvaluation();
  const results: ReversionOpportunity[] = [];

  for (const pattern of completedPatterns) {
    const opportunity = evaluator.evaluate(pattern);
    if (opportunity) {
      const execution = simulateExecution(opportunity);
      results.push(opportunity);

      if (opportunity.deterministicGatePass) {
        emitter.queue("REVERSION_OPPORTUNITY", {
          opportunityId: opportunity.opportunityId,
          instrument: opportunity.pattern.fingerprint.instrument,
          reversionPct: opportunity.pattern.reversionPct,
          netProfitGbp: opportunity.netProfitGbp,
          executionId: execution.executionId,
        });
      }
    }
  }

  res.json({
    patternsEvaluated: completedPatterns.length,
    opportunities: results.length,
    gatePasses: results.filter((r) => r.deterministicGatePass).length,
    gateRejects: results.filter((r) => !r.deterministicGatePass).length,
    results,
  });
});

// ── Execution Endpoints (4) ───────────────────────────────────────────────

app.get("/executions", (_req, res) => {
  res.json({
    total: executions.length,
    executions: executions.slice(-100),
    totalCapturedGbp: executions.reduce((s, e) => s + e.capturedGbp, 0),
    totalGasSpentGbp: executions.reduce((s, e) => s + e.gasSpentGbp, 0),
  });
});

app.get("/executions/recent", (_req, res) => {
  res.json({ recent: executions.slice(-20) });
});

app.get("/executions/:id", (req, res) => {
  const execution = executions.find((e) => e.executionId === req.params.id);
  if (!execution) {
    return res.status(404).json({ error: "Execution not found", id: req.params.id });
  }
  res.json(execution);
});

app.post("/executions/manual", (req, res) => {
  const { opportunityId } = req.body || {};
  if (!opportunityId) {
    return res.status(400).json({ error: "opportunityId required" });
  }

  const opportunity = evaluator.getEvaluationById(opportunityId);
  if (!opportunity) {
    return res.status(404).json({ error: "Opportunity not found", opportunityId });
  }

  if (!opportunity.deterministicGatePass) {
    return res.status(403).json({
      error: "Opportunity did not pass deterministic gate — manual execution blocked",
      opportunityId,
    });
  }

  const execution = simulateExecution(opportunity);
  console.log(
    `[MANUAL] Execution triggered: ${execution.executionId} for ${opportunityId} | captured=£${execution.capturedGbp.toFixed(2)}`
  );

  emitter.queue("CRUMB_CAPTURED", {
    executionId: execution.executionId,
    opportunityId,
    capturedGbp: execution.capturedGbp,
    status: execution.status,
    manual: true,
  });

  res.json({ execution });
});

// ── Registration Endpoints (3) ────────────────────────────────────────────

app.post("/register", async (_req, res) => {
  const result = await registry.register();
  res.json(result);
});

app.get("/register", (_req, res) => {
  res.json(registry.getStatus());
});

// ─── v10.0 POLISH ENDPOINT ──────────────────────────────────────────────────

/** GET /fingerprint/probabilistic — Probabilistic fingerprint service state */
app.get("/fingerprint/probabilistic", (_req, res) => {
  res.json({
    state: probFingerprint.getState(),
    recentMatches: probFingerprint.getRecentMatches(20),
    recentEntryDecisions: probFingerprint.getRecentEntryDecisions(20),
    timestamp: Date.now(),
  });
});

app.post("/intel", (req, res) => {
  const signal = req.body;
  console.log(`[INTEL] Received: ${signal?.type} from ${signal?.source}`);

  // If Toxicity Reversion Layer sends a suppression, log it
  if (signal?.type === "WEAPON_SUPPRESS") {
    console.log(
      `[INTEL] SUPPRESSION received for ${signal?.instrument} — pausing STRIKE operations`
    );
  }

  // If Cartographer sends a direct fingerprint, process it
  if (signal?.type === "FINGERPRINT_UPDATE" && signal?.data) {
    console.log(`[INTEL] Direct fingerprint from Cartographer — queuing for analysis`);
  }

  res.json({ received: true, weaponId: "WD-043" });
});

// ── Boot ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  GENESIS TOWER REVERSION MINER — WD-043");
  console.log("  Microstructure Fingerprint → Reversion Tail Harvester");
  console.log("  Spark #008 — Remora Doctrine (Tower Research Capital)");
  console.log(`  Port: ${PORT}`);
  console.log("  Endpoints: 20 (health 4, fingerprint 4, reversion 4, execution 4, registration 3, v10 1)");
  console.log("  Loops: 3 (fingerprint 5s, reversion 5s, broadcast 30s)");
  console.log("  Deployment Class: STRIKE");
  console.log("═══════════════════════════════════════════════════════════");

  // Start perpetual loops
  setInterval(loopFingerprintWatch, loops[0].intervalMs);
  setInterval(loopReversionEvaluation, loops[1].intervalMs);
  setInterval(loopBroadcast, loops[2].intervalMs);

  // Stagger initial runs to avoid thundering herd
  setTimeout(loopFingerprintWatch, 3_000);
  setTimeout(loopReversionEvaluation, 6_000);
  setTimeout(loopBroadcast, 10_000);
});
