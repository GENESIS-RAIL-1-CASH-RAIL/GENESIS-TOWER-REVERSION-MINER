// ─── Probabilistic Fingerprint Service — 128-dim Rival Embeddings ────────────────
// P(r|e_t) ∝ sim_r(t) × P(rate|r) × P(venue|r).
// Cosine similarity decay. Novelty: Mahalanobis > χ²_{0.999}(128) → counter-fingerprint alert.
// Entry when P(exit)>0.78, residual z>1.9, re-entry hazard<0.18.
// Spark #008 — Guerrilla Weapons Battery POLISHED v10.0
// ─────────────────────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────────────

export interface RivalEmbedding {
  rivalId: string;
  embedding: number[];           // 128-dim
  meanEmbedding: number[];       // running mean
  varianceDiag: number[];        // diagonal covariance for Mahalanobis
  observations: number;
  lastSeen: number;
  venues: Map<string, number>;   // venue → frequency
  rateHistogram: number[];       // binned amendment rates
}

export interface FingerprintMatch {
  rivalId: string;
  posteriorProbability: number;
  cosineSimilarity: number;
  rateLikelihood: number;
  venueLikelihood: number;
  isNovel: boolean;
  mahalanobisDistance: number;
  timestamp: number;
}

export interface EntryDecision {
  rivalId: string;
  pExit: number;
  residualZ: number;
  reentryHazard: number;
  shouldEnter: boolean;
  reason: string;
}

export interface ProbabilisticFingerprintState {
  rivalCount: number;
  matchCount: number;
  noveltyAlerts: number;
  entryDecisions: number;
  entriesApproved: number;
  entriesDenied: number;
  chi2Threshold: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const EMBEDDING_DIM = 128;
const CHI2_999_128 = 186.156;  // χ²_{0.999}(128) critical value
const P_EXIT_THRESHOLD = 0.78;
const RESIDUAL_Z_THRESHOLD = 1.9;
const REENTRY_HAZARD_THRESHOLD = 0.18;
const RATE_BINS = 20;           // histogram bins for amendment rate

// ── Service ──────────────────────────────────────────────────────────────────

export class ProbabilisticFingerprintService {
  private rivals: Map<string, RivalEmbedding> = new Map();
  private matchCount = 0;
  private noveltyAlerts = 0;
  private entryDecisionCount = 0;
  private entriesApproved = 0;
  private entriesDenied = 0;
  private recentMatches: FingerprintMatch[] = [];
  private recentEntryDecisions: EntryDecision[] = [];

  /**
   * Register or update a rival's embedding from observed behaviour.
   */
  observe(rivalId: string, embedding: number[], venue: string, amendmentRate: number): void {
    if (embedding.length !== EMBEDDING_DIM) return;

    let rival = this.rivals.get(rivalId);
    if (!rival) {
      rival = {
        rivalId,
        embedding: [...embedding],
        meanEmbedding: [...embedding],
        varianceDiag: new Array(EMBEDDING_DIM).fill(1.0),
        observations: 0,
        lastSeen: Date.now(),
        venues: new Map(),
        rateHistogram: new Array(RATE_BINS).fill(0),
      };
      this.rivals.set(rivalId, rival);
    }

    // Incremental mean update
    rival.observations++;
    const n = rival.observations;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      const delta = embedding[i] - rival.meanEmbedding[i];
      rival.meanEmbedding[i] += delta / n;
      // Welford variance update
      const delta2 = embedding[i] - rival.meanEmbedding[i];
      rival.varianceDiag[i] += (delta * delta2 - rival.varianceDiag[i]) / n;
    }

    rival.embedding = [...embedding];
    rival.lastSeen = Date.now();

    // Update venue frequency
    rival.venues.set(venue, (rival.venues.get(venue) || 0) + 1);

    // Update rate histogram
    const bin = Math.min(RATE_BINS - 1, Math.floor(amendmentRate / 10));
    rival.rateHistogram[bin]++;
  }

  /**
   * Match an observed embedding against all known rivals.
   * P(r|e_t) ∝ sim_r(t) × P(rate|r) × P(venue|r)
   */
  match(
    embedding: number[],
    venue: string,
    amendmentRate: number,
  ): FingerprintMatch[] {
    if (embedding.length !== EMBEDDING_DIM) return [];

    const matches: FingerprintMatch[] = [];

    for (const [rivalId, rival] of this.rivals) {
      // Cosine similarity
      const sim = this.cosineSimilarity(embedding, rival.meanEmbedding);

      // Rate likelihood
      const bin = Math.min(RATE_BINS - 1, Math.floor(amendmentRate / 10));
      const totalObs = rival.rateHistogram.reduce((s, v) => s + v, 0);
      const rateLikelihood = totalObs > 0 ? rival.rateHistogram[bin] / totalObs : 1 / RATE_BINS;

      // Venue likelihood
      const totalVenueObs = Array.from(rival.venues.values()).reduce((s, v) => s + v, 0);
      const venueLikelihood = totalVenueObs > 0
        ? (rival.venues.get(venue) || 0) / totalVenueObs
        : 0.1;

      // Posterior (unnormalised)
      const posterior = sim * rateLikelihood * venueLikelihood;

      // Novelty detection via Mahalanobis distance
      const mahal = this.mahalanobisDistance(embedding, rival.meanEmbedding, rival.varianceDiag);
      const isNovel = mahal > CHI2_999_128;

      if (isNovel) {
        this.noveltyAlerts++;
      }

      matches.push({
        rivalId,
        posteriorProbability: Math.round(posterior * 100000) / 100000,
        cosineSimilarity: Math.round(sim * 10000) / 10000,
        rateLikelihood: Math.round(rateLikelihood * 10000) / 10000,
        venueLikelihood: Math.round(venueLikelihood * 10000) / 10000,
        isNovel,
        mahalanobisDistance: Math.round(mahal * 100) / 100,
        timestamp: Date.now(),
      });
    }

    // Normalise posteriors
    const totalPosterior = matches.reduce((s, m) => s + m.posteriorProbability, 0);
    if (totalPosterior > 0) {
      for (const m of matches) {
        m.posteriorProbability = Math.round((m.posteriorProbability / totalPosterior) * 10000) / 10000;
      }
    }

    // Sort by posterior descending
    matches.sort((a, b) => b.posteriorProbability - a.posteriorProbability);

    this.matchCount++;
    this.recentMatches.push(...matches.slice(0, 5));
    if (this.recentMatches.length > 500) {
      this.recentMatches.splice(0, this.recentMatches.length - 500);
    }

    return matches;
  }

  /**
   * Decide whether to enter based on exit probability, residual z-score, and re-entry hazard.
   */
  entryDecision(
    rivalId: string,
    pExit: number,
    residualZ: number,
    reentryHazard: number,
  ): EntryDecision {
    this.entryDecisionCount++;

    const shouldEnter =
      pExit > P_EXIT_THRESHOLD &&
      residualZ > RESIDUAL_Z_THRESHOLD &&
      reentryHazard < REENTRY_HAZARD_THRESHOLD;

    if (shouldEnter) {
      this.entriesApproved++;
    } else {
      this.entriesDenied++;
    }

    let reason = 'ALL_CONDITIONS_MET';
    if (pExit <= P_EXIT_THRESHOLD) reason = `P_EXIT_TOO_LOW (${pExit} <= ${P_EXIT_THRESHOLD})`;
    else if (residualZ <= RESIDUAL_Z_THRESHOLD) reason = `RESIDUAL_Z_TOO_LOW (${residualZ} <= ${RESIDUAL_Z_THRESHOLD})`;
    else if (reentryHazard >= REENTRY_HAZARD_THRESHOLD) reason = `REENTRY_HAZARD_TOO_HIGH (${reentryHazard} >= ${REENTRY_HAZARD_THRESHOLD})`;

    const decision: EntryDecision = {
      rivalId,
      pExit,
      residualZ,
      reentryHazard,
      shouldEnter,
      reason,
    };

    this.recentEntryDecisions.push(decision);
    if (this.recentEntryDecisions.length > 200) {
      this.recentEntryDecisions.splice(0, this.recentEntryDecisions.length - 200);
    }

    return decision;
  }

  /**
   * Cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  /**
   * Mahalanobis distance with diagonal covariance.
   * d² = Σ (x_i - μ_i)² / σ²_i
   */
  private mahalanobisDistance(x: number[], mu: number[], variance: number[]): number {
    let d2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = Math.max(variance[i], 1e-12);
      d2 += ((x[i] - mu[i]) ** 2) / v;
    }
    return d2;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getState(): ProbabilisticFingerprintState {
    return {
      rivalCount: this.rivals.size,
      matchCount: this.matchCount,
      noveltyAlerts: this.noveltyAlerts,
      entryDecisions: this.entryDecisionCount,
      entriesApproved: this.entriesApproved,
      entriesDenied: this.entriesDenied,
      chi2Threshold: CHI2_999_128,
    };
  }

  getRecentMatches(limit = 50): FingerprintMatch[] {
    return this.recentMatches.slice(-limit);
  }

  getRecentEntryDecisions(limit = 50): EntryDecision[] {
    return this.recentEntryDecisions.slice(-limit);
  }

  getRival(rivalId: string): { rivalId: string; observations: number; lastSeen: number; venues: string[] } | null {
    const r = this.rivals.get(rivalId);
    if (!r) return null;
    return {
      rivalId: r.rivalId,
      observations: r.observations,
      lastSeen: r.lastSeen,
      venues: Array.from(r.venues.keys()),
    };
  }

  reset(): void {
    this.rivals.clear();
    this.matchCount = 0;
    this.noveltyAlerts = 0;
    this.entryDecisionCount = 0;
    this.entriesApproved = 0;
    this.entriesDenied = 0;
    this.recentMatches = [];
    this.recentEntryDecisions = [];
    console.log('[PROB-FINGERPRINT] Reset complete');
  }
}
