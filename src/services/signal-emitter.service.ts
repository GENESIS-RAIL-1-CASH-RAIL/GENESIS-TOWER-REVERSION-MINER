// ─── Signal Emitter Service — Broadcast to CIA/DARPA/GTC/Whiteboard + Labs ───
// Standard Genesis broadcast pattern for WD-043 Tower Reversion Miner.
// Three payload types: FINGERPRINT_DETECTED, REVERSION_OPPORTUNITY, CRUMB_CAPTURED
// ─────────────────────────────────────────────────────────────────────────────

import { BroadcastPayload, BroadcastType } from "../types";

interface BroadcastTarget {
  url: string;
  endpoint: string;
  label: string;
}

export class SignalEmitterService {
  private broadcastsSent = 0;
  private pendingBroadcasts: BroadcastPayload[] = [];
  private broadcastLog: { type: BroadcastType; targetsReached: number; timestamp: number }[] = [];

  private targets: BroadcastTarget[] = [
    { url: process.env.CIA_URL || "http://genesis-cia:8797", endpoint: "/intel", label: "CIA" },
    { url: process.env.DARPA_URL || "http://genesis-darpa:8840", endpoint: "/intel", label: "DARPA" },
    { url: process.env.WHITEBOARD_URL || "http://genesis-whiteboard:8710", endpoint: "/ingest", label: "WB" },
    { url: process.env.GTC_URL || "http://genesis-gtc:8650", endpoint: "/ingest", label: "GTC" },
    { url: process.env.LABS_URL || "http://genesis-labs:8845", endpoint: "/intel", label: "LABS" },
    { url: process.env.TOXICITY_ORACLE_URL || "http://genesis-toxicity-oracle:8858", endpoint: "/intel", label: "TOX" },
  ];

  constructor() {}

  // ── Queue Broadcast ────────────────────────────────────────────────────

  queue(type: BroadcastType, data: Record<string, unknown>): void {
    const payload: BroadcastPayload = {
      source: "TOWER_REVERSION_MINER",
      type,
      data,
      timestamp: Date.now(),
    };

    // Avoid excessive duplicates — cap pending at 100
    if (this.pendingBroadcasts.length >= 100) {
      this.pendingBroadcasts.splice(0, this.pendingBroadcasts.length - 50);
    }

    this.pendingBroadcasts.push(payload);
  }

  // ── Broadcast All Pending ──────────────────────────────────────────────

  async broadcastAll(): Promise<{ sent: number; reached: number }> {
    if (this.pendingBroadcasts.length === 0) {
      return { sent: 0, reached: 0 };
    }

    let totalSent = 0;
    let totalReached = 0;

    for (const payload of this.pendingBroadcasts) {
      const reached = await this.broadcastToTargets(payload);
      totalSent++;
      totalReached += reached;
      this.broadcastsSent++;

      this.broadcastLog.push({
        type: payload.type,
        targetsReached: reached,
        timestamp: Date.now(),
      });
    }

    // Cap broadcast log at 500
    if (this.broadcastLog.length > 500) {
      this.broadcastLog.splice(0, this.broadcastLog.length - 500);
    }

    // Clear pending queue
    const sent = this.pendingBroadcasts.length;
    this.pendingBroadcasts = [];

    if (totalSent > 0) {
      console.log(
        `[EMITTER] Broadcast complete: ${totalSent} payloads, ${totalReached} total target hits`
      );
    }

    return { sent, reached: totalReached };
  }

  // ── Fire to All Targets ────────────────────────────────────────────────

  private async broadcastToTargets(payload: BroadcastPayload): Promise<number> {
    const results = await Promise.allSettled(
      this.targets.map((t) => this.fire(t, payload))
    );

    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (ok > 0) {
      console.log(
        `[EMITTER] ${payload.type}: ${ok}/${this.targets.length} targets reached`
      );
    }
    return ok;
  }

  // ── Fire Single Request ────────────────────────────────────────────────

  private async fire(target: BroadcastTarget, payload: BroadcastPayload): Promise<void> {
    try {
      await fetch(`${target.url}${target.endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-weapon": "WD-043",
          "x-source": "TOWER_REVERSION_MINER",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* fire-and-forget — targets may be offline */
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────

  getPendingCount(): number {
    return this.pendingBroadcasts.length;
  }

  getRecentBroadcasts(limit = 50): { type: BroadcastType; targetsReached: number; timestamp: number }[] {
    return this.broadcastLog.slice(-limit);
  }

  getStats(): {
    broadcastsSent: number;
    pendingCount: number;
    targetCount: number;
    recentLogSize: number;
  } {
    return {
      broadcastsSent: this.broadcastsSent,
      pendingCount: this.pendingBroadcasts.length,
      targetCount: this.targets.length,
      recentLogSize: this.broadcastLog.length,
    };
  }

  reset(): void {
    this.broadcastsSent = 0;
    this.pendingBroadcasts = [];
    this.broadcastLog = [];
    console.log("[EMITTER] Reset complete");
  }
}
