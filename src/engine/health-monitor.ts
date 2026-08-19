// ---------------------------------------------------------------------------
// Per-source health monitor with circuit breaker pattern
// ---------------------------------------------------------------------------
// Tracks success/failure rates, response times, and implements the classic
// CLOSED → OPEN → HALF_OPEN circuit breaker to prevent hammering dead sources.
// ---------------------------------------------------------------------------

import type { CircuitState, SourceHealth } from '../types.js';

interface HealthEntry {
  timestamp: number;
  success: boolean;
  responseMs: number;
}

export class HealthMonitor {
  private sources = new Map<string, SourceHealthTracker>();
  private readonly windowMs: number;

  constructor(windowMinutes = 60) {
    this.windowMs = windowMinutes * 60 * 1000;
  }

  /** Get or create a tracker for a source */
  private tracker(source: string): SourceHealthTracker {
    let t = this.sources.get(source);
    if (!t) {
      t = new SourceHealthTracker(source, this.windowMs);
      this.sources.set(source, t);
    }
    return t;
  }

  /** Record a successful request */
  recordSuccess(source: string, responseMs: number): void {
    this.tracker(source).record(true, responseMs);
  }

  /** Record a failed request */
  recordFailure(source: string, responseMs: number): void {
    this.tracker(source).record(false, responseMs);
  }

  /** Check if a source is allowed to receive requests */
  isAvailable(source: string): boolean {
    return this.tracker(source).isAvailable();
  }

  /** Get health snapshot for a source */
  getHealth(source: string): SourceHealth {
    return this.tracker(source).getHealth();
  }

  /** Get health snapshots for all sources */
  getAllHealth(): SourceHealth[] {
    return Array.from(this.sources.values()).map(t => t.getHealth());
  }

  /** Signal the start of a half-open probe */
  attemptProbe(source: string): boolean {
    return this.tracker(source).attemptProbe();
  }
}

class SourceHealthTracker {
  readonly source: string;
  private entries: HealthEntry[] = [];
  private windowMs: number;
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastSuccess: number | null = null;
  private lastFailure: number | null = null;
  private openedAt: number | null = null;
  private totalRequests = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;

  // Circuit breaker thresholds
  private readonly failureThreshold = 3;    // consecutive failures to trip
  private readonly recoveryMs = 30_000;     // 30s before half-open probe
  private readonly maxRecoveryMs = 300_000; // 5m maximum backoff
  private recoveryAttempts = 0;

  constructor(source: string, windowMs: number) {
    this.source = source;
    this.windowMs = windowMs;
  }

  /** Record a request outcome */
  record(success: boolean, responseMs: number): void {
    const now = Date.now();
    this.entries.push({ timestamp: now, success, responseMs });
    this.totalRequests++;
    this.pruneOldEntries(now);

    if (success) {
      this.totalSuccesses++;
      this.consecutiveFailures = 0;
      this.lastSuccess = now;

      // Successful probe → close the circuit
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.recoveryAttempts = 0;
      }
    } else {
      this.totalFailures++;
      this.consecutiveFailures++;
      this.lastFailure = now;

      // Failed probe → reopen
      if (this.state === 'HALF_OPEN') {
        this.state = 'OPEN';
        this.openedAt = now;
        this.recoveryAttempts++;
      }

      // Trip the circuit
      if (this.state === 'CLOSED' && this.consecutiveFailures >= this.failureThreshold) {
        this.state = 'OPEN';
        this.openedAt = now;
        this.recoveryAttempts = 0;
      }
    }
  }

  /** Check if this source is accepting requests */
  isAvailable(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'HALF_OPEN') return false; // only one probe at a time

    // Check if enough time has passed for a probe
    if (this.state === 'OPEN' && this.openedAt) {
      const backoff = Math.min(
        this.recoveryMs * Math.pow(2, this.recoveryAttempts),
        this.maxRecoveryMs
      );
      if (Date.now() - this.openedAt >= backoff) {
        return true; // time to try a probe
      }
    }

    return false;
  }

  /** Transition to HALF_OPEN for a probe request */
  attemptProbe(): boolean {
    if (this.state === 'OPEN' && this.isAvailable()) {
      this.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }

  /** Get the current health snapshot */
  getHealth(): SourceHealth {
    const now = Date.now();
    this.pruneOldEntries(now);

    const windowEntries = this.entries;
    const successes = windowEntries.filter(e => e.success).length;
    const total = windowEntries.length;
    const avgMs = total > 0
      ? windowEntries.reduce((sum, e) => sum + e.responseMs, 0) / total
      : 0;

    return {
      source: this.source,
      state: this.state,
      successRate: total > 0 ? successes / total : 1,
      avgResponseMs: Math.round(avgMs),
      lastSuccess: this.lastSuccess ? new Date(this.lastSuccess) : null,
      lastFailure: this.lastFailure ? new Date(this.lastFailure) : null,
      consecutiveFailures: this.consecutiveFailures,
      totalRequests: this.totalRequests,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
    };
  }

  /** Remove entries outside the rolling window */
  private pruneOldEntries(now: number): void {
    const cutoff = now - this.windowMs;
    this.entries = this.entries.filter(e => e.timestamp >= cutoff);
  }
}
