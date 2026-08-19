// ---------------------------------------------------------------------------
// Data quality validator
// ---------------------------------------------------------------------------
// Gates the pipeline: rejects listings with missing critical fields,
// validates URLs, and flags suspicious data.
// ---------------------------------------------------------------------------

import type { JobListing } from '../types.js';

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
  warnings: string[];
}

/** Validate a normalized job listing */
export function validate(job: JobListing): ValidationResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  // Critical fields
  if (!job.title || job.title === 'Untitled' || job.title.length < 3) {
    reasons.push('Missing or too-short title');
  }

  if (!job.company || job.company === 'Unknown' || job.company.length < 2) {
    reasons.push('Missing or invalid company');
  }

  // URL validation
  if (job.url) {
    try {
      new URL(job.url);
    } catch {
      warnings.push('Invalid URL format');
    }
  }

  // Suspiciously short description
  if (job.description && job.description.length < 10) {
    warnings.push('Very short description');
  }

  // Title sanity: reject obvious garbage
  if (job.title && /^[\d\s]+$/.test(job.title)) {
    reasons.push('Title contains only numbers/spaces');
  }

  // Company sanity
  if (job.company && /^[\d\s]+$/.test(job.company)) {
    reasons.push('Company name contains only numbers/spaces');
  }

  // Confidence threshold
  if (job.confidence < 0.3) {
    warnings.push('Low extraction confidence');
  }

  return {
    valid: reasons.length === 0,
    reasons,
    warnings,
  };
}
