// ---------------------------------------------------------------------------
// SQLite storage layer
// ---------------------------------------------------------------------------
// Zero-dependency persistent storage using better-sqlite3 with WAL mode
// for concurrent read/write. Auto-migrates schema on startup.
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { JobListing, ScrapeRun } from '../types.js';

export class Database {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new BetterSqlite3(dbPath);

    // Performance: WAL mode for concurrent reads
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.migrate();
  }

  // ---- Schema migration ----

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        salary_min REAL,
        salary_max REAL,
        salary_currency TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        url TEXT NOT NULL DEFAULT '',
        posted_at TEXT NOT NULL,
        scraped_at TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
      CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_scraped_at ON jobs(scraped_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
      CREATE INDEX IF NOT EXISTS idx_jobs_content_hash ON jobs(content_hash);

      CREATE TABLE IF NOT EXISTS scrape_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        jobs_found INTEGER NOT NULL DEFAULT 0,
        jobs_new INTEGER NOT NULL DEFAULT 0,
        jobs_duplicate INTEGER NOT NULL DEFAULT 0,
        errors TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_runs_source ON scrape_runs(source);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON scrape_runs(started_at);

      CREATE TABLE IF NOT EXISTS health_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        success_rate REAL NOT NULL,
        avg_response_ms INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_health_source ON health_snapshots(source);
    `);
  }

  // ---- Jobs ----

  insertJob(job: JobListing): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO jobs (
        id, source, external_id, title, company, location, description,
        salary_min, salary_max, salary_currency, tags, url,
        posted_at, scraped_at, confidence, content_hash
      ) VALUES (
        @id, @source, @externalId, @title, @company, @location, @description,
        @salaryMin, @salaryMax, @salaryCurrency, @tags, @url,
        @postedAt, @scrapedAt, @confidence, @contentHash
      )
    `);

    const contentHash = this.hashContent(job.title, job.company);

    stmt.run({
      id: job.id,
      source: job.source,
      externalId: job.externalId,
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
      salaryMin: job.salary?.min ?? null,
      salaryMax: job.salary?.max ?? null,
      salaryCurrency: job.salary?.currency ?? null,
      tags: JSON.stringify(job.tags),
      url: job.url,
      postedAt: job.postedAt.toISOString(),
      scrapedAt: job.scrapedAt.toISOString(),
      confidence: job.confidence,
      contentHash,
    });
  }

  getJobs(options: {
    limit?: number;
    offset?: number;
    source?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  } = {}): { jobs: JobListing[]; total: number } {
    const {
      limit = 50,
      offset = 0,
      source,
      search,
      sortBy = 'scraped_at',
      sortOrder = 'desc',
    } = options;

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (source) {
      conditions.push('source = @source');
      params.source = source;
    }
    if (search) {
      conditions.push('(title LIKE @search OR company LIKE @search OR description LIKE @search)');
      params.search = `%${search}%`;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Validate sort column
    const allowedSorts = ['scraped_at', 'posted_at', 'title', 'company', 'confidence'];
    const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'scraped_at';
    const safeOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';

    const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM jobs ${where}`);
    const countResult = countStmt.get(params) as { count: number };

    const selectStmt = this.db.prepare(`
      SELECT * FROM jobs ${where}
      ORDER BY ${safeSort} ${safeOrder}
      LIMIT @limit OFFSET @offset
    `);

    const rows = selectStmt.all({ ...params, limit, offset }) as Record<string, unknown>[];
    const jobs = rows.map(row => this.rowToJob(row));

    return { jobs, total: countResult.count };
  }

  getJob(id: string): JobListing | null {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToJob(row) : null;
  }

  jobExists(source: string, externalId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM jobs WHERE source = ? AND external_id = ?');
    return !!stmt.get(source, externalId);
  }

  jobExistsFuzzy(title: string, company: string): boolean {
    const hash = this.hashContent(title, company);
    const stmt = this.db.prepare('SELECT 1 FROM jobs WHERE content_hash = ?');
    return !!stmt.get(hash);
  }

  getAllJobHashes(): string[] {
    const stmt = this.db.prepare('SELECT DISTINCT content_hash FROM jobs WHERE content_hash IS NOT NULL');
    return (stmt.all() as { content_hash: string }[]).map(r => r.content_hash);
  }

  getJobStats(): {
    total: number;
    bySource: Record<string, number>;
    last24h: number;
    avgConfidence: number;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM jobs').get() as { c: number }).c;

    const bySourceRows = this.db.prepare(
      'SELECT source, COUNT(*) as c FROM jobs GROUP BY source'
    ).all() as { source: string; c: number }[];
    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) bySource[row.source] = row.c;

    const last24h = (this.db.prepare(
      "SELECT COUNT(*) as c FROM jobs WHERE scraped_at > datetime('now', '-1 day')"
    ).get() as { c: number }).c;

    const avgConf = (this.db.prepare(
      'SELECT AVG(confidence) as avg FROM jobs'
    ).get() as { avg: number | null }).avg;

    return {
      total,
      bySource,
      last24h,
      avgConfidence: Math.round((avgConf ?? 0) * 100) / 100,
    };
  }

  // ---- Scrape runs ----

  insertRun(run: ScrapeRun): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO scrape_runs (
        id, source, started_at, completed_at, status,
        jobs_found, jobs_new, jobs_duplicate, errors
      ) VALUES (
        @id, @source, @startedAt, @completedAt, @status,
        @jobsFound, @jobsNew, @jobsDuplicate, @errors
      )
    `);

    stmt.run({
      id: run.id,
      source: run.source,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      status: run.status,
      jobsFound: run.jobsFound,
      jobsNew: run.jobsNew,
      jobsDuplicate: run.jobsDuplicate,
      errors: JSON.stringify(run.errors),
    });
  }

  getRuns(limit = 20): ScrapeRun[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT ?
    `);

    return (stmt.all(limit) as Record<string, unknown>[]).map(row => ({
      id: String(row.id),
      source: String(row.source),
      startedAt: new Date(String(row.started_at)),
      completedAt: row.completed_at ? new Date(String(row.completed_at)) : null,
      status: String(row.status) as ScrapeRun['status'],
      jobsFound: Number(row.jobs_found),
      jobsNew: Number(row.jobs_new),
      jobsDuplicate: Number(row.jobs_duplicate),
      errors: JSON.parse(String(row.errors || '[]')),
    }));
  }

  // ---- Helpers ----

  private rowToJob(row: Record<string, unknown>): JobListing {
    const salaryMin = row.salary_min as number | null;
    const salaryMax = row.salary_max as number | null;
    const salaryCurrency = row.salary_currency as string | null;

    return {
      id: String(row.id),
      source: String(row.source),
      externalId: String(row.external_id),
      title: String(row.title),
      company: String(row.company),
      location: String(row.location),
      description: String(row.description),
      salary: salaryMin != null && salaryMax != null
        ? { min: salaryMin, max: salaryMax, currency: salaryCurrency || 'USD' }
        : null,
      tags: JSON.parse(String(row.tags || '[]')),
      url: String(row.url),
      postedAt: new Date(String(row.posted_at)),
      scrapedAt: new Date(String(row.scraped_at)),
      confidence: Number(row.confidence),
    };
  }

  private hashContent(title: string, company: string): string {
    return createHash('md5')
      .update(`${title.toLowerCase().trim()}::${company.toLowerCase().trim()}`)
      .digest('hex');
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }
}
