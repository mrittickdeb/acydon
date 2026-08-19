// ---------------------------------------------------------------------------
// Cron-based scrape scheduler with jitter
// ---------------------------------------------------------------------------
// Prevents detection through predictable timing by adding configurable random
// jitter to each scrape interval.
// ---------------------------------------------------------------------------

import cron from 'node-cron';
import { EventEmitter } from 'events';

export class Scheduler extends EventEmitter {
  private tasks = new Map<string, cron.ScheduledTask>();
  private intervalMinutes: number;
  private jitterMinutes: number;

  constructor(intervalMinutes: number, jitterMinutes: number) {
    super();
    this.intervalMinutes = intervalMinutes;
    this.jitterMinutes = jitterMinutes;
  }

  /** Start the periodic scrape schedule */
  start(): void {
    // Run every N minutes — the jitter is applied to the callback, not the cron
    const cronExpr = `*/${this.intervalMinutes} * * * *`;

    const task = cron.schedule(cronExpr, () => {
      const jitterMs = this.calculateJitter();

      setTimeout(() => {
        this.emit('scrape:trigger', {
          scheduledAt: new Date(),
          jitterMs,
        });
      }, jitterMs);
    });

    this.tasks.set('main', task);
    this.emit('log', {
      level: 'info',
      message: `Scheduler started: every ${this.intervalMinutes}m ±${this.jitterMinutes}m jitter`,
    });
  }

  /** Stop all scheduled tasks */
  stop(): void {
    for (const [name, task] of this.tasks) {
      task.stop();
      this.tasks.delete(name);
    }
    this.emit('log', { level: 'info', message: 'Scheduler stopped' });
  }

  /** Manually trigger a scrape (bypasses schedule and jitter) */
  triggerNow(): void {
    this.emit('scrape:trigger', {
      scheduledAt: new Date(),
      jitterMs: 0,
      manual: true,
    });
  }

  /** Calculate random jitter within the configured window */
  private calculateJitter(): number {
    const maxMs = this.jitterMinutes * 60 * 1000;
    // Random value between -maxMs and +maxMs
    return Math.floor(Math.random() * 2 * maxMs) - maxMs;
  }

  /** Get scheduler status */
  getStatus(): { running: boolean; intervalMinutes: number; jitterMinutes: number } {
    return {
      running: this.tasks.size > 0,
      intervalMinutes: this.intervalMinutes,
      jitterMinutes: this.jitterMinutes,
    };
  }
}
