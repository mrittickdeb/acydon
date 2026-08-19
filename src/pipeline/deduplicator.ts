// ---------------------------------------------------------------------------
// Content-based deduplicator
// ---------------------------------------------------------------------------
// Uses content hashing + fuzzy title/company matching to prevent duplicate
// job listings from being stored across scrape runs.
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';
import type { JobListing } from '../types.js';
import type { Database } from '../storage/database.js';

export class Deduplicator {
  private seenHashes = new Set<string>();
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    // Preload existing hashes from DB
    this.loadExistingHashes();
  }

  /** Check if a job listing is a duplicate */
  isDuplicate(job: JobListing): boolean {
    const hash = this.computeHash(job);

    // Exact match by content hash
    if (this.seenHashes.has(hash)) return true;

    // Check DB by source + externalId (same listing re-scraped)
    if (this.db.jobExists(job.source, job.externalId)) return true;

    // Fuzzy: same title + company from different source
    if (this.db.jobExistsFuzzy(job.title, job.company)) return true;

    return false;
  }

  /** Mark a job as seen */
  markSeen(job: JobListing): void {
    const hash = this.computeHash(job);
    this.seenHashes.add(hash);
  }

  /** Compute a content hash for fuzzy deduplication */
  private computeHash(job: JobListing): string {
    // Normalize for comparison: lowercase, strip extra whitespace
    const key = [
      job.title.toLowerCase().trim(),
      job.company.toLowerCase().trim(),
      job.source,
    ].join('::');

    return createHash('md5').update(key).digest('hex');
  }

  /** Load existing job hashes from the database */
  private loadExistingHashes(): void {
    try {
      const existing = this.db.getAllJobHashes();
      for (const hash of existing) {
        this.seenHashes.add(hash);
      }
    } catch {
      // DB might not be initialized yet, that's fine
    }
  }
}
