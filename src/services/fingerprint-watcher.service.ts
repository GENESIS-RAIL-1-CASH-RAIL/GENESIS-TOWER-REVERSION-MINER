// ─── Fingerprint Watcher Service — Tower Microstructure Pattern Detection ────
// Polls GENESIS-BEHAVIOURAL-CARTOGRAPHER (WD-037, port 8859) for fingerprints,
// identifies Tower Research Capital-style quote-skew + amendment-cadence signatures,
// tracks active patterns, and flags completed patterns for reversion evaluation.
// ─────────────────────────────────────────────────────────────────────────────

import { QuoteSkewFingerprint, ActivePattern } from "../types";

const CARTOGRAPHER_URL =
  process.env.CARTOGRAPHER_URL || "http://genesis-behavioural-cartographer:8859";

// ── Tower Fingerprint Thresholds ────────────────────────────────────────────
const AMENDMENT_RATE_THRESHOLD = 50; // >50 amendments/sec = algorithmic
const CADENCE_REGULARITY_THRESHOLD = 0.7; // >0.7 = machine-regular
const SKEW_PERSISTENCE_THRESHOLD_MS = 500; // >500ms sustained skew
const COMPLETION_AMENDMENT_DROP = 15; // amendment rate drop-off = pattern exit

export class FingerprintWatcherService {
  private activePatterns: Map<string, ActivePattern> = new Map();
  private completedPatterns: ActivePattern[] = [];
  private fingerprintHistory: Map<string, QuoteSkewFingerprint[]> = new Map();
  private totalFingerprintsProcessed = 0;
  private lastPollTimestamp = 0;

  constructor() {}

  // ── Poll Cartographer for Latest Fingerprints ──────────────────────────

  async pollCartographer(): Promise<QuoteSkewFingerprint[]> {
    const fingerprints: QuoteSkewFingerprint[] = [];

    try {
      // Poll primary fingerprint endpoint
      const fpRes = await fetch(`${CARTOGRAPHER_URL}/fingerprints`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (fpRes.ok) {
        const data = (await fpRes.json()) as { fingerprints?: QuoteSkewFingerprint[] };
        if (data.fingerprints && Array.isArray(data.fingerprints)) {
          fingerprints.push(...data.fingerprints);
        }
      }
    } catch {
      /* Cartographer may be offline — non-fatal */
    }

    try {
      // Poll recent intel for supplementary data
      const intelRes = await fetch(`${CARTOGRAPHER_URL}/intel/recent`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (intelRes.ok) {
        const data = (await intelRes.json()) as { intel?: QuoteSkewFingerprint[] };
        if (data.intel && Array.isArray(data.intel)) {
          // Deduplicate by fingerprintId
          const existingIds = new Set(fingerprints.map((f) => f.fingerprintId));
          for (const fp of data.intel) {
            if (fp.fingerprintId && !existingIds.has(fp.fingerprintId)) {
              fingerprints.push(fp);
            }
          }
        }
      }
    } catch {
      /* fire-and-forget */
    }

    this.lastPollTimestamp = Date.now();
    this.totalFingerprintsProcessed += fingerprints.length;

    // Store in per-participant history
    for (const fp of fingerprints) {
      const key = fp.participantCodename;
      if (!this.fingerprintHistory.has(key)) {
        this.fingerprintHistory.set(key, []);
      }
      const history = this.fingerprintHistory.get(key)!;
      history.push(fp);
      // Cap history per participant at 500
      if (history.length > 500) {
        history.splice(0, history.length - 500);
      }
    }

    return fingerprints;
  }

  // ── Detect Tower-Style Fingerprints ────────────────────────────────────

  detectTowerFingerprints(fingerprints: QuoteSkewFingerprint[]): QuoteSkewFingerprint[] {
    const towerStyle: QuoteSkewFingerprint[] = [];

    for (const fp of fingerprints) {
      const isTower =
        fp.amendmentRate > AMENDMENT_RATE_THRESHOLD &&
        fp.cadenceRegularity > CADENCE_REGULARITY_THRESHOLD &&
        fp.skewPersistenceMs > SKEW_PERSISTENCE_THRESHOLD_MS;

      if (isTower) {
        towerStyle.push(fp);

        // Track as active pattern
        const patternKey = `${fp.participantCodename}:${fp.instrument}`;
        const existing = this.activePatterns.get(patternKey);

        if (existing && !existing.completed) {
          // Update existing active pattern
          existing.lastSeen = fp.observedAt;
          existing.fingerprint = fp;
          existing.peakAmendmentRate = Math.max(
            existing.peakAmendmentRate,
            fp.amendmentRate
          );
        } else {
          // New active pattern
          this.activePatterns.set(patternKey, {
            fingerprint: fp,
            firstSeen: fp.observedAt,
            lastSeen: fp.observedAt,
            peakAmendmentRate: fp.amendmentRate,
            completed: false,
            completedAt: null,
          });
        }
      }
    }

    if (towerStyle.length > 0) {
      console.log(
        `[WATCHER] Tower-style fingerprints detected: ${towerStyle.length} (amendment>${AMENDMENT_RATE_THRESHOLD}/s, regularity>${CADENCE_REGULARITY_THRESHOLD})`
      );
    }

    return towerStyle;
  }

  // ── Check Pattern Completion (Tower exits the pool) ────────────────────
  // Pattern completion = amendment rate dropped below threshold AND skew is decaying.
  // This means Tower has moved on — the reversion tail is now available for harvesting.

  checkPatternCompletion(fingerprints: QuoteSkewFingerprint[]): ActivePattern[] {
    const newlyCompleted: ActivePattern[] = [];
    const now = Date.now();

    // Build a lookup of current fingerprints by participant+instrument
    const currentFpMap = new Map<string, QuoteSkewFingerprint>();
    for (const fp of fingerprints) {
      const key = `${fp.participantCodename}:${fp.instrument}`;
      currentFpMap.set(key, fp);
    }

    for (const [patternKey, pattern] of this.activePatterns.entries()) {
      if (pattern.completed) continue;

      const currentFp = currentFpMap.get(patternKey);

      // Pattern completes if:
      // 1. No current fingerprint for this participant+instrument (they left), OR
      // 2. Amendment rate dropped below completion threshold, OR
      // 3. Pattern has been stale for >30 seconds (no new fingerprint data)
      const amendmentDropped =
        currentFp !== undefined &&
        currentFp.amendmentRate < COMPLETION_AMENDMENT_DROP;
      const participantLeft = currentFp === undefined;
      const stalePattern =
        now - pattern.lastSeen > 30_000 && !currentFpMap.has(patternKey);

      if (amendmentDropped || participantLeft || stalePattern) {
        pattern.completed = true;
        pattern.completedAt = now;

        // Update fingerprint if we have a current reading showing the drop
        if (currentFp) {
          pattern.fingerprint = currentFp;
        }

        this.completedPatterns.push(pattern);
        newlyCompleted.push(pattern);

        console.log(
          `[WATCHER] Pattern COMPLETED: ${patternKey} | peak=${pattern.peakAmendmentRate.toFixed(1)}/s | reason=${
            amendmentDropped ? "RATE_DROP" : participantLeft ? "PARTICIPANT_LEFT" : "STALE"
          }`
        );
      }
    }

    // Prune completed patterns from active map (keep for 2 minutes for reference)
    for (const [key, pattern] of this.activePatterns.entries()) {
      if (pattern.completed && pattern.completedAt && now - pattern.completedAt > 120_000) {
        this.activePatterns.delete(key);
      }
    }

    // Cap completed patterns history at 1000
    if (this.completedPatterns.length > 1000) {
      this.completedPatterns.splice(0, this.completedPatterns.length - 1000);
    }

    return newlyCompleted;
  }

  // ── Queries ────────────────────────────────────────────────────────────

  getActivePatterns(): ActivePattern[] {
    return Array.from(this.activePatterns.values()).filter((p) => !p.completed);
  }

  getCompletedPatterns(limit = 50): ActivePattern[] {
    return this.completedPatterns.slice(-limit);
  }

  getPatternById(patternKey: string): ActivePattern | undefined {
    return this.activePatterns.get(patternKey);
  }

  getParticipantHistory(codename: string): QuoteSkewFingerprint[] {
    return this.fingerprintHistory.get(codename) || [];
  }

  getRecentCompletedForEvaluation(): ActivePattern[] {
    const now = Date.now();
    // Return patterns completed within the last 60 seconds that haven't been evaluated yet
    return this.completedPatterns.filter(
      (p) => p.completed && p.completedAt !== null && now - p.completedAt < 60_000
    );
  }

  getStats(): {
    activePatterns: number;
    completedPatterns: number;
    totalFingerprintsProcessed: number;
    trackedParticipants: number;
    lastPollTimestamp: number;
  } {
    return {
      activePatterns: this.getActivePatterns().length,
      completedPatterns: this.completedPatterns.length,
      totalFingerprintsProcessed: this.totalFingerprintsProcessed,
      trackedParticipants: this.fingerprintHistory.size,
      lastPollTimestamp: this.lastPollTimestamp,
    };
  }

  reset(): void {
    this.activePatterns.clear();
    this.completedPatterns = [];
    this.fingerprintHistory.clear();
    this.totalFingerprintsProcessed = 0;
    this.lastPollTimestamp = 0;
    console.log("[WATCHER] Reset complete");
  }
}
