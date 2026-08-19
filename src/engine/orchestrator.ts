// ---------------------------------------------------------------------------
// Orchestrator — the brain of the ingestion engine
// ---------------------------------------------------------------------------
// Coordinates source adapters, rate limiters, health monitors, and the data
// pipeline. Manages the full scrape lifecycle and emits events for the
// real-time dashboard.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { SourceAdapter, RawJobListing, ScrapeRun, EngineEvent, JobListing } from '../types.js';
import { RateLimiterRegistry } from './rate-limiter.js';
import { HealthMonitor } from './health-monitor.js';
import { Scheduler } from './scheduler.js';
import { normalize } from '../pipeline/normalizer.js';
import { Deduplicator } from '../pipeline/deduplicator.js';
import { validate } from '../pipeline/validator.js';
import { Database } from '../storage/database.js';
import { config } from '../config.js';

export class Orchestrator extends EventEmitter {
  private adapters = new Map<string, SourceAdapter>();
  private rateLimiters: RateLimiterRegistry;
  private healthMonitor: HealthMonitor;
  private scheduler: Scheduler;
  private deduplicator: Deduplicator;
  private db: Database;
  private isRunning = false;
  private activeScrapes = new Set<string>();

  constructor(db: Database) {
    super();
    this.db = db;
    this.rateLimiters = new RateLimiterRegistry(
      config.rateLimitRequestsPerMinute,
      config.rateLimitBurst
    );
    this.healthMonitor = new HealthMonitor(60);
    this.scheduler = new Scheduler(config.scrapeIntervalMinutes, config.scrapeJitterMinutes);
    this.deduplicator = new Deduplicator(db);

    // Wire scheduler triggers to orchestrator
    this.scheduler.on('scrape:trigger', () => {
      this.scrapeAll().catch(err => {
        this.emitEvent('log', { level: 'error', message: `Scrape trigger failed: ${err.message}` });
      });
    });

    this.scheduler.on('log', (data) => {
      this.emitEvent('log', data);
    });
  }

  /** Register a source adapter */
  registerAdapter(adapter: SourceAdapter): void {
    this.adapters.set(adapter.name, adapter);
    this.emitEvent('log', { level: 'info', message: `Adapter registered: ${adapter.name}` });
  }

  /** Unregister a source adapter */
  unregisterAdapter(name: string): void {
    this.adapters.delete(name);
  }

  /** Start the engine (scheduler + initial scrape) */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    this.emitEvent('log', { level: 'info', message: 'Orchestrator starting...' });
    this.scheduler.start();

    // Kick off an initial scrape immediately
    await this.scrapeAll();
  }

  /** Stop the engine */
  stop(): void {
    this.isRunning = false;
    this.scheduler.stop();
    this.emitEvent('log', { level: 'info', message: 'Orchestrator stopped' });
  }

  /** Manually trigger a scrape of all sources */
  async scrapeAll(): Promise<void> {
    const adapters = Array.from(this.adapters.values());
    const active = adapters.filter(a => {
      if (this.activeScrapes.has(a.name)) {
        this.emitEvent('log', { level: 'warn', message: `Skipping ${a.name}: already running` });
        return false;
      }
      return true;
    });

    // Run adapters with concurrency limit
    const chunks = this.chunk(active, config.maxConcurrentScrapes);
    for (const batch of chunks) {
      await Promise.allSettled(batch.map(adapter => this.scrapeSource(adapter)));
    }
  }

  /** Manually trigger a single source */
  async scrapeSource(adapter: SourceAdapter): Promise<ScrapeRun> {
    const runId = uuidv4();
    const run: ScrapeRun = {
      id: runId,
      source: adapter.name,
      startedAt: new Date(),
      completedAt: null,
      status: 'running',
      jobsFound: 0,
      jobsNew: 0,
      jobsDuplicate: 0,
      errors: [],
    };

    this.activeScrapes.add(adapter.name);
    this.emitEvent('scrape:started', { run });
    this.emitEvent('log', { level: 'info', message: `Scrape started: ${adapter.name} (run: ${runId.slice(0, 8)})` });

    const limiter = this.rateLimiters.get(adapter.name);

    // Check circuit breaker
    if (!this.healthMonitor.isAvailable(adapter.name)) {
      const probing = this.healthMonitor.attemptProbe(adapter.name);
      if (!probing) {
        run.status = 'failed';
        run.completedAt = new Date();
        run.errors.push('Circuit breaker OPEN — source unavailable');
        this.activeScrapes.delete(adapter.name);
        this.emitEvent('scrape:failed', { run });
        this.emitEvent('log', { level: 'warn', message: `Circuit breaker OPEN for ${adapter.name}, skipping` });
        this.db.insertRun(run);
        return run;
      }
      this.emitEvent('log', { level: 'info', message: `Probing ${adapter.name} (circuit HALF_OPEN)` });
    }

    try {
      const startTime = Date.now();

      for await (const raw of adapter.scrape()) {
        await limiter.acquire();
        run.jobsFound++;

        try {
          // Normalize
          const job = normalize(raw);

          // Validate
          const validation = validate(job);
          if (!validation.valid) {
            this.emitEvent('log', {
              level: 'debug',
              message: `Validation failed for ${raw.externalId}: ${validation.reasons.join(', ')}`,
            });
            continue;
          }

          // Deduplicate
          if (this.deduplicator.isDuplicate(job)) {
            run.jobsDuplicate++;
            this.emitEvent('job:duplicate', { job });
            continue;
          }

          // Store
          this.db.insertJob(job);
          this.deduplicator.markSeen(job);
          run.jobsNew++;

          this.emitEvent('job:new', { job });
          this.emitEvent('scrape:progress', {
            run,
            latestJob: { title: job.title, company: job.company },
          });

          limiter.onSuccess();
        } catch (pipelineErr: unknown) {
          const msg = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
          run.errors.push(`Pipeline error: ${msg}`);
          this.emitEvent('log', { level: 'error', message: `Pipeline error: ${msg}` });
        }
      }

      const elapsed = Date.now() - startTime;
      this.healthMonitor.recordSuccess(adapter.name, elapsed);
      limiter.onSuccess();

      run.status = 'completed';
      run.completedAt = new Date();

      this.emitEvent('scrape:completed', { run });
      this.emitEvent('log', {
        level: 'info',
        message: `Scrape completed: ${adapter.name} — ${run.jobsNew} new, ${run.jobsDuplicate} dupes, ${run.errors.length} errors (${elapsed}ms)`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      run.status = 'failed';
      run.completedAt = new Date();
      run.errors.push(msg);

      this.healthMonitor.recordFailure(adapter.name, 0);
      limiter.onThrottle();

      this.emitEvent('scrape:failed', { run });
      this.emitEvent('log', { level: 'error', message: `Scrape failed: ${adapter.name} — ${msg}` });
    } finally {
      this.activeScrapes.delete(adapter.name);
      this.db.insertRun(run);
    }

    return run;
  }

  /** Get health data for all sources */
  getHealthData() {
    return this.healthMonitor.getAllHealth();
  }

  /** Get rate limiter status */
  getRateLimiterStatus() {
    return this.rateLimiters.getStatus();
  }

  /** Get scheduler status */
  getSchedulerStatus() {
    return this.scheduler.getStatus();
  }

  /** List registered adapters */
  getAdapters(): { name: string; detectionProfile: ReturnType<SourceAdapter['getDetectionProfile']> }[] {
    return Array.from(this.adapters.values()).map(a => ({
      name: a.name,
      detectionProfile: a.getDetectionProfile(),
    }));
  }

  /** Emit a typed engine event */
  private emitEvent(type: string, data: Record<string, unknown>): void {
    const event: EngineEvent = {
      type: type as EngineEvent['type'],
      timestamp: new Date(),
      data,
    };
    this.emit('event', event);
  }

  /** Split array into chunks */
  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
