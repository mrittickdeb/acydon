// ---------------------------------------------------------------------------
// Adaptive token-bucket rate limiter
// ---------------------------------------------------------------------------
// Automatically throttles when 429/403 responses are detected, and ramps back
// up during sustained success. Each source gets its own bucket.
// ---------------------------------------------------------------------------

export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per second
  private lastRefill: number;
  private minRefillRate: number;
  private baseRefillRate: number;
  private consecutiveThrottles = 0;
  private consecutiveSuccesses = 0;

  constructor(requestsPerMinute: number, burst: number) {
    this.baseRefillRate = requestsPerMinute / 60;
    this.refillRate = this.baseRefillRate;
    this.minRefillRate = this.baseRefillRate * 0.1; // floor at 10% of base
    this.maxTokens = burst;
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  /** Refill tokens based on elapsed time */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /** Wait until a token is available, then consume it */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate wait time until next token
    const deficit = 1 - this.tokens;
    const waitMs = (deficit / this.refillRate) * 1000;

    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= 1;
  }

  /** Signal a throttle response (429/403) — backs off exponentially */
  onThrottle(): void {
    this.consecutiveThrottles++;
    this.consecutiveSuccesses = 0;

    // Exponential backoff: halve rate each consecutive throttle, floor at minimum
    const factor = Math.pow(0.5, Math.min(this.consecutiveThrottles, 5));
    this.refillRate = Math.max(this.minRefillRate, this.baseRefillRate * factor);
  }

  /** Signal a successful response — gradually recovers rate */
  onSuccess(): void {
    this.consecutiveSuccesses++;
    this.consecutiveThrottles = 0;

    // Recover after 10 consecutive successes, step by 20%
    if (this.consecutiveSuccesses >= 10 && this.refillRate < this.baseRefillRate) {
      this.refillRate = Math.min(this.baseRefillRate, this.refillRate * 1.2);
      this.consecutiveSuccesses = 0;
    }
  }

  /** Current effective rate (requests per minute) */
  get effectiveRatePerMinute(): number {
    return Math.round(this.refillRate * 60 * 100) / 100;
  }

  /** How many tokens are currently available */
  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/** Per-source rate limiter registry */
export class RateLimiterRegistry {
  private limiters = new Map<string, RateLimiter>();
  private defaultRpm: number;
  private defaultBurst: number;

  constructor(defaultRpm: number, defaultBurst: number) {
    this.defaultRpm = defaultRpm;
    this.defaultBurst = defaultBurst;
  }

  /** Get or create a rate limiter for a source */
  get(source: string, rpm?: number, burst?: number): RateLimiter {
    let limiter = this.limiters.get(source);
    if (!limiter) {
      limiter = new RateLimiter(rpm ?? this.defaultRpm, burst ?? this.defaultBurst);
      this.limiters.set(source, limiter);
    }
    return limiter;
  }

  /** Get status of all limiters */
  getStatus(): Record<string, { effectiveRpm: number; availableTokens: number }> {
    const status: Record<string, { effectiveRpm: number; availableTokens: number }> = {};
    for (const [source, limiter] of this.limiters) {
      status[source] = {
        effectiveRpm: limiter.effectiveRatePerMinute,
        availableTokens: limiter.availableTokens,
      };
    }
    return status;
  }
}
